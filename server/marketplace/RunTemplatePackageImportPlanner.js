import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { getGraphScriptReferences } from "../../app/scripting/GraphDocument.js";
import { normalizeScriptDocument } from "../../app/scripting/EditorDocument.js";
import { normalizeScenario, stripScenarioMetadata } from "../../app/scenarios/ScenarioDocument.js";
import { validateRouteVerification, verifyCanonicalRoute } from "../../app/scenarios/route/Route.js";
import { computeResolvedRunHash, normalizeRunManifest } from "../../app/simulation/RunManifest.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import { planEnvironmentPackageImport, readPreparedEnvironment } from "./EnvironmentPackageImportPlanner.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "./MarketplaceJson.js";

const INITIAL_SUFFIX_LENGTH = 12;
const FULL_DIGEST_LENGTH = 64;

function conflict(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function operationId(operation) {
    const value = structuredClone(operation);
    delete value.operationId;
    return createHash("sha256").update(canonicalMarketplaceBytes(value)).digest("hex");
}

async function writePrepared(preparationDir, kind, document) {
    const bytes = Buffer.from(canonicalMarketplaceBytes(document));
    const preparedHash = createHash("sha256").update(bytes).digest("hex");
    const filePath = path.join(preparationDir, "generated", `run-template-${kind}-${preparedHash}.json`);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
        await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const current = await fs.readFile(filePath);
        if (!current.equals(bytes)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template record changed for the same digest.");
    }
    return preparedHash;
}

export async function readPreparedRunTemplateImportRecord({ preparationDir, kind, preparedHash }) {
    if (!/^[a-f0-9]{64}$/u.test(String(preparedHash))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template record hash is invalid.");
    }
    const bytes = await fs.readFile(path.join(preparationDir, "generated", `run-template-${kind}-${preparedHash}.json`));
    if (createHash("sha256").update(bytes).digest("hex") !== preparedHash) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template record failed its content hash.");
    }
    const { document } = parseMarketplaceJsonBytes(bytes);
    if (!bytes.equals(Buffer.from(canonicalMarketplaceBytes(document)))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared run-template record is not canonical.");
    }
    return document;
}

async function priorMapping({ receiptStore, release, context, resourceKind, sourceId, sourceRevision, sourceRecord }) {
    const found = await receiptStore.findMappings({
        registryId: context.source.registryId,
        marketplaceSourceId: context.source.sourceId,
        itemId: release.itemId,
        artifactSha256: release.artifact.sha256,
        resourceKind,
    });
    return found.map((entry) => entry.mapping).filter((mapping) => (
        mapping.sourceId === sourceId
        && (sourceRevision === undefined || mapping.sourceRevision === sourceRevision)
        && mapping.hashes.sourceRecord === sourceRecord
    ));
}

async function allocateId({
    sourceId, closureHash, reserved = new Set(), getCurrent, build, contentHash,
    receiptStore, release, context, resourceKind, sourceRevision, sourceRecord,
    identical = (current, candidate) => contentHash(current) === contentHash(candidate),
    free = async () => true,
}) {
    for (const mapping of await priorMapping({
        receiptStore, release, context, resourceKind, sourceId, sourceRevision, sourceRecord,
    })) {
        if (reserved.has(mapping.localId)) continue;
        const current = await getCurrent(mapping.localId);
        const candidate = build(mapping.localId);
        if (current && await identical(current, candidate, mapping.localId)
            && mapping.hashes.localContent === contentHash(candidate)) {
            return { localId: mapping.localId, current, candidate, reused: true };
        }
    }
    const direct = build(sourceId);
    const current = await getCurrent(sourceId);
    if (!reserved.has(sourceId) && (current
        ? await identical(current, direct, sourceId)
        : await free(sourceId))) {
        return { localId: sourceId, current, candidate: direct, reused: Boolean(current) };
    }
    for (let length = INITIAL_SUFFIX_LENGTH; length <= FULL_DIGEST_LENGTH; length += 4) {
        const localId = `${sourceId}-mkt-${closureHash.slice(0, length)}`;
        const candidate = build(localId);
        const existing = await getCurrent(localId);
        if (!reserved.has(localId) && (existing
            ? await identical(existing, candidate, localId)
            : await free(localId))) {
            return { localId, current: existing, candidate, reused: Boolean(existing) };
        }
    }
    conflict(`${resourceKind} ID collision for ${sourceId} exhausted the package digest.`);
}

