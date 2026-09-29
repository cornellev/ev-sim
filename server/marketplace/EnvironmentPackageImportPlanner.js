import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { rewriteAssetBinding } from "../../app/editor-assets/AssetBackedObject.js";
import {
    assetMetricDefinitionFromRevision,
    assetMetricKey,
    validateAssetMetricsDomain,
} from "../../app/editor-assets/AssetMetricSnapshot.js";
import { compareUtf8 } from "../../app/math/compareUtf8.js";
import {
    VISUAL_ASSET_UPLOAD_OPERATIONS,
    hashVisualLayer,
    hashVisualLayerAccess,
    rebindVisualLayer,
    rebindVisualLayerAccess,
} from "../../app/simulation/visual/VisualLayer.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import {
    assetImportOperationId,
    planAssetPackageImport,
    readPreparedAssetRevision,
    revisionMappingIndex,
} from "./AssetPackageImportPlanner.js";
import { marketplaceEnvironmentContentHash } from "./EnvironmentPackage.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "./MarketplaceJson.js";

const INITIAL_SUFFIX_LENGTH = 12;
const FULL_DIGEST_LENGTH = 64;

function conflict(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function sourceKey(assetId, revision) {
    return `${assetId}@${revision}`;
}

async function writePreparedFile(filePath, bytes) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
        await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await fs.readFile(filePath);
        if (!existing.equals(bytes)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared environment changed for the same content hash.");
    }
}

function cleanEnvironmentForImport(source) {
    const target = structuredClone(source);
    delete target.revision;
    delete target.createdAt;
    delete target.updatedAt;
    delete target.clientRevision;
    target.schemaVersion = 4;
    target.evidence = null;
    if (target.visualLayer) delete target.visualLayer.bakeReuseManifestHash;
    return target;
}

async function preparedRevisionIndex(assetPlan, preparationDir) {
    const result = new Map();
    for (const entry of assetPlan.preparedRevisions) {
        const prepared = await readPreparedAssetRevision({
            preparationDir,
            preparedRevisionHash: entry.preparedRevisionHash,
        });
        result.set(sourceKey(entry.sourceAssetId, entry.sourceRevision), prepared);
    }
    return result;
}

