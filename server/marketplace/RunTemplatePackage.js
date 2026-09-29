import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { collectAssetInstanceReferences } from "../../app/editor-assets/EditorAssetContract.js";
import { presentStoredEnvironment } from "../../app/3d/environment/EnvironmentManifestPolicy.js";
import { createBuiltInIGVCEnvironmentManifest } from "../../app/3d/igvc/IGVCEnvironmentDocument.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { collectArtifactPluginRequirements } from "../../app/plugin/PluginRequirements.js";
import { normalizeGraphPluginLocks } from "../../app/plugin/PluginGraphLocks.js";
import { effectivePluginLocks } from "../../app/plugin/PluginSelection.js";
import { normalizeVehiclePluginLocks } from "../../app/plugin/PluginSensorAuthoring.js";
import { createSensorDefinitionRegistry } from "../../app/simulation/sensors/SensorTypeRegistry.js";
import { computeResolvedRunHash, normalizeRunManifest, validateRunManifest } from "../../app/simulation/RunManifest.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import { collectScenarioScriptIds, normalizeScenario, stripScenarioMetadata, validateScenario } from "../../app/scenarios/ScenarioDocument.js";
import { getGraphScriptReferences } from "../../app/scripting/GraphDocument.js";
import { isCompiledArtifact, normalizeScriptDocument } from "../../app/scripting/EditorDocument.js";
import { normalizeBindingManifest } from "../../app/scripting/bindings/BindingDocument.js";
import { normalizeVehicleManifest, validateVehicleManifest } from "../../app/vehicles/VehicleManifest.js";
import { getBuiltInVehicleManifest } from "../../app/vehicles/BuiltInVehicleManifests.js";
import { createDeterministicArchiveStream, verifyDeterministicArchive } from "../artifacts/DeterministicArchive.js";
import {
    ASSET_PACKAGE_BLOB_PREFIX,
    ASSET_PACKAGE_RECORD_PREFIX,
    parseCanonicalRecord,
    verifyAssetClosure,
} from "./AssetPackage.js";
import { normalizeEnvironmentPackageManifest, verifyVisualClosure } from "./EnvironmentPackage.js";
import { RUN_TEMPLATE_PACKAGE_LIMITS } from "./MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "./MarketplaceErrors.js";
import { assertMarketplaceId, assertReleaseVersion } from "./MarketplaceFormats.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes } from "./MarketplaceJson.js";
import { createPackagePreparationIndex, readPackagePreparation } from "./PackagePreparation.js";
import { collectRunTemplateClosure, recheckRunTemplateSnapshot } from "./RunTemplateClosure.js";

export const RUN_TEMPLATE_PACKAGE_KIND = "cev-sim.run-template-package";
export const RUN_TEMPLATE_PACKAGE_VERSION = 1;
export const RUN_TEMPLATE_PACKAGE_MANIFEST = "manifest.json";
export const RUN_TEMPLATE_PACKAGE_RECORD_PREFIX = ASSET_PACKAGE_RECORD_PREFIX;
export const RUN_TEMPLATE_PACKAGE_BLOB_PREFIX = ASSET_PACKAGE_BLOB_PREFIX;

const SHA256 = /^[a-f0-9]{64}$/u;
const PORTABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function invalid(message, field = null) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, message, { path: field });
}

function limit(message) {
    throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, message);
}