function rewriteGraphScriptIds(graph, scriptIds) {
    const rewritten = structuredClone(graph);
    rewritten.nodes = (rewritten.nodes ?? []).map((node) => {
        if (!node?.state || typeof node.state.sourceScriptId !== "string") return node;
        return {
            ...node,
            state: {
                ...node.state,
                sourceScriptId: scriptIds.get(node.state.sourceScriptId) ?? node.state.sourceScriptId,
            },
        };
    });
    return rewritten;
}

function rewriteParameterScriptIds(parameters, scriptIds) {
    return (parameters ?? []).map((parameter) => parameter.target?.kind === "script-input"
        ? { ...parameter, target: { ...parameter.target, scriptId: scriptIds.get(parameter.target.scriptId) ?? parameter.target.scriptId } }
        : parameter);
}

function rewriteScenarioScripts(source, scriptIds) {
    const scenario = structuredClone(source);
    for (const route of scenario.routes ?? []) {
        if (route.controller?.scriptId) route.controller.scriptId = scriptIds.get(route.controller.scriptId) ?? route.controller.scriptId;
    }
    for (const trigger of scenario.triggers ?? []) {
        for (const action of trigger.actions ?? []) {
            if (action.scriptId) action.scriptId = scriptIds.get(action.scriptId) ?? action.scriptId;
        }
    }
    for (const completion of scenario.completion?.conditions ?? []) {
        if (completion.scriptId) completion.scriptId = scriptIds.get(completion.scriptId) ?? completion.scriptId;
    }
    for (const outcome of scenario.expectedOutcomes ?? []) {
        if (outcome.scriptId) outcome.scriptId = scriptIds.get(outcome.scriptId) ?? outcome.scriptId;
    }
    scenario.parameters = rewriteParameterScriptIds(scenario.parameters, scriptIds);
    return scenario;
}

