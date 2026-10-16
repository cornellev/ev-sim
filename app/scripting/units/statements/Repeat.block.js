import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { REPEAT_BODY_INPUT, REPEAT_REF_PORT } from "../../runtime/LoopFrames.js";
import { REPEAT_REF_TYPE, UNIT, UNIT_TYPE, finiteInt32 } from "../../types/PortTypes.js";

import { freezePort } from "../defineBlock.js";

export const MAX_REPEAT_COUNT = 256;
export const INDEX_OUTSIDE_REPEAT_ERROR = "Index read outside its Repeat.";
export const REPEAT_HOST_ERROR = "Repeat requires a loop-aware script runner.";

export const REPEAT_PORTS = Object.freeze({
    inputs: Object.freeze([
        freezePort({ label: "count", type: "int32" }),
        freezePort({ label: REPEAT_BODY_INPUT, type: UNIT_TYPE }),
    ]),
    outputs: Object.freeze([
        freezePort({ label: "then", type: UNIT_TYPE }),
        freezePort({ label: "count", type: "int32" }),
        freezePort({ label: REPEAT_REF_PORT, type: REPEAT_REF_TYPE }),
    ]),
});

export const REPEAT_INDEX_PORTS = Object.freeze({
    inputs: Object.freeze([
        freezePort({ label: REPEAT_REF_PORT, type: REPEAT_REF_TYPE }),
    ]),
    outputs: Object.freeze([
        freezePort({ label: "index", type: "int32" }),
        freezePort({ label: "count", type: "int32" }),
        freezePort({ label: "t", type: "float64" }),
    ]),
});

function registerPorts(block, ports) {
    for (const port of ports.inputs) block.registerInput(port.label, port.type);
    for (const port of ports.outputs) block.registerOutput(port.label, port.type);
}

export class RepeatBlock extends UnitBlock {
    static blockType = "RepeatBlock";

    register() {
        registerPorts(this, REPEAT_PORTS);
    }

    valid() {
        return this.hasInput("count") && this.hasInput(REPEAT_BODY_INPUT);
    }

    execute() {
        const manager = this.manager;
        if (typeof manager?.setLoopFrame !== "function") throw new Error(REPEAT_HOST_ERROR);

        const count = Math.min(MAX_REPEAT_COUNT, Math.max(0, finiteInt32(this.getInput("count"))));
        const passUnits = [...manager.getLoopPassUnits(this.uuid)];
        try {
            for (let index = 0; index < count; index += 1) {
                manager.setLoopFrame(this.uuid, { index, count });
                manager.invalidateOutputs(passUnits);
                this.getInput(REPEAT_BODY_INPUT);
            }
        } finally {
            manager.setLoopFrame(this.uuid, null);
        }

        return new BlockOutput()
            .set("then", UNIT)
            .set("count", count)
            .set(REPEAT_REF_PORT, { type: REPEAT_REF_TYPE, uuid: this.uuid });
    }
}

export class RepeatIndexBlock extends UnitBlock {
    static blockType = "RepeatIndexBlock";

    register() {
        registerPorts(this, REPEAT_INDEX_PORTS);
    }

    valid() {
        return this.hasInput(REPEAT_REF_PORT);
    }

    execute() {
        const repeatUuid = this.inputSourceUuid(REPEAT_REF_PORT);
        const frame = repeatUuid ? this.manager?.getLoopFrame?.(repeatUuid) : null;
        if (!frame) throw new Error(INDEX_OUTSIDE_REPEAT_ERROR);

        const { index, count } = frame;
        return new BlockOutput()
            .set("index", index)
            .set("count", count)
            .set("t", index / Math.max(count - 1, 1));
    }
}
