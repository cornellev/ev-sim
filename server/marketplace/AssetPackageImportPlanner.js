import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";

import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { compileAssetDefinition } from "../../app/editor-assets/AssetCompiler.js";
import {
    hashEditorAssetRevisionContent,
    normalizeEditorAssetRevision,
} from "../../app/editor-assets/EditorAssetContract.js";
import {
    collectAssetRevisionReferences,
    rewriteAssetDefinitionReferences,
} from "../../app/editor-assets/AssetDefinition.js";
import {
    hashVisualAssetUse,
    VISUAL_ASSET_UPLOAD_OPERATIONS,
} from "../../app/simulation/visual/VisualLayer.js";
import {
    decodeAssetAppearanceGeometry,
    decodeAssetSourceGeometry,
} from "../storage/ServerAssetGeometryDecoder.js";
import {
    compiledAppearanceUse,
    compileAssetAppearance,
} from "../storage/ServerAssetAppearanceCompiler.js";
import { EDITOR_ASSET_ERROR_CODES } from "../storage/StorageErrors.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";
import {
    canonicalMarketplaceBytes,
    parseMarketplaceJsonBytes,
} from "./MarketplaceJson.js";

const FULL_DIGEST_LENGTH = 64;
const INITIAL_SUFFIX_LENGTH = 12;

function sha256(value) {
    return createHash("sha256").update(canonicalMarketplaceBytes(value)).digest("hex");
}

function revisionKey(assetId, revision) {
    return `${assetId}@${revision}`;
}

function visualUseRoots(revision) {
    const hashes = new Set([revision.modelUseHash]);
    if (revision.version === 2) {
        revision.definition.sources.forEach((source) => hashes.add(source.modelUseHash));
        revision.definition.materials.forEach((material) => material.textures.forEach((texture) => hashes.add(texture.useHash)));
        revision.appearance.forEach((material) => material.textures.forEach((texture) => hashes.add(texture.useHash)));
    }
    return [...hashes].sort(compareUtf8);
}

function groupClosure(verified, assetId) {
    const revisions = verified.manifest.assets.find((asset) => asset.assetId === assetId).revisions;
    const revisionKeys = new Set();
    const uses = new Set();
    const blobs = new Set();
    const visitRevision = (key) => {
        if (revisionKeys.has(key)) return;
        revisionKeys.add(key);
        const entry = verified.revisions.get(key);
        if (entry.revision.version === 2) {
            collectAssetRevisionReferences(entry.revision.definition)
                .forEach((child) => visitRevision(revisionKey(child.assetId, child.revision)));
        }
        visualUseRoots(entry.revision).forEach(visitUse);
    };
    const visitUse = (useHash) => {
        if (uses.has(useHash)) return;
        uses.add(useHash);
        const use = verified.uses.get(useHash).use;
        blobs.add(use.asset.sha256);
        Object.values(use.dependencies).sort(compareUtf8).forEach(visitUse);
    };
    revisions.forEach((revision) => visitRevision(revisionKey(assetId, revision.revision)));
    const edgeSet = new Set([
        ...verified.assetEdges.filter(([left, right]) => revisionKeys.has(left) && revisionKeys.has(right)).map((edge) => edge.join("\u0000")),
        ...verified.useEdges.filter(([left, right]) => uses.has(left) && uses.has(right)).map((edge) => edge.join("\u0000")),
    ]);
    return sha256({
        sourceAssetId: assetId,
        revisions: [...revisionKeys].sort(compareUtf8).map((key) => ({
            key,
            recordSha256: verified.revisions.get(key).descriptor.recordSha256,
        })),
        uses: [...uses].sort(compareUtf8),
        blobs: [...blobs].sort(compareUtf8),
        edges: [...edgeSet].sort(compareUtf8),
    });
}

async function assetExists(editorAssetStore, assetId) {
    try {
        return await editorAssetStore.get(assetId);
    } catch (error) {
        if (error.code === EDITOR_ASSET_ERROR_CODES.NOT_FOUND) return null;
        throw error;
    }
}

async function readAsset(editorAssetStore, assetId) {
    const result = await assetExists(editorAssetStore, assetId);
    return result?.asset ?? result;
}

