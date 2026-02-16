
import { UnitBlock } from "@/app/scripting/ScriptManager";
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

export class ScaleBlock extends UnitBlock {
    register() {
        this.registerOutput("result", "tex1d");
        this.registerInput("scalar", "float64");
        this.registerInput("tex1d", "tex1d");
    }
    
    valid() {
        return false; //todo
    }
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

export class MultiplyTexBlock extends UnitBlock {
    register() {
        this.registerOutput("result", "tex1d");
        this.registerInput("tex1d_a", "tex1d");
        this.registerInput("tex1d_b", "tex1d");
    }

    onConnectionsUpdate() {
        const canvas = document.getElementById(`canvas-${this.uuid}`);
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        if (this.hasInput("tex1d_a") && this.hasInput("tex1d_b")) {
            const inputA = this.getInput("tex1d_a");
            const inputB = this.getInput("tex1d_b");

            console.log(inputA, inputB);

            const wsize = Math.sqrt(inputA.length);
            const pixelSize = canvas.width / wsize;

            let index = 0;
            for (let y = 0; y < canvas.height; y += pixelSize) {
                for (let x = 0; x < canvas.width; x += pixelSize) {
                    const value = (inputA[index] || 0) * (inputB[index] || 0) * 255;
                    ctx.fillStyle = `rgb(${value}, ${value}, ${value})`;
                    ctx.fillRect(x, y, pixelSize, pixelSize);
                    index++;
                }
            }
        }
    }

    valid() {
        if (!(this.hasInput("tex1d_a") && this.hasInput("tex1d_b"))) return false;

        const inputA = this.getInput("tex1d_a");
        const inputB = this.getInput("tex1d_b");

        if (inputA == null || inputB == null) return false;

        return inputA.length === inputB.length;
    }

    execute() {
        const input = this.getInput("tex1d_a");
        const input2 = this.getInput("tex1d_b");

        if (input.length !== input2.length) {
            console.error("Input textures must be the same size");
            return;
        }
    }
}