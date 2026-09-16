import Unit from "../../Unit";
import { TEXTURE_BLOCK_PORTS } from "./Scale.block.js";

function staticPortsUnit(title, ports) {
    function StaticUnit({ _uuid }) {
        return (
            <Unit
                title={title}
                hasOptions={false}
                _uuid={_uuid}
                inputs={[...ports.inputs]}
                outputs={[...ports.outputs]}
            />
        );
    }
    StaticUnit.displayName = `${title.replace(/\s+/g, "")}Unit`;
    return StaticUnit;
}

export function Scale({ _uuid }) {
    return (
        <Unit
            title="Scale Matrix"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "tex1d", type: "tex1d" },
                { label: "scalar", type: "float64" },
            ]}
            outputs={[
                { label: "result", type: "tex1d" },
            ]}
        />
    );
}

export const ScaleTextureUnit = staticPortsUnit("Scale Texture", TEXTURE_BLOCK_PORTS.ScaleTextureBlock);
export const MultiplyTex = staticPortsUnit("Multiply Textures", TEXTURE_BLOCK_PORTS.MultiplyTexBlock);
export const AddTextureUnit = staticPortsUnit("Add Textures", TEXTURE_BLOCK_PORTS.AddTextureBlock);
export const SubtractTextureUnit = staticPortsUnit("Subtract Textures", TEXTURE_BLOCK_PORTS.SubtractTextureBlock);
export const ClampTextureUnit = staticPortsUnit("Clamp Texture", TEXTURE_BLOCK_PORTS.ClampTextureBlock);
export const InvertTextureUnit = staticPortsUnit("Invert Texture", TEXTURE_BLOCK_PORTS.InvertTextureBlock);

export {
    AddTextureBlock,
    ClampTextureBlock,
    InvertTextureBlock,
    MultiplyTexBlock,
    ScaleBlock,
    ScaleTextureBlock,
    SubtractTextureBlock,
} from "./Scale.block.js";
