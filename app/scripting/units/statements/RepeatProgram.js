import Unit from "../Unit";
import { repeatProgramPorts } from "./RepeatProgram.block.js";

export function RepeatProgramUnit({ _uuid, initialState = {} }) {
    const ports = repeatProgramPorts(initialState);
    return (
        <Unit
            title="Repeat Program"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[...ports.inputs]}
            outputs={[...ports.outputs]}
        />
    );
}

export { RepeatProgramBlock } from "./RepeatProgram.block.js";
