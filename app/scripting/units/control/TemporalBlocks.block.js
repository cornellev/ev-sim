import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { GENERIC_TYPE, finiteFloat, valuesEqual } from "../../types/PortTypes.js";
import {
    cloneRuntimeValue,
    debounceStep,
    derivativeStep,
    fallingPulse,
    hysteresisStep,
    integratorStep,
    mean,
    median,
    nonNegativeFloat,
    pulseStep,
    pushWindow,
    requireDt,
    risingPulse,
    slewStep,
    stopwatchStep,
} from "./temporalMath.js";

function freezePort(port) {
    return Object.freeze({ label: port.label, type: port.type });
}

function freezePorts(inputs, outputs = [{ label: "out", type: "float64" }]) {
    return Object.freeze({
        inputs: Object.freeze(inputs.map(freezePort)),
        outputs: Object.freeze(outputs.map(freezePort)),
    });
}

function defineStatefulBlock({ type, ports, execute, valid, typeScheme, init, serialize, hydrate }) {
    class Block extends UnitBlock {
        static blockType = type;

        constructor(uuid) {
            super(uuid);
            init?.call(this);
        }

        register() {
            for (const port of ports.inputs) this.registerInput(port.label, port.type);
            for (const port of ports.outputs) this.registerOutput(port.label, port.type);
        }

        valid() {
            if (valid) return valid.call(this);
            return ports.inputs.every((port) => this.hasInput(port.label));
        }

        serializeRuntimeState() {
            return serialize ? serialize.call(this) : {};
        }

        hydrateRuntimeState(state = {}) {
            if (hydrate) hydrate.call(this, state);
        }

        execute() {
            return execute.call(this);
        }
    }

    if (typeScheme) Block.typeScheme = typeScheme;
    try {
        Object.defineProperty(Block, "name", { value: type });
    } catch {
        // Class name is non-configurable in some engines; blockType is the authority.
    }

    return Block;
}

function out(label, value) {
    return new BlockOutput().set(label, value);
}

function hydrateSamples(state = {}) {
    if (!Array.isArray(state.samples)) return [];
    return state.samples.map((sample) => finiteFloat(sample));
}

const PREVIOUS_SCHEME = Object.freeze({
    variables: Object.freeze({
        T: Object.freeze({
            inputs: Object.freeze(["value", "initial"]),
            outputs: Object.freeze(["previous"]),
        }),
    }),
});

const VALUE_CHANGED_SCHEME = Object.freeze({
    variables: Object.freeze({
        T: Object.freeze({
            inputs: Object.freeze(["value"]),
            outputs: Object.freeze([]),
        }),
    }),
});

const PREVIOUS_PORTS = freezePorts(
    [
        { label: "value", type: GENERIC_TYPE },
        { label: "initial", type: GENERIC_TYPE },
    ],
    [{ label: "previous", type: GENERIC_TYPE }],
);
const VALUE_CHANGED_PORTS = freezePorts(
    [{ label: "value", type: GENERIC_TYPE }],
    [{ label: "changed", type: "boolean" }],
);
const EDGE_PORTS = freezePorts(
    [{ label: "value", type: "boolean" }],
    [{ label: "pulse", type: "boolean" }],
);
const DEBOUNCE_PORTS = freezePorts(
    [
        { label: "value", type: "boolean" },
        { label: "dt", type: "float64" },
        { label: "duration", type: "float64" },
    ],
    [{ label: "out", type: "boolean" }],
);
const HYSTERESIS_PORTS = freezePorts(
    [
        { label: "value", type: "float64" },
        { label: "low", type: "float64" },
        { label: "high", type: "float64" },
    ],
    [{ label: "out", type: "boolean" }],
);
const PULSE_PORTS = freezePorts(
    [
        { label: "trigger", type: "boolean" },
        { label: "dt", type: "float64" },
        { label: "duration", type: "float64" },
    ],
    [{ label: "out", type: "boolean" }],
);
const STOPWATCH_PORTS = freezePorts(
    [
        { label: "enabled", type: "boolean" },
        { label: "reset", type: "boolean" },
        { label: "dt", type: "float64" },
    ],
    [{ label: "elapsed", type: "float64" }],
);
const WINDOW_PORTS = freezePorts([
    { label: "value", type: "float64" },
    { label: "window", type: "int32" },
]);
const SLEW_PORTS = freezePorts([
    { label: "value", type: "float64" },
    { label: "riseRate", type: "float64" },
    { label: "fallRate", type: "float64" },
    { label: "dt", type: "float64" },
]);
const INTEGRATOR_PORTS = freezePorts([
    { label: "value", type: "float64" },
    { label: "dt", type: "float64" },
    { label: "reset", type: "boolean" },
]);

