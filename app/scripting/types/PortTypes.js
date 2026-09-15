/**
 * Editor/runtime port type helpers.
 * `generic` is editor-only. Compiled artifacts never contain it.
 * `unit` is a concrete sequencing token. Future value types (`actor_command`) belong here too.
 */

export const GENERIC_TYPE = "generic";
export const UNIT_TYPE = "unit";
export const UNIT = Object.freeze({ type: UNIT_TYPE });

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
