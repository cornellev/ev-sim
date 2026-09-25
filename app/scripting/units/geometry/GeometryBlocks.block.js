import { BlockOutput } from "../../ScriptManager.js";
import {
    POSE2D_TYPE,
    POSE3D_TYPE,
    VEC2_TYPE,
    VEC3_TYPE,
    normalizePose2d,
    normalizePose3d,
    normalizeVec2,
    normalizeVec3,
} from "../../types/PortTypes.js";
import * as vectorMath from "./vectorMath.js";

import { createBlockHelpers } from "../defineBlock.js";
const { freezePorts, defineBlock } = createBlockHelpers({ defaultOutputType: VEC2_TYPE });
function out(value) {
    return new BlockOutput().set("out", value);
}

const MAKE_VEC2_PORTS = freezePorts(
    [
        { label: "x", type: "float64" },
        { label: "y", type: "float64" },
    ],
    [{ label: "out", type: VEC2_TYPE }],
);
const SPLIT_VEC2_PORTS = freezePorts(
    [{ label: "value", type: VEC2_TYPE }],
    [
        { label: "x", type: "float64" },
        { label: "y", type: "float64" },
    ],
);
const BINARY_VEC2 = freezePorts(
    [
        { label: "a", type: VEC2_TYPE },
        { label: "b", type: VEC2_TYPE },
    ],
    [{ label: "out", type: VEC2_TYPE }],
);
const SCALE_VEC2_PORTS = freezePorts(
    [
        { label: "value", type: VEC2_TYPE },
        { label: "scalar", type: "float64" },
    ],
    [{ label: "out", type: VEC2_TYPE }],
);
const DOT_VEC2_PORTS = freezePorts(
    [
        { label: "a", type: VEC2_TYPE },
        { label: "b", type: VEC2_TYPE },
    ],
    [{ label: "out", type: "float64" }],
);
const UNARY_VEC2 = freezePorts(
    [{ label: "value", type: VEC2_TYPE }],
    [{ label: "out", type: VEC2_TYPE }],
);
const LENGTH_VEC2_PORTS = freezePorts(
    [{ label: "value", type: VEC2_TYPE }],
    [{ label: "out", type: "float64" }],
);
const DISTANCE_VEC2_PORTS = freezePorts(
    [
        { label: "a", type: VEC2_TYPE },
        { label: "b", type: VEC2_TYPE },
    ],
    [{ label: "out", type: "float64" }],
);

const MAKE_VEC3_PORTS = freezePorts(
    [
        { label: "x", type: "float64" },
        { label: "y", type: "float64" },
        { label: "z", type: "float64" },
    ],
    [{ label: "out", type: VEC3_TYPE }],
);
const SPLIT_VEC3_PORTS = freezePorts(
    [{ label: "value", type: VEC3_TYPE }],
    [
        { label: "x", type: "float64" },
        { label: "y", type: "float64" },
        { label: "z", type: "float64" },
    ],
);
const BINARY_VEC3 = freezePorts(
    [
        { label: "a", type: VEC3_TYPE },
        { label: "b", type: VEC3_TYPE },
    ],
    [{ label: "out", type: VEC3_TYPE }],
);
const SCALE_VEC3_PORTS = freezePorts(
    [
        { label: "value", type: VEC3_TYPE },
        { label: "scalar", type: "float64" },
    ],
    [{ label: "out", type: VEC3_TYPE }],
);
const DOT_VEC3_PORTS = freezePorts(
    [
        { label: "a", type: VEC3_TYPE },
        { label: "b", type: VEC3_TYPE },
    ],
    [{ label: "out", type: "float64" }],
);
const UNARY_VEC3 = freezePorts(
    [{ label: "value", type: VEC3_TYPE }],
    [{ label: "out", type: VEC3_TYPE }],
);
const LENGTH_VEC3_PORTS = freezePorts(
    [{ label: "value", type: VEC3_TYPE }],
    [{ label: "out", type: "float64" }],
);
const DISTANCE_VEC3_PORTS = freezePorts(
    [
        { label: "a", type: VEC3_TYPE },
        { label: "b", type: VEC3_TYPE },
    ],
    [{ label: "out", type: "float64" }],
);

