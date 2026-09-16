

import Unit from "../../Unit";

export function Scale({ _uuid }) {
    return (
        <Unit title="Scale Matrix" hasOptions={false} _uuid={_uuid}
        inputs={
            [
                {label: "tex1d", type: "tex1d"},
                {label: "scalar", type: "float64"}
            ]
        }
        outputs={
            [
                {label: "result", type: "tex1d"}
            ]
        }>
        </Unit>
    )
}

export function MultiplyTex({ _uuid }) {
    return (
        <Unit title="Multiply Textures" hasOptions={false} _uuid={_uuid}
        inputs={
            [
                {label: "tex1d_a", type: "tex1d"},
                {label: "tex1d_b", type: "tex1d"}
            ]
        }
        outputs={
            [
                {label: "result", type: "tex1d"}
            ]
        } />
    );
}
export { ScaleBlock, MultiplyTexBlock } from "./Scale.block.js";