export const PreviousBlock = defineStatefulBlock({
    type: "PreviousBlock",
    ports: PREVIOUS_PORTS,
    typeScheme: PREVIOUS_SCHEME,
    init() {
        this.value = null;
        this.initialized = false;
    },
    serialize() {
        return {
            value: cloneRuntimeValue(this.value),
            initialized: Boolean(this.initialized),
        };
    },
    hydrate(state = {}) {
        this.initialized = state.initialized === true;
        this.value = this.initialized ? cloneRuntimeValue(state.value) : null;
    },
    execute() {
        const value = this.getInput("value");
        const initial = this.getInput("initial");
        const emitted = this.initialized ? cloneRuntimeValue(this.value) : cloneRuntimeValue(initial);
        this.value = cloneRuntimeValue(value);
        this.initialized = true;
        return out("previous", emitted);
    },
});

export const ValueChangedBlock = defineStatefulBlock({
    type: "ValueChangedBlock",
    ports: VALUE_CHANGED_PORTS,
    typeScheme: VALUE_CHANGED_SCHEME,
    init() {
        this.previous = null;
        this.initialized = false;
    },
    serialize() {
        return {
            previous: cloneRuntimeValue(this.previous),
            initialized: Boolean(this.initialized),
        };
    },
    hydrate(state = {}) {
        this.initialized = state.initialized === true;
        this.previous = this.initialized ? cloneRuntimeValue(state.previous) : null;
    },
    execute() {
        const value = this.getInput("value");
        const changed = this.initialized ? !valuesEqual(value, this.previous) : false;
        this.previous = cloneRuntimeValue(value);
        this.initialized = true;
        return out("changed", changed);
    },
});

export const RisingEdgeBlock = defineStatefulBlock({
    type: "RisingEdgeBlock",
    ports: EDGE_PORTS,
    init() {
        this.previous = false;
        this.initialized = false;
    },
    serialize() {
        return { previous: Boolean(this.previous), initialized: Boolean(this.initialized) };
    },
    hydrate(state = {}) {
        this.previous = Boolean(state.previous);
        this.initialized = Boolean(state.initialized);
    },
    execute() {
        const next = risingPulse(this.previous, this.initialized, Boolean(this.getInput("value")));
        this.previous = next.previous;
        this.initialized = next.initialized;
        return out("pulse", next.pulse);
    },
});

export const FallingEdgeBlock = defineStatefulBlock({
    type: "FallingEdgeBlock",
    ports: EDGE_PORTS,
    init() {
        this.previous = false;
        this.initialized = false;
    },
    serialize() {
        return { previous: Boolean(this.previous), initialized: Boolean(this.initialized) };
    },
    hydrate(state = {}) {
        this.previous = Boolean(state.previous);
        this.initialized = Boolean(state.initialized);
    },
    execute() {
        const next = fallingPulse(this.previous, this.initialized, Boolean(this.getInput("value")));
        this.previous = next.previous;
        this.initialized = next.initialized;
        return out("pulse", next.pulse);
    },
});

