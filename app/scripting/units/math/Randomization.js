import { BlockOutput, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

function seededRandom(seed) {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
}

export function RandomRangeUnit({ _uuid }) {
    return (
        <Unit
            title="Random Range"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "min", type: "float64" },
                { label: "max", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "float64" }
            ]}
        />
    );
}

export class RandomRangeBlock extends UnitBlock {
    register() {
        this.registerInput("min", "float64");
        this.registerInput("max", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("min") && this.hasInput("max");
    }

    execute() {
        let min = this.getInput("min") || 0;
        let max = this.getInput("max") || 0;
        if (min > max) {
            const tmp = min;
            min = max;
            max = tmp;
        }

        const out = min + Math.random() * (max - min);
        return new BlockOutput().set("out", out);
    }
}

export function SeededRandomUnit({ _uuid }) {
    return (
        <Unit
            title="Seeded Random"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "seed", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "float64" }
            ]}
        />
    );
}

export class SeededRandomBlock extends UnitBlock {
    register() {
        this.registerInput("seed", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("seed");
    }

    execute() {
        const seed = this.getInput("seed") || 0;
        return new BlockOutput().set("out", seededRandom(seed));
    }
}

export function GaussianNoiseUnit({ _uuid }) {
    return (
        <Unit
            title="Gaussian Noise"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "mean", type: "float64" },
                { label: "stddev", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "float64" }
            ]}
        />
    );
}

export class GaussianNoiseBlock extends UnitBlock {
    register() {
        this.registerInput("mean", "float64");
        this.registerInput("stddev", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("mean") && this.hasInput("stddev");
    }

    execute() {
        const mean = this.getInput("mean") || 0;
        const stddev = Math.max(0, this.getInput("stddev") || 0);

        const u1 = Math.max(Number.EPSILON, Math.random());
        const u2 = Math.random();
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return new BlockOutput().set("out", mean + z0 * stddev);
    }
}

export function JitterUnit({ _uuid }) {
    return (
        <Unit
            title="Jitter"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "value", type: "float64" },
                { label: "amount", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "float64" }
            ]}
        />
    );
}

export class JitterBlock extends UnitBlock {
    register() {
        this.registerInput("value", "float64");
        this.registerInput("amount", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("value") && this.hasInput("amount");
    }

    execute() {
        const value = this.getInput("value") || 0;
        const amount = Math.max(0, this.getInput("amount") || 0);
        const out = value + (Math.random() * 2 - 1) * amount;
        return new BlockOutput().set("out", out);
    }
}

export function WeightedSelectUnit({ _uuid }) {
    return (
        <Unit
            title="Weighted Select"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "a", type: "float64" },
                { label: "b", type: "float64" },
                { label: "prob b", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "float64" }
            ]}
        />
    );
}

export class WeightedSelectBlock extends UnitBlock {
    register() {
        this.registerInput("a", "float64");
        this.registerInput("b", "float64");
        this.registerInput("prob b", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("a") && this.hasInput("b") && this.hasInput("prob b");
    }

    execute() {
        const a = this.getInput("a") || 0;
        const b = this.getInput("b") || 0;
        const probB = Math.max(0, Math.min(1, this.getInput("prob b") || 0.5));
        return new BlockOutput().set("out", Math.random() < probB ? b : a);
    }
}

export function RemapRangeUnit({ _uuid }) {
    return (
        <Unit
            title="Remap Range"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "value", type: "float64" },
                { label: "in min", type: "float64" },
                { label: "in max", type: "float64" },
                { label: "out min", type: "float64" },
                { label: "out max", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "float64" }
            ]}
        />
    );
}

export class RemapRangeBlock extends UnitBlock {
    register() {
        this.registerInput("value", "float64");
        this.registerInput("in min", "float64");
        this.registerInput("in max", "float64");
        this.registerInput("out min", "float64");
        this.registerInput("out max", "float64");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("value")
            && this.hasInput("in min")
            && this.hasInput("in max")
            && this.hasInput("out min")
            && this.hasInput("out max");
    }

    execute() {
        const value = this.getInput("value") || 0;
        const inMin = this.getInput("in min") || 0;
        const inMax = this.getInput("in max") || 1;
        const outMin = this.getInput("out min") || 0;
        const outMax = this.getInput("out max") || 1;

        const denom = inMax - inMin;
        if (Math.abs(denom) < Number.EPSILON) {
            return new BlockOutput().set("out", outMin);
        }

        const t = (value - inMin) / denom;
        return new BlockOutput().set("out", outMin + t * (outMax - outMin));
    }
}
