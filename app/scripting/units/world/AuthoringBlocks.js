import Unit from "../Unit";

const PLACE_PORTS = {
    inputs: [
        { label: "assetId", type: "string" },
        { label: "pose", type: "pose3d" },
        { label: "parentId", type: "scene_object" },
    ],
    outputs: [
        { label: "then", type: "unit" },
        { label: "id", type: "string" },
        { label: "ok", type: "boolean" },
    ],
};

const GROUP_PORTS = {
    inputs: [
        { label: "name", type: "string" },
        { label: "parentId", type: "scene_object" },
    ],
    outputs: [
        { label: "then", type: "unit" },
        { label: "id", type: "scene_object" },
    ],
};

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

export const PlaceFeatureUnit = staticPortsUnit("Place Feature", PLACE_PORTS);
export const CreateGroupUnit = staticPortsUnit("Create Group", GROUP_PORTS);

export { CreateGroupBlock, PlaceFeatureBlock } from "./AuthoringBlocks.block.js";