async function intactPriorGroup(editorAssetStore, group, closureHash, priorMappings, context, release) {
    const revisions = group.revisions.map((entry) => entry.revision);
    const candidates = new Map();
    for (const item of priorMappings) {
        const mapping = item.mapping;
        if (mapping.sourceId !== group.assetId || !revisions.includes(mapping.sourceRevision)) continue;
        const values = candidates.get(mapping.localId) ?? new Map();
        values.set(mapping.sourceRevision, mapping);
        candidates.set(mapping.localId, values);
    }
    for (const [localId, values] of candidates) {
        if (values.size !== revisions.length) continue;
        let intact = true;
        for (let index = 0; index < group.revisions.length; index += 1) {
            const source = group.revisions[index];
            const mapping = values.get(source.revision);
            if (!mapping || mapping.localRevision !== index + 1
                || mapping.hashes.sourceRecord !== source.recordSha256
                || mapping.hashes.sourceClosure !== closureHash) { intact = false; break; }
            try {
                const local = await editorAssetStore.getRevision(localId, index + 1);
                const expectedPublicationId = publicationId({
                    context, release,
                    sourceAssetId: group.assetId,
                    sourceRevision: source.revision,
                    localAssetId: localId,
                    localRevision: index + 1,
                });
                const root = await editorAssetStore.visualAssets.getRoot(`editor-asset:${localId}:revision:${index + 1}`);
                if (local.publicationId !== expectedPublicationId || root?.useHash !== local.modelUseHash) { intact = false; break; }
                if (mapping.hashes.localContent && mapping.hashes.localContent !== hashEditorAssetRevisionContent(local)) { intact = false; break; }
            } catch { intact = false; break; }
        }
        if (intact) return localId;
    }
    return null;
}

async function contentIdenticalHistory(editorAssetStore, localAssetId, group, verified) {
    const asset = await readAsset(editorAssetStore, localAssetId);
    if (!asset || asset.latestRevision !== group.revisions.length) return false;
    for (let index = 0; index < group.revisions.length; index += 1) {
        const source = verified.revisions.get(revisionKey(group.assetId, group.revisions[index].revision)).revision;
        if (source.version !== 1) return false;
        const local = await editorAssetStore.getRevision(localAssetId, index + 1);
        if (hashEditorAssetRevisionContent(local) !== hashEditorAssetRevisionContent(source)) return false;
    }
    return true;
}

async function allocateLocalId(editorAssetStore, group, closureHash, verified, startLength = INITIAL_SUFFIX_LENGTH) {
    for (let length = startLength; length <= FULL_DIGEST_LENGTH; length += 4) {
        const localId = `${group.assetId}-mkt-${closureHash.slice(0, Math.min(length, FULL_DIGEST_LENGTH))}`;
        if (!await assetExists(editorAssetStore, localId)) return { localId, reusedContent: false };
        if (await contentIdenticalHistory(editorAssetStore, localId, group, verified)) {
            return { localId, reusedContent: true, occupied: true, suffixLength: length };
        }
        const asset = await readAsset(editorAssetStore, localId);
        if (asset?.latestRevision === group.revisions.length
            && group.revisions.some((entry) => verified.revisions.get(revisionKey(group.assetId, entry.revision)).revision.version === 2)) {
            return { localId, reusedContent: false, occupied: true, suffixLength: length };
        }
    }
    throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, `Asset ID collision for ${group.assetId} exhausted the source closure digest.`);
}

async function preparedHistoryIsIdentical(editorAssetStore, group, preparedBySource) {
    const asset = await readAsset(editorAssetStore, group.localAssetId);
    if (!asset || asset.latestRevision !== group.revisions.length) return false;
    for (const mapping of group.revisions) {
        const expected = preparedBySource.get(revisionKey(mapping.sourceAssetId, mapping.sourceRevision));
        const local = await editorAssetStore.getRevision(mapping.localAssetId, mapping.localRevision);
        const root = await editorAssetStore.visualAssets.getRoot(`editor-asset:${mapping.localAssetId}:revision:${mapping.localRevision}`);
        if (hashEditorAssetRevisionContent(local) !== expected.hashes.localContent || root?.useHash !== local.modelUseHash) return false;
    }
    return true;
}

