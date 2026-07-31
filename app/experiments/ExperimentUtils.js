export function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asObject(value) {
    return isPlainObject(value) ? value : {};
}

export function trimmedText(value, fallback = "") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

export function finiteNumber(value, fallback = 0) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : fallback;
}

export function nonNegativeInteger(value, fallback = 0) {
    const normalized = Math.floor(Number(value));
    return Number.isFinite(normalized) && normalized >= 0 ? normalized : fallback;
}

export function cloneValue(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(
        Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
}

export function canonicalStringify(value) {
    return JSON.stringify(canonicalize(value));
}

export function stableHash(value) {
    const input = typeof value === "string" ? value : canonicalStringify(value);
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < input.length; index += 1) {
        const code = input.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
        second ^= second >>> 13;
    }
    return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

export function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const nested of Object.values(value)) deepFreeze(nested);
    return Object.freeze(value);
}

export function uniqueValues(values, key = canonicalStringify) {
    const seen = new Set();
    const result = [];
    for (const value of values) {
        const identity = key(value);
        if (seen.has(identity)) continue;
        seen.add(identity);
        result.push(value);
    }
    return result;
}

export function catalogLookup(catalog, id) {
    if (catalog instanceof Map) return catalog.get(id) ?? null;
    if (Array.isArray(catalog)) return catalog.find((entry) => entry?.id === id) ?? null;
    if (isPlainObject(catalog)) return catalog[id] ?? null;
    return null;
}

export function hasCatalog(catalog) {
    return catalog instanceof Map || Array.isArray(catalog) || isPlainObject(catalog);
}
