import { isConcreteType, isGeneric } from "./PortTypes.js";
import {
    getTypeScheme,
    getTypeVariable,
    hasDeclaredPort,
    rejectedBindingError,
    typeConflictError
} from "./TypeScheme.js";

function resolveLabel(unit, side, label) {
    return side === "outputs" ? unit.resolveOutputLabel(label) : unit.resolveInputLabel(label);
}

function describePort(unit, side, label) {
    const resolved = resolveLabel(unit, side, label);
    if (!hasDeclaredPort(unit, side, resolved)) {
        return { kind: "missing", unit, label: resolved, side };
    }

    const variable = getTypeVariable(unit, side, resolved);
    if (variable) {
        return {
            kind: "var",
            unit,
            variable,
            key: `${unit.uuid}::${variable}`,
            label: resolved,
            side
        };
    }

    const type = side === "outputs" ? unit.typeMap.outputs[resolved] : unit.typeMap.inputs[resolved];
    if (isGeneric(type)) {
        return { kind: "wildcard", unit, label: resolved, side };
    }
    if (isConcreteType(type)) {
        return { kind: "concrete", unit, type, label: resolved, side };
    }
    return { kind: "missing", unit, label: resolved, side };
}

function createUnionFind() {
    const parent = new Map();

    const find = (key) => {
        if (!parent.has(key)) parent.set(key, key);
        const current = parent.get(key);
        if (current !== key) {
            const root = find(current);
            parent.set(key, root);
            return root;
        }
        return key;
    };

    const union = (left, right) => {
        const leftRoot = find(left);
        const rightRoot = find(right);
        if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
        return find(left);
    };

    return { find, union };
}

function collectExistingEdges(manager) {
    const edges = [];
    for (const unit of manager.units) {
        for (const connections of Object.values(unit.outputs || {})) {
            for (const connection of connections) {
                const output = connection.getOutput();
                const input = connection.getInput();
                edges.push({
                    outputUnit: output.unit,
                    outputLabel: output.label,
                    inputUnit: input.unit,
                    inputLabel: input.label
                });
            }
        }
    }
    return edges;
}

function resolveCandidate(manager, candidate) {
    if (!candidate) return null;
    const outputUnit = manager.units.find((unit) => unit.uuid === candidate.outputUUID);
    const inputUnit = manager.units.find((unit) => unit.uuid === candidate.inputUUID);
    if (!outputUnit || !inputUnit) {
        return { error: `Invalid UUIDs for connection "${candidate.outputUUID}" -> "${candidate.inputUUID}".` };
    }
    return {
        outputUnit,
        outputLabel: outputUnit.resolveOutputLabel(candidate.outputLabel),
        inputUnit,
        inputLabel: inputUnit.resolveInputLabel(candidate.inputLabel)
    };
}

function membersForRoot(root, find, keys) {
    return keys.filter((member) => find(member.key) === root);
}

/**
 * Plan graph-wide generic bindings from existing edges plus an optional candidate.
 * Does not mutate the manager.
 */
