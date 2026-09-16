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
