import { createHash } from "node:crypto";

import { collectScenarioScriptIds, normalizeScenario, stripScenarioMetadata } from "../../app/scenarios/ScenarioDocument.js";
import { getGraphScriptReferences } from "../../app/scripting/GraphDocument.js";
import { isCompiledArtifact, normalizeScriptDocument } from "../../app/scripting/EditorDocument.js";
import { BINDING_SCOPES, createBindingManifest, normalizeBinding } from "../../app/scripting/bindings/BindingDocument.js";
import { collectArtifactPluginRequirements } from "../../app/plugin/PluginRequirements.js";
import { normalizeGraphPluginLocks } from "../../app/plugin/PluginGraphLocks.js";
import { effectivePluginLocks } from "../../app/plugin/PluginSelection.js";
import { normalizeVehiclePluginLocks } from "../../app/plugin/PluginSensorAuthoring.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { computeResolvedRunHash, normalizeRunManifest } from "../../app/simulation/RunManifest.js";
import { getBuiltInVehicleManifest } from "../../app/vehicles/BuiltInVehicleManifests.js";
import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { collectEnvironmentPackageClosure } from "./EnvironmentPackage.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes } from "./MarketplaceJson.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";

const MAX_GRAPH_DEPTH = 64;

function invalid(message, path = null) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message, { path });
}

