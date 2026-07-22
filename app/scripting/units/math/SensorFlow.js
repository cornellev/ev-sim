
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
export { SampleTextureBlock, LowPassFilterBlock, RateLimiterBlock, SensorFusionBlock, ThresholdGateBlock } from "./SensorFlow.block.js";