export const DebounceBlock = defineStatefulBlock({
    type: "DebounceBlock",
    ports: DEBOUNCE_PORTS,
    init() {
        this.output = false;
        this.candidate = false;
        this.elapsed = 0;
    },
    serialize() {
        return {
            output: Boolean(this.output),
            candidate: Boolean(this.candidate),
            elapsed: finiteFloat(this.elapsed),
        };
    },
    hydrate(state = {}) {
        this.output = Boolean(state.output);
        this.candidate = Boolean(state.candidate);
        this.elapsed = finiteFloat(state.elapsed);
    },
    execute() {
        const dt = requireDt(this.getInput("dt"), this.typeId());
        const next = debounceStep(
            { output: this.output, candidate: this.candidate, elapsed: this.elapsed },
            Boolean(this.getInput("value")),
            dt,
            nonNegativeFloat(this.getInput("duration")),
        );
        this.output = next.output;
        this.candidate = next.candidate;
        this.elapsed = next.elapsed;
        return out("out", next.output);
    },
});

export const HysteresisBlock = defineStatefulBlock({
    type: "HysteresisBlock",
    ports: HYSTERESIS_PORTS,
    init() {
        this.output = false;
    },
    serialize() {
        return { output: Boolean(this.output) };
    },
    hydrate(state = {}) {
        this.output = Boolean(state.output);
    },
    execute() {
        this.output = hysteresisStep(
            this.output,
            this.getInput("value"),
            this.getInput("low"),
            this.getInput("high"),
        );
        return out("out", this.output);
    },
});

export const PulseBlock = defineStatefulBlock({
    type: "PulseBlock",
    ports: PULSE_PORTS,
    init() {
        this.previous = false;
        this.remaining = 0;
        this.initialized = false;
    },
    serialize() {
        return {
            previous: Boolean(this.previous),
            remaining: finiteFloat(this.remaining),
            initialized: Boolean(this.initialized),
        };
    },
    hydrate(state = {}) {
        this.previous = Boolean(state.previous);
        this.remaining = Math.max(0, finiteFloat(state.remaining));
        this.initialized = Boolean(state.initialized);
    },
    execute() {
        const dt = requireDt(this.getInput("dt"), this.typeId());
        const next = pulseStep(
            { previous: this.previous, remaining: this.remaining, initialized: this.initialized },
            Boolean(this.getInput("trigger")),
            dt,
            this.getInput("duration"),
        );
        this.previous = next.previous;
        this.remaining = next.remaining;
        this.initialized = next.initialized;
        return out("out", next.out);
    },
});

export const StopwatchBlock = defineStatefulBlock({
    type: "StopwatchBlock",
    ports: STOPWATCH_PORTS,
    init() {
        this.elapsed = 0;
    },
    serialize() {
        return { elapsed: finiteFloat(this.elapsed) };
    },
    hydrate(state = {}) {
        this.elapsed = Math.max(0, finiteFloat(state.elapsed));
    },
    execute() {
        const dt = requireDt(this.getInput("dt"), this.typeId());
        this.elapsed = stopwatchStep(
            this.elapsed,
            Boolean(this.getInput("enabled")),
            Boolean(this.getInput("reset")),
            dt,
        );
        return out("elapsed", this.elapsed);
    },
});

export const MovingAverageBlock = defineStatefulBlock({
    type: "MovingAverageBlock",
    ports: WINDOW_PORTS,
    init() {
        this.samples = [];
    },
    serialize() {
        return { samples: cloneRuntimeValue(this.samples) ?? [] };
    },
    hydrate(state = {}) {
        this.samples = hydrateSamples(state);
    },
    execute() {
        this.samples = pushWindow(this.samples, this.getInput("value"), this.getInput("window"));
        return out("out", mean(this.samples));
    },
});

