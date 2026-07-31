function hash(value) {
    const text = String(value ?? "visual-script");
    let state = 1779033703;
    for (let index = 0; index < text.length; index += 1) {
        state = Math.imul(state ^ text.charCodeAt(index), 3432918353);
        state = (state << 13) | (state >>> 19);
    }
    return state >>> 0;
}

function fallbackRandom(unit) {
    unit._deterministicRandomState ??= hash(unit.uuid);
    let value = (unit._deterministicRandomState += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/** Use a run-scoped deterministic RNG, with a stable per-unit fallback. */
export function runtimeRandom(unit) {
    const supplied = unit?.manager?.getRuntimeContext?.()?.random;
    const value = typeof supplied === "function" ? supplied() : fallbackRandom(unit);
    return Math.max(0, Math.min(1 - Number.EPSILON, Number(value) || 0));
}