function publicationId({ context, release, sourceAssetId, sourceRevision, localAssetId, localRevision }) {
    return `mkt-${sha256({
        kind: "cev-sim.marketplace-asset-publication",
        version: 1,
        registryId: context.source.registryId,
        marketplaceSourceId: context.source.sourceId,
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifact.sha256,
        sourceAssetId,
        sourceRevision,
        localAssetId,
        localRevision,
    })}`;
}

function operationId(operation) {
    return sha256({ kind: "cev-sim.marketplace-adapter-operation", version: 1, operation });
}

function childGeometry(decoded) {
    return Object.fromEntries(Object.entries(decoded.nodes).map(([nodeIndex, node]) => [nodeIndex, {
        matrix: node.matrix,
        vertices: node.primitives.flatMap((primitive) => primitive.attributes.POSITION.values),
        triangles: (() => {
            const triangles = [];
            let offset = 0;
            for (const primitive of node.primitives) {
                for (let index = 0; index < primitive.indices.length; index += 3) {
                    triangles.push(primitive.indices.slice(index, index + 3).map((vertex) => vertex + offset));
                }
                offset += primitive.attributes.POSITION.values.length;
            }
            return triangles;
        })(),
    }]));
}

async function writePreparedFile(filePath, bytes) {
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
        await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await fs.readFile(filePath);
        if (!existing.equals(bytes)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared asset revision changed for the same content hash.");
        }
    }
}

