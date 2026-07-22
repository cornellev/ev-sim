
import Unit from "../Unit";

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
export { RandomRangeBlock, SeededRandomBlock, GaussianNoiseBlock, JitterBlock, WeightedSelectBlock, RemapRangeBlock } from "./Randomization.block.js";
