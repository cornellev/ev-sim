/**
 * Fallback coercions for authoring and runtime documents.
 * Do not use these in hashed world/episode identity — those paths must keep
 * `canonicalFiniteNumber` in `simulation/kernel/SimulationHashes.js`.
 */

export function clonePlain(value) {
    if (value === undefined) return undefined;
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
}

export function plainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function clonePlainObject(value) {
    return clonePlain(plainObject(value));
}

export function plainText(value, fallback = "") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
}

export function finiteOr(value, fallback = 0) {
    const normalized = Number(value);
    return Number.isFinite(normalized) ? normalized : fallback;
}

export function positiveOr(value, fallback) {
    const normalized = finiteOr(value, fallback);
    return normalized > 0 ? normalized : fallback;
}

export function nonNegativeOr(value, fallback) {
    const normalized = finiteOr(value, fallback);
    return normalized >= 0 ? normalized : fallback;
}

export function nonNegativeIntegerOr(value, fallback = 0) {
    const normalized = Math.floor(finiteOr(value, fallback));
    return normalized >= 0 ? normalized : fallback;
}

export function positiveIntegerOr(value, fallback = 1) {
    const normalized = Math.floor(finiteOr(value, fallback));
    return normalized > 0 ? normalized : fallback;
}

export function vec3(value = {}, fallback = {}) {
    const source = plainObject(value);
    return {
        x: finiteOr(source.x, fallback.x ?? 0),
        y: finiteOr(source.y, fallback.y ?? 0),
        z: finiteOr(source.z, fallback.z ?? 0),
    };
}

export function euler(value = {}) {
    const source = plainObject(value);
    return { ...vec3(source), order: plainText(source.order, "XYZ") };
}

export function pose(value = {}) {
    const source = plainObject(value);
    return {
        position: vec3(source.position),
        rotation: euler(source.rotation),
    };
}
