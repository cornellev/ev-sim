import { BlockOutput, UnitBlock, usesLazySelectors } from "../../ScriptManager.js";
import { runtimeRandom } from "../../runtime/RuntimeRandom.js";
import { finiteFloat, GENERIC_TYPE } from "../../types/PortTypes.js";

function seededRandom(seed) {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
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
        let min = finiteFloat(this.getInput("min"));
        let max = finiteFloat(this.getInput("max"));
        if (min > max) {
            const tmp = min;
            min = max;
            max = tmp;
        }

        const out = min + runtimeRandom(this) * (max - min);
        return new BlockOutput().set("out", out);
    }
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
        const seed = finiteFloat(this.getInput("seed"));
        return new BlockOutput().set("out", seededRandom(seed));
    }
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
        const mean = finiteFloat(this.getInput("mean"));
        const stddev = Math.max(0, finiteFloat(this.getInput("stddev")));

        const u1 = Math.max(Number.EPSILON, runtimeRandom(this));
        const u2 = runtimeRandom(this);
        const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
        return new BlockOutput().set("out", mean + z0 * stddev);
    }
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
        const value = finiteFloat(this.getInput("value"));
        const amount = Math.max(0, finiteFloat(this.getInput("amount")));
        const out = value + (runtimeRandom(this) * 2 - 1) * amount;
        return new BlockOutput().set("out", out);
    }
}

export class WeightedSelectBlock extends UnitBlock {
    static typeScheme = {
        variables: {
            T: {
                inputs: ["a", "b"],
                outputs: ["out"]
            }
        }
    };

    register() {
        this.registerInput("a", GENERIC_TYPE);
        this.registerInput("b", GENERIC_TYPE);
        this.registerInput("prob b", "float64");
        this.registerOutput("out", GENERIC_TYPE);
    }

    valid() {
        return this.hasInput("a") && this.hasInput("b") && this.hasInput("prob b");
    }

    execute() {
        if (usesLazySelectors(this.manager)) {
            const probB = Math.max(0, Math.min(1, finiteFloat(this.getInput("prob b"), 0.5)));
            const selected = runtimeRandom(this) < probB ? "b" : "a";
            return new BlockOutput().set("out", this.getInput(selected));
        }

        const a = this.getInput("a");
        const b = this.getInput("b");
        const probB = Math.max(0, Math.min(1, finiteFloat(this.getInput("prob b"), 0.5)));
        return new BlockOutput().set("out", runtimeRandom(this) < probB ? b : a);
    }
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
        const value = finiteFloat(this.getInput("value"));
        const inMin = finiteFloat(this.getInput("in min"));
        const inMax = finiteFloat(this.getInput("in max"), 1);
        const outMin = finiteFloat(this.getInput("out min"));
        const outMax = finiteFloat(this.getInput("out max"), 1);

        const denom = inMax - inMin;
        if (Math.abs(denom) < Number.EPSILON) {
            return new BlockOutput().set("out", outMin);
        }

        const t = (value - inMin) / denom;
        return new BlockOutput().set("out", outMin + t * (outMax - outMin));
    }
}
