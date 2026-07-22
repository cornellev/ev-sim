import { useEffect, useRef } from "react";
import Unit from "../../Unit";

export function Mask({ _uuid }) {
    const canvasRef = useRef();

    return (
        <Unit title="Mask" hasOptions={true} _uuid={_uuid}
            inputs={[
                { label: "tex1d", type: "tex1d" },
                { label: "mask", type: "float64" }
            ]}
            outputs={
                [
                    {label: "out", type: "tex1d"}
                ]
            } >
            <div className="w-full h-full flex items-center justify-center">
            <canvas id={`canvas-${_uuid}`} className="w-[192px] h-[192px]" ref={canvasRef} />
            </div>
        </Unit>
    );
}
export { MaskBlock } from "./Mask.block.js";