function rewriteEnvironmentAssets(environment, assetPlan, preparedBySource) {
    const mappings = revisionMappingIndex(assetPlan);
    const target = cleanEnvironmentForImport(environment);
    const metrics = new Map();
    target.document = structuredClone(target.document);
    target.document.objects = (target.document.objects ?? []).map((record) => {
        const binding = record?.components?.asset;
        if (!binding) return record;
        const key = sourceKey(binding.assetId, binding.revision);
        const mapping = mappings.get(key);
        const prepared = preparedBySource.get(key);
        if (!mapping || !prepared) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Environment asset pin ${key} has no prepared mapping.`);
        }
        const assetTypeVersion = prepared.draft.definition ? 2 : 1;
        const rewritten = rewriteAssetBinding(record, {
            assetId: mapping.localAssetId,
            revision: mapping.localRevision,
            assetTypeVersion,
        });
        if (assetTypeVersion === 2) {
            const definition = assetMetricDefinitionFromRevision(mapping.localAssetId, {
                version: 2,
                revision: mapping.localRevision,
                metric: prepared.draft.metric,
                metricHash: prepared.draft.metricHash,
            });
            metrics.set(assetMetricKey(definition.assetId, definition.revision), definition);
        }
        return rewritten;
    });
    if (metrics.size) {
        target.document.assetMetrics = {
            version: 1,
            definitions: [...metrics.values()].sort((left, right) => compareUtf8(
                assetMetricKey(left.assetId, left.revision),
                assetMetricKey(right.assetId, right.revision),
            )),
        };
    } else {
        delete target.document.assetMetrics;
    }
    const issues = validateAssetMetricsDomain(target.document);
    if (issues.length) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Prepared environment asset metrics are invalid: ${issues[0].message}`);
    return target;
}

function buildCandidate(base, environmentId, sourceWorld, visual) {
    const target = structuredClone(base);
    target.environmentId = environmentId;
    target.document = { ...target.document, environmentId };
    target.evidence = null;
    const localWorld = createWorldResource(target);
    let descriptor = null;
    let access = null;
    if (visual?.descriptor) {
        descriptor = sourceWorld.hash === localWorld.hash
            ? structuredClone(visual.descriptor)
            : rebindVisualLayer(visual.descriptor, localWorld.hash, localWorld.description);
        const descriptorHash = hashVisualLayer(descriptor);
        access = sourceWorld.hash === localWorld.hash
            ? structuredClone(visual.access)
            : rebindVisualLayerAccess(visual.access, descriptorHash);
        target.visualLayer = {
            descriptorHash,
            accessHash: hashVisualLayerAccess(access),
        };
    } else {
        target.visualLayer = null;
    }
    const contentHash = marketplaceEnvironmentContentHash(target);
    return Object.freeze({ target, localWorld, descriptor, access, contentHash });
}

async function matchingPriorEnvironment({ receiptStore, storageService, release, context, verified, build, builtInIds }) {
    const prior = await receiptStore.findMappings({
        registryId: context.source.registryId,
        marketplaceSourceId: context.source.sourceId,
        itemId: release.itemId,
        artifactSha256: release.artifact.sha256,
        resourceKind: "environment",
    });
    for (const { mapping } of prior) {
        if (builtInIds.has(mapping.localId)) continue;
        if (mapping.sourceId !== verified.environment.environmentId
            || mapping.sourceRevision !== verified.environment.revision
            || mapping.hashes.sourceRecord !== verified.manifest.environment.recordSha256
            || mapping.hashes.sourceClosure !== verified.manifestSha256) continue;
        const current = await storageService.getEnvironment(mapping.localId);
        if (!current) continue;
        const candidate = build(mapping.localId);
        if (marketplaceEnvironmentContentHash(current) === candidate.contentHash
            && mapping.hashes.localContent === candidate.contentHash
            && mapping.hashes.localWorld === candidate.localWorld.hash) {
            return { environmentId: mapping.localId, current, candidate };
        }
    }
    return null;
}

async function allocateEnvironment({ storageService, sourceId, closureHash, build, builtInIds }) {
    const direct = build(sourceId);
    const directCurrent = await storageService.getEnvironment(sourceId);
    if (!builtInIds.has(sourceId)
        && (!directCurrent || marketplaceEnvironmentContentHash(directCurrent) === direct.contentHash)) {
        return { environmentId: sourceId, current: directCurrent, candidate: direct };
    }
    for (let length = INITIAL_SUFFIX_LENGTH; length <= FULL_DIGEST_LENGTH; length += 4) {
        const environmentId = `${sourceId}-mkt-${closureHash.slice(0, Math.min(length, FULL_DIGEST_LENGTH))}`;
        const candidate = build(environmentId);
        const current = await storageService.getEnvironment(environmentId);
        if (!builtInIds.has(environmentId)
            && (!current || marketplaceEnvironmentContentHash(current) === candidate.contentHash)) {
            return { environmentId, current, candidate };
        }
    }
    conflict(`Environment ID collision for ${sourceId} exhausted the source closure digest.`);
}

function environmentMapping({ verified, selected, localRevision }) {
    const sourceVisual = verified.manifest.visualLayer;
    return {
        resourceKind: "environment",
        sourceId: verified.environment.environmentId,
        sourceRevision: verified.environment.revision,
        localId: selected.environmentId,
        localRevision,
        hashes: {
            sourceRecord: verified.manifest.environment.recordSha256,
            sourceClosure: verified.manifestSha256,
            sourceWorld: verified.world.hash,
            localContent: selected.candidate.contentHash,
            localWorld: selected.candidate.localWorld.hash,
            ...(sourceVisual ? {
                sourceVisualDescriptor: sourceVisual.descriptorHash,
                sourceVisualAccess: sourceVisual.accessHash,
                localVisualDescriptor: hashVisualLayer(selected.candidate.descriptor),
                localVisualAccess: hashVisualLayerAccess(selected.candidate.access),
            } : {}),
        },
    };
}

export async function planEnvironmentPackageImport({
    verified,
    preparation,
    editorAssetStore,
    visualAssetStore,
    storageService,
    receiptStore,
    release,
    context,
}) {
    const assetPlan = await planAssetPackageImport({
        verified: verified.assets,
        editorAssetStore,
        visualAssetStore,
        receiptStore,
        release,
        context,
        preparationHash: preparation.preparationHash,
        preparation,
    });
    const preparedBySource = await preparedRevisionIndex(assetPlan, preparation.preparationDir);
    const base = rewriteEnvironmentAssets(verified.environment, assetPlan, preparedBySource);
    const build = (environmentId) => buildCandidate(base, environmentId, verified.world, verified.visual);
    const builtInIds = new Set((await storageService.listEnvironments())
        .filter((entry) => entry.builtIn)
        .map((entry) => entry.id));
    const prior = await matchingPriorEnvironment({ receiptStore, storageService, release, context, verified, build, builtInIds });
    const selected = prior ?? await allocateEnvironment({
        storageService,
        sourceId: verified.environment.environmentId,
        closureHash: verified.manifestSha256,
        build,
        builtInIds,
    });
    const expectedLocalRevision = selected.current?.revision ?? 0;
    const localRevision = selected.current?.revision ?? 1;
    const preparedDocument = {
        kind: "cev-sim.marketplace-prepared-environment",
        version: 1,
        source: {
            environmentId: verified.environment.environmentId,
            revision: verified.environment.revision,
            recordSha256: verified.manifest.environment.recordSha256,
            closureHash: verified.manifestSha256,
            worldHash: verified.world.hash,
        },
        target: {
            environmentId: selected.environmentId,
            expectedRevision: expectedLocalRevision,
            manifest: selected.candidate.target,
            contentHash: selected.candidate.contentHash,
            worldHash: selected.candidate.localWorld.hash,
        },
        visual: selected.candidate.descriptor ? {
            descriptor: selected.candidate.descriptor,
            descriptorHash: hashVisualLayer(selected.candidate.descriptor),
            access: selected.candidate.access,
            accessHash: hashVisualLayerAccess(selected.candidate.access),
        } : null,
    };
    const preparedBytes = Buffer.from(canonicalMarketplaceBytes(preparedDocument));
    const preparedEnvironmentHash = createHash("sha256").update(preparedBytes).digest("hex");
    await writePreparedFile(path.join(preparation.preparationDir, "generated", `${preparedEnvironmentHash}.json`), preparedBytes);

    const sourceIds = [...new Set([...verified.uses.values()].flatMap((entry) => entry.use.sourceIds))].sort(compareUtf8);
    const requiredOperations = [
        ...VISUAL_ASSET_UPLOAD_OPERATIONS,
        ...(assetPlan.rights.some((right) => right.right === "derivatives") ? ["derivatives"] : []),
    ];
    const rightsDecision = await visualAssetStore.evaluateSourceRights({ sourceIds, operations: requiredOperations });
    const rights = requiredOperations.flatMap((right) => sourceIds.map((sourceId) => ({
        id: `${sourceId}:${right}`,
        sourceId,
        right,
        allowed: !rightsDecision.denials.some((denial) => denial.sourceId === sourceId
            && (denial.operation === right || denial.operation === null)),
    })));

    const useOperations = verified.useOrder.map((useHash) => {
        const entry = verified.uses.get(useHash);
        const operation = {
            kind: "publish-visual-use",
            useHash,
            recordSha256: entry.descriptor.recordSha256,
            blobSha256: entry.use.asset.sha256,
        };
        return { ...operation, operationId: assetImportOperationId(operation) };
    });
    const revisionOperations = assetPlan.operations.filter((operation) => operation.kind === "publish-editor-asset-revision");
    const visualOperation = preparedDocument.visual ? (() => {
        const operation = {
            kind: "publish-environment-visual-layer",
            preparedEnvironmentHash,
            descriptorHash: preparedDocument.visual.descriptorHash,
            accessHash: preparedDocument.visual.accessHash,
        };
        return { ...operation, operationId: assetImportOperationId(operation) };
    })() : null;
    const publishOperation = {
        kind: "publish-environment",
        preparedEnvironmentHash,
        environmentId: selected.environmentId,
        expectedRevision: expectedLocalRevision,
        contentHash: selected.candidate.contentHash,
        worldHash: selected.candidate.localWorld.hash,
    };
    const mapping = environmentMapping({ verified, selected, localRevision });
    return {
        preparationHash: preparation.preparationHash,
        groups: assetPlan.groups,
        revisionMappings: assetPlan.revisionMappings,
        preparedRevisions: assetPlan.preparedRevisions,
        package: {
            archiveSha256: verified.archiveSha256,
            manifestSha256: verified.manifestSha256,
            environmentId: verified.environment.environmentId,
            sourceRevision: verified.environment.revision,
            assetCount: verified.manifest.assets.assets.length,
            revisionCount: verified.revisions.size,
            useCount: verified.uses.size,
            blobCount: new Set([...verified.manifest.assets.blobs, ...(verified.manifest.visualLayer?.blobs ?? [])].map((entry) => entry.sha256)).size,
        },
        environment: {
            sourceEnvironmentId: verified.environment.environmentId,
            sourceRevision: verified.environment.revision,
            sourceRecordHash: verified.manifest.environment.recordSha256,
            sourceClosureHash: verified.manifestSha256,
            sourceWorldHash: verified.world.hash,
            localEnvironmentId: selected.environmentId,
            expectedLocalRevision,
            preparedEnvironmentHash,
            localContentHash: selected.candidate.contentHash,
            localWorldHash: selected.candidate.localWorld.hash,
            sourceDescriptorHash: verified.manifest.visualLayer?.descriptorHash ?? null,
            sourceAccessHash: verified.manifest.visualLayer?.accessHash ?? null,
            localDescriptorHash: preparedDocument.visual?.descriptorHash ?? null,
            localAccessHash: preparedDocument.visual?.accessHash ?? null,
        },
        operations: [
            ...useOperations,
            ...revisionOperations,
            ...(visualOperation ? [visualOperation] : []),
            { ...publishOperation, operationId: assetImportOperationId(publishOperation) },
        ],
        rights,
        mappings: [...assetPlan.mappings, mapping],
        conflicts: [],
        warnings: [],
        blockingIssues: rightsDecision.allowed ? [] : rightsDecision.denials.map((denial) => (
            `Visual source ${denial.sourceId} denies ${denial.operation ?? "required operations"}.`
        )),
    };
}

export async function readPreparedEnvironment({ preparationDir, preparedEnvironmentHash }) {
    const filePath = path.join(preparationDir, "generated", `${preparedEnvironmentHash}.json`);
    const bytes = await fs.readFile(filePath);
    if (createHash("sha256").update(bytes).digest("hex") !== preparedEnvironmentHash) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared environment failed its content hash.");
    }
    const { document } = parseMarketplaceJsonBytes(bytes);
    if (!bytes.equals(Buffer.from(canonicalMarketplaceBytes(document)))
        || document.kind !== "cev-sim.marketplace-prepared-environment" || document.version !== 1) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared environment is not canonical.");
    }
    return document;
}
