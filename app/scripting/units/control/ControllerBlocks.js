import Unit from "../Unit";
import { CONTROLLER_BLOCK_PORTS } from "./ControllerBlocks.block.js";

export function PidControllerUnit({ _uuid }) {
    const ports = CONTROLLER_BLOCK_PORTS.PidControllerBlock;
    return (
        <Unit
            title="PID Controller"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[...ports.inputs]}
            outputs={[...ports.outputs]}
        />
    );
}

export { PidControllerBlock } from "./ControllerBlocks.block.js";
