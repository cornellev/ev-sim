import { useEffect, useRef, useState } from "react";
import * as NoiseJS from "noisejs";
import Unit from "../../Unit";
import { BlockOutput, storeData, UnitBlock } from "../../../ScriptManager";

export function Noise({ _uuid }) {
    const canvasRef = useRef(null);
    const [values, setValues] = useState([]);

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

            const noise = new NoiseJS.Noise(Math.random());
            const values = [];

            for (let y = 0; y < rows; y++) {
                for (let x = 0; x < cols; x++) {
                    const raw = noise.simplex2(x, y);
                    const value = raw * 128 + 128; // scale to [0, 255]
                    ctx.fillStyle = `rgb(${value}, ${value}, ${value})`;
                    ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
                    values.push(raw * 0.5 + 0.5);
                }
            }
            return values;
        }

        const noiseValues = generateNoise();
        setValues(noiseValues);
    }, [])

    useEffect(() => {
        storeData(_uuid, values);
    }, [values, _uuid]);

    return (
        <Unit title="Noise 2D" hasOptions={true} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "tex1d"}
                ]
            } >
                <div className="w-full h-full flex items-center justify-center">
                <canvas className="w-[192px] h-[192px]" ref={canvasRef} />
                </div>
        </Unit>
    );
}

export class NoiseBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "tex1d");
    }
    
    valid() {
        return this.hasOutput("out");
    }

    execute() {
        return new BlockOutput()
            .set("out", this.manager.getStoredData(this.uuid) || []);
    }
}