import { BlockOutput, UnitBlock } from "../../../ScriptManager.js";
import { finiteFloat, orderedBounds } from "../../../types/PortTypes.js";
import { mapBinary, mapUnary } from "./textureMath.js";

import { createBlockHelpers } from "../../defineBlock.js";
const { freezePorts, defineBlock } = createBlockHelpers({ defaultOutputType: "tex1d" });
function out(value) {
    return new BlockOutput().set("out", value);
}

function readBinaryTexture(block) {
    const a = block.hasInput("a") ? block.getInput("a") : block.getInput("tex1d_a");
    const b = block.hasInput("b") ? block.getInput("b") : block.getInput("tex1d_b");
    return { a, b };
}

const SCALE_TEXTURE_PORTS = freezePorts([
    { label: "tex", type: "tex1d" },
    { label: "scalar", type: "float64" },
]);
const BINARY_TEXTURE_PORTS = freezePorts([
    { label: "a", type: "tex1d" },
    { label: "b", type: "tex1d" },
]);
const CLAMP_TEXTURE_PORTS = freezePorts([
    { label: "tex", type: "tex1d" },
    { label: "min", type: "float64" },
    { label: "max", type: "float64" },
]);
const INVERT_TEXTURE_PORTS = freezePorts([{ label: "tex", type: "tex1d" }]);

export class ScaleBlock extends UnitBlock {
    static blockType = "ScaleBlock";

    register() {
        this.registerOutput("result", "tex1d");
        this.registerInput("scalar", "float64");
        this.registerInput("tex1d", "tex1d");
    }

    valid() {
        return this.hasInput("tex1d") && this.hasInput("scalar");
    }

    execute() {
        const texture = this.getInput("tex1d");
        if (!Array.isArray(texture)) throw new Error("Scale texture input must be an array.");
        const scalar = finiteFloat(this.getInput("scalar"));
        return new BlockOutput().set("result", texture.map((value) => value * scalar));
    }
}

export const ScaleTextureBlock = defineBlock({
    type: "ScaleTextureBlock",
    ports: SCALE_TEXTURE_PORTS,
    execute() {
        const scalar = finiteFloat(this.getInput("scalar"));
        return out(mapUnary(this.getInput("tex"), (value) => value * scalar, "ScaleTextureBlock"));
    },
});

export const MultiplyTexBlock = defineBlock({
    type: "MultiplyTexBlock",
    ports: BINARY_TEXTURE_PORTS,
    valid() {
        return (this.hasInput("a") || this.hasInput("tex1d_a"))
            && (this.hasInput("b") || this.hasInput("tex1d_b"));
    },
    execute() {
        const { a, b } = readBinaryTexture(this);
        const result = mapBinary(a, b, (left, right) => left * right, "MultiplyTexBlock");
        return new BlockOutput()
            .setDeclared(this, "out", result)
            .setDeclared(this, "result", result);
    },
});

export const AddTextureBlock = defineBlock({
    type: "AddTextureBlock",
    ports: BINARY_TEXTURE_PORTS,
    execute() {
        const { a, b } = readBinaryTexture(this);
        return out(mapBinary(a, b, (left, right) => left + right, "AddTextureBlock"));
    },
});

export const SubtractTextureBlock = defineBlock({
    type: "SubtractTextureBlock",
    ports: BINARY_TEXTURE_PORTS,
    execute() {
        const { a, b } = readBinaryTexture(this);
        return out(mapBinary(a, b, (left, right) => left - right, "SubtractTextureBlock"));
    },
});

export const ClampTextureBlock = defineBlock({
    type: "ClampTextureBlock",
    ports: CLAMP_TEXTURE_PORTS,
    execute() {
        const bounds = orderedBounds(this.getInput("min"), this.getInput("max"));
        return out(mapUnary(
            this.getInput("tex"),
            (value) => Math.min(bounds.max, Math.max(bounds.min, value)),
            "ClampTextureBlock",
        ));
    },
});

export const InvertTextureBlock = defineBlock({
    type: "InvertTextureBlock",
    ports: INVERT_TEXTURE_PORTS,
    execute() {
        return out(mapUnary(this.getInput("tex"), (value) => 1 - value, "InvertTextureBlock"));
    },
});

export const TEXTURE_BLOCKS = Object.freeze({
    ScaleTextureBlock,
    MultiplyTexBlock,
    AddTextureBlock,
    SubtractTextureBlock,
    ClampTextureBlock,
    InvertTextureBlock,
});

export const TEXTURE_BLOCK_PORTS = Object.freeze({
    ScaleTextureBlock: SCALE_TEXTURE_PORTS,
    MultiplyTexBlock: BINARY_TEXTURE_PORTS,
    AddTextureBlock: BINARY_TEXTURE_PORTS,
    SubtractTextureBlock: BINARY_TEXTURE_PORTS,
    ClampTextureBlock: CLAMP_TEXTURE_PORTS,
    InvertTextureBlock: INVERT_TEXTURE_PORTS,
});
