import { BlockOutput } from "../../ScriptManager.js";
import { finiteInt32 } from "../../types/PortTypes.js";
import * as scalarMath from "./scalarMath.js";

import { freezePorts, defineBlock } from "../defineBlock.js";
function out(value) {
    return new BlockOutput().set("out", value);
}

function cloneJsonValue(value) {
    let source = value;
    if (typeof source === "string") {
        try {
            source = JSON.parse(source);
        } catch {
            return null;
        }
    }

    try {
        return JSON.parse(JSON.stringify(source));
    } catch {
        return null;
    }
}

const BINARY_FLOAT = freezePorts([
    { label: "a", type: "float64" },
    { label: "b", type: "float64" },
]);
const UNARY_FLOAT = freezePorts([{ label: "value", type: "float64" }]);
const VALUE_MIN_MAX = freezePorts([
    { label: "value", type: "float64" },
    { label: "min", type: "float64" },
    { label: "max", type: "float64" },
]);

const INTEGER_PORTS = freezePorts([], [{ label: "out", type: "int32" }]);
const JSON_PORTS = freezePorts([], [{ label: "out", type: "json" }]);
const LERP_PORTS = freezePorts([
    { label: "a", type: "float64" },
    { label: "b", type: "float64" },
    { label: "t", type: "float64" },
]);
const DEADBAND_PORTS = freezePorts([
    { label: "value", type: "float64" },
    { label: "width", type: "float64" },
]);
const ATAN2_PORTS = freezePorts([
    { label: "y", type: "float64" },
    { label: "x", type: "float64" },
]);

export const IntegerBlock = defineBlock({
    type: "IntegerBlock",
    ports: INTEGER_PORTS,
    valid() {
        return true;
    },
    execute() {
        return out(finiteInt32(this.getStoredData()));
    },
});

export const JsonBlock = defineBlock({
    type: "JsonBlock",
    ports: JSON_PORTS,
    valid() {
        return true;
    },
    execute() {
        return out(cloneJsonValue(this.getStoredData()));
    },
});

export const AddBlock = defineBlock({
    type: "AddBlock",
    ports: BINARY_FLOAT,
    execute() {
        return out(scalarMath.add(this.getInput("a"), this.getInput("b")));
    },
});

export const SubtractBlock = defineBlock({
    type: "SubtractBlock",
    ports: BINARY_FLOAT,
    execute() {
        return out(scalarMath.sub(this.getInput("a"), this.getInput("b")));
    },
});

export const MultiplyBlock = defineBlock({
    type: "MultiplyBlock",
    ports: BINARY_FLOAT,
    execute() {
        return out(scalarMath.mul(this.getInput("a"), this.getInput("b")));
    },
});

export const DivideBlock = defineBlock({
    type: "DivideBlock",
    ports: BINARY_FLOAT,
    execute() {
        return out(scalarMath.div(this.getInput("a"), this.getInput("b")));
    },
});

export const ModuloBlock = defineBlock({
    type: "ModuloBlock",
    ports: BINARY_FLOAT,
    execute() {
        return out(scalarMath.mod(this.getInput("a"), this.getInput("b")));
    },
});

export const PowerBlock = defineBlock({
    type: "PowerBlock",
    ports: BINARY_FLOAT,
    execute() {
        return out(scalarMath.pow(this.getInput("a"), this.getInput("b")));
    },
});

export const MinimumBlock = defineBlock({
    type: "MinimumBlock",
    ports: BINARY_FLOAT,
    execute() {
        return out(scalarMath.min(this.getInput("a"), this.getInput("b")));
    },
});

export const MaximumBlock = defineBlock({
    type: "MaximumBlock",
    ports: BINARY_FLOAT,
    execute() {
        return out(scalarMath.max(this.getInput("a"), this.getInput("b")));
    },
});

export const NegateBlock = defineBlock({
    type: "NegateBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.neg(this.getInput("value")));
    },
});

export const AbsoluteBlock = defineBlock({
    type: "AbsoluteBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.abs(this.getInput("value")));
    },
});

export const SignBlock = defineBlock({
    type: "SignBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.sign(this.getInput("value")));
    },
});

export const SquareRootBlock = defineBlock({
    type: "SquareRootBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.sqrt(this.getInput("value")));
    },
});

export const ExponentialBlock = defineBlock({
    type: "ExponentialBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.exp(this.getInput("value")));
    },
});

export const NaturalLogBlock = defineBlock({
    type: "NaturalLogBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.ln(this.getInput("value")));
    },
});

export const Log10Block = defineBlock({
    type: "Log10Block",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.log10(this.getInput("value")));
    },
});

export const ClampBlock = defineBlock({
    type: "ClampBlock",
    ports: VALUE_MIN_MAX,
    execute() {
        return out(scalarMath.clamp(this.getInput("value"), this.getInput("min"), this.getInput("max")));
    },
});

