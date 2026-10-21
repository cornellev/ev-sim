import Unit from "../Unit";
import {
    ADD_RIGID_BODY_PORTS,
    GET_RIGID_BODY_PORTS,
    MAKE_RIGID_BODY_PORTS,
    SPLIT_RIGID_BODY_PORTS,
} from "./RigidBodyBlocks.block.js";

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

export const MakeRigidBodyUnit = staticPortsUnit("Make Rigid Body", MAKE_RIGID_BODY_PORTS);
export const SplitRigidBodyUnit = staticPortsUnit("Split Rigid Body", SPLIT_RIGID_BODY_PORTS);
export const GetRigidBodyUnit = staticPortsUnit("Get Rigid Body", GET_RIGID_BODY_PORTS);
export const AddRigidBodyUnit = staticPortsUnit("Add Rigid Body", ADD_RIGID_BODY_PORTS);

export {
    AddRigidBodyBlock,
    GetRigidBodyBlock,
    MakeRigidBodyBlock,
    SplitRigidBodyBlock,
} from "./RigidBodyBlocks.block.js";
