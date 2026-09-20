import { BlockOutput, CompiledProgramUnitBlock, ScriptManager } from "../../ScriptManager.js";
import { UNIT, UNIT_TYPE, finiteInt32 } from "../../types/PortTypes.js";

export const MAX_REPEAT_COUNT = 256;
export const RESERVED_REPEAT_INPUTS = Object.freeze(["index", "item", "count"]);

function freezePort(port) {
    return Object.freeze({ label: port.label, type: port.type });
}

export function repeatProgramPorts(state = {}) {
    const inputPorts = state?.compiledProgram?.interface?.inputs || [];
    const outputPorts = state?.compiledProgram?.interface?.outputs || [];
    const reserved = new Set(RESERVED_REPEAT_INPUTS);
    return Object.freeze({
        inputs: Object.freeze([
            freezePort({ label: "count", type: "int32" }),
            ...inputPorts
                .filter((port) => !reserved.has(port.label))
                .map((port) => freezePort({ label: port.label, type: port.type })),
        ]),
        outputs: Object.freeze([
            ...outputPorts
                .filter((port) => port.label !== "then" && port.label !== "count")
                .map((port) => freezePort({ label: port.label, type: port.type })),
            freezePort({ label: "then", type: UNIT_TYPE }),
            freezePort({ label: "count", type: "int32" }),
        ]),
    });
}

export class RepeatProgramBlock extends CompiledProgramUnitBlock {
    static blockType = "RepeatProgramBlock";

    register() {
        const ports = repeatProgramPorts(this.state);
        for (const port of ports.inputs) this.registerInput(port.label, port.type);
        for (const port of ports.outputs) this.registerOutput(port.label, port.type);
    }

    valid() {
        const compiledProgram = this.state?.compiledProgram;
        if (!compiledProgram) return false;
        if (!this.hasInput("count")) return false;
        const reserved = new Set(RESERVED_REPEAT_INPUTS);
        return (compiledProgram.interface?.inputs || []).every((port) => (
            reserved.has(port.label) || this.hasInput(port.label)
        ));
    }

    execute() {
        const compiledProgram = this.state?.compiledProgram;
        if (!compiledProgram) return new BlockOutput().set("then", UNIT).set("count", 0);

        const count = Math.min(MAX_REPEAT_COUNT, Math.max(0, finiteInt32(this.getInput("count"))));
        const reserved = new Set(RESERVED_REPEAT_INPUTS);
        const wiredInputs = {};
        for (const port of compiledProgram.interface?.inputs || []) {
            if (reserved.has(port.label) || !this.hasInput(port.label)) continue;
            wiredInputs[port.label] = this.getInput(port.label);
        }

        if (!this.runner) {
            this.runner = ScriptManager.createRunner(compiledProgram, {
                signalStore: this.manager?.getSignalStore?.(),
                runtimeContext: this.manager?.getRuntimeContext?.(),
                blockRegistry: this.manager?.getBlockRegistry?.() ?? this.manager?.blockRegistry,
                pluginHost: this.manager?.getPluginHost?.() ?? this.manager?.pluginHost,
                pluginSession: this.manager?.getPluginSession?.() ?? this.manager?.pluginSession,
                scopeId: `${this.manager?.getScopeId?.() ?? this.manager?.scopeId ?? "script"}/repeat:${this.uuid}`,
            });
            if (this.pendingRuntimeState) {
                this.runner.hydrateRuntimeState(this.pendingRuntimeState);
                this.pendingRuntimeState = null;
            }
        } else {
            this.runner.setSignalStore?.(this.manager?.getSignalStore?.());
            this.runner.setRuntimeContext?.(this.manager?.getRuntimeContext?.() || {});
        }

        let lastOutputs = {};
        for (let index = 0; index < count; index += 1) {
            const run = this.runner.run({
                ...wiredInputs,
                count,
                index,
                item: index,
            });
            if (run.status === "failure") {
                const error = new Error(`Repeat Program child failed: ${run.e?.message || "unknown error"}`);
                Object.assign(error, run.e ?? {});
                throw error;
            }
            lastOutputs = run.outputs || {};
        }

        const output = new BlockOutput();
        for (const port of compiledProgram.interface?.outputs || []) {
            if (port.label === "then" || port.label === "count") continue;
            output.set(port.label, lastOutputs[port.label]);
        }
        return output.set("then", UNIT).set("count", count);
    }
}
