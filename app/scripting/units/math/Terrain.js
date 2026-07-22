
import Unit from "../Unit";

export function TerrainNoiseUnit({ _uuid }) {
    return (
        <Unit
            title="Terrain Noise"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "seed", type: "float64" },
                { label: "frequency", type: "float64" },
                { label: "amplitude", type: "float64" },
                { label: "octaves", type: "float64" }
            ]}
            outputs={[
                { label: "tex", type: "tex1d" }
            ]}
        />
    );
}

export function NormalizeTextureUnit({ _uuid }) {
    return (
        <Unit
            title="Normalize Texture"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex", type: "tex1d" }
            ]}
            outputs={[
                { label: "out", type: "tex1d" }
            ]}
        />
    );
}

export function BlendTextureUnit({ _uuid }) {
    return (
        <Unit
            title="Blend Texture"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex a", type: "tex1d" },
                { label: "tex b", type: "tex1d" },
                { label: "blend", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "tex1d" }
            ]}
        />
    );
}

export function TerraceTextureUnit({ _uuid }) {
    return (
        <Unit
            title="Terrace Texture"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex", type: "tex1d" },
                { label: "steps", type: "float64" }
            ]}
            outputs={[
                { label: "out", type: "tex1d" }
            ]}
        />
    );
}

export function HeightToSlopeUnit({ _uuid }) {
    return (
        <Unit
            title="Height To Slope"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex", type: "tex1d" }
            ]}
            outputs={[
                { label: "slope", type: "tex1d" }
            ]}
        />
    );
}
export { TerrainNoiseBlock, NormalizeTextureBlock, BlendTextureBlock, TerraceTextureBlock, HeightToSlopeBlock } from "./Terrain.block.js";
