import { useEffect, useRef } from "react";
import Unit from "../Unit";

export function Noise({ _uuid }) {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;

        function generateNoise() {
            const imageData = ctx.createImageData(32, 32);
            const data = imageData.data;
            
            for (let i = 0; i < data.length; i += 4) {
                const value = Math.random() * 255;
                ctx.fillStyle = `rgb(${value}, ${value}, ${value})`;
                // fill rect, 3x3 pixels for better visibility
                const x = ((i / 4) % 64) * 3;
                const y = Math.floor((i / 4) / 64) * 3;
                ctx.fillRect(x, y, 3, 3);
            }
        }

        generateNoise();
    }, [canvasRef])

    return (
        <Unit title="Random Number" hasOptions={true} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "vec2"}
                ]
            } >
                <div className="w-full h-full flex items-center justify-center">
                <canvas className="w-[192px] h-[192px]" ref={canvasRef} />
                </div>
        </Unit>
    );
}