export function planUnify(manager, candidate = null) {
    const edges = collectExistingEdges(manager);
    let resolvedCandidate = null;
    if (candidate) {
        const resolved = resolveCandidate(manager, candidate);
        if (resolved?.error) return { ok: false, hardConflict: true, bindings: new Map(), error: resolved.error };
        resolvedCandidate = resolved;
        edges.push(resolvedCandidate);
    }

    const { find, union } = createUnionFind();
    const variableKeys = [];
    const seenKeys = new Set();
    const constraints = new Map();

    const rememberVar = (port) => {
        if (port.kind !== "var") return;
        if (seenKeys.has(port.key)) return;
        seenKeys.add(port.key);
        variableKeys.push({
            key: port.key,
            unit: port.unit,
            variable: port.variable
        });
        find(port.key);
    };

    const addConstraint = (key, type, sourceUnit) => {
        const root = find(key);
        if (!constraints.has(root)) constraints.set(root, []);
        constraints.get(root).push({ type, unit: sourceUnit });
    };

    for (const edge of edges) {
        const outputPort = describePort(edge.outputUnit, "outputs", edge.outputLabel);
        const inputPort = describePort(edge.inputUnit, "inputs", edge.inputLabel);

        if (outputPort.kind === "missing") {
            return {
                ok: false,
                hardConflict: true,
                bindings: new Map(),
                error: `Missing output port "${edge.outputLabel}" on block "${edge.outputUnit.uuid}".`
            };
        }
        if (inputPort.kind === "missing") {
            return {
                ok: false,
                hardConflict: true,
                bindings: new Map(),
                error: `Missing input port "${edge.inputLabel}" on block "${edge.inputUnit.uuid}".`
            };
        }

        rememberVar(outputPort);
        rememberVar(inputPort);

        if (outputPort.kind === "var" && inputPort.kind === "var") {
            union(outputPort.key, inputPort.key);
        }
    }

    for (const edge of edges) {
        const outputPort = describePort(edge.outputUnit, "outputs", edge.outputLabel);
        const inputPort = describePort(edge.inputUnit, "inputs", edge.inputLabel);

        if (outputPort.kind === "concrete" && inputPort.kind === "concrete" && outputPort.type !== inputPort.type) {
            return {
                ok: false,
                hardConflict: true,
                bindings: new Map(),
                error: `Type mismatch from ${outputPort.unit.uuid}.${outputPort.label} (${outputPort.type}) to ${inputPort.unit.uuid}.${inputPort.label} (${inputPort.type}).`
            };
        }

        if (outputPort.kind === "var" && inputPort.kind === "concrete") {
            addConstraint(outputPort.key, inputPort.type, outputPort.unit);
        }
        if (inputPort.kind === "var" && outputPort.kind === "concrete") {
            addConstraint(inputPort.key, outputPort.type, inputPort.unit);
        }
    }

    const merged = new Map();
    for (const [root, entries] of constraints.entries()) {
        const types = [...new Set(entries.map((entry) => entry.type))];
        if (types.length > 1) {
            const members = membersForRoot(root, find, variableKeys);
            const preferred = resolvedCandidate
                ? members.find((member) => member.unit === resolvedCandidate.inputUnit) || members[0]
                : members[0];
            const unit = preferred?.unit || entries[0].unit;
            const variable = preferred?.variable || "T";
            return {
                ok: false,
                hardConflict: true,
                bindings: new Map(),
                error: typeConflictError(unit, variable, types[0], types[1])
            };
        }
        merged.set(root, types[0]);
    }

    const bindings = new Map();
    for (const member of variableKeys) {
        const type = merged.get(find(member.key));
        if (!isConcreteType(type)) continue;
        if (!bindings.has(member.unit.uuid)) bindings.set(member.unit.uuid, {});
        bindings.get(member.unit.uuid)[member.variable] = type;
    }

    for (const unit of manager.units) {
        const planned = bindings.get(unit.uuid) || {};
        const variables = getTypeScheme(unit).variables || {};
        for (const [variable, spec] of Object.entries(variables)) {
            if (typeof spec.accept !== "function") continue;
            const bound = planned[variable];
            if (!isConcreteType(bound)) continue;
            if (!spec.accept(bound, unit)) {
                return {
                    ok: false,
                    hardConflict: false,
                    bindings,
                    error: rejectedBindingError(unit, variable, bound)
                };
            }
        }
    }

    return { ok: true, hardConflict: false, bindings, error: null };
}

export function applyBindings(manager, bindings) {
    const assigned = bindings instanceof Map ? bindings : new Map();
    for (const unit of manager.units) {
        const next = assigned.get(unit.uuid) || {};
        const concrete = {};
        for (const [variable, type] of Object.entries(next)) {
            if (isConcreteType(type)) concrete[variable] = type;
        }
        unit.typeBindings = concrete;
    }
}

export function recomputeBindings(manager) {
    const plan = planUnify(manager);
    if (!plan.hardConflict) applyBindings(manager, plan.bindings);
    return plan;
}
