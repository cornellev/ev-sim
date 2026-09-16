import { linspace } from "../../../roads/PathFrame.js";
import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { asArray, arrayType, normalizeItemType } from "../valueOps.js";
import * as arrayOps from "./arrayOps.js";

function freezePort(port) {
    return Object.freeze({ label: port.label, type: port.type });
}

function freezePorts(inputs, outputs) {
    return Object.freeze({
        inputs: Object.freeze(inputs.map(freezePort)),
        outputs: Object.freeze(outputs.map(freezePort)),
    });
}

function applyPorts(unit, ports) {
    for (const port of ports.inputs) unit.registerInput(port.label, port.type);
    for (const port of ports.outputs) unit.registerOutput(port.label, port.type);
}

export function normalizeArrayState(state = {}, extras = {}) {
    return {
        itemType: normalizeItemType(state.itemType),
        ...extras,
    };
}

export function arrayLiteralPorts(state = {}) {
    return freezePorts([], [{ label: "out", type: arrayType(state.itemType) }]);
}

export const LINSPACE_PORTS = freezePorts(
    [
        { label: "start", type: "float64" },
        { label: "end", type: "float64" },
        { label: "count", type: "int32" },
    ],
    [{ label: "out", type: arrayType("float64") }],
);

export function arrayLengthPorts(state = {}) {
    return freezePorts(
        [{ label: "values", type: arrayType(state.itemType) }],
        [{ label: "length", type: "int32" }],
    );
}

export function arrayGetPorts(state = {}) {
    const itemType = normalizeItemType(state.itemType);
    return freezePorts(
        [
            { label: "values", type: arrayType(itemType) },
            { label: "index", type: "int32" },
        ],
        [
            { label: "out", type: itemType },
            { label: "found", type: "boolean" },
        ],
    );
}

export function arraySetPorts(state = {}) {
    const itemType = normalizeItemType(state.itemType);
    return freezePorts(
        [
            { label: "values", type: arrayType(itemType) },
            { label: "index", type: "int32" },
            { label: "value", type: itemType },
        ],
        [
            { label: "out", type: arrayType(itemType) },
            { label: "changed", type: "boolean" },
        ],
    );
}

export function arrayAppendPorts(state = {}) {
    const itemType = normalizeItemType(state.itemType);
    return freezePorts(
        [
            { label: "values", type: arrayType(itemType) },
            { label: "value", type: itemType },
        ],
        [{ label: "out", type: arrayType(itemType) }],
    );
}

export function arrayConcatPorts(state = {}) {
    const array = arrayType(state.itemType);
    return freezePorts(
        [
            { label: "a", type: array },
            { label: "b", type: array },
        ],
        [{ label: "out", type: array }],
    );
}

export function arraySlicePorts(state = {}) {
    const array = arrayType(state.itemType);
    return freezePorts(
        [
            { label: "values", type: array },
            { label: "start", type: "int32" },
            { label: "end", type: "int32" },
        ],
        [{ label: "out", type: array }],
    );
}

export function arrayContainsPorts(state = {}) {
    const itemType = normalizeItemType(state.itemType);
    return freezePorts(
        [
            { label: "values", type: arrayType(itemType) },
            { label: "value", type: itemType },
        ],
        [{ label: "out", type: "boolean" }],
    );
}

function defineConfiguredBlock({ type, defaults, normalizeState, register, execute, valid }) {
    class Block extends UnitBlock {
        static blockType = type;
        static defaults = defaults;

        normalizeState(state = {}) {
            return normalizeState.call(this, state);
        }

        serializeState() {
            return { ...this.state };
        }

        hydrateState(state = {}) {
            this.state = this.normalizeState(state);
            this.reregister();
        }

        register() {
            this.state = this.normalizeState(this.state);
            register.call(this);
        }

        valid() {
            if (valid) return valid.call(this);
            return true;
        }

        execute() {
            return execute.call(this);
        }
    }

    try {
        Object.defineProperty(Block, "name", { value: type });
    } catch {
        // Class name is non-configurable in some engines; blockType is the authority.
    }

    return Block;
}

function out(value) {
    return new BlockOutput().set("out", value);
}

export const ArrayLiteralBlock = defineConfiguredBlock({
    type: "ArrayLiteralBlock",
    defaults: { itemType: "float64" },
    normalizeState(state = {}) {
        return { itemType: normalizeItemType(state.itemType) };
    },
    register() {
        applyPorts(this, arrayLiteralPorts(this.state));
    },
    valid() {
        return true;
    },
    execute() {
        return out(asArray(this.getStoredData(), this.state.itemType));
    },
});

export const ArrayLengthBlock = defineConfiguredBlock({
    type: "ArrayLengthBlock",
    defaults: { itemType: "float64" },
    normalizeState(state = {}) {
        return { itemType: normalizeItemType(state.itemType) };
    },
    register() {
        applyPorts(this, arrayLengthPorts(this.state));
    },
    valid() {
        return this.hasInput("values");
    },
    execute() {
        return new BlockOutput().set("length", arrayOps.arrayLength(this.getInput("values"), this.state.itemType));
    },
});