export const LerpBlock = defineBlock({
    type: "LerpBlock",
    ports: LERP_PORTS,
    execute() {
        return out(scalarMath.lerp(this.getInput("a"), this.getInput("b"), this.getInput("t")));
    },
});

export const InverseLerpBlock = defineBlock({
    type: "InverseLerpBlock",
    ports: VALUE_MIN_MAX,
    execute() {
        return out(scalarMath.inverseLerp(this.getInput("value"), this.getInput("min"), this.getInput("max")));
    },
});

export const SmoothstepBlock = defineBlock({
    type: "SmoothstepBlock",
    ports: VALUE_MIN_MAX,
    execute() {
        return out(scalarMath.smoothstep(this.getInput("value"), this.getInput("min"), this.getInput("max")));
    },
});

export const DeadbandBlock = defineBlock({
    type: "DeadbandBlock",
    ports: DEADBAND_PORTS,
    execute() {
        return out(scalarMath.deadband(this.getInput("value"), this.getInput("width")));
    },
});

export const SinBlock = defineBlock({
    type: "SinBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.sin(this.getInput("value")));
    },
});

export const CosBlock = defineBlock({
    type: "CosBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.cos(this.getInput("value")));
    },
});

export const TanBlock = defineBlock({
    type: "TanBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.tan(this.getInput("value")));
    },
});

export const AsinBlock = defineBlock({
    type: "AsinBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.asin(this.getInput("value")));
    },
});

export const AcosBlock = defineBlock({
    type: "AcosBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.acos(this.getInput("value")));
    },
});

export const AtanBlock = defineBlock({
    type: "AtanBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.atan(this.getInput("value")));
    },
});

export const DegreesToRadiansBlock = defineBlock({
    type: "DegreesToRadiansBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.degToRad(this.getInput("value")));
    },
});

export const RadiansToDegreesBlock = defineBlock({
    type: "RadiansToDegreesBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.radToDeg(this.getInput("value")));
    },
});

export const WrapRadiansBlock = defineBlock({
    type: "WrapRadiansBlock",
    ports: UNARY_FLOAT,
    execute() {
        return out(scalarMath.wrapRadians(this.getInput("value")));
    },
});

export const Atan2Block = defineBlock({
    type: "Atan2Block",
    ports: ATAN2_PORTS,
    execute() {
        return out(scalarMath.atan2(this.getInput("y"), this.getInput("x")));
    },
});

export const SCALAR_BLOCKS = Object.freeze({
    IntegerBlock,
    JsonBlock,
    AddBlock,
    SubtractBlock,
    MultiplyBlock,
    DivideBlock,
    ModuloBlock,
    PowerBlock,
    MinimumBlock,
    MaximumBlock,
    NegateBlock,
    AbsoluteBlock,
    SignBlock,
    SquareRootBlock,
    ExponentialBlock,
    NaturalLogBlock,
    Log10Block,
    ClampBlock,
    LerpBlock,
    InverseLerpBlock,
    SmoothstepBlock,
    DeadbandBlock,
    SinBlock,
    CosBlock,
    TanBlock,
    AsinBlock,
    AcosBlock,
    AtanBlock,
    DegreesToRadiansBlock,
    RadiansToDegreesBlock,
    WrapRadiansBlock,
    Atan2Block,
});

export const SCALAR_BLOCK_PORTS = Object.freeze({
    IntegerBlock: INTEGER_PORTS,
    JsonBlock: JSON_PORTS,
    AddBlock: BINARY_FLOAT,
    SubtractBlock: BINARY_FLOAT,
    MultiplyBlock: BINARY_FLOAT,
    DivideBlock: BINARY_FLOAT,
    ModuloBlock: BINARY_FLOAT,
    PowerBlock: BINARY_FLOAT,
    MinimumBlock: BINARY_FLOAT,
    MaximumBlock: BINARY_FLOAT,
    NegateBlock: UNARY_FLOAT,
    AbsoluteBlock: UNARY_FLOAT,
    SignBlock: UNARY_FLOAT,
    SquareRootBlock: UNARY_FLOAT,
    ExponentialBlock: UNARY_FLOAT,
    NaturalLogBlock: UNARY_FLOAT,
    Log10Block: UNARY_FLOAT,
    ClampBlock: VALUE_MIN_MAX,
    LerpBlock: LERP_PORTS,
    InverseLerpBlock: VALUE_MIN_MAX,
    SmoothstepBlock: VALUE_MIN_MAX,
    DeadbandBlock: DEADBAND_PORTS,
    SinBlock: UNARY_FLOAT,
    CosBlock: UNARY_FLOAT,
    TanBlock: UNARY_FLOAT,
    AsinBlock: UNARY_FLOAT,
    AcosBlock: UNARY_FLOAT,
    AtanBlock: UNARY_FLOAT,
    DegreesToRadiansBlock: UNARY_FLOAT,
    RadiansToDegreesBlock: UNARY_FLOAT,
    WrapRadiansBlock: UNARY_FLOAT,
    Atan2Block: ATAN2_PORTS,
});