function exactKeys(value, keys, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object.`, field);
    const expected = new Set(keys);
    for (const key of keys) if (!Object.hasOwn(value, key)) invalid(`${field}.${key} is required.`, `${field}.${key}`);
    for (const key of Object.keys(value)) if (!expected.has(key)) invalid(`${field}.${key} is not allowed.`, `${field}.${key}`);
}

function digest(value, field) {
    if (typeof value !== "string" || !SHA256.test(value)) invalid(`${field} must be a lowercase SHA-256 digest.`, field);
    return value;
}

function portableId(value, field) {
    if (typeof value !== "string" || !PORTABLE_ID.test(value)) invalid(`${field} must be a portable id.`, field);
    return value;
}

function nonNegative(value, field) {
    if (!Number.isSafeInteger(value) || value < 0) invalid(`${field} must be a non-negative safe integer.`, field);
    return value;
}

function positive(value, field) {
    if (!Number.isSafeInteger(value) || value < 1) invalid(`${field} must be a positive safe integer.`, field);
    return value;
}

function dense(value, field) {
    if (!Array.isArray(value) || Object.keys(value).length !== value.length) invalid(`${field} must be a dense array.`, field);
    return value;
}

function sortedUnique(values, key, field) {
    const seen = new Set();
    let previous = null;
    values.forEach((entry, index) => {
        const current = key(entry);
        if (seen.has(current)) invalid(`${field}.${index} is a duplicate.`, `${field}.${index}`);
        if (previous !== null && compareUtf8(previous, current) >= 0) invalid(`${field} must be in canonical UTF-8 order.`, field);
        previous = current;
        seen.add(current);
    });
}

function descriptor(value, field, idKey) {
    const keys = [idKey, "revision", "definitionHash", "recordSha256", "sizeBytes"];
    exactKeys(value, keys, field);
    return {
        [idKey]: portableId(value[idKey], `${field}.${idKey}`),
        revision: positive(value.revision, `${field}.revision`),
        definitionHash: digest(value.definitionHash, `${field}.definitionHash`),
        recordSha256: digest(value.recordSha256, `${field}.recordSha256`),
        sizeBytes: nonNegative(value.sizeBytes, `${field}.sizeBytes`),
    };
}

function releaseRef(value, field) {
    exactKeys(value, ["itemId", "releaseVersion", "artifactSha256"], field);
    return {
        itemId: assertMarketplaceId(value.itemId, `${field}.itemId`),
        releaseVersion: assertReleaseVersion(value.releaseVersion, `${field}.releaseVersion`),
        artifactSha256: digest(value.artifactSha256, `${field}.artifactSha256`),
    };
}

function normalizeRoot(value) {
    exactKeys(value, ["manifestId", "revision", "recordSha256", "sizeBytes"], "$manifest.root");
    return {
        manifestId: portableId(value.manifestId, "$manifest.root.manifestId"),
        revision: positive(value.revision, "$manifest.root.revision"),
        recordSha256: digest(value.recordSha256, "$manifest.root.recordSha256"),
        sizeBytes: nonNegative(value.sizeBytes, "$manifest.root.sizeBytes"),
    };
}

function normalizeScenarios(value) {
    const entries = dense(value, "$manifest.scenarios").map((entry, index) => descriptor(entry, `$manifest.scenarios.${index}`, "scenarioId"));
    sortedUnique(entries, (entry) => entry.scenarioId, "$manifest.scenarios");
    return entries;
}

function normalizeVehicles(value) {
    const entries = dense(value, "$manifest.vehicles").map((entry, index) => {
        const field = `$manifest.vehicles.${index}`;
        exactKeys(entry, ["vehicleId", "revision", "definitionHash", "recordSha256", "sizeBytes", "assets"], field);
        const base = descriptor({
            vehicleId: entry.vehicleId,
            revision: entry.revision,
            definitionHash: entry.definitionHash,
            recordSha256: entry.recordSha256,
            sizeBytes: entry.sizeBytes,
        }, field, "vehicleId");
        const assets = dense(entry.assets, `${field}.assets`).map((asset, assetIndex) => {
            const assetField = `${field}.assets.${assetIndex}`;
            exactKeys(asset, ["name", "sha256", "sizeBytes"], assetField);
            const name = String(asset.name ?? "");
            if (!name || name !== name.trim() || /[\\/\0]/u.test(name) || name === "." || name === "..") invalid(`${assetField}.name is invalid.`, `${assetField}.name`);
            return { name, sha256: digest(asset.sha256, `${assetField}.sha256`), sizeBytes: nonNegative(asset.sizeBytes, `${assetField}.sizeBytes`) };
        });
        sortedUnique(assets, (asset) => asset.name, `${field}.assets`);
        return { ...base, assets };
    });
    sortedUnique(entries, (entry) => entry.vehicleId, "$manifest.vehicles");
    return entries;
}

function normalizeScripts(value) {
    const entries = dense(value, "$manifest.scripts").map((entry, index) => {
        const field = `$manifest.scripts.${index}`;
        exactKeys(entry, [
            "scriptId", "recordSha256", "sizeBytes", "graphHash", "artifactHash",
            "scriptReferences", "pluginPackageHashes",
        ], field);
        const scriptReferences = dense(entry.scriptReferences, `${field}.scriptReferences`).map((id, refIndex) => portableId(id, `${field}.scriptReferences.${refIndex}`));
        const pluginPackageHashes = dense(entry.pluginPackageHashes, `${field}.pluginPackageHashes`).map((hash, hashIndex) => digest(hash, `${field}.pluginPackageHashes.${hashIndex}`));
        sortedUnique(scriptReferences, (id) => id, `${field}.scriptReferences`);
        sortedUnique(pluginPackageHashes, (hash) => hash, `${field}.pluginPackageHashes`);
        return {
            scriptId: portableId(entry.scriptId, `${field}.scriptId`),
            recordSha256: digest(entry.recordSha256, `${field}.recordSha256`),
            sizeBytes: nonNegative(entry.sizeBytes, `${field}.sizeBytes`),
            graphHash: digest(entry.graphHash, `${field}.graphHash`),
            artifactHash: digest(entry.artifactHash, `${field}.artifactHash`),
            scriptReferences,
            pluginPackageHashes,
        };
    });
    sortedUnique(entries, (entry) => entry.scriptId, "$manifest.scripts");
    return entries;
}

function normalizePlugins(value) {
    const entries = dense(value, "$manifest.plugins").map((entry, index) => {
        const field = `$manifest.plugins.${index}`;
        exactKeys(entry, [
            "pluginId", "version", "packageHash", "runtimeHash", "recordSha256", "sizeBytes", "release",
        ], field);
        return {
            pluginId: portableId(entry.pluginId, `${field}.pluginId`),
            version: String(entry.version ?? ""),
            packageHash: digest(entry.packageHash, `${field}.packageHash`),
            runtimeHash: digest(entry.runtimeHash, `${field}.runtimeHash`),
            recordSha256: digest(entry.recordSha256, `${field}.recordSha256`),
            sizeBytes: nonNegative(entry.sizeBytes, `${field}.sizeBytes`),
            release: releaseRef(entry.release, `${field}.release`),
        };
    });
    sortedUnique(entries, (entry) => entry.pluginId, "$manifest.plugins");
    return entries;
}

export function normalizeRunTemplatePackageManifest(value) {
    exactKeys(value, [
        "kind", "version", "root", "environmentClosure", "scenarios", "vehicles", "scripts",
        "bindings", "plugins", "builtIns", "contracts",
    ], "$manifest");
    if (value.kind !== RUN_TEMPLATE_PACKAGE_KIND || value.version !== RUN_TEMPLATE_PACKAGE_VERSION) {
        invalid(`Expected ${RUN_TEMPLATE_PACKAGE_KIND}@${RUN_TEMPLATE_PACKAGE_VERSION}.`, "$manifest.kind");
    }
    exactKeys(value.bindings, ["recordSha256", "sizeBytes", "bindingIds"], "$manifest.bindings");
    const bindingIds = dense(value.bindings.bindingIds, "$manifest.bindings.bindingIds")
        .map((id, index) => portableId(id, `$manifest.bindings.bindingIds.${index}`));
    sortedUnique(bindingIds, (id) => id, "$manifest.bindings.bindingIds");
    const builtIns = dense(value.builtIns, "$manifest.builtIns").map((entry, index) => {
        const field = `$manifest.builtIns.${index}`;
        exactKeys(entry, ["resourceKind", "resourceId", "contractKind", "contractVersion", "contentHash"], field);
        return {
            resourceKind: String(entry.resourceKind ?? ""),
            resourceId: portableId(entry.resourceId, `${field}.resourceId`),
            contractKind: String(entry.contractKind ?? ""),
            contractVersion: positive(entry.contractVersion, `${field}.contractVersion`),
            contentHash: digest(entry.contentHash, `${field}.contentHash`),
        };
    });
    sortedUnique(builtIns, (entry) => `${entry.resourceKind}\0${entry.resourceId}`, "$manifest.builtIns");
    const contracts = dense(value.contracts, "$manifest.contracts").map((entry, index) => {
        const field = `$manifest.contracts.${index}`;
        exactKeys(entry, ["kind", "version"], field);
        const kind = String(entry.kind ?? "");
        if (!kind) invalid(`${field}.kind must not be empty.`, `${field}.kind`);
        return { kind, version: positive(entry.version, `${field}.version`) };
    });
    sortedUnique(contracts, (entry) => `${entry.kind}\0${String(entry.version).padStart(16, "0")}`, "$manifest.contracts");
    return {
        kind: RUN_TEMPLATE_PACKAGE_KIND,
        version: RUN_TEMPLATE_PACKAGE_VERSION,
        root: normalizeRoot(value.root),
        environmentClosure: value.environmentClosure === null ? null : normalizeEnvironmentPackageManifest(value.environmentClosure),
        scenarios: normalizeScenarios(value.scenarios),
        vehicles: normalizeVehicles(value.vehicles),
        scripts: normalizeScripts(value.scripts),
        bindings: {
            recordSha256: digest(value.bindings.recordSha256, "$manifest.bindings.recordSha256"),
            sizeBytes: nonNegative(value.bindings.sizeBytes, "$manifest.bindings.sizeBytes"),
            bindingIds,
        },
        plugins: normalizePlugins(value.plugins),
        builtIns,
        contracts,
    };
}

function contractsFor(captured) {
    const contracts = new Map();
    const add = (kind, version) => contracts.set(`${kind}\0${version}`, { kind, version });
    add(captured.manifest.kind, captured.manifest.version);
    add(captured.bindingManifest.kind, captured.bindingManifest.version);
    if (captured.environment) add(captured.environment.manifest.kind, captured.environment.manifest.version);
    for (const entry of captured.scenarioRecords) add(entry.scenario.kind, entry.scenario.version);
    for (const { manifest } of captured.vehicles.custom.values()) add(manifest.kind, manifest.version);
    for (const entry of captured.scriptRecords) {
        add(entry.document.kind, entry.document.version);
        add(entry.document.latestValidArtifact.kind, entry.document.latestValidArtifact.version);
    }
    for (const entry of captured.plugins) add(entry.resource.kind, entry.resource.version);
    for (const entry of captured.builtIns) add(entry.contractKind, entry.contractVersion);
    return [...contracts.values()].sort((left, right) => compareUtf8(left.kind, right.kind) || left.version - right.version);
}

function packageManifest(captured) {
    return normalizeRunTemplatePackageManifest({
        kind: RUN_TEMPLATE_PACKAGE_KIND,
        version: RUN_TEMPLATE_PACKAGE_VERSION,
        root: {
            manifestId: captured.manifest.id,
            revision: captured.storedManifest.revision,
            recordSha256: captured.rootRecord.sha256,
            sizeBytes: captured.rootRecord.bytes.length,
        },
        environmentClosure: captured.environment?.manifest ?? null,
        scenarios: captured.scenarioRecords.map((entry) => ({
            scenarioId: entry.scenario.id,
            revision: entry.revision,
            definitionHash: entry.definitionHash,
            recordSha256: entry.record.sha256,
            sizeBytes: entry.record.bytes.length,
        })),
        vehicles: [...captured.vehicles.custom].map(([vehicleId, entry]) => ({
            vehicleId,
            revision: entry.revision,
            definitionHash: entry.definitionHash,
            recordSha256: entry.record.sha256,
            sizeBytes: entry.record.bytes.length,
            assets: entry.assets.map(({ name, sha256, sizeBytes }) => ({ name, sha256, sizeBytes })),
        })).sort((left, right) => compareUtf8(left.vehicleId, right.vehicleId)),
        scripts: captured.scriptRecords.map((entry) => ({
            scriptId: entry.scriptId,
            recordSha256: entry.record.sha256,
            sizeBytes: entry.record.bytes.length,
            graphHash: entry.graphHash,
            artifactHash: entry.artifactHash,
            scriptReferences: entry.references,
            pluginPackageHashes: entry.pluginPackageHashes,
        })),
        bindings: {
            recordSha256: captured.bindingRecord.sha256,
            sizeBytes: captured.bindingRecord.bytes.length,
            bindingIds: captured.bindings.map((entry) => entry.id),
        },
        plugins: captured.plugins.map((entry) => ({
            pluginId: entry.pluginId,
            version: entry.version,
            packageHash: entry.packageHash,
            runtimeHash: entry.runtimeHash,
            recordSha256: entry.recordSha256,
            sizeBytes: entry.sizeBytes,
            release: entry.release,
        })),
        builtIns: captured.builtIns,
        contracts: contractsFor(captured),
    });
}

function packageLimits(overrides = {}) {
    const limits = { ...RUN_TEMPLATE_PACKAGE_LIMITS, ...overrides };
    for (const key of ["archiveBytes", "blobBytes", "recordBytes", "manifestBytes", "payloadEntries", "entries", "graphDepth", "temporaryBytes", "inodes", "verificationTimeoutMs"]) {
        if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > RUN_TEMPLATE_PACKAGE_LIMITS[key]) {
            throw new TypeError(`Run-template limit ${key} exceeds the frozen profile.`);
        }
    }
    return Object.freeze(limits);
}

export async function exportRunTemplatePackage({
    storageService,
    manifestId,
    expectedRevision,
    pluginReleaseRefs = [],
    output = null,
    signal,
} = {}) {
    const captured = await collectRunTemplateClosure({ storageService, manifestId, expectedRevision, pluginReleaseRefs });
    await recheckRunTemplateSnapshot({ storageService, captured });
    const manifest = packageManifest(captured);
    const manifestBytes = Buffer.from(canonicalMarketplaceBytes(manifest));
    const entries = [
        { name: RUN_TEMPLATE_PACKAGE_MANIFEST, bytes: manifestBytes, sizeBytes: manifestBytes.length },
        ...captured.records.map((entry) => ({
            name: `${RUN_TEMPLATE_PACKAGE_RECORD_PREFIX}${entry.sha256}`,
            bytes: entry.bytes,
            sizeBytes: entry.bytes.length,
            sha256: entry.sha256,
        })),
        ...captured.blobs.map((entry) => ({
            name: `${RUN_TEMPLATE_PACKAGE_BLOB_PREFIX}${entry.sha256}`,
            sizeBytes: entry.sizeBytes,
            sha256: entry.sha256,
            open: entry.open ?? (() => storageService.visualAssets.openPublishedStream(entry.sha256, { expectedSize: entry.sizeBytes })),
        })),
    ];
    if (manifestBytes.length > RUN_TEMPLATE_PACKAGE_LIMITS.manifestBytes) limit("Run-template manifest exceeds the manifest limit.");
    if (captured.records.some((entry) => entry.bytes.length > RUN_TEMPLATE_PACKAGE_LIMITS.recordBytes)) limit("Run-template record exceeds the record limit.");
    if (captured.blobs.some((entry) => entry.sizeBytes > RUN_TEMPLATE_PACKAGE_LIMITS.blobBytes)) limit("Run-template blob exceeds the blob limit.");
    if (entries.length - 1 > RUN_TEMPLATE_PACKAGE_LIMITS.payloadEntries) limit("Run-template package exceeds the payload-entry limit.");
    const archive = createDeterministicArchiveStream(entries, {
        limits: {
            archiveBytes: RUN_TEMPLATE_PACKAGE_LIMITS.archiveBytes,
            entryBytes: RUN_TEMPLATE_PACKAGE_LIMITS.blobBytes,
            entries: RUN_TEMPLATE_PACKAGE_LIMITS.entries,
            temporaryBytes: RUN_TEMPLATE_PACKAGE_LIMITS.temporaryBytes,
            inodes: RUN_TEMPLATE_PACKAGE_LIMITS.inodes,
        },
        signal,
    });
    if (output) {
        await pipeline(archive.stream, output, { signal });
        return Object.freeze({ manifest, ...await archive.completion });
    }
    return Object.freeze({ manifest, stream: archive.stream, completion: archive.completion });
}

function environmentRecordDigests(manifest) {
    if (!manifest) return [];
    return [...new Set([
        manifest.environment.recordSha256,
        ...manifest.assets.assets.flatMap((asset) => asset.revisions.map((entry) => entry.recordSha256)),
        ...manifest.assets.uses.map((entry) => entry.recordSha256),
        ...(manifest.visualLayer ? [
            manifest.visualLayer.descriptor.recordSha256,
            manifest.visualLayer.access.recordSha256,
            ...manifest.visualLayer.uses.map((entry) => entry.recordSha256),
        ] : []),
    ])];
}

function environmentBlobDescriptors(manifest) {
    if (!manifest) return [];
    return [...manifest.assets.blobs, ...(manifest.visualLayer?.blobs ?? [])];
}

function expectedDescriptors(manifest) {
    const recordDigests = new Set([
        manifest.root.recordSha256,
        manifest.bindings.recordSha256,
        ...environmentRecordDigests(manifest.environmentClosure),
        ...manifest.scenarios.map((entry) => entry.recordSha256),
        ...manifest.vehicles.map((entry) => entry.recordSha256),
        ...manifest.scripts.map((entry) => entry.recordSha256),
        ...manifest.plugins.map((entry) => entry.recordSha256),
    ]);
    const blobs = new Map();
    for (const entry of [...environmentBlobDescriptors(manifest.environmentClosure), ...manifest.vehicles.flatMap((vehicle) => vehicle.assets)]) {
        const current = blobs.get(entry.sha256);
        if (current !== undefined && current !== entry.sizeBytes) invalid(`Blob ${entry.sha256} has conflicting declared sizes.`);
        blobs.set(entry.sha256, entry.sizeBytes);
    }
    return {
        recordDigests: [...recordDigests].sort(compareUtf8),
        blobs: [...blobs].map(([sha256, sizeBytes]) => ({ sha256, sizeBytes })).sort((left, right) => compareUtf8(left.sha256, right.sha256)),
    };
}

function verifyBuiltInDescriptors(manifest) {
    for (const entry of manifest.builtIns) {
        if (entry.resourceKind === "vehicle") {
            const vehicle = getBuiltInVehicleManifest(entry.resourceId);
            if (!vehicle || entry.contractKind !== vehicle.kind || entry.contractVersion !== vehicle.version
                || entry.contentHash !== computeResolvedRunHash(vehicle)) invalid(`Built-in vehicle "${entry.resourceId}" descriptor is unsupported or stale.`);
        } else if (entry.resourceKind === "environment" && entry.resourceId === "igvc") {
            const environment = presentStoredEnvironment(createBuiltInIGVCEnvironmentManifest(), "igvc");
            if (entry.contractKind !== "cev-sim.environment-manifest"
                || entry.contractVersion !== Number(environment.schemaVersion)
                || entry.contentHash !== computeResolvedRunHash(environment)) invalid("Built-in IGVC environment descriptor is unsupported or stale.");
        } else {
            invalid(`Unsupported built-in resource ${entry.resourceKind}:${entry.resourceId}.`);
        }
    }
}

function assertStaticClosure({ manifest, root, scenarios, vehicles, scripts, bindings, plugins, environment }) {
    const scriptIds = new Set(scripts.keys());
    const scenarioIds = new Set(scenarios.keys());
    const vehicleIds = new Set([...vehicles.keys(), ...manifest.builtIns.filter((entry) => entry.resourceKind === "vehicle").map((entry) => entry.resourceId)]);
    const pluginPackages = new Set(plugins.values().map((entry) => entry.resource.packageHash));
    const usedPluginPackages = new Set();
    const usedScenarioIds = new Set();
    const usedVehicleIds = new Set();
    const scriptRoots = new Set();
    const hasPluginLock = (pluginId, packageHash) => {
        const plugin = plugins.get(pluginId);
        return plugin?.resource.packageHash === packageHash;
    };
    const usedBuiltIns = new Set();
    for (const lock of effectivePluginLocks(root.plugins)) {
        if (!hasPluginLock(lock.pluginId, lock.expectedHash)) invalid(`Run manifest plugin lock for "${lock.pluginId}" is not packaged.`);
        usedPluginPackages.add(lock.expectedHash);
    }
    if (root.scenario && !scenarioIds.has(root.scenario.id)) invalid(`Run manifest references missing scenario "${root.scenario.id}".`);
    if (root.scenario) usedScenarioIds.add(root.scenario.id);
    if (root.scenario?.expectedHash) {
        const scenarioHash = computeResolvedRunHash(stripScenarioMetadata(scenarios.get(root.scenario.id)));
        if (root.scenario.expectedHash !== scenarioHash) invalid(`Run manifest scenario lock for "${root.scenario.id}" is stale.`);
    }
    for (const vehicle of root.initialState.vehicles) {
        if (!vehicleIds.has(vehicle.type)) invalid(`Run manifest references missing vehicle "${vehicle.type}".`);
        usedVehicleIds.add(vehicle.type);
        if (!vehicles.has(vehicle.type)) usedBuiltIns.add(`vehicle\0${vehicle.type}`);
    }
    if (root.scenario?.egoVehicleId) {
        if (!vehicleIds.has(root.scenario.egoVehicleId)) invalid(`Run manifest references missing ego vehicle "${root.scenario.egoVehicleId}".`);
        usedVehicleIds.add(root.scenario.egoVehicleId);
        if (!vehicles.has(root.scenario.egoVehicleId)) usedBuiltIns.add(`vehicle\0${root.scenario.egoVehicleId}`);
    }
    for (const entry of root.scripts.artifacts) {
        const script = scripts.get(entry.scriptId);
        if (!script) invalid(`Run manifest references missing script "${entry.scriptId}".`);
        scriptRoots.add(entry.scriptId);
        if (entry.expectedHash && entry.expectedHash !== computeResolvedRunHash(script.latestValidArtifact)) {
            invalid(`Run manifest script lock for "${entry.scriptId}" is stale.`);
        }
    }
    for (const parameter of root.parameters ?? []) {
        if (parameter.target?.kind === "script-input") {
            if (!scriptIds.has(parameter.target.scriptId)) invalid(`Run parameter references missing script "${parameter.target.scriptId}".`);
            scriptRoots.add(parameter.target.scriptId);
        }
    }
    for (const scenario of scenarios.values()) {
        for (const scriptId of collectScenarioScriptIds(scenario)) {
            if (!scriptIds.has(scriptId)) invalid(`Scenario references missing script "${scriptId}".`);
            scriptRoots.add(scriptId);
        }
        for (const actor of scenario.actors ?? []) {
            if (actor.vehicleId && !vehicleIds.has(actor.vehicleId)) invalid(`Scenario references missing vehicle "${actor.vehicleId}".`);
            if (actor.vehicleId) usedVehicleIds.add(actor.vehicleId);
            if (actor.vehicleId && !vehicles.has(actor.vehicleId)) usedBuiltIns.add(`vehicle\0${actor.vehicleId}`);
        }
    }
    for (const vehicle of vehicles.values()) {
        for (const lock of normalizeVehiclePluginLocks(vehicle.pluginLocks) ?? []) {
            if (!hasPluginLock(lock.pluginId, lock.packageHash)) invalid(`Vehicle plugin lock for "${lock.pluginId}" is not packaged.`);
            usedPluginPackages.add(lock.packageHash);
        }
    }
    for (const binding of bindings.bindings) {
        if (binding.scriptId && !scriptIds.has(binding.scriptId)) invalid(`Binding references missing script "${binding.scriptId}".`);
        if (binding.scriptId) scriptRoots.add(binding.scriptId);
    }
    if (root.scripts.expectedBindingsHash
        && root.scripts.expectedBindingsHash !== computeResolvedRunHash(bindings.bindings)) {
        invalid("Run manifest script-binding lock is stale.");
    }
    for (const [scriptId, document] of scripts) {
        for (const reference of getGraphScriptReferences(document.graph)) if (!scriptIds.has(reference)) invalid(`Script "${scriptId}" references missing script "${reference}".`);
        const descriptor = manifest.scripts.find((entry) => entry.scriptId === scriptId);
        if (descriptor.pluginPackageHashes.some((hash) => !pluginPackages.has(hash))) invalid(`Script "${scriptId}" references a missing plugin package.`);
        const required = new Set([
            ...normalizeGraphPluginLocks(document.graph?.pluginLocks).map((lock) => {
                if (!hasPluginLock(lock.pluginId, lock.packageHash)) {
                    invalid(`Script "${scriptId}" graph lock for "${lock.pluginId}" is not packaged.`);
                }
                usedPluginPackages.add(lock.packageHash);
                return lock.packageHash;
            }),
            ...collectArtifactPluginRequirements(document.latestValidArtifact).map((requirement) => {
                const plugin = [...plugins.values()].find((entry) => entry.document.id === requirement.pluginId);
                if (!plugin || plugin.document.version !== requirement.version
                    || plugin.resource.runtimeHash !== requirement.runtimeHash) {
                    invalid(`Script "${scriptId}" has an unresolved plugin requirement "${requirement.pluginId}".`);
                }
                usedPluginPackages.add(plugin.resource.packageHash);
                return plugin.resource.packageHash;
            }),
        ]);
        if (JSON.stringify([...required].sort(compareUtf8)) !== JSON.stringify(descriptor.pluginPackageHashes)) {
            invalid(`Script "${scriptId}" plugin package inventory is not exact.`);
        }
    }
    const reachableScripts = new Set();
    const visitScript = (scriptId) => {
        if (reachableScripts.has(scriptId)) return;
        reachableScripts.add(scriptId);
        for (const child of getGraphScriptReferences(scripts.get(scriptId).graph)) visitScript(child);
    };
    for (const scriptId of scriptRoots) visitScript(scriptId);
    if (JSON.stringify([...reachableScripts].sort(compareUtf8)) !== JSON.stringify([...scriptIds].sort(compareUtf8))) {
        invalid("Run-template script inventory contains unreachable records.");
    }
    if (JSON.stringify([...usedScenarioIds].sort(compareUtf8)) !== JSON.stringify([...scenarioIds].sort(compareUtf8))) {
        invalid("Run-template scenario inventory contains unreachable records.");
    }
    const customVehicleIds = [...vehicles.keys()].sort(compareUtf8);
    const usedCustomVehicleIds = [...usedVehicleIds].filter((id) => vehicles.has(id)).sort(compareUtf8);
    if (JSON.stringify(usedCustomVehicleIds) !== JSON.stringify(customVehicleIds)) {
        invalid("Run-template vehicle inventory contains unreachable records.");
    }
    if (JSON.stringify([...usedPluginPackages].sort(compareUtf8)) !== JSON.stringify([...pluginPackages].sort(compareUtf8))) {
        invalid("Run-template plugin inventory contains unreachable records.");
    }
    if (manifest.environmentClosure) {
        if (!environment || root.environment.id !== environment.environmentId) invalid("Run manifest environment does not match the packaged environment closure.");
        for (const scenario of scenarios.values()) if (scenario.environment.id !== environment.environmentId) invalid("Scenario environment does not match the packaged environment closure.");
    } else {
        usedBuiltIns.add(`environment\0${root.environment.id}`);
        for (const scenario of scenarios.values()) if (scenario.environment.id !== root.environment.id) invalid("Scenario environment does not match the declared built-in environment.");
    }
    const environmentHash = environment
        ? computeResolvedRunHash(environment)
        : manifest.builtIns.find((entry) => entry.resourceKind === "environment" && entry.resourceId === root.environment.id)?.contentHash;
    if (root.environment.expectedHash && root.environment.expectedHash !== environmentHash) {
        invalid("Run manifest environment lock is stale.");
    }
    for (const scenario of scenarios.values()) {
        if (scenario.environment.expectedHash && scenario.environment.expectedHash !== environmentHash) {
            invalid(`Scenario "${scenario.id}" environment lock is stale.`);
        }
    }
    const declaredBuiltIns = manifest.builtIns.map((entry) => `${entry.resourceKind}\0${entry.resourceId}`).sort(compareUtf8);
    const requiredBuiltIns = [...usedBuiltIns].sort(compareUtf8);
    if (JSON.stringify(declaredBuiltIns) !== JSON.stringify(requiredBuiltIns)) {
        invalid("Run-template built-in inventory is missing or contains unreachable resources.");
    }
}

async function verifyStagedRunTemplate(archive, limits) {
    if (!archive.entries.length || archive.entries[0].name !== RUN_TEMPLATE_PACKAGE_MANIFEST) invalid("Run-template manifest must be the first archive entry.");
    if (archive.entries.length - 1 > limits.payloadEntries) limit("Run-template package exceeds the payload-entry limit.");
    const manifestEntry = archive.entries[0];
    const manifestBytes = await fs.readFile(manifestEntry.path);
    const parsed = parseCanonicalRecord(manifestBytes, manifestEntry.sha256, manifestEntry.sizeBytes, "Run-template manifest");
    const manifest = normalizeRunTemplatePackageManifest(parsed);
    verifyBuiltInDescriptors(manifest);
    if (!manifestBytes.equals(Buffer.from(canonicalMarketplaceBytes(manifest)))) invalid("Run-template manifest is not normalized canonical JSON.");
    const expected = expectedDescriptors(manifest);
    const expectedNames = [
        RUN_TEMPLATE_PACKAGE_MANIFEST,
        ...expected.recordDigests.map((hash) => `${RUN_TEMPLATE_PACKAGE_RECORD_PREFIX}${hash}`),
        ...expected.blobs.map((entry) => `${RUN_TEMPLATE_PACKAGE_BLOB_PREFIX}${entry.sha256}`),
    ];
    if (archive.entries.length !== expectedNames.length || archive.entries.some((entry, index) => entry.name !== expectedNames[index])) {
        invalid("Run-template entries do not exactly match the manifest or canonical ordering.");
    }
    const entries = new Map(archive.entries.map((entry) => [entry.name, entry]));
    const recordBytes = new Map();
    for (const hash of expected.recordDigests) {
        const entry = entries.get(`${RUN_TEMPLATE_PACKAGE_RECORD_PREFIX}${hash}`);
        if (entry.sha256 !== hash) invalid(`Record ${hash} digest does not match its path.`);
        recordBytes.set(hash, await fs.readFile(entry.path));
    }
    const blobEntries = new Map(expected.blobs.map((blob) => {
        const entry = entries.get(`${RUN_TEMPLATE_PACKAGE_BLOB_PREFIX}${blob.sha256}`);
        if (entry.sha256 !== blob.sha256 || entry.sizeBytes !== blob.sizeBytes) invalid(`Blob ${blob.sha256} does not match its descriptor.`);
        return [blob.sha256, { sha256: entry.sha256, sizeBytes: entry.sizeBytes }];
    }));

    const rootSource = parseCanonicalRecord(recordBytes.get(manifest.root.recordSha256), manifest.root.recordSha256, manifest.root.sizeBytes, "Run manifest record");
    const root = normalizeRunManifest(rootSource);
    if (root.id !== manifest.root.manifestId || rootSource.revision !== manifest.root.revision) invalid("Run manifest record identity does not match the package root.");
    const plugins = new Map();
    for (const descriptor of manifest.plugins) {
        const resource = parseCanonicalRecord(recordBytes.get(descriptor.recordSha256), descriptor.recordSha256, descriptor.sizeBytes, `Plugin ${descriptor.pluginId}`);
        const verified = verifyPluginPackage(resource);
        if (verified.document.id !== descriptor.pluginId || verified.document.version !== descriptor.version
            || verified.resource.packageHash !== descriptor.packageHash || verified.resource.runtimeHash !== descriptor.runtimeHash) invalid(`Plugin ${descriptor.pluginId} identity does not match its descriptor.`);
        plugins.set(descriptor.pluginId, verified);
    }
    const sensorRegistry = createSensorDefinitionRegistry([...plugins.values()]);
    const scenarios = new Map();
    for (const descriptor of manifest.scenarios) {
        const source = parseCanonicalRecord(recordBytes.get(descriptor.recordSha256), descriptor.recordSha256, descriptor.sizeBytes, `Scenario ${descriptor.scenarioId}`);
        const scenario = normalizeScenario(source);
        if (scenario.id !== descriptor.scenarioId || source.revision !== descriptor.revision
            || computeResolvedRunHash(stripScenarioMetadata(scenario)) !== descriptor.definitionHash) invalid(`Scenario ${descriptor.scenarioId} identity does not match its descriptor.`);
        const validation = validateScenario(scenario);
        if (!validation.ok) invalid(`Scenario ${descriptor.scenarioId} is invalid: ${validation.issues[0]?.message ?? "unknown error"}.`);
        scenarios.set(descriptor.scenarioId, scenario);
    }
    const vehicles = new Map();
    for (const descriptor of manifest.vehicles) {
        const source = parseCanonicalRecord(recordBytes.get(descriptor.recordSha256), descriptor.recordSha256, descriptor.sizeBytes, `Vehicle ${descriptor.vehicleId}`);
        const vehicle = normalizeVehicleManifest(source, { sensorRegistry });
        const validation = validateVehicleManifest(vehicle, { sensorRegistry });
        if (!validation.ok || vehicle.id !== descriptor.vehicleId || source.revision !== descriptor.revision
            || computeResolvedRunHash(vehicle) !== descriptor.definitionHash) invalid(`Vehicle ${descriptor.vehicleId} is invalid.`);
        const modelAsset = String(vehicle.model?.asset ?? "");
        if (modelAsset && !descriptor.assets.some((entry) => entry.name === modelAsset)) invalid(`Vehicle ${descriptor.vehicleId} is missing its model blob.`);
        vehicles.set(descriptor.vehicleId, vehicle);
    }
    const scripts = new Map();
    for (const descriptor of manifest.scripts) {
        const document = normalizeScriptDocument(parseCanonicalRecord(recordBytes.get(descriptor.recordSha256), descriptor.recordSha256, descriptor.sizeBytes, `Script ${descriptor.scriptId}`));
        if (document.id !== descriptor.scriptId || document.sourceType !== "editable" || !document.graph
            || !document.compileStatus?.valid || !isCompiledArtifact(document.latestValidArtifact)) invalid(`Script ${descriptor.scriptId} is not a complete editable script.`);
        if (computeResolvedRunHash(document.graph) !== descriptor.graphHash
            || computeResolvedRunHash(document.latestValidArtifact) !== descriptor.artifactHash
            || JSON.stringify([...new Set(getGraphScriptReferences(document.graph))].sort(compareUtf8)) !== JSON.stringify(descriptor.scriptReferences)) invalid(`Script ${descriptor.scriptId} identity does not match its descriptor.`);
        scripts.set(descriptor.scriptId, document);
    }
    const scriptState = new Map();
    const visitScript = (scriptId, depth = 1) => {
        if (depth > limits.graphDepth) limit("Run-template script graph exceeds the depth limit.");
        if (scriptState.get(scriptId) === "visiting") invalid(`Run-template script graph contains a cycle at ${scriptId}.`);
        if (scriptState.get(scriptId) === "visited") return;
        const document = scripts.get(scriptId);
        if (!document) invalid(`Run-template script graph references missing script ${scriptId}.`);
        scriptState.set(scriptId, "visiting");
        for (const child of getGraphScriptReferences(document.graph).sort(compareUtf8)) visitScript(child, depth + 1);
        scriptState.set(scriptId, "visited");
    };
    for (const scriptId of [...scripts.keys()].sort(compareUtf8)) visitScript(scriptId);
    const bindings = normalizeBindingManifest(parseCanonicalRecord(recordBytes.get(manifest.bindings.recordSha256), manifest.bindings.recordSha256, manifest.bindings.sizeBytes, "Binding record"));
    if (JSON.stringify(bindings.bindings.map((entry) => entry.id).sort(compareUtf8)) !== JSON.stringify(manifest.bindings.bindingIds)) invalid("Binding identities do not match the package manifest.");

    let environment = null;
    let environmentVerified = null;
    if (manifest.environmentClosure) {
        const envManifest = manifest.environmentClosure;
        environment = parseCanonicalRecord(recordBytes.get(envManifest.environment.recordSha256), envManifest.environment.recordSha256, envManifest.environment.sizeBytes, "Environment record");
        if (environment.environmentId !== envManifest.environment.environmentId || environment.revision !== envManifest.environment.revision
            || createWorldResource(environment).hash !== envManifest.environment.worldHash) invalid("Environment identity does not match its closure descriptor.");
        const roots = [...new Map(collectAssetInstanceReferences(environment.document).map((entry) => [
            `${entry.assetId}@${entry.revision}`,
            { assetId: entry.assetId, revision: entry.revision },
        ])).values()].sort((left, right) => compareUtf8(left.assetId, right.assetId) || left.revision - right.revision);
        if (JSON.stringify(roots) !== JSON.stringify(envManifest.assets.roots)) invalid("Environment asset roots do not match document pins.");
        const assetRecords = new Map(envManifest.assets.assets.flatMap((asset) => asset.revisions.map((entry) => entry.recordSha256))
            .concat(envManifest.assets.uses.map((entry) => entry.recordSha256)).map((hash) => [hash, recordBytes.get(hash)]));
        const assetBlobs = new Map(envManifest.assets.blobs.map((blob) => [blob.sha256, blobEntries.get(blob.sha256)]));
        const assets = verifyAssetClosure({ manifest: envManifest.assets, recordBytes: assetRecords, blobs: assetBlobs, limits });
        const visual = verifyVisualClosure({ manifest: envManifest.visualLayer, recordBytes, blobEntries, limits });
        const uses = new Map(assets.uses);
        for (const [useHash, entry] of visual.uses) {
            const current = uses.get(useHash);
            if (current && JSON.stringify(current.use) !== JSON.stringify(entry.use)) invalid(`Visual use ${useHash} differs between environment closures.`);
            uses.set(useHash, entry);
        }
        const useOrder = [];
        const useState = new Map();
        const visitUse = (useHash, depth = 1) => {
            if (depth > limits.graphDepth) limit("Run-template visual-use graph exceeds the depth limit.");
            if (useState.get(useHash) === "visiting") invalid(`Run-template visual-use graph contains a cycle at ${useHash}.`);
            if (useState.get(useHash) === "visited") return;
            const entry = uses.get(useHash);
            if (!entry) invalid(`Run-template visual-use graph references missing use ${useHash}.`);
            useState.set(useHash, "visiting");
            for (const child of Object.values(entry.use.dependencies).sort(compareUtf8)) visitUse(child, depth + 1);
            useState.set(useHash, "visited");
            useOrder.push(useHash);
        };
        for (const useHash of [...uses.keys()].sort(compareUtf8)) visitUse(useHash);
        environmentVerified = Object.freeze({
            manifest: envManifest,
            manifestSha256: hashMarketplaceBytes(canonicalMarketplaceBytes(envManifest)),
            archiveSha256: archive.sha256,
            archiveSizeBytes: archive.sizeBytes,
            environment,
            world: createWorldResource(environment),
            assets,
            visual,
            revisions: assets.revisions,
            uses,
            assetOrder: assets.assetOrder,
            useOrder: Object.freeze(useOrder),
        });
    }
    const runValidation = validateRunManifest(root, { sensorRegistry });
    if (!runValidation.ok) invalid(`Run manifest is invalid: ${runValidation.issues[0]?.message ?? "unknown error"}.`);
    assertStaticClosure({ manifest, root, scenarios, vehicles, scripts, bindings, plugins, environment });
    const actualContracts = new Map();
    const addContract = (kind, version) => actualContracts.set(`${kind}\0${version}`, { kind, version });
    addContract(root.kind, root.version);
    addContract(bindings.kind, bindings.version);
    if (manifest.environmentClosure) addContract(manifest.environmentClosure.kind, manifest.environmentClosure.version);
    for (const scenario of scenarios.values()) addContract(scenario.kind, scenario.version);
    for (const vehicle of vehicles.values()) addContract(vehicle.kind, vehicle.version);
    for (const script of scripts.values()) {
        addContract(script.kind, script.version);
        addContract(script.latestValidArtifact.kind, script.latestValidArtifact.version);
    }
    for (const plugin of plugins.values()) addContract(plugin.resource.kind, plugin.resource.version);
    for (const builtIn of manifest.builtIns) addContract(builtIn.contractKind, builtIn.contractVersion);
    const expectedContracts = [...actualContracts.values()].sort((left, right) => compareUtf8(left.kind, right.kind) || left.version - right.version);
    if (JSON.stringify(expectedContracts) !== JSON.stringify(manifest.contracts)) invalid("Run-template contract inventory is not exact.");
    return Object.freeze({
        manifest,
        manifestSha256: manifestEntry.sha256,
        archiveSha256: archive.sha256,
        archiveSizeBytes: archive.sizeBytes,
        stagingDir: archive.stagingDir,
        entries: Object.freeze(archive.entries.map((entry) => Object.freeze({ ...entry }))),
        root,
        environment,
        environmentVerified,
        scenarios,
        vehicles,
        scripts,
        bindings,
        plugins,
        cleanup: archive.cleanup,
    });
}

export async function verifyRunTemplatePackage(input, {
    limits: overrides = {}, signal, stagingRoot, stagingDir, retainStaging = true,
} = {}) {
    const limits = packageLimits(overrides);
    const source = typeof input === "string" ? createReadStream(input, { signal }) : input;
    const archive = await verifyDeterministicArchive(source, {
        limits: {
            archiveBytes: limits.archiveBytes,
            entryBytes: limits.blobBytes,
            entries: limits.entries,
            temporaryBytes: limits.temporaryBytes,
            inodes: limits.inodes,
            verificationTimeoutMs: limits.verificationTimeoutMs,
        },
        signal,
        stagingRoot,
        stagingDir,
        retainStaging: true,
        cleanupStaging: stagingDir ? true : undefined,
        entryLimit: ({ index, name }) => index === 0 || name === RUN_TEMPLATE_PACKAGE_MANIFEST
            ? limits.manifestBytes
            : name.startsWith(RUN_TEMPLATE_PACKAGE_RECORD_PREFIX) ? limits.recordBytes : limits.blobBytes,
    });
    try {
        const verified = await verifyStagedRunTemplate(archive, limits);
        if (!retainStaging) await archive.cleanup();
        return verified;
    } catch (error) {
        await archive.cleanup().catch(() => {});
        throw error;
    }
}

export async function inspectRunTemplatePackage({ archivePath, stagingRoot, limits, signal, retainStaging = false }) {
    const verified = await verifyRunTemplatePackage(archivePath, { stagingRoot, limits, signal, retainStaging });
    const inspection = Object.freeze({
        kind: verified.manifest.kind,
        version: verified.manifest.version,
        archiveSha256: verified.archiveSha256,
        archiveSizeBytes: verified.archiveSizeBytes,
        manifestSha256: verified.manifestSha256,
        manifestId: verified.manifest.root.manifestId,
        scenarioCount: verified.manifest.scenarios.length,
        vehicleCount: verified.manifest.vehicles.length,
        scriptCount: verified.manifest.scripts.length,
        bindingCount: verified.manifest.bindings.bindingIds.length,
        plugins: verified.manifest.plugins.map((entry) => ({
            pluginId: entry.pluginId,
            packageHash: entry.packageHash,
            runtimeHash: entry.runtimeHash,
            release: structuredClone(entry.release),
        })),
    });
    if (!retainStaging) await verified.cleanup();
    return inspection;
}

export async function prepareRunTemplatePackage({ archivePath, workDirectory, limits, signal }) {
    const stagingRoot = path.join(workDirectory, "run-template-package-staging");
    await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const verified = await verifyRunTemplatePackage(archivePath, { stagingRoot, limits, signal, retainStaging: true });
    const { preparationHash, index } = createPackagePreparationIndex({
        kind: "cev-sim.run-template-package-preparation",
        archiveSha256: verified.archiveSha256,
        manifestSha256: verified.manifestSha256,
        entries: verified.entries,
    });
    const bytes = Buffer.from(canonicalMarketplaceBytes(index));
    const root = path.join(workDirectory, "run-template-packages");
    const destination = path.join(root, preparationHash);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(verified.stagingDir, "preparation.json"), bytes, { flag: "wx", mode: 0o600 });
    try {
        await fs.rename(verified.stagingDir, destination);
    } catch (error) {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        const existing = await fs.readFile(path.join(destination, "preparation.json"));
        if (!existing.equals(bytes)) invalid("Existing run-template preparation does not match the verified artifact.");
        await verified.cleanup();
    }
    return Object.freeze({ verified, preparationHash, preparationDir: destination, index });
}

export function readRunTemplatePackagePreparation({ workDirectory, preparationHash, archiveSha256 = null }) {
    return readPackagePreparation({
        workDirectory,
        directoryName: "run-template-packages",
        preparationHash,
        archiveSha256,
        kind: "cev-sim.run-template-package-preparation",
        manifestName: RUN_TEMPLATE_PACKAGE_MANIFEST,
        recordPrefix: RUN_TEMPLATE_PACKAGE_RECORD_PREFIX,
        blobPrefix: RUN_TEMPLATE_PACKAGE_BLOB_PREFIX,
    });
}

export async function readPreparedRunTemplateRecord(preparation, recordSha256) {
    digest(recordSha256, "$recordSha256");
    const descriptor = preparation.entry(`${RUN_TEMPLATE_PACKAGE_RECORD_PREFIX}${recordSha256}`);
    return parseCanonicalRecord(await fs.readFile(descriptor.path), recordSha256, descriptor.sizeBytes, `Prepared record ${recordSha256}`);
}