function conflict(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function record(value) {
    const bytes = Buffer.from(canonicalMarketplaceBytes(value));
    return Object.freeze({ bytes, sha256: hashMarketplaceBytes(bytes) });
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function mergeRecords(records) {
    const byHash = new Map();
    for (const entry of records) {
        const current = byHash.get(entry.sha256);
        if (current && !current.bytes.equals(entry.bytes)) invalid(`Record digest collision at ${entry.sha256}.`);
        byHash.set(entry.sha256, entry);
    }
    return [...byHash.values()].sort((left, right) => compareUtf8(left.sha256, right.sha256));
}

function mergeBlobs(blobs) {
    const byHash = new Map();
    for (const entry of blobs) {
        const current = byHash.get(entry.sha256);
        if (current && current.sizeBytes !== entry.sizeBytes) invalid(`Blob ${entry.sha256} has conflicting sizes.`);
        byHash.set(entry.sha256, entry);
    }
    return [...byHash.values()].sort((left, right) => compareUtf8(left.sha256, right.sha256));
}

function exactPluginReleaseRefs(refs = []) {
    const byPackageHash = new Map();
    for (const entry of refs) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalid("Plugin release references must be objects.");
        const packageHash = String(entry.packageHash ?? "");
        const itemId = String(entry.itemId ?? "");
        const releaseVersion = String(entry.releaseVersion ?? "");
        const artifactSha256 = String(entry.artifactSha256 ?? "");
        if (!/^[a-f0-9]{64}$/u.test(packageHash) || !/^[a-f0-9]{64}$/u.test(artifactSha256)
            || !itemId || !releaseVersion) invalid("Plugin release reference identity is invalid.");
        if (byPackageHash.has(packageHash)) invalid(`Duplicate plugin release reference for ${packageHash}.`);
        byPackageHash.set(packageHash, { itemId, releaseVersion, artifactSha256 });
    }
    return byPackageHash;
}

function referencedVehicleIds(manifest, scenario) {
    const ids = new Set(manifest.initialState.vehicles.map((entry) => entry.type).filter(Boolean));
    if (manifest.scenario?.egoVehicleId) ids.add(manifest.scenario.egoVehicleId);
    for (const actor of scenario?.actors ?? []) if (actor.vehicleId) ids.add(actor.vehicleId);
    return [...ids].sort(compareUtf8);
}

function directScriptIds(manifest, scenario, bindings) {
    const ids = new Set(manifest.scripts.artifacts.map((entry) => entry.scriptId));
    for (const id of collectScenarioScriptIds(scenario)) ids.add(id);
    for (const binding of bindings) if (binding.scriptId) ids.add(binding.scriptId);
    for (const parameter of manifest.parameters ?? []) {
        if (parameter.target?.kind === "script-input" && parameter.target.scriptId) ids.add(parameter.target.scriptId);
    }
    return [...ids].sort(compareUtf8);
}

async function effectiveBindings(storageService, manifest) {
    if (manifest.scripts.bindingSource === "embedded" || manifest.scripts.embeddedBindings.length > 0) {
        return manifest.scripts.embeddedBindings.map((entry) => normalizeBinding(entry));
    }
    const stored = await storageService.getBindings();
    const explicit = new Set(manifest.scripts.bindingIds);
    return (stored?.bindings ?? [])
        .filter((entry) => entry.scope === BINDING_SCOPES.GLOBAL || explicit.has(entry.id))
        .map((entry) => normalizeBinding(entry));
}

async function collectScripts(storageService, roots) {
    const documents = new Map();
    const visiting = new Set();
    const order = [];
    const visit = async (scriptId, depth = 1) => {
        if (depth > MAX_GRAPH_DEPTH) invalid("Run-template script graph exceeds the depth limit.", `scripts.${scriptId}`);
        if (visiting.has(scriptId)) invalid(`Run-template script graph contains a cycle at "${scriptId}".`, `scripts.${scriptId}`);
        if (documents.has(scriptId)) return;
        const stored = await storageService.getScript(scriptId);
        if (!stored) invalid(`Script "${scriptId}" does not exist.`, `scripts.${scriptId}`);
        const document = normalizeScriptDocument(stored);
        if (document.sourceType !== "editable" || document.editable === false || !document.graph) {
            invalid(`Script "${scriptId}" has no editable source graph.`, `scripts.${scriptId}.graph`);
        }
        if (!document.compileStatus?.valid || !isCompiledArtifact(document.latestValidArtifact)) {
            invalid(`Script "${scriptId}" has no current valid compiled artifact.`, `scripts.${scriptId}.latestValidArtifact`);
        }
        visiting.add(scriptId);
        const references = [...new Set(getGraphScriptReferences(document.graph))].sort(compareUtf8);
        for (const reference of references) await visit(reference, depth + 1);
        visiting.delete(scriptId);
        documents.set(scriptId, { document, references });
        order.push(scriptId);
    };
    for (const scriptId of roots) await visit(scriptId);
    return { documents, order };
}

function addPluginLock(locks, lock, path) {
    const current = locks.get(lock.pluginId);
    const packageHash = lock.packageHash ?? lock.expectedHash ?? current?.packageHash ?? null;
    if (!packageHash) invalid(`Plugin requirement "${lock.pluginId}" has no exact package hash.`, path);
    const next = {
        pluginId: lock.pluginId,
        packageHash,
        version: lock.version ?? current?.version ?? null,
        runtimeHash: lock.runtimeHash ?? current?.runtimeHash ?? null,
    };
    if (current && (current.packageHash !== next.packageHash
        || (current.version && next.version && current.version !== next.version)
        || (current.runtimeHash && next.runtimeHash && current.runtimeHash !== next.runtimeHash))) {
        invalid(`Plugin "${lock.pluginId}" has conflicting exact identities.`, path);
    }
    locks.set(lock.pluginId, { ...current, ...next });
}

async function collectPlugins(storageService, manifest, vehicles, scripts, releaseRefs) {
    const locks = new Map();
    for (const lock of effectivePluginLocks(manifest.plugins)) addPluginLock(locks, lock, "manifest.plugins");
    for (const { manifest: vehicle } of vehicles.values()) {
        for (const lock of normalizeVehiclePluginLocks(vehicle.pluginLocks) ?? []) addPluginLock(locks, lock, `vehicles.${vehicle.id}.pluginLocks`);
    }
    for (const [scriptId, entry] of scripts.documents) {
        for (const lock of normalizeGraphPluginLocks(entry.document.graph?.pluginLocks)) addPluginLock(locks, lock, `scripts.${scriptId}.graph.pluginLocks`);
        for (const requirement of collectArtifactPluginRequirements(entry.document.latestValidArtifact)) {
            addPluginLock(locks, requirement, `scripts.${scriptId}.latestValidArtifact.pluginRequirements`);
        }
    }

    const ownerSnapshot = await storageService.plugins.snapshotWithOwners();
    const explicit = exactPluginReleaseRefs(releaseRefs);
    const plugins = [];
    for (const lock of [...locks.values()].sort((left, right) => compareUtf8(left.pluginId, right.pluginId))) {
        let resource;
        try {
            resource = await storageService.plugins.getPackage(lock.packageHash);
        } catch (error) {
            invalid(`Plugin package ${lock.packageHash} for "${lock.pluginId}" is unavailable.`, "plugins");
        }
        const verified = verifyPluginPackage(resource);
        if (verified.document.id !== lock.pluginId
            || (lock.version && verified.document.version !== lock.version)
            || (lock.runtimeHash && verified.resource.runtimeHash !== lock.runtimeHash)) {
            invalid(`Plugin package ${lock.packageHash} does not match its authoring locks.`, "plugins");
        }
        let release = explicit.get(lock.packageHash) ?? null;
        if (!release) {
            const library = ownerSnapshot.packages.find((entry) => entry.pluginId === lock.pluginId && entry.packageHash === lock.packageHash);
            const owners = library?.ownership?.marketplace ?? [];
            const unique = new Map(owners.map((entry) => [
                `${entry.itemId}\0${entry.releaseVersion}\0${entry.artifactSha256}`,
                { itemId: entry.itemId, releaseVersion: entry.releaseVersion, artifactSha256: entry.artifactSha256 },
            ]));
            if (unique.size === 1) release = [...unique.values()][0];
        }
        if (!release) invalid(`Plugin package ${lock.packageHash} requires one exact marketplace release reference.`, "plugins");
        const resourceRecord = record(verified.resource);
        plugins.push({
            pluginId: verified.document.id,
            version: verified.document.version,
            packageHash: verified.resource.packageHash,
            runtimeHash: verified.resource.runtimeHash,
            recordSha256: resourceRecord.sha256,
            sizeBytes: resourceRecord.bytes.length,
            release,
            resource: verified.resource,
            record: resourceRecord,
        });
    }
    return plugins;
}

async function collectVehicles(storageService, manifest, scenario) {
    const custom = new Map();
    const builtIns = [];
    for (const vehicleId of referencedVehicleIds(manifest, scenario)) {
        const builtIn = getBuiltInVehicleManifest(vehicleId);
        if (builtIn) {
            builtIns.push({
                resourceKind: "vehicle",
                resourceId: vehicleId,
                contractKind: builtIn.kind,
                contractVersion: builtIn.version,
                contentHash: computeResolvedRunHash(builtIn),
            });
            continue;
        }
        const stored = await storageService.getVehicleManifest(vehicleId);
        if (!stored) invalid(`Vehicle "${vehicleId}" does not exist.`, "vehicles");
        const vehicle = structuredClone(stored);
        const modelAsset = String(vehicle.model?.asset ?? "").trim();
        if (modelAsset && (modelAsset.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(modelAsset))) {
            invalid(`Vehicle "${vehicleId}" uses nonportable model URL "${modelAsset}".`, `vehicles.${vehicleId}.model.asset`);
        }
        const assets = [];
        for (const name of (await storageService.listVehicleAssets(vehicleId)).sort(compareUtf8)) {
            const bytes = await storageService.readVehicleAsset(vehicleId, name);
            assets.push({ name, bytes, sizeBytes: bytes.length, sha256: sha256(bytes) });
        }
        if (modelAsset && !assets.some((entry) => entry.name === modelAsset)) {
            invalid(`Vehicle "${vehicleId}" is missing model asset "${modelAsset}".`, `vehicles.${vehicleId}.model.asset`);
        }
        const vehicleRecord = record(stored);
        const definitionHash = computeResolvedRunHash(vehicle);
        if (stored.definitionHash && stored.definitionHash !== definitionHash) {
            invalid(`Vehicle "${vehicleId}" has a stale definition hash.`, `vehicles.${vehicleId}.definitionHash`);
        }
        custom.set(vehicleId, {
            manifest: vehicle,
            stored,
            record: vehicleRecord,
            assets,
            revision: Number(stored.revision ?? 0),
            definitionHash,
        });
    }
    builtIns.sort((left, right) => compareUtf8(`${left.resourceKind}\0${left.resourceId}`, `${right.resourceKind}\0${right.resourceId}`));
    return { custom, builtIns };
}

export async function collectRunTemplateClosure({
    storageService,
    manifestId,
    expectedRevision,
    pluginReleaseRefs = [],
} = {}) {
    const storedManifest = await storageService.getRunManifest(manifestId);
    if (!storedManifest || !Number.isSafeInteger(storedManifest.revision) || storedManifest.revision < 1) {
        invalid(`Saved run manifest "${manifestId}" was not found.`, "root");
    }
    if (expectedRevision !== undefined && Number(expectedRevision) !== storedManifest.revision) {
        conflict("Run manifest revision changed before export.");
    }
    const manifest = normalizeRunManifest(storedManifest);
    const scenario = manifest.scenario ? await storageService.getScenario(manifest.scenario.id) : null;
    if (manifest.scenario && !scenario) invalid(`Scenario "${manifest.scenario.id}" does not exist.`, "root.scenario");
    const normalizedScenario = scenario ? normalizeScenario(scenario) : null;
    const scenarioDefinitionHash = normalizedScenario
        ? computeResolvedRunHash(stripScenarioMetadata(normalizedScenario))
        : null;
    if (scenario?.definitionHash && scenario.definitionHash !== scenarioDefinitionHash) {
        invalid(`Scenario "${normalizedScenario.id}" has a stale definition hash.`, "root.scenario");
    }
    if (normalizedScenario && manifest.scenario.expectedHash
        && manifest.scenario.expectedHash !== scenarioDefinitionHash) {
        invalid(`Scenario "${normalizedScenario.id}" does not match its run-manifest lock.`, "root.scenario");
    }
    const bindings = (await effectiveBindings(storageService, manifest)).sort((left, right) => compareUtf8(left.id, right.id));
    const bindingsHash = computeResolvedRunHash(bindings);
    if (manifest.scripts.expectedBindingsHash && manifest.scripts.expectedBindingsHash !== bindingsHash) {
        invalid("The run manifest has a stale script-binding lock.", "root.scripts.expectedBindingsHash");
    }
    const bindingManifest = createBindingManifest({
        bindings,
        folders: [],
        enabled: manifest.scripts.enabled,
        updatedAt: storedManifest.updatedAt ?? storedManifest.createdAt ?? "1970-01-01T00:00:00.000Z",
    });
    const bindingRecord = record(bindingManifest);
    const scripts = await collectScripts(storageService, directScriptIds(manifest, normalizedScenario, bindings));
    for (const lock of manifest.scripts.artifacts) {
        const document = scripts.documents.get(lock.scriptId)?.document;
        const artifactHash = document ? computeResolvedRunHash(document.latestValidArtifact) : null;
        if (lock.expectedHash && lock.expectedHash !== artifactHash) {
            invalid(`Script "${lock.scriptId}" does not match its run-manifest artifact lock.`, "root.scripts.artifacts");
        }
    }
    const vehicles = await collectVehicles(storageService, manifest, normalizedScenario);
    const environmentId = normalizedScenario?.environment?.id ?? manifest.environment.id;
    if (normalizedScenario && manifest.environment.id !== environmentId) {
        invalid("A run-template package supports one exact environment closure; the run and scenario environments differ.", "root.environment");
    }
    const environmentDocument = await storageService.getEnvironment(environmentId);
    if (!environmentDocument) invalid(`Environment "${environmentId}" does not exist.`, "environment");
    const environmentHash = computeResolvedRunHash(environmentDocument);
    if (manifest.environment.expectedHash && manifest.environment.expectedHash !== environmentHash) {
        invalid(`Environment "${environmentId}" does not match its run-manifest lock.`, "root.environment.expectedHash");
    }
    if (normalizedScenario?.environment?.expectedHash
        && normalizedScenario.environment.expectedHash !== environmentHash) {
        invalid(`Environment "${environmentId}" does not match its scenario lock.`, "root.scenario.environment.expectedHash");
    }
    const builtInEnvironment = Number(environmentDocument.revision ?? 0) === 0;
    const environment = builtInEnvironment ? null : await collectEnvironmentPackageClosure({
        storageService,
        environmentId,
    });
    const plugins = await collectPlugins(storageService, manifest, vehicles.custom, scripts, pluginReleaseRefs);

    const rootRecord = record(storedManifest);
    const scenarioRecords = normalizedScenario ? [{
        scenario: normalizedScenario,
        stored: scenario,
        record: record(scenario),
        revision: Number(scenario.revision ?? 0),
        definitionHash: scenarioDefinitionHash,
    }] : [];
    const scriptRecords = [...scripts.documents].map(([scriptId, entry]) => {
        const documentRecord = record(entry.document);
        const graphPackageHashes = normalizeGraphPluginLocks(entry.document.graph?.pluginLocks).map((lock) => lock.packageHash);
        const artifactPackageHashes = collectArtifactPluginRequirements(entry.document.latestValidArtifact).map((requirement) => {
            const plugin = plugins.find((candidate) => candidate.pluginId === requirement.pluginId);
            if (!plugin) invalid(`Script "${scriptId}" has an unresolved compiled-artifact plugin requirement.`, `scripts.${scriptId}`);
            return plugin.packageHash;
        });
        return {
            scriptId,
            ...entry,
            record: documentRecord,
            graphHash: computeResolvedRunHash(entry.document.graph),
            artifactHash: computeResolvedRunHash(entry.document.latestValidArtifact),
            pluginPackageHashes: [...new Set([...graphPackageHashes, ...artifactPackageHashes])].sort(compareUtf8),
        };
    }).sort((left, right) => compareUtf8(left.scriptId, right.scriptId));
    const records = mergeRecords([
        rootRecord,
        bindingRecord,
        ...(environment?.records ?? []),
        ...scenarioRecords.map((entry) => entry.record),
        ...[...vehicles.custom.values()].map((entry) => entry.record),
        ...scriptRecords.map((entry) => entry.record),
        ...plugins.map((entry) => entry.record),
    ]);
    const blobs = mergeBlobs([
        ...(environment?.blobs ?? []),
        ...[...vehicles.custom.values()].flatMap((entry) => entry.assets.map((asset) => ({
            sha256: asset.sha256,
            sizeBytes: asset.sizeBytes,
            open: () => asset.bytes,
        }))),
    ]);
    return Object.freeze({
        storedManifest,
        manifest,
        rootRecord,
        scenarioRecords,
        vehicles,
        scripts,
        scriptRecords,
        bindings,
        bindingManifest,
        bindingRecord,
        environment,
        plugins,
        builtIns: [
            ...vehicles.builtIns,
            ...(builtInEnvironment ? [{
                resourceKind: "environment",
                resourceId: environmentId,
                contractKind: "cev-sim.environment-manifest",
                contractVersion: Number(environmentDocument.schemaVersion ?? 0),
                contentHash: computeResolvedRunHash(environmentDocument),
            }] : []),
        ].sort((left, right) => compareUtf8(`${left.resourceKind}\0${left.resourceId}`, `${right.resourceKind}\0${right.resourceId}`)),
        records,
        blobs,
    });
}

export const captureRunTemplateSnapshot = collectRunTemplateClosure;

export async function recheckRunTemplateSnapshot({ storageService, captured }) {
    const currentManifest = await storageService.getRunManifest(captured.manifest.id);
    if (!currentManifest || currentManifest.revision !== captured.storedManifest.revision
        || record(currentManifest).sha256 !== captured.rootRecord.sha256) conflict("Run manifest changed while its template was captured.");
    const currentBindings = (await effectiveBindings(storageService, captured.manifest))
        .sort((left, right) => compareUtf8(left.id, right.id));
    if (computeResolvedRunHash(currentBindings) !== computeResolvedRunHash(captured.bindings)) {
        conflict("Script bindings changed while the run template was captured.");
    }
    for (const entry of captured.scenarioRecords) {
        const current = await storageService.getScenario(entry.scenario.id);
        if (!current || current.revision !== entry.revision || record(current).sha256 !== entry.record.sha256) {
            conflict(`Scenario "${entry.scenario.id}" changed while its template was captured.`);
        }
    }
    for (const [vehicleId, entry] of captured.vehicles.custom) {
        const current = await storageService.getVehicleManifest(vehicleId);
        if (!current || current.revision !== entry.revision || record(current).sha256 !== entry.record.sha256) {
            conflict(`Vehicle "${vehicleId}" changed while its template was captured.`);
        }
        const currentNames = (await storageService.listVehicleAssets(vehicleId)).sort(compareUtf8);
        if (JSON.stringify(currentNames) !== JSON.stringify(entry.assets.map((asset) => asset.name))) {
            conflict(`Vehicle "${vehicleId}" assets changed while its template was captured.`);
        }
        for (const asset of entry.assets) {
            if (sha256(await storageService.readVehicleAsset(vehicleId, asset.name)) !== asset.sha256) {
                conflict(`Vehicle "${vehicleId}" asset "${asset.name}" changed while its template was captured.`);
            }
        }
    }
    for (const entry of captured.scriptRecords) {
        const current = await storageService.getScript(entry.scriptId);
        if (!current || record(normalizeScriptDocument(current)).sha256 !== entry.record.sha256) {
            conflict(`Script "${entry.scriptId}" changed while its template was captured.`);
        }
    }
    if (captured.environment) {
        const environment = await storageService.snapshotMarketplaceEnvironment(captured.environment.manifest.environment.environmentId);
        if (environment.environment.revision !== captured.environment.snapshot.environment.revision
            || record(environment.environment).sha256 !== captured.environment.recordSha256) {
            conflict("Environment changed while its run template was captured.");
        }
    } else {
        const descriptor = captured.builtIns.find((entry) => entry.resourceKind === "environment");
        const environment = await storageService.getEnvironment(descriptor.resourceId);
        if (!environment || computeResolvedRunHash(environment) !== descriptor.contentHash) {
            conflict("Built-in environment changed while its run template was captured.");
        }
    }
    return true;
}
