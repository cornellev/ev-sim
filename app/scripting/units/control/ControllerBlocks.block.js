import { BlockOutput } from "../../ScriptManager.js";
import { finiteFloat } from "../../types/PortTypes.js";
import { pidStep, requireDt } from "./temporalMath.js";

import { freezePorts, defineStatefulBlock } from "../defineBlock.js";
const PID_PORTS = freezePorts(
    [
        { label: "setpoint", type: "float64" },
        { label: "measurement", type: "float64" },
        { label: "kp", type: "float64" },
        { label: "ki", type: "float64" },
        { label: "kd", type: "float64" },
        { label: "dt", type: "float64" },
        { label: "min", type: "float64" },
        { label: "max", type: "float64" },
        { label: "reset", type: "boolean" },
    ],
    [
        { label: "command", type: "float64" },
        { label: "error", type: "float64" },
        { label: "p", type: "float64" },
        { label: "i", type: "float64" },
        { label: "d", type: "float64" },
        { label: "saturated", type: "boolean" },
    ],
);

export const PidControllerBlock = defineStatefulBlock({
    type: "PidControllerBlock",
    ports: PID_PORTS,
    init() {
        this.integral = 0;
        this.previousError = 0;
        this.initialized = false;
    },
    serialize() {
        return {
            integral: finiteFloat(this.integral),
            previousError: finiteFloat(this.previousError),
            initialized: Boolean(this.initialized),
        };
    },
    hydrate(state = {}) {
        this.integral = finiteFloat(state.integral);
        this.previousError = finiteFloat(state.previousError);
        this.initialized = Boolean(state.initialized);
    },
    execute() {
        const dt = requireDt(this.getInput("dt"), this.typeId());
        const next = pidStep(
            {
                integral: this.integral,
                previousError: this.previousError,
                initialized: this.initialized,
            },
            {
                setpoint: this.getInput("setpoint"),
                measurement: this.getInput("measurement"),
                kp: this.getInput("kp"),
                ki: this.getInput("ki"),
                kd: this.getInput("kd"),
                dt,
                min: this.getInput("min"),
                max: this.getInput("max"),
                reset: Boolean(this.getInput("reset")),
            },
        );
        this.integral = next.state.integral;
        this.previousError = next.state.previousError;
        this.initialized = next.state.initialized;
        return new BlockOutput()
            .set("command", next.outputs.command)
            .set("error", next.outputs.error)
            .set("p", next.outputs.p)
            .set("i", next.outputs.i)
            .set("d", next.outputs.d)
            .set("saturated", next.outputs.saturated);
    },
});

export const CONTROLLER_BLOCKS = Object.freeze({
    PidControllerBlock,
});

export const CONTROLLER_BLOCK_PORTS = Object.freeze({
    PidControllerBlock: PID_PORTS,
});
