import Unit from "../Unit";
import { REPEAT_INDEX_PORTS, REPEAT_PORTS } from "./Repeat.block.js";

export function RepeatUnit({ _uuid }) {
    return (
        <Unit
            title="Repeat"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[...REPEAT_PORTS.inputs]}
            outputs={[...REPEAT_PORTS.outputs]}
        />
    );
}

export function RepeatIndexUnit({ _uuid }) {
    return (
        <Unit
            title="Index"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[...REPEAT_INDEX_PORTS.inputs]}
            outputs={[...REPEAT_INDEX_PORTS.outputs]}
        />
    );
}

export { RepeatBlock, RepeatIndexBlock } from "./Repeat.block.js";
