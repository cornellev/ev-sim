import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { finiteFloat } from "../../types/PortTypes.js";
import { isPerfectSquare, requireFiniteSamples, requireTexture } from "./tex/textureMath.js";

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
        const tex = this.getInput("tex");
        requireTexture(tex, "SampleTextureBlock");
        if (!isPerfectSquare(tex.length)) {
            throw new Error("SampleTextureBlock texture length must be a perfect square.");
        }
        requireFiniteSamples(tex, "SampleTextureBlock");

        const size = Math.sqrt(tex.length);
        const x = Math.max(0, Math.min(1, finiteFloat(this.getInput("x"))));
        const y = Math.max(0, Math.min(1, finiteFloat(this.getInput("y"))));

        const ix = Math.min(size - 1, Math.floor(x * (size - 1)));
        const iy = Math.min(size - 1, Math.floor(y * (size - 1)));

        return new BlockOutput().set("out", finiteFloat(tex[iy * size + ix]));
    }
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

    serializeRuntimeState() {
        return {
            prev: this.prev,
            initialized: this.initialized
        };
    }

    hydrateRuntimeState(state = {}) {
        this.prev = Number.isFinite(state.prev) ? state.prev : 0;
        this.initialized = Boolean(state.initialized);
    }

    execute() {
        const signal = finiteFloat(this.getInput("signal"));
        const alpha = Math.max(0, Math.min(1, finiteFloat(this.getInput("alpha"), 0.5)));

        if (!this.initialized) {
            this.prev = signal;
            this.initialized = true;
        }

        this.prev = this.prev + alpha * (signal - this.prev);
        return new BlockOutput().set("filtered", this.prev);
    }
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

    serializeRuntimeState() {
        return {
            prev: this.prev,
            initialized: this.initialized
        };
    }

    hydrateRuntimeState(state = {}) {
        this.prev = Number.isFinite(state.prev) ? state.prev : 0;
        this.initialized = Boolean(state.initialized);
    }

    execute() {
        const signal = finiteFloat(this.getInput("signal"));
        const maxDelta = Math.max(0, finiteFloat(this.getInput("max delta")));

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
        const primary = finiteFloat(this.getInput("primary"));
        const secondary = finiteFloat(this.getInput("secondary"));
        const weight = Math.max(0, Math.min(1, finiteFloat(this.getInput("weight"), 0.5)));
        const bias = finiteFloat(this.getInput("bias"));

        const fused = primary * weight + secondary * (1 - weight) + bias;
        return new BlockOutput().set("fused", fused);
    }
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
        const signal = finiteFloat(this.getInput("signal"));
        let min = finiteFloat(this.getInput("min"));
        let max = finiteFloat(this.getInput("max"));

        if (min > max) {
            const tmp = min;
            min = max;
            max = tmp;
        }

        return new BlockOutput().set("in range", signal >= min && signal <= max);
    }
}