const MAKE_POSE2D_PORTS = freezePorts(
    [
        { label: "position", type: VEC2_TYPE },
        { label: "yaw", type: "float64" },
    ],
    [{ label: "out", type: POSE2D_TYPE }],
);
const SPLIT_POSE2D_PORTS = freezePorts(
    [{ label: "value", type: POSE2D_TYPE }],
    [
        { label: "position", type: VEC2_TYPE },
        { label: "yaw", type: "float64" },
    ],
);
const MAKE_POSE3D_PORTS = freezePorts(
    [
        { label: "position", type: VEC3_TYPE },
        { label: "x", type: "float64" },
        { label: "y", type: "float64" },
        { label: "z", type: "float64" },
        { label: "order", type: "string" },
    ],
    [{ label: "out", type: POSE3D_TYPE }],
);
const SPLIT_POSE3D_PORTS = freezePorts(
    [{ label: "value", type: POSE3D_TYPE }],
    [
        { label: "position", type: VEC3_TYPE },
        { label: "x", type: "float64" },
        { label: "y", type: "float64" },
        { label: "z", type: "float64" },
        { label: "order", type: "string" },
    ],
);

export const MakeVec2Block = defineBlock({
    type: "MakeVec2Block",
    ports: MAKE_VEC2_PORTS,
    execute() {
        return out(normalizeVec2({ x: this.getInput("x"), y: this.getInput("y") }));
    },
});

export const SplitVec2Block = defineBlock({
    type: "SplitVec2Block",
    ports: SPLIT_VEC2_PORTS,
    execute() {
        const value = normalizeVec2(this.getInput("value"));
        return new BlockOutput().set("x", value.x).set("y", value.y);
    },
});

export const AddVec2Block = defineBlock({
    type: "AddVec2Block",
    ports: BINARY_VEC2,
    execute() {
        return out(vectorMath.addVec2(this.getInput("a"), this.getInput("b")));
    },
});

export const SubtractVec2Block = defineBlock({
    type: "SubtractVec2Block",
    ports: BINARY_VEC2,
    execute() {
        return out(vectorMath.subtractVec2(this.getInput("a"), this.getInput("b")));
    },
});

export const ScaleVec2Block = defineBlock({
    type: "ScaleVec2Block",
    ports: SCALE_VEC2_PORTS,
    execute() {
        return out(vectorMath.scaleVec2(this.getInput("value"), this.getInput("scalar")));
    },
});

export const DotVec2Block = defineBlock({
    type: "DotVec2Block",
    ports: DOT_VEC2_PORTS,
    execute() {
        return out(vectorMath.dotVec2(this.getInput("a"), this.getInput("b")));
    },
});

export const LengthVec2Block = defineBlock({
    type: "LengthVec2Block",
    ports: LENGTH_VEC2_PORTS,
    execute() {
        return out(vectorMath.lengthVec2(this.getInput("value")));
    },
});

export const NormalizeVec2Block = defineBlock({
    type: "NormalizeVec2Block",
    ports: UNARY_VEC2,
    execute() {
        return out(vectorMath.unitVec2(this.getInput("value")));
    },
});

export const DistanceVec2Block = defineBlock({
    type: "DistanceVec2Block",
    ports: DISTANCE_VEC2_PORTS,
    execute() {
        return out(vectorMath.distanceVec2(this.getInput("a"), this.getInput("b")));
    },
});

export const MakeVec3Block = defineBlock({
    type: "MakeVec3Block",
    ports: MAKE_VEC3_PORTS,
    execute() {
        return out(normalizeVec3({
            x: this.getInput("x"),
            y: this.getInput("y"),
            z: this.getInput("z"),
        }));
    },
});

export const SplitVec3Block = defineBlock({
    type: "SplitVec3Block",
    ports: SPLIT_VEC3_PORTS,
    execute() {
        const value = normalizeVec3(this.getInput("value"));
        return new BlockOutput().set("x", value.x).set("y", value.y).set("z", value.z);
    },
});

export const AddVec3Block = defineBlock({
    type: "AddVec3Block",
    ports: BINARY_VEC3,
    execute() {
        return out(vectorMath.addVec3(this.getInput("a"), this.getInput("b")));
    },
});

export const SubtractVec3Block = defineBlock({
    type: "SubtractVec3Block",
    ports: BINARY_VEC3,
    execute() {
        return out(vectorMath.subtractVec3(this.getInput("a"), this.getInput("b")));
    },
});

export const ScaleVec3Block = defineBlock({
    type: "ScaleVec3Block",
    ports: SCALE_VEC3_PORTS,
    execute() {
        return out(vectorMath.scaleVec3(this.getInput("value"), this.getInput("scalar")));
    },
});

export const DotVec3Block = defineBlock({
    type: "DotVec3Block",
    ports: DOT_VEC3_PORTS,
    execute() {
        return out(vectorMath.dotVec3(this.getInput("a"), this.getInput("b")));
    },
});

export const LengthVec3Block = defineBlock({
    type: "LengthVec3Block",
    ports: LENGTH_VEC3_PORTS,
    execute() {
        return out(vectorMath.lengthVec3(this.getInput("value")));
    },
});

