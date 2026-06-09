import { createFailureNode, FAILURE_NODE_ID, VISUAL_SCRIPT_KIND, VISUAL_SCRIPT_VERSION } from "./Artifact.js";

function byUnitOrder(unitOrder) {
    return (a, b) => (unitOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (unitOrder.get(b) ?? Number.MAX_SAFE_INTEGER);
}

function ensureUniqueProgramLabel(interfaceMap, port) {
    if (!port?.role || !port?.label) return;

    const labels = interfaceMap[port.role];
    if (!labels) return;

    if (labels.has(port.label)) {
        throw new Error(`Duplicate program ${port.role} label "${port.label}".`);
    }

    labels.add(port.label);
}

function transitionKey(transition) {
    return [
        transition.from,
        transition.output,
        transition.to,
        transition.input
    ].join("|");
}

function createReverseSuccess(successTransitions) {
    return successTransitions.reduce((reverse, transition) => {
        if (!reverse[transition.to]) reverse[transition.to] = {};

        if (reverse[transition.to][transition.input]) {
            throw new Error(`Duplicate input edge for ${transition.to}.${transition.input}.`);
        }

        reverse[transition.to][transition.input] = {
            from: transition.from,
            output: transition.output,
            type: transition.type
        };
        return reverse;
    }, {});
}

function collectReachableUnits(finalStates, unitById) {
    const reachable = new Set();
    const visiting = new Set();
    const visited = new Set();

    function visit(uuid, path = []) {
        const unit = unitById.get(uuid);
        if (!unit) {
            throw new Error(`Unreachable final state or missing unit "${uuid}".`);
        }

        if (visiting.has(uuid)) {
            throw new Error(`Cycle detected in visual script: ${[...path, uuid].join(" -> ")}.`);
        }

        if (visited.has(uuid)) return;

        visiting.add(uuid);
        reachable.add(uuid);

        Object.values(unit.inputs || {}).forEach((connection) => {
            const output = connection.getOutput();
            visit(output.unit.uuid, [...path, uuid]);
        });

        visiting.delete(uuid);
        visited.add(uuid);
    }

    finalStates.forEach((uuid) => visit(uuid));
    return reachable;
}

function validateReachableUnit(unit, getBlockClass) {
    const type = unit.typeId();
    if (!getBlockClass(type)) {
        throw new Error(`Unknown block type "${type}". Register it before compiling.`);
    }

    if (!unit.valid()) {
        throw new Error(`Block "${unit.uuid}" (${type}) is invalid.`);
    }
}

function createTransition(connection, nodeIndex) {
    const output = connection.getOutput();
    const input = connection.getInput();
    const outputType = output.unit.outputType(output.label);
    const inputType = input.unit.inputType(input.label);

    if (!outputType) {
        throw new Error(`Missing output port "${output.label}" on block "${output.unit.uuid}".`);
    }

    if (!inputType) {
        throw new Error(`Missing input port "${input.label}" on block "${input.unit.uuid}".`);
    }

    if (outputType !== inputType) {
        throw new Error(`Type mismatch from ${output.unit.uuid}.${output.label} (${outputType}) to ${input.unit.uuid}.${input.label} (${inputType}).`);
    }

    return {
        from: output.unit.uuid,
        fromIndex: nodeIndex[output.unit.uuid],
        output: output.label,
        to: input.unit.uuid,
        toIndex: nodeIndex[input.unit.uuid],
        input: input.label,
        type: outputType
    };
}

function collectSuccessTransitions(units, reachable, nodeIndex) {
    const seen = new Set();
    const transitions = [];

    units.forEach((unit) => {
        if (!reachable.has(unit.uuid)) return;

        Object.values(unit.outputs || {}).flat().forEach((connection) => {
            const input = connection.getInput();
            if (!reachable.has(input.unit.uuid)) return;

            const transition = createTransition(connection, nodeIndex);
            const key = transitionKey(transition);
            if (seen.has(key)) return;

            seen.add(key);
            transitions.push(transition);
        });
    });

    return transitions;
}

function collectInterface(units, reachable) {
    const interfaceMap = {
        input: new Set(),
        output: new Set()
    };
    const programInterface = {
        inputs: [],
        outputs: []
    };

    units.forEach((unit) => {
        if (!reachable.has(unit.uuid)) return;

        const portDefinitions = unit.getProgramPortDefinition();
        if (!portDefinitions) return;

        const ports = Array.isArray(portDefinitions) ? portDefinitions : [portDefinitions];

        ports.forEach((port) => {
            ensureUniqueProgramLabel(interfaceMap, port);

            const definition = {
                uuid: unit.uuid,
                label: port.label,
                type: port.type
            };

            if (port.portId) definition.portId = port.portId;

            if (port.role === "input") programInterface.inputs.push(definition);
            if (port.role === "output") programInterface.outputs.push(definition);
        });
    });

    return programInterface;
}

function collectUnitDefinitions(units, methodName) {
    return units.flatMap((unit) => {
        if (typeof unit[methodName] !== "function") return [];

        const definition = unit[methodName]();
        if (!definition) return [];

        const definitions = Array.isArray(definition) ? definition : [definition];
        return definitions
            .filter(Boolean)
            .map((item) => ({
                uuid: unit.uuid,
                blockType: unit.typeId(),
                ...item
            }));
    });
}

function createNodeDefinition(unit, storedData) {
    return {
        uuid: unit.uuid,
        type: unit.typeId(),
        state: unit.serializeState(),
        storedData,
        runtimeState: unit.serializeRuntimeState(),
        ports: {
            inputs: { ...unit.typeMap.inputs },
            outputs: { ...unit.typeMap.outputs }
        }
    };
}

export function compileVisualScript(manager, name, getBlockClass) {
    const units = [...manager.units];
    const unitById = new Map(units.map((unit) => [unit.uuid, unit]));
    const unitOrder = new Map(units.map((unit, index) => [unit.uuid, index]));
    const outputUnits = units.filter((unit) => unit.constructor.programNodeRole === "output");
    const finalStates = outputUnits.length > 0
        ? outputUnits.map((unit) => unit.uuid).sort(byUnitOrder(unitOrder))
        : (manager.head ? [manager.head] : []);

    if (finalStates.length === 0) {
        throw new Error("Cannot compile a script without a head or Program Output block.");
    }

    const reachable = collectReachableUnits(finalStates, unitById);
    units.forEach((unit) => {
        if (reachable.has(unit.uuid)) validateReachableUnit(unit, getBlockClass);
    });

    const Q = units
        .filter((unit) => reachable.has(unit.uuid))
        .map((unit) => unit.uuid);

    const nodeIndex = Q.reduce((index, uuid, position) => {
        index[uuid] = position;
        return index;
    }, {});

    const nodes = Q.map((uuid) => {
        const unit = unitById.get(uuid);
        return createNodeDefinition(unit, manager.getStoredData(uuid));
    });

    const success = collectSuccessTransitions(units, reachable, nodeIndex);
    const reverseSuccess = createReverseSuccess(success);
    const startStates = Q.filter((uuid) => !reverseSuccess[uuid]);
    const programInterface = collectInterface(units, reachable);
    const bindings = collectUnitDefinitions(units, "getBindingDefinition");
    const entrypoints = collectUnitDefinitions(units, "getEntrypointDefinition");

    return {
        kind: VISUAL_SCRIPT_KIND,
        version: VISUAL_SCRIPT_VERSION,
        name,
        head: outputUnits.length > 0 ? null : manager.head,
        finalStates,
        startStates,
        Q,
        nodeIndex,
        nodes,
        transitions: {
            success,
            failure: []
        },
        failureNode: createFailureNode(),
        F: [FAILURE_NODE_ID],
        reverseSuccess,
        interface: programInterface,
        bindings,
        entrypoints
    };
}
