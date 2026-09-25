import { UnitBlock } from "../ScriptManager.js";

export function freezePort(port) {
    return Object.freeze({ label: port.label, type: port.type });
}

export function freezePorts(inputs, outputs = [{ label: "out", type: "float64" }]) {
    return Object.freeze({
        inputs: Object.freeze(inputs.map(freezePort)),
        outputs: Object.freeze(outputs.map(freezePort)),
    });
}

function nameBlock(Block, type) {
    try {
        Object.defineProperty(Block, "name", { value: type });
    } catch {
        // Class name is non-configurable in some engines; blockType is the authority.
    }
}

export function defineBlock({ type, ports, execute, valid, typeScheme }) {
    class Block extends UnitBlock {
        static blockType = type;

        register() {
            for (const port of ports.inputs) this.registerInput(port.label, port.type);
            for (const port of ports.outputs) this.registerOutput(port.label, port.type);
        }

        valid() {
            if (valid) return valid.call(this);
            return ports.inputs.every((port) => this.hasInput(port.label));
        }

        execute() {
            return execute.call(this);
        }
    }

    if (typeScheme) Block.typeScheme = typeScheme;
    nameBlock(Block, type);
    return Block;
}

export function defineStatefulBlock({
    type,
    ports,
    execute,
    valid,
    typeScheme,
    init,
    serialize,
    hydrate,
}) {
    class Block extends UnitBlock {
        static blockType = type;

        constructor(uuid) {
            super(uuid);
            init?.call(this);
        }

        register() {
            for (const port of ports.inputs) this.registerInput(port.label, port.type);
            for (const port of ports.outputs) this.registerOutput(port.label, port.type);
        }

        valid() {
            if (valid) return valid.call(this);
            return ports.inputs.every((port) => this.hasInput(port.label));
        }

        serializeRuntimeState() {
            return serialize ? serialize.call(this) : {};
        }

        hydrateRuntimeState(state = {}) {
            if (hydrate) hydrate.call(this, state);
        }

        execute() {
            return execute.call(this);
        }
    }

    if (typeScheme) Block.typeScheme = typeScheme;
    nameBlock(Block, type);
    return Block;
}

export function createBlockHelpers({ defaultOutputType = "float64" } = {}) {
    function freezePortsForFile(inputs, outputs = [{ label: "out", type: defaultOutputType }]) {
        return freezePorts(inputs, outputs);
    }
    return {
        freezePort,
        freezePorts: freezePortsForFile,
        defineBlock,
        defineStatefulBlock,
    };
}