export const NormalizeVec3Block = defineBlock({
    type: "NormalizeVec3Block",
    ports: UNARY_VEC3,
    execute() {
        return out(vectorMath.unitVec3(this.getInput("value")));
    },
});

export const DistanceVec3Block = defineBlock({
    type: "DistanceVec3Block",
    ports: DISTANCE_VEC3_PORTS,
    execute() {
        return out(vectorMath.distanceVec3(this.getInput("a"), this.getInput("b")));
    },
});

export const CrossVec3Block = defineBlock({
    type: "CrossVec3Block",
    ports: BINARY_VEC3,
    execute() {
        return out(vectorMath.crossVec3(this.getInput("a"), this.getInput("b")));
    },
});

export const MakePose2DBlock = defineBlock({
    type: "MakePose2DBlock",
    ports: MAKE_POSE2D_PORTS,
    execute() {
        return out(normalizePose2d({
            position: this.getInput("position"),
            yaw: this.getInput("yaw"),
        }));
    },
});

export const SplitPose2DBlock = defineBlock({
    type: "SplitPose2DBlock",
    ports: SPLIT_POSE2D_PORTS,
    execute() {
        const pose = normalizePose2d(this.getInput("value"));
        return new BlockOutput().set("position", pose.position).set("yaw", pose.yaw);
    },
});

export const MakePose3DBlock = defineBlock({
    type: "MakePose3DBlock",
    ports: MAKE_POSE3D_PORTS,
    valid() {
        return this.hasInput("position")
            && this.hasInput("x")
            && this.hasInput("y")
            && this.hasInput("z");
    },
    execute() {
        return out(normalizePose3d({
            position: this.getInput("position"),
            rotation: {
                x: this.getInput("x"),
                y: this.getInput("y"),
                z: this.getInput("z"),
                order: this.hasInput("order") ? this.getInput("order") : "XYZ",
            },
        }));
    },
});

export const SplitPose3DBlock = defineBlock({
    type: "SplitPose3DBlock",
    ports: SPLIT_POSE3D_PORTS,
    execute() {
        const pose = normalizePose3d(this.getInput("value"));
        return new BlockOutput()
            .set("position", pose.position)
            .set("x", pose.rotation.x)
            .set("y", pose.rotation.y)
            .set("z", pose.rotation.z)
            .set("order", pose.rotation.order);
    },
});

export const GEOMETRY_BLOCKS = Object.freeze({
    MakeVec2Block,
    SplitVec2Block,
    AddVec2Block,
    SubtractVec2Block,
    ScaleVec2Block,
    DotVec2Block,
    LengthVec2Block,
    NormalizeVec2Block,
    DistanceVec2Block,
    MakeVec3Block,
    SplitVec3Block,
    AddVec3Block,
    SubtractVec3Block,
    ScaleVec3Block,
    DotVec3Block,
    LengthVec3Block,
    NormalizeVec3Block,
    DistanceVec3Block,
    CrossVec3Block,
    MakePose2DBlock,
    SplitPose2DBlock,
    MakePose3DBlock,
    SplitPose3DBlock,
});

export const GEOMETRY_BLOCK_PORTS = Object.freeze({
    MakeVec2Block: MAKE_VEC2_PORTS,
    SplitVec2Block: SPLIT_VEC2_PORTS,
    AddVec2Block: BINARY_VEC2,
    SubtractVec2Block: BINARY_VEC2,
    ScaleVec2Block: SCALE_VEC2_PORTS,
    DotVec2Block: DOT_VEC2_PORTS,
    LengthVec2Block: LENGTH_VEC2_PORTS,
    NormalizeVec2Block: UNARY_VEC2,
    DistanceVec2Block: DISTANCE_VEC2_PORTS,
    MakeVec3Block: MAKE_VEC3_PORTS,
    SplitVec3Block: SPLIT_VEC3_PORTS,
    AddVec3Block: BINARY_VEC3,
    SubtractVec3Block: BINARY_VEC3,
    ScaleVec3Block: SCALE_VEC3_PORTS,
    DotVec3Block: DOT_VEC3_PORTS,
    LengthVec3Block: LENGTH_VEC3_PORTS,
    NormalizeVec3Block: UNARY_VEC3,
    DistanceVec3Block: DISTANCE_VEC3_PORTS,
    CrossVec3Block: BINARY_VEC3,
    MakePose2DBlock: MAKE_POSE2D_PORTS,
    SplitPose2DBlock: SPLIT_POSE2D_PORTS,
    MakePose3DBlock: MAKE_POSE3D_PORTS,
    SplitPose3DBlock: SPLIT_POSE3D_PORTS,
});
