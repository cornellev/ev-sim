import { BlockOutput, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

export function SampleTextureUnit({ _uuid }) {
    return (
        <Unit
            title="Sample Texture"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex", type: "tex1d" },
                { label: "x", type: "float64" },
                { label: "y", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "float64" }
            ]}
        />
    );
}

export class SampleTextureBlock extends UnitBlock {
    register() {
        this.registerInput("tex", "tex1d");
        this.registerInput("x", "float64");
        this.registerInput("y", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("tex") && this.hasInput("x") && this.hasInput("y");
    }

    execute() {
        const tex = this.getInput("tex") || [];
        if (tex.length === 0) {
            return new BlockOutput().set("out", 0);
        }

        const size = Math.max(1, Math.floor(Math.sqrt(tex.length)));
        const x = Math.max(0, Math.min(1, this.getInput("x") || 0));
        const y = Math.max(0, Math.min(1, this.getInput("y") || 0));

        const ix = Math.min(size - 1, Math.floor(x * (size - 1)));
        const iy = Math.min(size - 1, Math.floor(y * (size - 1)));

        return new BlockOutput().set("out", tex[iy * size + ix] || 0);
    }
}

export function LowPassFilterUnit({ _uuid }) {
    return (
        <Unit
            title="Low Pass Filter"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "signal", type: "float64" },
                { label: "alpha", type: "float64" }
            ]}
            outputs={[
                { label: "filtered", type: "float64" }
            ]}
        />
    );
}

export class LowPassFilterBlock extends UnitBlock {
    constructor(uuid) {
        super(uuid);
        this.prev = 0;
        this.initialized = false;
    }

    register() {
        this.registerInput("signal", "float64");
        this.registerInput("alpha", "float64");
        this.registerOutput("filtered", "float64");
    }

    valid() {
        return this.hasInput("signal") && this.hasInput("alpha");
    }

    execute() {
        const signal = this.getInput("signal") || 0;
        const alpha = Math.max(0, Math.min(1, this.getInput("alpha") || 0.5));

        if (!this.initialized) {
            this.prev = signal;
            this.initialized = true;
        }

        this.prev = this.prev + alpha * (signal - this.prev);
        return new BlockOutput().set("filtered", this.prev);
    }
}

export function RateLimiterUnit({ _uuid }) {
    return (
        <Unit
            title="Rate Limiter"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "signal", type: "float64" },
                { label: "max delta", type: "float64" }
            ]}
            outputs={[
                { label: "limited", type: "float64" }
            ]}
        />
    );
}

export class RateLimiterBlock extends UnitBlock {
    constructor(uuid) {
        super(uuid);
        this.prev = 0;
        this.initialized = false;
    }

    register() {
        this.registerInput("signal", "float64");
        this.registerInput("max delta", "float64");
        this.registerOutput("limited", "float64");
    }

    valid() {
        return this.hasInput("signal") && this.hasInput("max delta");
    }

    execute() {
        const signal = this.getInput("signal") || 0;
        const maxDelta = Math.max(0, this.getInput("max delta") || 0);

        if (!this.initialized) {
            this.prev = signal;
            this.initialized = true;
            return new BlockOutput().set("limited", signal);
        }

        const delta = signal - this.prev;
        if (delta > maxDelta) {
            this.prev += maxDelta;
        } else if (delta < -maxDelta) {
            this.prev -= maxDelta;
        } else {
            this.prev = signal;
        }

        return new BlockOutput().set("limited", this.prev);
    }
}

export function SensorFusionUnit({ _uuid }) {
    return (
        <Unit
            title="Sensor Fusion"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "primary", type: "float64" },
                { label: "secondary", type: "float64" },
                { label: "weight", type: "float64" },
                { label: "bias", type: "float64" }
            ]}
            outputs={[
                { label: "fused", type: "float64" }
            ]}
        />
    );
}

export class SensorFusionBlock extends UnitBlock {
    register() {
        this.registerInput("primary", "float64");
        this.registerInput("secondary", "float64");
        this.registerInput("weight", "float64");
        this.registerInput("bias", "float64");
        this.registerOutput("fused", "float64");
    }

    valid() {
        return this.hasInput("primary")
            && this.hasInput("secondary")
            && this.hasInput("weight")
            && this.hasInput("bias");
    }

    execute() {
        const primary = this.getInput("primary") || 0;
        const secondary = this.getInput("secondary") || 0;
        const weight = Math.max(0, Math.min(1, this.getInput("weight") || 0.5));
        const bias = this.getInput("bias") || 0;

        const fused = primary * weight + secondary * (1 - weight) + bias;
        return new BlockOutput().set("fused", fused);
    }
}

export function ThresholdGateUnit({ _uuid }) {
    return (
        <Unit
            title="Threshold Gate"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "signal", type: "float64" },
                { label: "min", type: "float64" },
                { label: "max", type: "float64" }
            ]}
            outputs={[
                { label: "in range", type: "boolean" }
            ]}
        />
    );
}

export class ThresholdGateBlock extends UnitBlock {
    register() {
        this.registerInput("signal", "float64");
        this.registerInput("min", "float64");
        this.registerInput("max", "float64");
        this.registerOutput("in range", "boolean");
    }

    valid() {
        return this.hasInput("signal") && this.hasInput("min") && this.hasInput("max");
    }

    execute() {
        const signal = this.getInput("signal") || 0;
        let min = this.getInput("min") || 0;
        let max = this.getInput("max") || 0;

        if (min > max) {
            const tmp = min;
            min = max;
            max = tmp;
        }

        return new BlockOutput().set("in range", signal >= min && signal <= max);
    }
}
