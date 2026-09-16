import Unit from "../Unit";
import { GEOMETRY_BLOCK_PORTS } from "./GeometryBlocks.block.js";

function staticPortsUnit(title, ports) {
    function StaticUnit({ _uuid }) {
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={[...ports.inputs]}
                outputs={[...ports.outputs]}
            />
        );
    }
    StaticUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return StaticUnit;
}

export const MakeVec2Unit = staticPortsUnit("Make Vec2", GEOMETRY_BLOCK_PORTS.MakeVec2Block);
export const SplitVec2Unit = staticPortsUnit("Split Vec2", GEOMETRY_BLOCK_PORTS.SplitVec2Block);
export const AddVec2Unit = staticPortsUnit("Add Vec2", GEOMETRY_BLOCK_PORTS.AddVec2Block);
export const SubtractVec2Unit = staticPortsUnit("Subtract Vec2", GEOMETRY_BLOCK_PORTS.SubtractVec2Block);
export const ScaleVec2Unit = staticPortsUnit("Scale Vec2", GEOMETRY_BLOCK_PORTS.ScaleVec2Block);
export const DotVec2Unit = staticPortsUnit("Dot Vec2", GEOMETRY_BLOCK_PORTS.DotVec2Block);
export const LengthVec2Unit = staticPortsUnit("Length Vec2", GEOMETRY_BLOCK_PORTS.LengthVec2Block);
export const NormalizeVec2Unit = staticPortsUnit("Normalize Vec2", GEOMETRY_BLOCK_PORTS.NormalizeVec2Block);
export const DistanceVec2Unit = staticPortsUnit("Distance Vec2", GEOMETRY_BLOCK_PORTS.DistanceVec2Block);
export const MakeVec3Unit = staticPortsUnit("Make Vec3", GEOMETRY_BLOCK_PORTS.MakeVec3Block);
export const SplitVec3Unit = staticPortsUnit("Split Vec3", GEOMETRY_BLOCK_PORTS.SplitVec3Block);
export const AddVec3Unit = staticPortsUnit("Add Vec3", GEOMETRY_BLOCK_PORTS.AddVec3Block);
export const SubtractVec3Unit = staticPortsUnit("Subtract Vec3", GEOMETRY_BLOCK_PORTS.SubtractVec3Block);
export const ScaleVec3Unit = staticPortsUnit("Scale Vec3", GEOMETRY_BLOCK_PORTS.ScaleVec3Block);
export const DotVec3Unit = staticPortsUnit("Dot Vec3", GEOMETRY_BLOCK_PORTS.DotVec3Block);
export const LengthVec3Unit = staticPortsUnit("Length Vec3", GEOMETRY_BLOCK_PORTS.LengthVec3Block);
export const NormalizeVec3Unit = staticPortsUnit("Normalize Vec3", GEOMETRY_BLOCK_PORTS.NormalizeVec3Block);
export const DistanceVec3Unit = staticPortsUnit("Distance Vec3", GEOMETRY_BLOCK_PORTS.DistanceVec3Block);
export const CrossVec3Unit = staticPortsUnit("Cross Vec3", GEOMETRY_BLOCK_PORTS.CrossVec3Block);
export const MakePose2DUnit = staticPortsUnit("Make Pose 2D", GEOMETRY_BLOCK_PORTS.MakePose2DBlock);
export const SplitPose2DUnit = staticPortsUnit("Split Pose 2D", GEOMETRY_BLOCK_PORTS.SplitPose2DBlock);
export const MakePose3DUnit = staticPortsUnit("Make Pose 3D", GEOMETRY_BLOCK_PORTS.MakePose3DBlock);
export const SplitPose3DUnit = staticPortsUnit("Split Pose 3D", GEOMETRY_BLOCK_PORTS.SplitPose3DBlock);

export {
    AddVec2Block,
    AddVec3Block,
    CrossVec3Block,
    DistanceVec2Block,
    DistanceVec3Block,
    DotVec2Block,
    DotVec3Block,
    LengthVec2Block,
    LengthVec3Block,
    MakePose2DBlock,
    MakePose3DBlock,
    MakeVec2Block,
    MakeVec3Block,
    NormalizeVec2Block,
    NormalizeVec3Block,
    ScaleVec2Block,
    ScaleVec3Block,
    SplitPose2DBlock,
    SplitPose3DBlock,
    SplitVec2Block,
    SplitVec3Block,
    SubtractVec2Block,
    SubtractVec3Block,
} from "./GeometryBlocks.block.js";