async function prepareRevisionOutputs({ verified, mappingsBySource, groups, preparation }) {
    const sourceUseRecords = new Map([...verified.uses].map(([useHash, entry]) => [useHash, entry.use]));
    const generatedUses = new Map();
    const generatedBlobs = new Map();
    const entryByName = new Map(preparation.index.entries.map((entry) => [entry.name, entry]));
    const visualAssets = {
        async getUse(useHash) {
            const use = generatedUses.get(useHash) ?? sourceUseRecords.get(useHash);
            if (!use) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Prepared visual-use ${useHash} is missing.`);
            return use;
        },
        async readPublishedBytes(sha256, { expectedSize } = {}) {
            const generated = generatedBlobs.get(sha256);
            if (generated) {
                if (expectedSize !== undefined && generated.length !== expectedSize) throw new TypeError("Prepared generated blob size changed.");
                return generated;
            }
            const entry = entryByName.get(`blobs/sha256/${sha256}`);
            if (!entry) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Prepared blob ${sha256} is missing.`);
            const bytes = await fs.readFile(path.join(preparation.preparationDir, entry.stagingName));
            if ((expectedSize !== undefined && bytes.length !== expectedSize)
                || createHash("sha256").update(bytes).digest("hex") !== sha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, `Prepared blob ${sha256} failed integrity verification.`);
            }
            return bytes;
        },
    };
    const preparedBySource = new Map();
    const summaries = [];
    for (const key of verified.assetOrder) {
        const source = verified.revisions.get(key).revision;
        const mapping = mappingsBySource.get(key);
        const group = groups.find((entry) => entry.sourceAssetId === source.assetId);
        let modelUseHash = source.modelUseHash;
        let definition;
        let metric;
        let metricHash;
        let geometryHash;
        let appearance;
        let submittedAppearance;
        let generated = null;
        let requiredSourceIds = [];
        if (source.version === 2) {
            definition = rewriteAssetDefinitionReferences(source.definition, mappingsBySource);
            const resolvedChildren = {};
            const childAppearance = {};
            for (const part of definition.parts.filter((entry) => entry.content.kind === "asset-reference")) {
                const localKey = `${part.content.assetId}@${part.content.revision}`;
                if (resolvedChildren[localKey]) continue;
                const child = [...preparedBySource.values()].find((entry) => (
                    entry.assetId === part.content.assetId && entry.revision === part.content.revision
                ));
                if (!child) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Prepared child ${localKey} is missing.`);
                const decoded = await decodeAssetAppearanceGeometry(child.modelUseHash, visualAssets);
                childAppearance[localKey] = decoded;
                resolvedChildren[localKey] = { ...child, geometry: childGeometry(decoded) };
            }
            const sourceGeometries = {};
            const sourceAppearance = {};
            for (const model of definition.sources) {
                sourceGeometries[model.id] = await decodeAssetSourceGeometry(model.modelUseHash, visualAssets);
                sourceAppearance[model.id] = await decodeAssetAppearanceGeometry(model.modelUseHash, visualAssets);
            }
            const compiled = compileAssetDefinition(definition, { sourceGeometries, resolvedChildren });
            if (compiled.staleProxyIds.length) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Prepared asset ${key} has stale generated proxies: ${compiled.staleProxyIds.join(", ")}.`);
            }
            if (!isDeepStrictEqual(compiled.metric, source.metric) || compiled.metricHash !== source.metricHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Asset import changed metric behavior for ${key}.`);
            }
            for (const material of definition.materials) for (const texture of material.textures) {
                const textureUse = await visualAssets.getUse(texture.useHash);
                if (`sha256:${textureUse.asset.sha256}` !== texture.assetUri) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Prepared texture ${texture.useHash} does not match ${texture.assetUri}.`);
                }
            }
            const emitted = compileAssetAppearance({
                assetId: mapping.localAssetId,
                revision: mapping.localRevision,
                compiled,
                sources: sourceAppearance,
                children: childAppearance,
            });
            if (emitted.geometryHash !== source.geometryHash) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Asset import changed geometry for ${key}.`);
            }
            for (const material of emitted.appearance) for (const texture of material.textures) {
                const textureUse = await visualAssets.getUse(texture.useHash);
                if (`sha256:${textureUse.asset.sha256}` !== texture.assetUri) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Generated texture ${texture.useHash} does not match ${texture.assetUri}.`);
                }
            }
            const provenanceUses = await Promise.all([...new Set([
                ...definition.sources.map((entry) => entry.modelUseHash),
                ...definition.materials.flatMap((material) => material.textures.map((texture) => texture.useHash)),
                ...emitted.appearance.flatMap((material) => material.textures.map((texture) => texture.useHash)),
                ...Object.values(resolvedChildren).map((child) => child.modelUseHash),
            ])].map((useHash) => visualAssets.getUse(useHash)));
            const emittedUse = compiledAppearanceUse(emitted.bytes, provenanceUses.flatMap((use) => use.sourceIds));
            if (hashVisualAssetUse(emittedUse.use) !== emittedUse.useHash) throw new TypeError("Prepared generated use hash changed.");
            generatedUses.set(emittedUse.useHash, emittedUse.use);
            generatedBlobs.set(emittedUse.asset.sha256, emitted.bytes);
            modelUseHash = emittedUse.useHash;
            metric = compiled.metric;
            metricHash = compiled.metricHash;
            geometryHash = emitted.geometryHash;
            appearance = emitted.appearance;
            submittedAppearance = compiled.materials;
            requiredSourceIds = [...new Set(provenanceUses.flatMap((use) => use.sourceIds))].sort(compareUtf8);
            generated = {
                useHash: emittedUse.useHash,
                use: emittedUse.use,
                blobSha256: emittedUse.asset.sha256,
                sizeBytes: emitted.bytes.length,
            };
            await writePreparedFile(path.join(preparation.preparationDir, "generated", `${emittedUse.asset.sha256}.blob`), emitted.bytes);
        } else {
            requiredSourceIds = [...sourceUseRecords.get(source.modelUseHash).sourceIds];
        }
        const localRevision = normalizeEditorAssetRevision({
            version: source.version,
            assetId: mapping.localAssetId,
            revision: mapping.localRevision,
            publicationId: mapping.publicationId,
            createdAt: source.createdAt,
            modelUseHash,
            ...(source.version === 2 ? {
                definition,
                metric,
                metricHash,
                geometryHash,
                appearance,
                publicationPayloadHash: source.publicationPayloadHash,
            } : {}),
        });
        const draft = {
            assetId: mapping.localAssetId,
            publicationId: mapping.publicationId,
            expectedAssetRevision: mapping.localRevision - 1,
            name: group.name,
            folderId: null,
            tags: group.tags,
            modelUseHash,
            ...(source.version === 2 ? {
                definition, metric, metricHash, geometryHash, appearance: submittedAppearance,
            } : {}),
        };
        const document = {
            kind: "cev-sim.marketplace-prepared-asset-revision",
            version: 1,
            sourceAssetId: mapping.sourceAssetId,
            sourceRevision: mapping.sourceRevision,
            localAssetId: mapping.localAssetId,
            localRevision: mapping.localRevision,
            draft,
            generated,
            requiredSourceIds,
            hashes: {
                localContent: hashEditorAssetRevisionContent(localRevision),
                modelUse: modelUseHash,
                ...(source.version === 2 ? { metric: metricHash, geometry: geometryHash } : {}),
            },
        };
        const bytes = Buffer.from(canonicalMarketplaceBytes(document));
        const preparedRevisionHash = createHash("sha256").update(bytes).digest("hex");
        await writePreparedFile(path.join(preparation.preparationDir, "generated", `${preparedRevisionHash}.json`), bytes);
        const prepared = { ...localRevision, preparedRevisionHash };
        preparedBySource.set(key, prepared);
        summaries.push({
            sourceAssetId: mapping.sourceAssetId,
            sourceRevision: mapping.sourceRevision,
            localAssetId: mapping.localAssetId,
            localRevision: mapping.localRevision,
            preparedRevisionHash,
            hashes: document.hashes,
        });
    }
    return summaries;
}

