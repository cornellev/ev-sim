import {
    listSensorTypes,
    normalizeRunSensor,
    normalizeVehicleSensor,
    sensorTypeRegistry,
    validateRunSensorDefinition,
    validateVehicleSensorDefinition,
} from "../simulation/sensors/SensorTypeRegistry.js";
import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";
import { PLANT_STEP_CAPABILITY } from "./PlantModule.js";
import { clonePluginJson } from "./PluginJson.js";
import { verifyPluginPackage } from "./PluginPackage.js";
import {
    PLUGIN_ID_PATTERN,
    SHA256_PATTERN,
    comparePluginText,
    normalizePluginSelection,
} from "./PluginSelection.js";
import {
    describePluginSensorObservation,
    pluginSensorRangeImageCapability,
} from "./PluginSensorContract.js";

function object(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${path} must be an object.`);
    }
    return value;
}

function exactKeys(value, allowed, path) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) throw new TypeError(`${path} contains unknown field "${unknown}".`);
}

function pluginId(value, path) {
    const normalized = String(value ?? "").trim();
    if (!PLUGIN_ID_PATTERN.test(normalized) || normalized === "cev" || normalized.startsWith("cev.")) {
        throw new TypeError(`${path} must be a lowercase dotted plugin ID outside the reserved cev namespace.`);
    }
    return normalized;
}

function digest(value, path) {
    const normalized = String(value ?? "").trim();
    if (!SHA256_PATTERN.test(normalized)) throw new TypeError(`${path} must be a lowercase SHA-256 digest.`);
    return normalized;
}

function freezeJson(value) {
    return clonePluginJson(JSON.parse(JSON.stringify(value)), "plugin sensor catalog");
}

function uniqueSorted(values) {
    return [...new Set(values.map((entry) => String(entry ?? "").trim()).filter(Boolean))].sort(comparePluginText);
}

function describeBuiltinSensor(definition) {
    return Object.freeze({
        type: definition.id,
        label: definition.label,
        ownership: "builtin",
        descriptor: Object.freeze({
            type: definition.id,
            family: "builtin",
            defaults: Object.freeze({ rateHz: definition.run.defaultRateHz }),
        }),
        requiredCapabilities: Object.freeze([]),
        ui: Object.freeze({ available: true, fallback: "generic" }),
    });
}

function describePluginSensor(descriptor, metadata, document) {
    const ownership = {
        pluginId: metadata.pluginId,
        version: metadata.version,
        packageHash: metadata.packageHash,
        runtimeHash: metadata.runtimeHash,
        ...(metadata.uiHash ? { uiHash: metadata.uiHash } : {}),
    };
    return Object.freeze({
        type: descriptor.type,
        label: descriptor.type,
        ownership: Object.freeze(ownership),
        descriptor: Object.freeze(freezeJson(descriptor)),
        requiredCapabilities: Object.freeze([...(document.capabilities || [])].sort(comparePluginText)),
        ui: Object.freeze({
            available: Boolean(document.entry?.ui),
            fallback: "generic",
        }),
    });
}

export function buildRevisionedSensorCatalog({ library = { revision: 0, packages: [] }, documents = [] } = {}) {
    const revision = Number.isSafeInteger(library.revision) ? library.revision : 0;
    const sensors = listSensorTypes().map(describeBuiltinSensor);
    const metadataByHash = new Map((library.packages || []).map((entry) => [entry.packageHash, entry]));
    const pluginSensors = [];
    for (const item of documents) {
        const document = item.document;
        const metadata = item.metadata || metadataByHash.get(item.resource?.packageHash) || {
            pluginId: document.id,
            version: document.version,
            packageHash: item.resource?.packageHash,
            runtimeHash: item.resource?.runtimeHash,
            ...(item.resource?.uiHash ? { uiHash: item.resource.uiHash } : {}),
        };
        for (const descriptor of document.sensorTypes || []) {
            pluginSensors.push(describePluginSensor(descriptor, metadata, document));
        }
    }
    pluginSensors.sort((left, right) => comparePluginText(left.type, right.type)
        || comparePluginText(left.ownership.packageHash, right.ownership.packageHash));
    return {
        ok: true,
        revision,
        sensors: [...sensors, ...pluginSensors],
    };
}

function normalizePlantIds(value, path) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
    const plants = value.map((entry, index) => {
        const normalized = String(entry ?? "").trim();
        if (!normalized) throw new TypeError(`${path}.${index} is required.`);
        return normalized;
    }).sort(comparePluginText);
    if (new Set(plants).size !== plants.length) throw new TypeError(`${path} contains duplicates.`);
    return plants;
}

export function normalizeVehiclePluginLock(value, path = "pluginLocks.0") {
    const source = object(value, path);
    exactKeys(source, ["pluginId", "version", "packageHash", "runtimeHash", "sensorTypes", "plants"], path);
    const version = String(source.version ?? "").trim();
    if (!version) throw new TypeError(`${path}.version is required.`);
    if (!Array.isArray(source.sensorTypes)) throw new TypeError(`${path}.sensorTypes must be an array.`);
    const sensorTypes = [...source.sensorTypes].map((type, index) => {
        const normalized = String(type ?? "").trim();
        if (!normalized) throw new TypeError(`${path}.sensorTypes.${index} is required.`);
        return normalized;
    }).sort(comparePluginText);
    if (new Set(sensorTypes).size !== sensorTypes.length) {
        throw new TypeError(`${path}.sensorTypes contains duplicates.`);
    }
    const plants = normalizePlantIds(source.plants, `${path}.plants`);
    return Object.freeze({
        pluginId: pluginId(source.pluginId, `${path}.pluginId`),
        version,
        packageHash: digest(source.packageHash, `${path}.packageHash`),
        runtimeHash: digest(source.runtimeHash, `${path}.runtimeHash`),
        sensorTypes: Object.freeze(sensorTypes),
        ...(plants.length > 0 ? { plants: Object.freeze(plants) } : {}),
    });
}

export function normalizeVehiclePluginLocks(value, { path = "pluginLocks" } = {}) {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
    const records = value.map((entry, index) => normalizeVehiclePluginLock(entry, `${path}.${index}`))
        .sort((left, right) => comparePluginText(left.pluginId, right.pluginId));
    const seen = new Set();
    for (const entry of records) {
        if (seen.has(entry.pluginId)) {
            throw new TypeError(`${path} contains duplicate pluginId "${entry.pluginId}".`);
        }
        seen.add(entry.pluginId);
    }
    return records.length > 0 ? records : undefined;
}

export function stampVehiclePluginSensorLock(locks, catalogEntry) {
    const ownership = catalogEntry?.ownership;
    if (!ownership || ownership === "builtin" || typeof ownership !== "object") {
        return normalizeVehiclePluginLocks(locks);
    }
    const type = String(catalogEntry.type ?? "").trim();
    const nextLock = {
        pluginId: ownership.pluginId,
        version: ownership.version,
        packageHash: ownership.packageHash,
        runtimeHash: ownership.runtimeHash,
        sensorTypes: type ? [type] : [],
    };
    const current = normalizeVehiclePluginLocks(locks) ?? [];
    const existing = current.find((entry) => entry.pluginId === nextLock.pluginId);
    if (!existing) return normalizeVehiclePluginLocks([...current, nextLock]);
    if (existing.packageHash !== nextLock.packageHash || existing.runtimeHash !== nextLock.runtimeHash) {
        throw pluginError(
            PLUGIN_ERROR_CODES.REGISTRATION,
            `Vehicle is locked to plugin "${existing.pluginId}" package ${existing.packageHash}; cannot add ${nextLock.packageHash}.`,
            { pluginId: existing.pluginId, packageHash: nextLock.packageHash },
        );
    }
    const sensorTypes = uniqueSorted([...existing.sensorTypes, ...nextLock.sensorTypes]);
    return normalizeVehiclePluginLocks(current.map((entry) => (
        entry.pluginId === existing.pluginId ? { ...entry, sensorTypes } : entry
    )));
}

export function stampVehiclePluginPlantLock(locks, catalogEntry) {
    const plantId = String(catalogEntry?.plantId ?? catalogEntry?.id ?? "").trim();
    if (!plantId) throw new TypeError("A plant id is required to lock vehicle dynamics.");
    const nextLock = {
        pluginId: catalogEntry.pluginId,
        version: catalogEntry.version,
        packageHash: catalogEntry.packageHash,
        runtimeHash: catalogEntry.runtimeHash,
        sensorTypes: [],
        plants: [plantId],
    };
    const current = normalizeVehiclePluginLocks(locks) ?? [];
    const existing = current.find((entry) => entry.pluginId === nextLock.pluginId);
    if (!existing) return normalizeVehiclePluginLocks([...current, nextLock]);
    const hashDiffers = existing.packageHash !== nextLock.packageHash || existing.runtimeHash !== nextLock.runtimeHash;
    if (hashDiffers && existing.sensorTypes.length > 0) {
        throw pluginError(
            PLUGIN_ERROR_CODES.REGISTRATION,
            "Sensors from this plugin are locked to the previous build.",
            { pluginId: existing.pluginId, packageHash: nextLock.packageHash },
        );
    }
    if (hashDiffers) {
        return normalizeVehiclePluginLocks(current.map((entry) => (
            entry.pluginId === existing.pluginId ? nextLock : entry
        )));
    }
    const plants = uniqueSorted([...(existing.plants ?? []), plantId]);
    return normalizeVehiclePluginLocks(current.map((entry) => (
        entry.pluginId === existing.pluginId ? { ...entry, plants } : entry
    )));
}

export function reconcileVehiclePluginLocks(locks, sensors = [], { sensorRegistry = sensorTypeRegistry, dynamics = null } = {}) {
    if (locks === undefined || locks === null) return undefined;
    const current = normalizeVehiclePluginLocks(locks) ?? [];
    const typesByPlugin = new Map();
    const usedTypes = new Set();
    for (const sensor of sensors) {
        const type = String(sensor?.type ?? "").trim();
        if (!type) continue;
        usedTypes.add(type);
        const ownership = sensorRegistry.get(type)?.pluginSensor?.ownership;
        if (!ownership?.pluginId) continue;
        const types = typesByPlugin.get(ownership.pluginId) ?? [];
        if (!types.includes(type)) types.push(type);
        typesByPlugin.set(ownership.pluginId, types);
    }
    const selectedPlant = typeof dynamics?.plant === "string" ? dynamics.plant : "";
    const next = [];
    for (const lock of current) {
        const preserved = [];
        for (const type of lock.sensorTypes) {
            if (!usedTypes.has(type)) continue;
            const definition = sensorRegistry.get(type);
            if (!definition) {
                preserved.push(type);
                continue;
            }
            if (definition.pluginSensor?.ownership?.pluginId === lock.pluginId) preserved.push(type);
        }
        const types = uniqueSorted([...(typesByPlugin.get(lock.pluginId) ?? []), ...preserved]);
        const plants = selectedPlant && (lock.plants ?? []).includes(selectedPlant) ? [selectedPlant] : [];
        if (types.length === 0 && plants.length === 0) continue;
        next.push({
            pluginId: lock.pluginId,
            version: lock.version,
            packageHash: lock.packageHash,
            runtimeHash: lock.runtimeHash,
            sensorTypes: types,
            ...(plants.length > 0 ? { plants } : {}),
        });
    }
    return normalizeVehiclePluginLocks(next);
}

function requiredSensorGrants(catalogEntry) {
    const required = [...(catalogEntry?.requiredCapabilities ?? [])];
    if (!required.includes(pluginSensorRangeImageCapability())) {
        required.push(pluginSensorRangeImageCapability());
    }
    return uniqueSorted(required);
}

export function stampManifestPluginSelectionForSensor(selection, catalogEntry) {
    const ownership = catalogEntry?.ownership;
    if (!ownership || ownership === "builtin" || typeof ownership !== "object") {
        return normalizePluginSelection(selection);
    }
    const current = normalizePluginSelection(selection) ?? { enabled: true, artifacts: [] };
    const grants = requiredSensorGrants(catalogEntry);
    const existing = current.artifacts.find((entry) => entry.pluginId === ownership.pluginId);
    if (!existing) {
        return normalizePluginSelection({
            enabled: true,
            artifacts: [...current.artifacts, {
                pluginId: ownership.pluginId,
                expectedHash: ownership.packageHash,
                capabilities: grants,
            }],
        });
    }
    if (existing.expectedHash !== ownership.packageHash) {
        throw pluginError(
            PLUGIN_ERROR_CODES.REGISTRATION,
            `Run is locked to plugin "${existing.pluginId}" package ${existing.expectedHash}; cannot add ${ownership.packageHash}.`,
            { pluginId: existing.pluginId, packageHash: ownership.packageHash },
        );
    }
    const capabilities = uniqueSorted([...existing.capabilities, ...grants]);
    return normalizePluginSelection({
        enabled: true,
        artifacts: current.artifacts.map((entry) => (
            entry.pluginId === existing.pluginId ? { ...entry, capabilities } : entry
        )),
    });
}

export function stampManifestPluginSelectionForPlant(selection, lock) {
    const plugin = String(lock?.pluginId ?? "").trim();
    const packageHash = String(lock?.packageHash ?? "").trim();
    if (!plugin || !packageHash) throw new TypeError("A plant lock requires pluginId and packageHash.");
    const current = normalizePluginSelection(selection) ?? { enabled: true, artifacts: [] };
    const existing = current.artifacts.find((entry) => entry.pluginId === plugin);
    if (!existing) {
        return normalizePluginSelection({
            enabled: true,
            artifacts: [...current.artifacts, {
                pluginId: plugin,
                expectedHash: packageHash,
                capabilities: [PLANT_STEP_CAPABILITY],
            }],
        });
    }
    const capabilities = uniqueSorted([...existing.capabilities, PLANT_STEP_CAPABILITY]);
    return normalizePluginSelection({
        enabled: true,
        artifacts: current.artifacts.map((entry) => (
            entry.pluginId === plugin ? { ...entry, expectedHash: packageHash, capabilities } : entry
        )),
    });
}

export function verifyVehiclePluginLockAgainstPackage(lock, verified, path = "pluginLocks") {
    if (!verified?.document || !verified?.resource) {
        throw new Error(`${path}: plugin package ${lock.packageHash} is not available.`);
    }
    if (verified.document.id !== lock.pluginId
        || verified.document.version !== lock.version
        || verified.resource.packageHash !== lock.packageHash
        || verified.resource.runtimeHash !== lock.runtimeHash) {
        throw new Error(`${path}: plugin "${lock.pluginId}" does not match package ${lock.packageHash}.`);
    }
    const declared = new Set((verified.document.sensorTypes ?? []).map((entry) => entry.type));
    for (const type of lock.sensorTypes) {
        if (!declared.has(type)) {
            throw new Error(`${path}: plugin "${lock.pluginId}" does not declare sensor type "${type}".`);
        }
    }
    const declaredPlants = new Set((verified.document.plants ?? []).map((entry) => entry.id));
    for (const plantId of lock.plants ?? []) {
        if (!declaredPlants.has(plantId)) {
            throw new Error(`${path}: plugin "${lock.pluginId}" does not declare plant "${plantId}".`);
        }
    }
    return verified;
}

export function assertVehiclePluginLocksMatchRun({
    vehicles = [],
    plugins = [],
    pluginPackages = [],
} = {}) {
    const pluginById = new Map(plugins.map((entry) => [entry.pluginId, entry]));
    const packageByHash = new Map();
    for (const resource of pluginPackages) {
        const verified = verifyPluginPackage(resource);
        packageByHash.set(verified.resource.packageHash, verified);
    }
    for (const record of vehicles) {
        const vehicleId = record?.vehicleId || record?.manifest?.id || "vehicle";
        const locks = normalizeVehiclePluginLocks(record?.manifest?.pluginLocks) ?? [];
        for (const lock of locks) {
            const plugin = pluginById.get(lock.pluginId);
            if (!plugin) {
                throw new Error(`Vehicle "${vehicleId}" requires plugin "${lock.pluginId}" in the run selection.`);
            }
            if (plugin.version !== lock.version
                || plugin.packageHash !== lock.packageHash
                || plugin.runtimeHash !== lock.runtimeHash) {
                throw new Error(`Vehicle "${vehicleId}" plugin "${lock.pluginId}" conflicts with the run selection.`);
            }
            if (lock.sensorTypes.length > 0 && !plugin.capabilities.includes(pluginSensorRangeImageCapability())) {
                throw new Error(`Vehicle "${vehicleId}" plugin "${lock.pluginId}" is missing grant "${pluginSensorRangeImageCapability()}".`);
            }
            if ((lock.plants?.length ?? 0) > 0 && !plugin.capabilities.includes(PLANT_STEP_CAPABILITY)) {
                throw new Error(`Vehicle "${vehicleId}" plugin "${lock.pluginId}" is missing grant "${PLANT_STEP_CAPABILITY}".`);
            }
            const verified = packageByHash.get(lock.packageHash);
            if (!verified) {
                throw new Error(`Vehicle "${vehicleId}" plugin package ${lock.packageHash} is not in the portable closure.`);
            }
            verifyVehiclePluginLockAgainstPackage(lock, verified, `vehicles.${vehicleId}.pluginLocks`);
        }
    }
}

export function collectVehiclePluginLockIssues(manifest, { sensorRegistry = sensorTypeRegistry } = {}) {
    const issues = [];
    const locks = manifest.pluginLocks ?? [];
    const seenTypes = new Map();
    for (const [lockIndex, lock] of locks.entries()) {
        for (const type of lock.sensorTypes) {
            if (seenTypes.has(type)) {
                issues.push({
                    path: `pluginLocks.${lockIndex}.sensorTypes`,
                    message: `Sensor type "${type}" is locked by more than one plugin.`,
                });
            }
            seenTypes.set(type, lock);
        }
    }
    if (manifest.dynamics?.plant) {
        const lock = locks.find((entry) => entry.plants?.includes(manifest.dynamics.plant));
        if (!lock) {
            issues.push({
                path: "dynamics.plant",
                message: `Plant "${manifest.dynamics.plant}" has no matching plugin lock.`,
            });
        }
    }
    for (const [index, sensor] of (manifest.sensors ?? []).entries()) {
        const definition = sensorRegistry.get(sensor.type);
        const plugin = definition?.pluginSensor;
        const builtin = sensorTypeRegistry.has(sensor.type) && !plugin;
        if (builtin) continue;
        if (!plugin && definition) continue;
        const lock = seenTypes.get(sensor.type);
        if (!lock) {
            issues.push({
                path: `sensors.${index}.type`,
                message: `Custom sensor type "${sensor.type}" must appear in exactly one matching vehicle plugin lock.`,
            });
            continue;
        }
        if (plugin && lock.pluginId !== plugin.ownership.pluginId) {
            issues.push({
                path: `sensors.${index}.type`,
                message: `Sensor "${sensor.id}" type "${sensor.type}" does not match plugin lock "${lock.pluginId}".`,
            });
        }
    }
    return issues;
}

function pathParts(path) {
    if (Array.isArray(path)) return path.map((part) => String(part));
    return String(path ?? "").split(".").filter((part) => part.length > 0);
}

function setPath(target, parts, value) {
    if (parts.length === 0) throw new TypeError("A sensor patch path is required.");
    let cursor = target;
    for (const part of parts.slice(0, -1)) {
        if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) {
            cursor[part] = {};
        }
        cursor = cursor[part];
    }
    cursor[parts.at(-1)] = value;
    return target;
}

function declaredParameterKeys(descriptor) {
    return new Set((descriptor.settings ?? []).map((entry) => entry.key));
}

function declaredProductIds(descriptor) {
    return new Set((descriptor.products ?? []).map((entry) => entry.productId));
}

function declaredOutputKeys(descriptor) {
    return new Set((descriptor.products ?? [])
        .filter((entry) => entry.kind === "pointCloud")
        .map((entry) => entry.outputKey));
}

function resolveAuthoringPatchPath(path, context, descriptor) {
    const parts = pathParts(path);
    const joined = parts.join(".");
    const root = context === "vehicle" ? "config" : "calibration";
    const prefixed = joined.startsWith("calibration.") || joined.startsWith("config.") || joined.startsWith("outputs.")
        ? parts
        : [root, ...parts];
    const normalized = prefixed.join(".");
    if (context === "vehicle") {
        if (normalized === "config.scanLayout" || normalized === "config.rateHz") return prefixed;
        if (normalized.startsWith("config.parameters.")) {
            const key = prefixed[2];
            if (!declaredParameterKeys(descriptor).has(key) || prefixed.length !== 3) {
                throw new TypeError(`Cannot patch undeclared sensor path "${joined}".`);
            }
            return prefixed;
        }
        if (normalized.startsWith("config.products.")) {
            const key = prefixed[2];
            if (!declaredProductIds(descriptor).has(key) || prefixed.length !== 3) {
                throw new TypeError(`Cannot patch undeclared sensor path "${joined}".`);
            }
            return prefixed;
        }
    } else {
        if (normalized === "calibration.scanLayout") return prefixed;
        if (normalized.startsWith("calibration.parameters.")) {
            const key = prefixed[2];
            if (!declaredParameterKeys(descriptor).has(key) || prefixed.length !== 3) {
                throw new TypeError(`Cannot patch undeclared sensor path "${joined}".`);
            }
            return prefixed;
        }
        if (normalized.startsWith("calibration.products.")) {
            const key = prefixed[2];
            if (!declaredProductIds(descriptor).has(key) || prefixed.length !== 3) {
                throw new TypeError(`Cannot patch undeclared sensor path "${joined}".`);
            }
            return prefixed;
        }
        if (normalized.startsWith("outputs.")) {
            const key = prefixed[1];
            if (!declaredOutputKeys(descriptor).has(key) || prefixed.length !== 2) {
                throw new TypeError(`Cannot patch undeclared sensor path "${joined}".`);
            }
            return prefixed;
        }
    }
    throw new TypeError(`Cannot patch undeclared sensor path "${joined}".`);
}

export function applyPluginSensorAuthoringPatch(sensor, definition, { path, value } = {}, { context = "run" } = {}) {
    const descriptor = definition?.pluginSensor?.descriptor;
    if (!descriptor) throw new TypeError("Custom sensor patches require a plugin sensor definition.");
    const parts = resolveAuthoringPatchPath(path, context, descriptor);
    const candidate = structuredClone(sensor);
    setPath(candidate, parts, value);
    if (context === "vehicle") {
        const normalized = {
            ...candidate,
            config: definition.vehicle.normalize(candidate),
        };
        const issues = definition.vehicle.validate?.(normalized) || [];
        if (issues.length) throw new TypeError(issues[0].message);
        return normalized;
    }
    const specific = definition.run.normalize(candidate);
    const normalized = {
        ...candidate,
        calibration: specific.calibration,
        schema: specific.schema,
        health: specific.health || candidate.health,
        determinism: specific.determinism || candidate.determinism,
    };
    const issues = definition.run.validate?.(normalized) || [];
    if (issues.length) throw new TypeError(issues[0].message);
    return normalized;
}

function registryWithDefinition(sensorRegistry, definition) {
    if (definition?.id && sensorRegistry.get(definition.id)) return sensorRegistry;
    return {
        get(type) {
            if (definition?.id && type === definition.id) return definition;
            return sensorRegistry.get(type);
        },
        has(type) {
            return (definition?.id && type === definition.id) || Boolean(sensorRegistry.get(type));
        },
    };
}

export function commitPluginSensorAuthoringPatch(sensor, definition, patch, {
    context = "run",
    sensorRegistry = sensorTypeRegistry,
    index = 0,
} = {}) {
    const registry = registryWithDefinition(sensorRegistry, definition);
    const patched = applyPluginSensorAuthoringPatch(sensor, definition, patch, { context });
    if (context === "vehicle") {
        const normalized = normalizeVehicleSensor(patched, index, registry);
        const issues = validateVehicleSensorDefinition(normalized, registry);
        if (issues.length) throw new TypeError(issues[0].message);
        return normalized;
    }
    const normalized = normalizeRunSensor(patched, index, registry);
    const issues = validateRunSensorDefinition(normalized, registry);
    if (issues.length) throw new TypeError(issues[0].message);
    return normalized;
}

export function pluginSensorCatalogEntryForType(catalog, type, packageHash = null) {
    const sensors = catalog?.sensors ?? [];
    if (packageHash) {
        const exact = sensors.find((entry) => entry.type === type && entry.ownership?.packageHash === packageHash);
        if (exact) return exact;
    }
    return sensors.find((entry) => entry.type === type) || null;
}

export function stampInheritedPluginSelections(manifest, catalog, registry = sensorTypeRegistry) {
    let next = manifest;
    const issues = [];
    for (const [index, sensor] of (manifest?.sensorRig?.sensors ?? []).entries()) {
        if (!sensor?.inheritedFrom) continue;
        const definition = registry.get(sensor.type);
        const entry = pluginSensorCatalogEntryForType(catalog, sensor.type);
        const pluginOwned = Boolean(definition?.pluginSensor) || (entry && entry.ownership !== "builtin");
        if (!pluginOwned) continue;
        if (!entry?.ownership || entry.ownership === "builtin") {
            issues.push({
                path: `sensorRig.sensors.${index}.type`,
                message: `Inherited sensor "${sensor.id}" requires plugin type "${sensor.type}" in the sensor catalog.`,
            });
            continue;
        }
        try {
            const plugins = stampManifestPluginSelectionForSensor(next.plugins, entry);
            if (plugins !== next.plugins) next = { ...next, plugins };
        } catch (error) {
            issues.push({
                path: "plugins",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { manifest: next, issues };
}

export function sensorCatalogEntries(catalog, registry = sensorTypeRegistry) {
    if (catalog?.sensors?.length) return catalog.sensors;
    return registry.list().map((definition) => ({
        type: definition.id,
        label: definition.label,
        ownership: "builtin",
    }));
}

export function sensorCatalogEntryKey(entry) {
    const owner = entry?.ownership;
    const hash = owner && owner !== "builtin" ? owner.packageHash : "builtin";
    return `${entry?.type ?? ""}:${hash || "builtin"}`;
}

export function sensorCatalogEntryLabel(entry) {
    return entry?.label || entry?.type || "";
}

function catalogPackageIdentity(entry) {
    const owner = entry?.ownership;
    if (!owner || owner === "builtin") return "builtin";
    return `${owner.packageHash || ""}@${owner.version || ""}`;
}

export function sensorCatalogEntryChoiceLabel(entry, entries = []) {
    const label = sensorCatalogEntryLabel(entry);
    const sameType = entries.filter((item) => item?.type === entry?.type);
    const identities = new Set(sameType.map(catalogPackageIdentity));
    if (identities.size < 2) return label;
    const owner = entry?.ownership;
    if (!owner || owner === "builtin") return label;
    const versions = new Set(sameType.map((item) => (
        item?.ownership && item.ownership !== "builtin" ? item.ownership.version || "" : "builtin"
    )));
    if (versions.size > 1 && owner.version) return `${label} (${owner.version})`;
    const hash = String(owner.packageHash || "");
    return hash ? `${label} (${hash.slice(0, 8)})` : label;
}

export { describePluginSensorObservation };
