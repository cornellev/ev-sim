import Unit from "../Unit";
import { WORLD_BLOCK_PORTS } from "./WorldBlocks.block.js";

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

export const FrameAlongPathUnit = staticPortsUnit("Frame Along Path", WORLD_BLOCK_PORTS.FrameAlongPathBlock);
export const SampleRoadUnit = staticPortsUnit("Sample Road", WORLD_BLOCK_PORTS.SampleRoadBlock);
export const GetNearestRoadUnit = staticPortsUnit("Get Nearest Road", WORLD_BLOCK_PORTS.GetNearestRoadBlock);
export const SpawnPropUnit = staticPortsUnit("Spawn Prop", WORLD_BLOCK_PORTS.SpawnPropBlock);
export const ScatterFeaturesUnit = staticPortsUnit("Scatter Features", WORLD_BLOCK_PORTS.ScatterFeaturesBlock);

export {
    FrameAlongPathBlock,
    GetNearestRoadBlock,
    SampleRoadBlock,
    ScatterFeaturesBlock,
    SpawnPropBlock,
} from "./WorldBlocks.block.js";