export async function readPreparedAssetRevision({ workDirectory, preparationHash, preparedRevisionHash }) {
    const filePath = path.join(workDirectory, "asset-packages", preparationHash, "generated", `${preparedRevisionHash}.json`);
    const bytes = await fs.readFile(filePath);
    if (createHash("sha256").update(bytes).digest("hex") !== preparedRevisionHash) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared asset revision failed its content hash.");
    }
    const { document } = parseMarketplaceJsonBytes(bytes);
    if (!Buffer.from(bytes).equals(Buffer.from(canonicalMarketplaceBytes(document)))
        || document.kind !== "cev-sim.marketplace-prepared-asset-revision" || document.version !== 1) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared asset revision is not canonical.");
    }
    return document;
}

export async function planAssetPackageImport({
    verified, editorAssetStore, visualAssetStore, receiptStore, release, context, preparationHash, preparation,
}) {
    const priorMappings = await receiptStore.findMappings({
        registryId: context.source.registryId,
        marketplaceSourceId: context.source.sourceId,
        itemId: release.itemId,
        artifactSha256: release.artifact.sha256,
        resourceKind: "editor-asset-revision",
    });
    const groupBases = [];
    for (const group of verified.manifest.assets) {
        const sourceClosureHash = groupClosure(verified, group.assetId);
        const priorId = await intactPriorGroup(editorAssetStore, group, sourceClosureHash, priorMappings, context, release);
        groupBases.push({ group, sourceClosureHash, priorId });
    }
    const suffixLengths = new Map(groupBases.map(({ group }) => [group.assetId, INITIAL_SUFFIX_LENGTH]));
    let mappingsBySource;
    let groups;
    let preparedRevisions;
    let preparedBySource;
    for (;;) {
        mappingsBySource = new Map();
        groups = [];
        const allocations = new Map();
        for (const { group, sourceClosureHash, priorId } of groupBases) {
            const allocated = priorId
                ? { localId: priorId, reusedContent: true, occupied: true }
                : await allocateLocalId(editorAssetStore, group, sourceClosureHash, verified, suffixLengths.get(group.assetId));
            allocations.set(group.assetId, allocated);
            const revisions = group.revisions.map((descriptor, index) => {
                const mapping = {
                    sourceAssetId: group.assetId,
                    sourceRevision: descriptor.revision,
                    sourceRecordSha256: descriptor.recordSha256,
                    sourceClosureHash,
                    localAssetId: allocated.localId,
                    localRevision: index + 1,
                };
                mapping.publicationId = publicationId({
                    context, release,
                    sourceAssetId: mapping.sourceAssetId,
                    sourceRevision: mapping.sourceRevision,
                    localAssetId: mapping.localAssetId,
                    localRevision: mapping.localRevision,
                });
                mappingsBySource.set(revisionKey(group.assetId, descriptor.revision), mapping);
                return mapping;
            });
            groups.push({
                sourceAssetId: group.assetId,
                localAssetId: allocated.localId,
                sourceClosureHash,
                name: group.name,
                tags: group.tags,
                reused: Boolean(priorId) || allocated.reusedContent,
                revisions,
            });
        }
        preparedRevisions = await prepareRevisionOutputs({ verified, mappingsBySource, groups, preparation });
        preparedBySource = new Map(preparedRevisions.map((entry) => [revisionKey(entry.sourceAssetId, entry.sourceRevision), entry]));
        let retry = false;
        for (const group of groups) {
            const allocated = allocations.get(group.sourceAssetId);
            if (!allocated.occupied || allocated.reusedContent || groupBases.find((entry) => entry.group.assetId === group.sourceAssetId).priorId) continue;
            if (await preparedHistoryIsIdentical(editorAssetStore, group, preparedBySource)) {
                group.reused = true;
                continue;
            }
            const nextLength = allocated.suffixLength + 4;
            if (nextLength > FULL_DIGEST_LENGTH) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, `Full source closure hash collision for ${group.sourceAssetId}.`);
            }
            suffixLengths.set(group.sourceAssetId, nextLength);
            retry = true;
        }
        if (!retry) break;
    }
    const sourceIds = [...new Set([...verified.uses.values()].flatMap((entry) => entry.use.sourceIds))].sort(compareUtf8);
    const operations = [...VISUAL_ASSET_UPLOAD_OPERATIONS, ...(preparedRevisions.some((entry) => entry.hashes.metric) ? ["derivatives"] : [])];
    const rightsDecision = await visualAssetStore.evaluateSourceRights({ sourceIds, operations });
    const adapterOperations = [];
    for (const useHash of verified.useOrder) {
        const entry = verified.uses.get(useHash);
        const operation = {
            kind: "publish-visual-use",
            useHash,
            recordSha256: entry.descriptor.recordSha256,
            blobSha256: entry.use.asset.sha256,
        };
        adapterOperations.push({ ...operation, operationId: operationId(operation) });
    }
    for (const key of verified.assetOrder) {
        const source = verified.revisions.get(key);
        const mapping = mappingsBySource.get(key);
        const preparedRevision = preparedBySource.get(key);
        const operation = {
            kind: "publish-editor-asset-revision",
            sourceAssetId: mapping.sourceAssetId,
            sourceRevision: mapping.sourceRevision,
            sourceRecordSha256: source.descriptor.recordSha256,
            localAssetId: mapping.localAssetId,
            localRevision: mapping.localRevision,
            publicationId: mapping.publicationId,
            preparedRevisionHash: preparedRevision.preparedRevisionHash,
            localContentHash: preparedRevision.hashes.localContent,
        };
        adapterOperations.push({ ...operation, operationId: operationId(operation) });
    }
    return {
        preparationHash,
        groups,
        revisionMappings: [...mappingsBySource.values()],
        operations: adapterOperations,
        rights: operations.flatMap((right) => sourceIds.map((sourceId) => ({
            id: `${sourceId}:${right}`,
            sourceId,
            right,
            allowed: !rightsDecision.denials.some((denial) => denial.sourceId === sourceId
                && (denial.operation === right || denial.operation === null)),
        }))),
        conflicts: [],
        preparedRevisions,
        mappings: [...mappingsBySource.values()].map((mapping) => ({
            resourceKind: "editor-asset-revision",
            sourceId: mapping.sourceAssetId,
            sourceRevision: mapping.sourceRevision,
            localId: mapping.localAssetId,
            localRevision: mapping.localRevision,
            hashes: {
                sourceRecord: mapping.sourceRecordSha256,
                sourceClosure: mapping.sourceClosureHash,
                localContent: preparedBySource.get(revisionKey(mapping.sourceAssetId, mapping.sourceRevision)).hashes.localContent,
                modelUse: preparedBySource.get(revisionKey(mapping.sourceAssetId, mapping.sourceRevision)).hashes.modelUse,
                ...(preparedBySource.get(revisionKey(mapping.sourceAssetId, mapping.sourceRevision)).hashes.metric ? {
                    metric: preparedBySource.get(revisionKey(mapping.sourceAssetId, mapping.sourceRevision)).hashes.metric,
                    geometry: preparedBySource.get(revisionKey(mapping.sourceAssetId, mapping.sourceRevision)).hashes.geometry,
                } : {}),
            },
        })),
        warnings: [],
        blockingIssues: rightsDecision.allowed ? [] : rightsDecision.denials.map((denial) => (
            `Visual source ${denial.sourceId} denies ${denial.operation ?? "required operations"}.`
        )),
    };
}

export function revisionMappingIndex(adapterPlan) {
    return new Map(adapterPlan.revisionMappings.map((mapping) => [
        revisionKey(mapping.sourceAssetId, mapping.sourceRevision), mapping,
    ]));
}