export const ArrayGetBlock = defineConfiguredBlock({
    type: "ArrayGetBlock",
    defaults: { itemType: "float64", fallback: null },
    normalizeState(state = {}) {
        return {
            itemType: normalizeItemType(state.itemType),
            fallback: Object.prototype.hasOwnProperty.call(state, "fallback") ? state.fallback : null,
        };
    },
    register() {
        applyPorts(this, arrayGetPorts(this.state));
    },
    valid() {
        return this.hasInput("values") && this.hasInput("index");
    },
    execute() {
        const result = arrayOps.arrayGet(
            this.getInput("values"),
            this.getInput("index"),
            this.state.fallback,
            this.state.itemType,
        );
        return new BlockOutput().set("out", result.value).set("found", result.found);
    },
});

export const ArraySetBlock = defineConfiguredBlock({
    type: "ArraySetBlock",
    defaults: { itemType: "float64" },
    normalizeState(state = {}) {
        return { itemType: normalizeItemType(state.itemType) };
    },
    register() {
        applyPorts(this, arraySetPorts(this.state));
    },
    valid() {
        return this.hasInput("values") && this.hasInput("index") && this.hasInput("value");
    },
    execute() {
        const result = arrayOps.arraySet(
            this.getInput("values"),
            this.getInput("index"),
            this.getInput("value"),
            this.state.itemType,
        );
        return new BlockOutput().set("out", result.value).set("changed", result.changed);
    },
});

export const ArrayAppendBlock = defineConfiguredBlock({
    type: "ArrayAppendBlock",
    defaults: { itemType: "float64" },
    normalizeState(state = {}) {
        return { itemType: normalizeItemType(state.itemType) };
    },
    register() {
        applyPorts(this, arrayAppendPorts(this.state));
    },
    valid() {
        return this.hasInput("values") && this.hasInput("value");
    },
    execute() {
        return out(arrayOps.arrayAppend(this.getInput("values"), this.getInput("value"), this.state.itemType));
    },
});

export const ArrayConcatBlock = defineConfiguredBlock({
    type: "ArrayConcatBlock",
    defaults: { itemType: "float64" },
    normalizeState(state = {}) {
        return { itemType: normalizeItemType(state.itemType) };
    },
    register() {
        applyPorts(this, arrayConcatPorts(this.state));
    },
    valid() {
        return this.hasInput("a") && this.hasInput("b");
    },
    execute() {
        return out(arrayOps.arrayConcat(this.getInput("a"), this.getInput("b"), this.state.itemType));
    },
});

export const ArraySliceBlock = defineConfiguredBlock({
    type: "ArraySliceBlock",
    defaults: { itemType: "float64" },
    normalizeState(state = {}) {
        return { itemType: normalizeItemType(state.itemType) };
    },
    register() {
        applyPorts(this, arraySlicePorts(this.state));
    },
    valid() {
        return this.hasInput("values") && this.hasInput("start") && this.hasInput("end");
    },
    execute() {
        return out(arrayOps.arraySlice(
            this.getInput("values"),
            this.getInput("start"),
            this.getInput("end"),
            this.state.itemType,
        ));
    },
});

export const ArrayContainsBlock = defineConfiguredBlock({
    type: "ArrayContainsBlock",
    defaults: { itemType: "float64" },
    normalizeState(state = {}) {
        return { itemType: normalizeItemType(state.itemType) };
    },
    register() {
        applyPorts(this, arrayContainsPorts(this.state));
    },
    valid() {
        return this.hasInput("values") && this.hasInput("value");
    },
    execute() {
        return out(arrayOps.arrayContains(this.getInput("values"), this.getInput("value"), this.state.itemType));
    },
});

export const LinspaceBlock = class LinspaceBlock extends UnitBlock {
    static blockType = "LinspaceBlock";

    register() {
        applyPorts(this, LINSPACE_PORTS);
    }

    valid() {
        return this.hasInput("start") && this.hasInput("end") && this.hasInput("count");
    }

    execute() {
        return new BlockOutput().set("out", linspace(
            this.getInput("start"),
            this.getInput("end"),
            this.getInput("count"),
        ));
    }
};

try {
    Object.defineProperty(LinspaceBlock, "name", { value: "LinspaceBlock" });
} catch {
    // Class name is non-configurable in some engines; blockType is the authority.
}

export const ARRAY_BLOCKS = Object.freeze({
    ArrayLiteralBlock,
    ArrayLengthBlock,
    ArrayGetBlock,
    ArraySetBlock,
    ArrayAppendBlock,
    ArrayConcatBlock,
    ArraySliceBlock,
    ArrayContainsBlock,
    LinspaceBlock,
});

const DEFAULT_ARRAY_STATE = Object.freeze({ itemType: "float64" });

export const ARRAY_BLOCK_PORTS = Object.freeze({
    ArrayLiteralBlock: arrayLiteralPorts(DEFAULT_ARRAY_STATE),
    ArrayLengthBlock: arrayLengthPorts(DEFAULT_ARRAY_STATE),
    ArrayGetBlock: arrayGetPorts(DEFAULT_ARRAY_STATE),
    ArraySetBlock: arraySetPorts(DEFAULT_ARRAY_STATE),
    ArrayAppendBlock: arrayAppendPorts(DEFAULT_ARRAY_STATE),
    ArrayConcatBlock: arrayConcatPorts(DEFAULT_ARRAY_STATE),
    ArraySliceBlock: arraySlicePorts(DEFAULT_ARRAY_STATE),
    ArrayContainsBlock: arrayContainsPorts(DEFAULT_ARRAY_STATE),
    LinspaceBlock: LINSPACE_PORTS,
});
