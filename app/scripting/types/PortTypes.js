/**
 * Editor/runtime port type helpers.
 * `generic` is editor-only. Compiled artifacts never contain it.
 * `unit` is a concrete sequencing token. `actor_command` is a concrete value type.
 */

export const GENERIC_TYPE = "generic";
export const UNIT_TYPE = "unit";
export const UNIT = Object.freeze({ type: UNIT_TYPE });
export const ACTOR_COMMAND_TYPE = "actor_command";

export function finiteFloat(value, fallback = 0) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;

    const parsedFallback = Number.parseFloat(fallback);
    return Number.isFinite(parsedFallback) ? parsedFallback : 0;
}

export function finiteInt32(value, fallback = 0) {
    const parsed = finiteFloat(value, fallback);
    const truncated = Math.trunc(parsed);
    return Math.max(-2147483648, Math.min(2147483647, truncated));
}

export function finiteResult(value) {
    return Number.isFinite(value) ? value : 0;
}

export function orderedBounds(min, max) {
    let lower = finiteFloat(min);
    let upper = finiteFloat(max);
    if (lower > upper) {
        const swap = lower;
        lower = upper;
        upper = swap;
    }
    return { min: lower, max: upper };
}

export function valuesEqual(a, b) {
    if (typeof a === "number" && typeof b === "number") {
        return Object.is(a, b) || (a === 0 && b === 0);
    }
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let index = 0; index < a.length; index += 1) {
            if (!valuesEqual(a[index], b[index])) return false;
        }
        return true;
    }
    if (
        a !== null
        && b !== null
        && typeof a === "object"
        && typeof b === "object"
        && !Array.isArray(a)
        && !Array.isArray(b)
    ) {
        const aKeys = Object.keys(a);
        const bKeys = Object.keys(b);
        if (aKeys.length !== bKeys.length) return false;
        for (const key of aKeys) {
            if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
            if (!valuesEqual(a[key], b[key])) return false;
        }
        return true;
    }
    return false;
}

export function normalizeActorCommand(value) {
    let source = value;

    if (typeof source === "string") {
        const trimmed = source.trim();
        if (trimmed.length === 0) {
            source = {};
        } else {
            try {
                const parsed = JSON.parse(trimmed);
                source = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
            } catch {
                source = {};
            }
        }
    }

    if (!source || typeof source !== "object" || Array.isArray(source)) {
        source = {};
    }

    return {
        actorId: source.actorId == null ? "" : String(source.actorId),
        speedMps: finiteFloat(source.speedMps),
        steeringRad: finiteFloat(source.steeringRad),
    };
}

export function isGeneric(type) {
    return type === GENERIC_TYPE;
}

export function isConcreteType(type) {
    return typeof type === "string" && type.length > 0 && type !== GENERIC_TYPE;
}

export function portsCompatible(a, b) {
    if (!isConcreteType(a) && !isGeneric(a)) return false;
    if (!isConcreteType(b) && !isGeneric(b)) return false;
    if (isGeneric(a) || isGeneric(b)) return true;
    return a === b;
}

export function baseTypeName(type) {
    if (typeof type !== "string" || type.length === 0) return type;
    return type.replace(/\[.*?\]/, "") || type;
}
