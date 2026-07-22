

import Unit from "../../Unit";
import { useRef } from "react";

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
    const canvasRef = useRef();

    return (
        <Unit title="Multiply Textures" hasOptions={true} _uuid={_uuid}
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
        }>
            <div className="w-full h-full flex items-center justify-center">
            <canvas id={`canvas-${_uuid}`} className="w-[192px] h-[192px]" ref={canvasRef} />
            </div>
        </Unit>
    );
}
export { ScaleBlock, MultiplyTexBlock } from "./Scale.block.js";
