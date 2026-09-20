const hostBindings = new WeakMap();
const portStates = new WeakMap();

function stateFor(unit) {
    const state = portStates.get(unit);
    if (!state) throw new Error("Plugin unit was not initialized by the host.");
    return state;
}

export class UnitBlock {
    constructor(uuid = null) {
        this.uuid = uuid;
        this.state = {};
        this.manager = null;
        portStates.set(this, { open: false, inputs: {}, outputs: {} });
    }

    register() {}

    registerInput(label, type) {
        const ports = stateFor(this);
        if (!ports.open) throw new Error("Plugin ports are fixed after registration.");
        if (Object.prototype.hasOwnProperty.call(ports.inputs, label)) throw new Error(`Duplicate input port "${label}".`);
        ports.inputs[label] = type;
    }

    registerOutput(label, type) {
        const ports = stateFor(this);
        if (!ports.open) throw new Error("Plugin ports are fixed after registration.");
        if (Object.prototype.hasOwnProperty.call(ports.outputs, label)) throw new Error(`Duplicate output port "${label}".`);
        ports.outputs[label] = type;
    }

    inputType(label) {
        return stateFor(this).inputs[label];
    }

    outputType(label) {
        return stateFor(this).outputs[label];
    }

    hasInput(label) {
        return Boolean(hostBindings.get(this)?.hasInput(label));
    }

    getInput(label) {
        const binding = hostBindings.get(this);
        if (!binding) throw new Error("Plugin unit is not bound to a host.");
        return binding.readInput(label);
    }

    serializeState() {
        return { ...this.state };
    }

    hydrateState(state = {}) {
        this.state = { ...state };
    }

    serializeRuntimeState() {
        return {};
    }

    hydrateRuntimeState() {}

    valid() {
        return false;
    }

    execute() {}

    dispose() {}
}

export function initializePluginUnit(unit, { uuid = null, facade = null, readInput, hasInput } = {}) {
    if (!(unit instanceof UnitBlock)) throw new Error("Plugin units must extend the public UnitBlock class.");
    unit.uuid = uuid ?? unit.uuid;
    unit.manager = facade;
    hostBindings.set(unit, {
        readInput: typeof readInput === "function" ? readInput : () => { throw new Error("Input is unavailable."); },
        hasInput: typeof hasInput === "function" ? hasInput : () => false,
    });
    const state = stateFor(unit);
    state.open = true;
    let result;
    try {
        result = unit.register();
    } finally {
        state.open = false;
    }
    return result;
}

export function pluginUnitPortSnapshot(unit) {
    const state = stateFor(unit);
    return Object.freeze({
        inputs: Object.freeze({ ...state.inputs }),
        outputs: Object.freeze({ ...state.outputs }),
    });
}

export function revokePluginUnit(unit) {
    hostBindings.delete(unit);
    unit.manager = null;
}
