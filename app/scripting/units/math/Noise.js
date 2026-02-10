import { useEffect, useRef } from "react";
import Unit from "../Unit";

export function Noise({ _uuid }) {
    const canvasRef = useRef(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        // Match canvas internal size to its displayed size to avoid squashing
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        function generateNoise() {
            const width = canvas.width;
            const height = canvas.height;
            const tileSize = 4; // size of each noise block in pixels

            const cols = Math.ceil(width / tileSize);
            const rows = Math.ceil(height / tileSize);

            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const value = Math.random() * 255;
                    ctx.fillStyle = `rgb(${value}, ${value}, ${value})`;
                    ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
                }
            }
        }

        generateNoise();
    }, [])

    return (
        <Unit title="Random Number" hasOptions={true} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "tex2"}
                ]
            } >
                <div className="w-full h-full flex items-center justify-center">
                <canvas className="w-[192px] h-[192px]" ref={canvasRef} />
                </div>
        </Unit>
    );
}