export const MedianFilterBlock = defineStatefulBlock({
    type: "MedianFilterBlock",
    ports: WINDOW_PORTS,
    init() {
        this.samples = [];
    },
    serialize() {
        return { samples: cloneRuntimeValue(this.samples) ?? [] };
    },
    hydrate(state = {}) {
        this.samples = hydrateSamples(state);
    },
    execute() {
        this.samples = pushWindow(this.samples, this.getInput("value"), this.getInput("window"));
        return out("out", median(this.samples));
    },
});

export const SlewRateBlock = defineStatefulBlock({
    type: "SlewRateBlock",
    ports: SLEW_PORTS,
    init() {
        this.output = 0;
        this.initialized = false;
    },
    serialize() {
        return { output: finiteFloat(this.output), initialized: Boolean(this.initialized) };
    },
    hydrate(state = {}) {
        this.output = finiteFloat(state.output);
        this.initialized = Boolean(state.initialized);
    },
    execute() {
        const dt = requireDt(this.getInput("dt"), this.typeId());
        const next = slewStep(
            { output: this.output, initialized: this.initialized },
            this.getInput("value"),
            this.getInput("riseRate"),
            this.getInput("fallRate"),
            dt,
        );
        this.output = next.output;
        this.initialized = next.initialized;
        return out("out", next.output);
    },
});

export const IntegratorBlock = defineStatefulBlock({
    type: "IntegratorBlock",
    ports: INTEGRATOR_PORTS,
    init() {
        this.integral = 0;
    },
    serialize() {
        return { integral: finiteFloat(this.integral) };
    },
    hydrate(state = {}) {
        this.integral = finiteFloat(state.integral);
    },
    execute() {
        const dt = requireDt(this.getInput("dt"), this.typeId());
        this.integral = integratorStep(
            this.integral,
            this.getInput("value"),
            dt,
            Boolean(this.getInput("reset")),
        );
        return out("out", this.integral);
    },
});

export const DerivativeBlock = defineStatefulBlock({
    type: "DerivativeBlock",
    ports: INTEGRATOR_PORTS,
    init() {
        this.previous = 0;
        this.initialized = false;
    },
    serialize() {
        return { previous: finiteFloat(this.previous), initialized: Boolean(this.initialized) };
    },
    hydrate(state = {}) {
        this.previous = finiteFloat(state.previous);
        this.initialized = Boolean(state.initialized);
    },
    execute() {
        const dt = requireDt(this.getInput("dt"), this.typeId());
        const next = derivativeStep(
            { previous: this.previous, initialized: this.initialized },
            this.getInput("value"),
            dt,
            Boolean(this.getInput("reset")),
        );
        this.previous = next.previous;
        this.initialized = next.initialized;
        return out("out", next.out);
    },
});

export const TEMPORAL_BLOCKS = Object.freeze({
    PreviousBlock,
    ValueChangedBlock,
    RisingEdgeBlock,
    FallingEdgeBlock,
    DebounceBlock,
    HysteresisBlock,
    PulseBlock,
    StopwatchBlock,
    MovingAverageBlock,
    MedianFilterBlock,
    SlewRateBlock,
    IntegratorBlock,
    DerivativeBlock,
});

export const TEMPORAL_BLOCK_PORTS = Object.freeze({
    PreviousBlock: PREVIOUS_PORTS,
    ValueChangedBlock: VALUE_CHANGED_PORTS,
    RisingEdgeBlock: EDGE_PORTS,
    FallingEdgeBlock: EDGE_PORTS,
    DebounceBlock: DEBOUNCE_PORTS,
    HysteresisBlock: HYSTERESIS_PORTS,
    PulseBlock: PULSE_PORTS,
    StopwatchBlock: STOPWATCH_PORTS,
    MovingAverageBlock: WINDOW_PORTS,
    MedianFilterBlock: WINDOW_PORTS,
    SlewRateBlock: SLEW_PORTS,
    IntegratorBlock: INTEGRATOR_PORTS,
    DerivativeBlock: INTEGRATOR_PORTS,
});
