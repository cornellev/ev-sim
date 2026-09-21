import {
    listSensorTypes,
    normalizeRunSensor,
    normalizeVehicleSensor,
    sensorTypeRegistry,
    validateRunSensorDefinition,
    validateVehicleSensorDefinition,
} from "../simulation/sensors/SensorTypeRegistry.js";
import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";
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

export function normalizeVehiclePluginLock(value, path = "pluginLocks.0") {
    const source = object(value, path);
    exactKeys(source, ["pluginId", "version", "packageHash", "runtimeHash", "sensorTypes"], path);
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
    return Object.freeze({
        pluginId: pluginId(source.pluginId, `${path}.pluginId`),
        version,
        packageHash: digest(source.packageHash, `${path}.packageHash`),
        runtimeHash: digest(source.runtimeHash, `${path}.runtimeHash`),
        sensorTypes: Object.freeze(sensorTypes),
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

export function reconcileVehiclePluginLocks(locks, sensors = [], { sensorRegistry = sensorTypeRegistry } = {}) {
    if (locks === undefined || locks === null) return undefined;
    const current = normalizeVehiclePluginLocks(locks) ?? [];
    const typesByPlugin = new Map();
    for (const sensor of sensors) {
        const ownership = sensorRegistry.get(sensor?.type)?.pluginSensor?.ownership;
        if (!ownership?.pluginId) continue;
        const types = typesByPlugin.get(ownership.pluginId) ?? [];
        if (!types.includes(sensor.type)) types.push(sensor.type);
        typesByPlugin.set(ownership.pluginId, types);
    }
    const next = [];
    for (const lock of current) {
        const types = typesByPlugin.get(lock.pluginId);
        if (!types?.length) continue;
        next.push({ ...lock, sensorTypes: types });
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
            if (!plugin.capabilities.includes(pluginSensorRangeImageCapability())) {
                throw new Error(`Vehicle "${vehicleId}" plugin "${lock.pluginId}" is missing grant "${pluginSensorRangeImageCapability()}".`);
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

export function pluginSensorCatalogEntryForType(catalog, type) {
    return (catalog?.sensors ?? []).find((entry) => entry.type === type) || null;
}

export { describePluginSensorObservation };
