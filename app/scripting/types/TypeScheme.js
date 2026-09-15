import { GENERIC_TYPE, isConcreteType } from "./PortTypes.js";

export function getTypeScheme(unit) {
    return unit?.constructor?.typeScheme || { variables: {} };
}

function resolveLabel(unit, side, label) {
    if (side === "outputs") return unit.resolveOutputLabel(label);
    return unit.resolveInputLabel(label);
}

function portMap(unit, side) {
    return side === "outputs" ? unit.typeMap?.outputs : unit.typeMap?.inputs;
}

export function hasDeclaredPort(unit, side, label) {
    const resolved = resolveLabel(unit, side, label);
    const map = portMap(unit, side);
    return Boolean(map) && Object.prototype.hasOwnProperty.call(map, resolved);
}

export function getTypeVariable(unit, side, label) {
    const resolved = resolveLabel(unit, side, label);
    const variables = getTypeScheme(unit).variables || {};
    for (const [name, spec] of Object.entries(variables)) {
        const ports = side === "outputs" ? spec.outputs : spec.inputs;
        if (Array.isArray(ports) && ports.includes(resolved)) return name;
    }
    return null;
}

export function declaredPortType(unit, side, label) {
    const resolved = resolveLabel(unit, side, label);
    const map = portMap(unit, side);
    if (!map || !Object.prototype.hasOwnProperty.call(map, resolved)) return undefined;
    if (getTypeVariable(unit, side, resolved)) return GENERIC_TYPE;
    return map[resolved];
}

export function resolvedPortType(unit, side, label) {
    const resolved = resolveLabel(unit, side, label);
    const map = portMap(unit, side);
    if (!map || !Object.prototype.hasOwnProperty.call(map, resolved)) return undefined;

    const variable = getTypeVariable(unit, side, resolved);
    if (!variable) return map[resolved];

    const bound = unit.typeBindings?.[variable];
    if (isConcreteType(bound)) return bound;

    const declared = map[resolved];
    if (isConcreteType(declared)) return declared;
    return GENERIC_TYPE;
}

export function collectResolvedPortMap(unit) {
    const snapshotSide = (side) => {
        const map = portMap(unit, side) || {};
        return Object.fromEntries(Object.keys(map).map((label) => [label, resolvedPortType(unit, side, label)]));
    };

    return {
        inputs: snapshotSide("inputs"),
        outputs: snapshotSide("outputs")
    };
}

export function findUnboundGeneric(unit) {
    for (const side of ["inputs", "outputs"]) {
        const map = portMap(unit, side) || {};
        for (const label of Object.keys(map)) {
            const type = resolvedPortType(unit, side, label);
            if (type === GENERIC_TYPE) {
                return {
                    variable: getTypeVariable(unit, side, label) || GENERIC_TYPE,
                    side,
                    label
                };
            }
        }
    }
    return null;
}

export function findRejectedBinding(unit) {
    const variables = getTypeScheme(unit).variables || {};
    for (const [variable, spec] of Object.entries(variables)) {
        if (typeof spec.accept !== "function") continue;
        const bound = unit.typeBindings?.[variable];
        if (!isConcreteType(bound)) continue;
        if (!spec.accept(bound, unit)) {
            return { variable, type: bound };
        }
    }
    return null;
}

export function unboundGenericError(unit, variable) {
    return `Unbound generic ${variable} on ${unit.typeId()} "${unit.uuid}".`;
}

export function typeConflictError(unit, variable, left, right) {
    return `Type conflict on ${unit.typeId()} "${unit.uuid}" variable ${variable}: ${left} vs ${right}.`;
}

export function rejectedBindingError(unit, variable, type) {
    return `Type conflict on ${unit.typeId()} "${unit.uuid}" variable ${variable}: ${type} is not accepted.`;
}

export function serializeTypeScheme(scheme) {
    if (!scheme?.variables) return null;
    return {
        variables: Object.fromEntries(Object.entries(scheme.variables).map(([name, spec]) => [
            name,
            {
                inputs: [...(spec.inputs || [])],
                outputs: [...(spec.outputs || [])]
            }
        ]))
    };
}
