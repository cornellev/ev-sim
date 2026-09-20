import { comparePluginText, PLUGIN_ID_PATTERN, SHA256_PATTERN } from "./PluginSelection.js";

function normalizeTypes(value, path) {
    if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${path} must be a non-empty array.`);
    const types = value.map((entry, index) => {
        const type = String(entry ?? "").trim();
        if (!type) throw new TypeError(`${path}.${index} is required.`);
        return type;
    }).sort(comparePluginText);
    if (new Set(types).size !== types.length) throw new TypeError(`${path} contains duplicate types.`);
    return types;
}

export function normalizePluginRequirement(value, path = "pluginRequirements.0") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${path} must be an object.`);
    const unknown = Object.keys(value).find((key) => !["pluginId", "version", "runtimeHash", "types"].includes(key));
    if (unknown) throw new TypeError(`${path} contains unknown field "${unknown}".`);
    const pluginId = String(value.pluginId ?? "").trim();
    const version = String(value.version ?? "").trim();
    const runtimeHash = String(value.runtimeHash ?? "").trim();
    if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.startsWith("cev.")) throw new TypeError(`${path}.pluginId is invalid.`);
    if (!version) throw new TypeError(`${path}.version is required.`);
    if (!SHA256_PATTERN.test(runtimeHash)) throw new TypeError(`${path}.runtimeHash must be a lowercase SHA-256 digest.`);
    return Object.freeze({
        pluginId,
        version,
        runtimeHash,
        types: Object.freeze(normalizeTypes(value.types, `${path}.types`)),
    });
}

export function normalizePluginRequirements(value, { path = "pluginRequirements" } = {}) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array.`);
    const records = value.map((entry, index) => normalizePluginRequirement(entry, `${path}.${index}`))
        .sort((left, right) => comparePluginText(left.pluginId, right.pluginId));
    const seen = new Set();
    for (const record of records) {
        if (seen.has(record.pluginId)) throw new TypeError(`${path} contains duplicate pluginId "${record.pluginId}".`);
        seen.add(record.pluginId);
    }
    return Object.freeze(records);
}

export function mergePluginRequirements(...collections) {
    const byPlugin = new Map();
    for (const collection of collections) {
        for (const requirement of normalizePluginRequirements(collection ?? [])) {
            const current = byPlugin.get(requirement.pluginId);
            if (current && (current.version !== requirement.version || current.runtimeHash !== requirement.runtimeHash)) {
                throw new Error(`Plugin "${requirement.pluginId}" has conflicting compiled requirements.`);
            }
            byPlugin.set(requirement.pluginId, {
                pluginId: requirement.pluginId,
                version: requirement.version,
                runtimeHash: requirement.runtimeHash,
                types: new Set([...(current?.types ?? []), ...requirement.types]),
            });
        }
    }
    return [...byPlugin.values()]
        .sort((left, right) => comparePluginText(left.pluginId, right.pluginId))
        .map((entry) => Object.freeze({
            pluginId: entry.pluginId,
            version: entry.version,
            runtimeHash: entry.runtimeHash,
            types: Object.freeze([...entry.types].sort(comparePluginText)),
        }));
}

export function collectArtifactPluginRequirements(artifact, seen = new WeakSet()) {
    if (!artifact || typeof artifact !== "object") return [];
    if (seen.has(artifact)) throw new Error("Nested compiled program requirements contain a cycle.");
    seen.add(artifact);
    try {
        const nested = [];
        for (const node of artifact.nodes ?? []) {
            const child = node?.state?.compiledProgram;
            if (child) nested.push(collectArtifactPluginRequirements(child, seen));
        }
        return mergePluginRequirements(artifact.pluginRequirements ?? [], ...nested);
    } finally {
        seen.delete(artifact);
    }
}

export function requirementsForTypes(types, registry) {
    const ownership = new Map((registry?.snapshot?.() ?? []).map((entry) => [entry.type, entry.ownership]));
    const records = [];
    for (const type of types) {
        const owner = ownership.get(type);
        if (!owner || owner === "builtin") continue;
        records.push([{ pluginId: owner.pluginId, version: owner.version, runtimeHash: owner.runtimeHash, types: [type] }]);
    }
    return mergePluginRequirements(...records);
}

export function assertArtifactPluginRequirements(artifact, registry, selectedPlugins = null) {
    const declared = collectArtifactPluginRequirements(artifact);
    const selected = selectedPlugins
        ? new Map(selectedPlugins.map((entry) => [entry.pluginId, entry]))
        : null;
    const registryEntries = new Map((registry?.snapshot?.() ?? []).map((entry) => [entry.type, entry]));
    for (const requirement of declared) {
        const selectedRecord = selected?.get(requirement.pluginId);
        if (selected && (!selectedRecord || selectedRecord.version !== requirement.version
            || selectedRecord.runtimeHash !== requirement.runtimeHash)) {
            throw new Error(`Plugin requirement ${requirement.pluginId}@${requirement.version} is not selected with runtime ${requirement.runtimeHash}.`);
        }
        for (const type of requirement.types) {
            const entry = registryEntries.get(type);
            const owner = entry?.ownership;
            if (!entry || owner === "builtin" || owner.pluginId !== requirement.pluginId
                || owner.version !== requirement.version || owner.runtimeHash !== requirement.runtimeHash) {
                throw new Error(`Plugin block type "${type}" does not match its compiled requirement.`);
            }
        }
    }
    const actualTypes = new Set();
    const visit = (program) => {
        for (const node of program?.nodes ?? []) {
            const registryEntry = registryEntries.get(node.type);
            if (!registryEntry) {
                throw new Error(`Compiled block type "${node.type}" is unavailable in the selected run registry.`);
            }
            const owner = registryEntry.ownership;
            if (owner && owner !== "builtin") actualTypes.add(node.type);
            if (node?.state?.compiledProgram) visit(node.state.compiledProgram);
        }
    };
    visit(artifact);
    const declaredTypes = new Set(declared.flatMap((entry) => entry.types));
    const missing = [...actualTypes].find((type) => !declaredTypes.has(type));
    if (missing) throw new Error(`Plugin block type "${missing}" is missing from compiled requirements.`);
    const extra = [...declaredTypes].find((type) => !actualTypes.has(type));
    if (extra) throw new Error(`Compiled plugin requirement contains unused block type "${extra}".`);
    return declared;
}
