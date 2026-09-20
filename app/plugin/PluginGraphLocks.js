import { PLUGIN_ERROR_CODES, pluginError } from "./PluginErrors.js";
import {
    PLUGIN_ID_PATTERN,
    SHA256_PATTERN,
    comparePluginText,
} from "./PluginSelection.js";

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

function freezePorts(ports) {
    const source = ports && typeof ports === "object" ? ports : {};
    const side = (name) => Object.freeze({ ...(source[name] && typeof source[name] === "object" ? source[name] : {}) });
    return Object.freeze({ inputs: side("inputs"), outputs: side("outputs") });
}

export function normalizeGraphPluginLock(value, path = "pluginLocks.0") {
    const source = object(value, path);
    exactKeys(source, ["pluginId", "version", "packageHash", "runtimeHash", "types"], path);
    const version = String(source.version ?? "").trim();
    if (!version) throw new TypeError(`${path}.version is required.`);
    if (!Array.isArray(source.types)) throw new TypeError(`${path}.types must be an array.`);
    const types = [...source.types].map((type, index) => {
        const normalized = String(type ?? "").trim();
        if (!normalized) throw new TypeError(`${path}.types.${index} is required.`);
        return normalized;
    }).sort(comparePluginText);
    if (new Set(types).size !== types.length) throw new TypeError(`${path}.types contains duplicates.`);
    return Object.freeze({
        pluginId: pluginId(source.pluginId, `${path}.pluginId`),
        version,
        packageHash: digest(source.packageHash, `${path}.packageHash`),
        runtimeHash: digest(source.runtimeHash, `${path}.runtimeHash`),
        types: Object.freeze(types),
    });
}

export function normalizeGraphPluginLocks(value, { path = "pluginLocks" } = {}) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
    const records = value.map((entry, index) => normalizeGraphPluginLock(entry, `${path}.${index}`))
        .sort((left, right) => comparePluginText(left.pluginId, right.pluginId));
    const seen = new Set();
    for (const entry of records) {
        if (seen.has(entry.pluginId)) {
            throw new TypeError(`${path} contains duplicate pluginId "${entry.pluginId}".`);
        }
        seen.add(entry.pluginId);
    }
    return records;
}

export function stampGraphPluginLock(locks, catalogEntry) {
    const current = normalizeGraphPluginLocks(locks);
    const ownership = catalogEntry?.ownership;
    if (!ownership || ownership === "builtin" || typeof ownership !== "object") return current;
    const type = String(catalogEntry.type ?? "").trim();
    const nextLock = {
        pluginId: ownership.pluginId,
        version: ownership.version,
        packageHash: ownership.packageHash,
        runtimeHash: ownership.runtimeHash,
        types: type ? [type] : [],
    };
    const existing = current.find((entry) => entry.pluginId === nextLock.pluginId);
    if (!existing) return normalizeGraphPluginLocks([...current, nextLock]);
    if (existing.packageHash !== nextLock.packageHash || existing.runtimeHash !== nextLock.runtimeHash) {
        throw pluginError(
            PLUGIN_ERROR_CODES.REGISTRATION,
            `Graph is locked to plugin "${existing.pluginId}" package ${existing.packageHash}; cannot add ${nextLock.packageHash}.`,
            { pluginId: existing.pluginId, packageHash: nextLock.packageHash },
        );
    }
    const types = [...new Set([...existing.types, ...nextLock.types])];
    return normalizeGraphPluginLocks(current.map((entry) => (
        entry.pluginId === existing.pluginId ? { ...entry, types } : entry
    )));
}

export function portsForAuthoringNode(node, _lock = null, document = null) {
    if (node?.ports && typeof node.ports === "object") return freezePorts(node.ports);
    const type = String(node?.type ?? "");
    const unit = document?.units?.find((entry) => entry.type === type);
    if (unit?.ports) return freezePorts(unit.ports);
    return freezePorts({ inputs: {}, outputs: {} });
}

export function pluginOwnershipFromUnit(unit) {
    const ownership = unit?.constructor?.pluginOwnership;
    if (!ownership || ownership === "builtin" || typeof ownership !== "object") return null;
    return ownership;
}
