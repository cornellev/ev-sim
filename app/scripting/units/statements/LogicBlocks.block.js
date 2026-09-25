import { BlockOutput } from "../../ScriptManager.js";
import { GENERIC_TYPE, finiteFloat, finiteInt32, valuesEqual } from "../../types/PortTypes.js";
import { parseValueByType } from "../program/ProgramTypes.js";

import { createBlockHelpers } from "../defineBlock.js";
const { freezePorts, defineBlock } = createBlockHelpers({ defaultOutputType: "boolean" });
function out(value) {
    return new BlockOutput().set("out", value);
}

function acceptNumeric(type) {
    return type === "float64" || type === "int32";
}

const COMPARE_SCHEME = Object.freeze({
    variables: Object.freeze({
        T: Object.freeze({
            inputs: Object.freeze(["a", "b"]),
            outputs: Object.freeze([]),
        }),
    }),
});

const ORDERED_COMPARE_SCHEME = Object.freeze({
    variables: Object.freeze({
        T: Object.freeze({
            inputs: Object.freeze(["a", "b"]),
            outputs: Object.freeze([]),
            accept: acceptNumeric,
        }),
    }),
});

const BOOLEAN_PORTS = freezePorts([], [{ label: "out", type: "boolean" }]);
const NOT_PORTS = freezePorts([{ label: "value", type: "boolean" }]);
const BINARY_BOOLEAN = freezePorts([
    { label: "a", type: "boolean" },
    { label: "b", type: "boolean" },
]);
const GENERIC_COMPARE = freezePorts([
    { label: "a", type: GENERIC_TYPE },
    { label: "b", type: GENERIC_TYPE },
]);
const NEARLY_EQUAL_PORTS = freezePorts([
    { label: "a", type: "float64" },
    { label: "b", type: "float64" },
    { label: "tolerance", type: "float64" },
]);
const IS_FINITE_PORTS = freezePorts([{ label: "value", type: "float64" }]);

function compareNumbers(unit, operator) {
    const bound = unit.typeBindings?.T;
    const left = bound === "int32" ? finiteInt32(unit.getInput("a")) : finiteFloat(unit.getInput("a"));
    const right = bound === "int32" ? finiteInt32(unit.getInput("b")) : finiteFloat(unit.getInput("b"));
    switch (operator) {
        case "lt":
            return left < right;
        case "lte":
            return left <= right;
        case "gt":
            return left > right;
        case "gte":
            return left >= right;
        default:
            return false;
    }
}

export const BooleanBlock = defineBlock({
    type: "BooleanBlock",
    ports: BOOLEAN_PORTS,
    valid() {
        return true;
    },
    execute() {
        return out(parseValueByType(this.getStoredData(), "boolean"));
    },
});

export const NotBlock = defineBlock({
    type: "NotBlock",
    ports: NOT_PORTS,
    execute() {
        return out(!Boolean(this.getInput("value")));
    },
});

export const AndBlock = defineBlock({
    type: "AndBlock",
    ports: BINARY_BOOLEAN,
    execute() {
        const a = Boolean(this.getInput("a"));
        if (!a) return out(false);
        return out(Boolean(this.getInput("b")));
    },
});

export const OrBlock = defineBlock({
    type: "OrBlock",
    ports: BINARY_BOOLEAN,
    execute() {
        const a = Boolean(this.getInput("a"));
        if (a) return out(true);
        return out(Boolean(this.getInput("b")));
    },
});

export const XorBlock = defineBlock({
    type: "XorBlock",
    ports: BINARY_BOOLEAN,
    execute() {
        return out(Boolean(this.getInput("a")) !== Boolean(this.getInput("b")));
    },
});

export const EqualBlock = defineBlock({
    type: "EqualBlock",
    ports: GENERIC_COMPARE,
    typeScheme: COMPARE_SCHEME,
    execute() {
        return out(valuesEqual(this.getInput("a"), this.getInput("b")));
    },
});

export const NotEqualBlock = defineBlock({
    type: "NotEqualBlock",
    ports: GENERIC_COMPARE,
    typeScheme: COMPARE_SCHEME,
    execute() {
        return out(!valuesEqual(this.getInput("a"), this.getInput("b")));
    },
});

export const LessBlock = defineBlock({
    type: "LessBlock",
    ports: GENERIC_COMPARE,
    typeScheme: ORDERED_COMPARE_SCHEME,
    execute() {
        return out(compareNumbers(this, "lt"));
    },
});

export const LessEqualBlock = defineBlock({
    type: "LessEqualBlock",
    ports: GENERIC_COMPARE,
    typeScheme: ORDERED_COMPARE_SCHEME,
    execute() {
        return out(compareNumbers(this, "lte"));
    },
});

export const GreaterBlock = defineBlock({
    type: "GreaterBlock",
    ports: GENERIC_COMPARE,
    typeScheme: ORDERED_COMPARE_SCHEME,
    execute() {
        return out(compareNumbers(this, "gt"));
    },
});

export const GreaterEqualBlock = defineBlock({
    type: "GreaterEqualBlock",
    ports: GENERIC_COMPARE,
    typeScheme: ORDERED_COMPARE_SCHEME,
    execute() {
        return out(compareNumbers(this, "gte"));
    },
});

export const NearlyEqualBlock = defineBlock({
    type: "NearlyEqualBlock",
    ports: NEARLY_EQUAL_PORTS,
    execute() {
        const a = finiteFloat(this.getInput("a"));
        const b = finiteFloat(this.getInput("b"));
        const tolerance = Math.abs(finiteFloat(this.getInput("tolerance")));
        return out(Math.abs(a - b) <= tolerance);
    },
});

export const IsFiniteBlock = defineBlock({
    type: "IsFiniteBlock",
    ports: IS_FINITE_PORTS,
    execute() {
        return out(Number.isFinite(Number(this.getInput("value"))));
    },
});

export const LOGIC_BLOCKS = Object.freeze({
    BooleanBlock,
    NotBlock,
    AndBlock,
    OrBlock,
    XorBlock,
    EqualBlock,
    NotEqualBlock,
    LessBlock,
    LessEqualBlock,
    GreaterBlock,
    GreaterEqualBlock,
    NearlyEqualBlock,
    IsFiniteBlock,
});

export const LOGIC_BLOCK_PORTS = Object.freeze({
    BooleanBlock: BOOLEAN_PORTS,
    NotBlock: NOT_PORTS,
    AndBlock: BINARY_BOOLEAN,
    OrBlock: BINARY_BOOLEAN,
    XorBlock: BINARY_BOOLEAN,
    EqualBlock: GENERIC_COMPARE,
    NotEqualBlock: GENERIC_COMPARE,
    LessBlock: GENERIC_COMPARE,
    LessEqualBlock: GENERIC_COMPARE,
    GreaterBlock: GENERIC_COMPARE,
    GreaterEqualBlock: GENERIC_COMPARE,
    NearlyEqualBlock: NEARLY_EQUAL_PORTS,
    IsFiniteBlock: IS_FINITE_PORTS,
});
