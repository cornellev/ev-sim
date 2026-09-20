import { validateCapabilityGrants } from "../plugin-api/capabilities.js";

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const encoder = new TextEncoder();

export function comparePluginText(left, right) {
    const a = encoder.encode(String(left));
    const b = encoder.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

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

function capabilities(value, path) {
    try {
        return [...validateCapabilityGrants(value ?? [], value ?? [], value ?? [])]
            .sort(comparePluginText);
    } catch (error) {
        throw new TypeError(`${path}: ${error.message}`, { cause: error });
    }
}

export function normalizePluginArtifactLock(value, path = "plugins.artifacts.0") {
    const source = object(value, path);
    exactKeys(source, ["pluginId", "expectedHash", "capabilities"], path);
    return Object.freeze({
        pluginId: pluginId(source.pluginId, `${path}.pluginId`),
        expectedHash: digest(source.expectedHash, `${path}.expectedHash`),
        capabilities: Object.freeze(capabilities(source.capabilities, `${path}.capabilities`)),
    });
}

export function normalizePluginSelection(value, { path = "plugins" } = {}) {
    if (value === undefined || value === null) return null;
    const source = object(value, path);
    exactKeys(source, ["enabled", "artifacts"], path);
    if (source.enabled !== undefined && typeof source.enabled !== "boolean") {
        throw new TypeError(`${path}.enabled must be boolean.`);
    }
    if (!Array.isArray(source.artifacts ?? [])) throw new TypeError(`${path}.artifacts must be an array.`);
    const artifacts = (source.artifacts ?? [])
        .map((entry, index) => normalizePluginArtifactLock(entry, `${path}.artifacts.${index}`))
        .sort((left, right) => comparePluginText(left.pluginId, right.pluginId));
    const seen = new Set();
    for (const entry of artifacts) {
        if (seen.has(entry.pluginId)) throw new TypeError(`${path}.artifacts contains duplicate pluginId "${entry.pluginId}".`);
        seen.add(entry.pluginId);
    }
    if (artifacts.length === 0 && source.enabled !== true) return null;
    return Object.freeze({ enabled: source.enabled !== false, artifacts: Object.freeze(artifacts) });
}

export function effectivePluginLocks(selection) {
    return selection?.enabled === true ? selection.artifacts ?? [] : [];
}

export function normalizeResolvedPlugin(value, path = "resolved.plugins.0") {
    const source = object(value, path);
    exactKeys(source, ["pluginId", "version", "packageHash", "runtimeHash", "capabilities"], path);
    const version = String(source.version ?? "").trim();
    if (!version) throw new TypeError(`${path}.version is required.`);
    return Object.freeze({
        pluginId: pluginId(source.pluginId, `${path}.pluginId`),
        version,
        packageHash: digest(source.packageHash, `${path}.packageHash`),
        runtimeHash: digest(source.runtimeHash, `${path}.runtimeHash`),
        capabilities: Object.freeze(capabilities(source.capabilities, `${path}.capabilities`)),
    });
}

export function normalizeResolvedPlugins(value, { path = "resolved.plugins" } = {}) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
    const records = value.map((entry, index) => normalizeResolvedPlugin(entry, `${path}.${index}`))
        .sort((left, right) => comparePluginText(left.pluginId, right.pluginId));
    const seen = new Set();
    for (const entry of records) {
        if (seen.has(entry.pluginId)) throw new TypeError(`${path} contains duplicate pluginId "${entry.pluginId}".`);
        seen.add(entry.pluginId);
    }
    return Object.freeze(records);
}

export function pluginDependencyHashes(records = []) {
    return Object.freeze(Object.fromEntries(
        [...records]
            .sort((left, right) => comparePluginText(left.pluginId, right.pluginId))
            .map((entry) => [entry.pluginId, entry.packageHash]),
    ));
}

export function encodePluginSignalSegment(pluginIdValue) {
    return String(pluginIdValue).replaceAll("-", "_h_").replaceAll(".", "_d_");
}