function scriptTopologicalOrder(scripts) {
    const order = [];
    const state = new Map();
    const visit = (id) => {
        if (state.get(id) === "visited") return;
        if (state.get(id) === "visiting") throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Script cycle at ${id}.`);
        state.set(id, "visiting");
        for (const child of getGraphScriptReferences(scripts.get(id).graph).sort(compareUtf8)) visit(child);
        state.set(id, "visited");
        order.push(id);
    };
    for (const id of [...scripts.keys()].sort(compareUtf8)) visit(id);
    return order;
}

function mapping({ resourceKind, descriptor, selected, sourceRevision }) {
    return {
        resourceKind,
        sourceId: descriptor[`${resourceKind === "visual-script" ? "script" : resourceKind === "run-manifest" ? "manifest" : resourceKind}Id`],
        ...(sourceRevision === undefined ? {} : { sourceRevision }),
        localId: selected.localId,
        ...(sourceRevision === undefined ? {} : { localRevision: selected.current?.revision ?? 1 }),
        hashes: {
            sourceRecord: descriptor.recordSha256,
            localContent: computeResolvedRunHash(selected.candidate),
        },
    };
}

export async function planRunTemplatePackageImport({
    verified, preparation, storageService, editorAssetStore, visualAssetStore,
    receiptStore, release, context,
}) {
    const closureHash = verified.manifestSha256;
    let environmentPlan = null;
    let localEnvironmentId = verified.root.environment.id;
    let localEnvironmentHash = verified.root.environment.expectedHash;
    let localRoutingEnvironment = null;
    if (verified.environmentVerified) {
        environmentPlan = await planEnvironmentPackageImport({
            verified: verified.environmentVerified,
            preparation,
            storageService,
            editorAssetStore,
            visualAssetStore,
            receiptStore,
            release,
            context,
        });
        localEnvironmentId = environmentPlan.environment.localEnvironmentId;
        const preparedEnvironment = await readPreparedEnvironment({
            preparationDir: preparation.preparationDir,
            preparedEnvironmentHash: environmentPlan.environment.preparedEnvironmentHash,
        });
        localEnvironmentHash = computeResolvedRunHash(preparedEnvironment.target.manifest);
        localRoutingEnvironment = createWorldResource(preparedEnvironment.target.manifest).description;
    } else {
        const builtIn = await storageService.getEnvironment(localEnvironmentId);
        if (!builtIn) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Built-in environment ${localEnvironmentId} is unavailable.`);
        localEnvironmentHash = computeResolvedRunHash(builtIn);
        localRoutingEnvironment = createWorldResource(builtIn).description;
    }

    const scriptIds = new Map();
    const scriptPlans = [];
    for (const sourceId of scriptTopologicalOrder(verified.scripts)) {
        const descriptor = verified.manifest.scripts.find((entry) => entry.scriptId === sourceId);
        const source = verified.scripts.get(sourceId);
        const build = (localId) => normalizeScriptDocument({
            ...source,
            id: localId,
            folderId: null,
            graph: rewriteGraphScriptIds(source.graph, scriptIds),
        });
        const selected = await allocateId({
            sourceId, closureHash, getCurrent: (id) => storageService.getScript(id), build,
            contentHash: computeResolvedRunHash, receiptStore, release, context,
            resourceKind: "visual-script", sourceRecord: descriptor.recordSha256,
        });
        scriptIds.set(sourceId, selected.localId);
        const preparedHash = await writePrepared(preparation.preparationDir, "script", selected.candidate);
        const operation = {
            kind: "publish-script",
            sourceScriptId: sourceId,
            scriptId: selected.localId,
            expectedContentHash: selected.current ? computeResolvedRunHash(selected.current) : null,
            contentHash: computeResolvedRunHash(selected.candidate),
            preparedHash,
        };
        scriptPlans.push({ descriptor, selected, operation: { ...operation, operationId: operationId(operation) } });
    }

    const vehicleIds = new Map();
    const vehiclePlans = [];
    const builtInVehicleIds = new Set(verified.manifest.builtIns.filter((entry) => entry.resourceKind === "vehicle").map((entry) => entry.resourceId));
    for (const descriptor of verified.manifest.vehicles) {
        const sourceId = descriptor.vehicleId;
        const source = verified.vehicles.get(sourceId);
        const build = (localId) => ({ ...structuredClone(source), id: localId });
        const vehicleContentHash = (value) => value?.definitionHash ?? computeResolvedRunHash(value);
        const assetsMatch = async (localId) => {
            const names = (await storageService.listVehicleAssets(localId)).sort(compareUtf8);
            if (JSON.stringify(names) !== JSON.stringify(descriptor.assets.map((asset) => asset.name))) return false;
            for (const asset of descriptor.assets) {
                let bytes;
                try {
                    bytes = await storageService.readVehicleAsset(localId, asset.name);
                } catch (error) {
                    if (error.code === "ENOENT") return false;
                    throw error;
                }
                if (bytes.length !== asset.sizeBytes
                    || createHash("sha256").update(bytes).digest("hex") !== asset.sha256) return false;
            }
            return true;
        };
        const selected = await allocateId({
            sourceId, closureHash, reserved: builtInVehicleIds,
            getCurrent: (id) => storageService.getVehicleManifest(id), build,
            contentHash: vehicleContentHash, receiptStore, release, context,
            resourceKind: "vehicle", sourceRevision: descriptor.revision, sourceRecord: descriptor.recordSha256,
            identical: async (current, candidate, localId) => (
                vehicleContentHash(current) === vehicleContentHash(candidate)
                && await assetsMatch(localId)
            ),
            free: async (localId) => (await storageService.listVehicleAssets(localId)).length === 0,
        });
        vehicleIds.set(sourceId, selected.localId);
        const preparedHash = await writePrepared(preparation.preparationDir, "vehicle", selected.candidate);
        const assetOperations = descriptor.assets.map((asset) => {
            const operation = {
                kind: "publish-vehicle-asset",
                vehicleId: selected.localId,
                fileName: asset.name,
                sha256: asset.sha256,
                sizeBytes: asset.sizeBytes,
                expectedVehicleRevision: selected.current?.revision ?? 0,
                expectedVehicleContentHash: selected.current ? vehicleContentHash(selected.current) : null,
                publishedVehicleContentHash: vehicleContentHash(selected.candidate),
            };
            return { ...operation, operationId: operationId(operation) };
        });
        const operation = {
            kind: "publish-vehicle",
            sourceVehicleId: sourceId,
            vehicleId: selected.localId,
            expectedRevision: selected.current?.revision ?? 0,
            contentHash: computeResolvedRunHash(selected.candidate),
            preparedHash,
        };
        vehiclePlans.push({ descriptor, selected, assetOperations, operation: { ...operation, operationId: operationId(operation) } });
    }
    for (const id of builtInVehicleIds) vehicleIds.set(id, id);

    const scenarioIds = new Map();
    const scenarioPlans = [];
    for (const descriptor of verified.manifest.scenarios) {
        const sourceId = descriptor.scenarioId;
        const source = verified.scenarios.get(sourceId);
        const build = (localId) => {
            const rewritten = rewriteScenarioScripts(source, scriptIds);
            rewritten.id = localId;
            rewritten.folderId = null;
            rewritten.environment = { ...rewritten.environment, id: localEnvironmentId, expectedHash: localEnvironmentHash };
            rewritten.actors = (rewritten.actors ?? []).map((actor) => ({
                ...actor,
                vehicleId: vehicleIds.get(actor.vehicleId) ?? actor.vehicleId,
            }));
            rewritten.routes = (rewritten.routes ?? []).map((route) => {
                if (validateRouteVerification(route, localRoutingEnvironment).ok) return route;
                const result = verifyCanonicalRoute(route, localRoutingEnvironment);
                if (!result.ok) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Route ${route.id} cannot be regenerated for the imported environment: ${result.error ?? result.issues?.[0]?.message ?? "verification failed"}.`);
                }
                return result.route;
            });
            return normalizeScenario(rewritten);
        };
        const selected = await allocateId({
            sourceId, closureHash, getCurrent: (id) => storageService.getScenario(id), build,
            contentHash: (value) => computeResolvedRunHash(stripScenarioMetadata(value)),
            receiptStore, release, context, resourceKind: "scenario",
            sourceRevision: descriptor.revision, sourceRecord: descriptor.recordSha256,
        });
        scenarioIds.set(sourceId, selected.localId);
        const preparedHash = await writePrepared(preparation.preparationDir, "scenario", selected.candidate);
        const operation = {
            kind: "publish-scenario",
            sourceScenarioId: sourceId,
            scenarioId: selected.localId,
            expectedRevision: selected.current?.revision ?? 0,
            contentHash: computeResolvedRunHash(stripScenarioMetadata(selected.candidate)),
            preparedHash,
        };
        scenarioPlans.push({ descriptor, selected, operation: { ...operation, operationId: operationId(operation) } });
    }

    const rootDescriptor = verified.manifest.root;
    const buildRun = (localId) => {
        const source = structuredClone(verified.root);
        source.id = localId;
        source.environment = { ...source.environment, id: localEnvironmentId, expectedHash: localEnvironmentHash };
        source.scenario = source.scenario ? {
            ...source.scenario,
            id: scenarioIds.get(source.scenario.id) ?? source.scenario.id,
            egoVehicleId: vehicleIds.get(source.scenario.egoVehicleId) ?? source.scenario.egoVehicleId,
        } : null;
        if (source.scenario) {
            const planned = scenarioPlans.find((entry) => entry.descriptor.scenarioId === verified.root.scenario.id);
            if (planned) source.scenario.expectedHash = computeResolvedRunHash(stripScenarioMetadata(planned.selected.candidate));
        }
        source.initialState.vehicles = source.initialState.vehicles.map((entry) => ({
            ...entry,
            type: vehicleIds.get(entry.type) ?? entry.type,
        }));
        source.scripts.artifacts = source.scripts.artifacts.map((entry) => {
            const descriptor = verified.manifest.scripts.find((candidate) => candidate.scriptId === entry.scriptId);
            return {
                ...entry,
                scriptId: scriptIds.get(entry.scriptId) ?? entry.scriptId,
                expectedHash: descriptor?.artifactHash ?? entry.expectedHash,
            };
        });
        source.scripts.bindingSource = "embedded";
        source.scripts.bindingIds = [];
        source.scripts.embeddedBindings = verified.bindings.bindings.map((binding) => ({
            ...binding,
            scriptId: scriptIds.get(binding.scriptId) ?? binding.scriptId,
        })).sort((left, right) => compareUtf8(left.id, right.id));
        source.scripts.expectedBindingsHash = computeResolvedRunHash(source.scripts.embeddedBindings);
        source.parameters = rewriteParameterScriptIds(source.parameters, scriptIds);
        return normalizeRunManifest(source);
    };
    const runSelected = await allocateId({
        sourceId: rootDescriptor.manifestId,
        closureHash,
        reserved: new Set(["igvc-default"]),
        getCurrent: (id) => storageService.getRunManifest(id),
        build: buildRun,
        contentHash: (value) => computeResolvedRunHash(normalizeRunManifest(value)),
        receiptStore,
        release,
        context,
        resourceKind: "run-manifest",
        sourceRevision: rootDescriptor.revision,
        sourceRecord: rootDescriptor.recordSha256,
    });
    const runPreparedHash = await writePrepared(preparation.preparationDir, "run-manifest", runSelected.candidate);
    const runOperation = {
        kind: "publish-run-manifest",
        sourceManifestId: rootDescriptor.manifestId,
        manifestId: runSelected.localId,
        expectedRevision: runSelected.current?.revision ?? 0,
        contentHash: computeResolvedRunHash(runSelected.candidate),
        preparedHash: runPreparedHash,
    };

    const pluginOperations = verified.manifest.plugins.map((plugin) => {
        const operation = {
            kind: "publish-run-template-plugin-package",
            pluginId: plugin.pluginId,
            packageHash: plugin.packageHash,
            recordSha256: plugin.recordSha256,
        };
        return { ...operation, operationId: operationId(operation) };
    });
    const mappings = [
        ...verified.manifest.plugins.map((plugin) => ({
            resourceKind: "run-template-plugin-package",
            sourceId: plugin.pluginId,
            localId: plugin.packageHash,
            hashes: { sourceRecord: plugin.recordSha256, localContent: plugin.packageHash },
        })),
        ...(environmentPlan?.mappings ?? []),
        ...vehiclePlans.map((entry) => mapping({ resourceKind: "vehicle", descriptor: entry.descriptor, selected: entry.selected, sourceRevision: entry.descriptor.revision })),
        ...scriptPlans.map((entry) => mapping({ resourceKind: "visual-script", descriptor: entry.descriptor, selected: entry.selected })),
        ...scenarioPlans.map((entry) => mapping({ resourceKind: "scenario", descriptor: entry.descriptor, selected: entry.selected, sourceRevision: entry.descriptor.revision })),
        {
            resourceKind: "script-binding",
            sourceId: rootDescriptor.manifestId,
            sourceRevision: rootDescriptor.revision,
            localId: runSelected.localId,
            localRevision: runSelected.current?.revision ?? 1,
            hashes: { sourceRecord: verified.manifest.bindings.recordSha256, localContent: computeResolvedRunHash(runSelected.candidate.scripts.embeddedBindings) },
        },
        mapping({ resourceKind: "run-manifest", descriptor: rootDescriptor, selected: runSelected, sourceRevision: rootDescriptor.revision }),
    ];
    return {
        preparationHash: preparation.preparationHash,
        package: {
            archiveSha256: verified.archiveSha256,
            manifestSha256: verified.manifestSha256,
            manifestId: rootDescriptor.manifestId,
        },
        environment: environmentPlan,
        destination: {
            manifestId: runSelected.localId,
            bindingCount: runSelected.candidate.scripts.embeddedBindings.length,
            reusedRecords: [
                ...vehiclePlans,
                ...scriptPlans,
                ...scenarioPlans,
                { selected: runSelected },
            ].filter((entry) => Boolean(entry.selected.current)).length,
            newRecords: [
                ...vehiclePlans,
                ...scriptPlans,
                ...scenarioPlans,
                { selected: runSelected },
            ].filter((entry) => !entry.selected.current).length,
        },
        operations: [
            ...pluginOperations,
            ...(environmentPlan?.operations ?? []),
            ...vehiclePlans.flatMap((entry) => [...entry.assetOperations, entry.operation]),
            ...scriptPlans.map((entry) => entry.operation),
            ...scenarioPlans.map((entry) => entry.operation),
            { ...runOperation, operationId: operationId(runOperation) },
        ],
        rights: environmentPlan?.rights ?? [],
        conflicts: [],
        mappings,
        warnings: [],
        blockingIssues: environmentPlan?.blockingIssues ?? [],
    };
}
