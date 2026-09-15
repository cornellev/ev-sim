/**
 * Editor/runtime port type helpers.
 * `generic` is editor-only. Compiled artifacts never contain it.
 * Future value types (`unit`, `actor_command`) belong in this module.
 */

export const GENERIC_TYPE = "generic";

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
