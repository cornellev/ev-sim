import { BlockOutput, UnitBlock } from "../../../ScriptManager.js";

export class MaskBlock extends UnitBlock {
    register() {
        this.registerInput("tex1d", "tex1d");
        this.registerInput("mask", "float64");
        this.registerOutput("out", "tex1d");
    } 

    onConnectionsUpdate() {
        if (typeof document === "undefined") return;
        const canvas = document.getElementById(`canvas-${this.uuid}`);
        if (!canvas) return;

        const ctx = canvas.getContext("2d");
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = rect.height;

        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        if (this.hasInput("tex1d") && this.hasInput("mask")) {
            const mask = this.getInput("mask");
            const input = this.getInput("tex1d");

            const wsize = Math.sqrt(input.length);
            const pixelSize = canvas.width / wsize;

            console.log(input)
            
            // Simple visualization: draw white pixels where input >= mask
            let index = 0;
            for (let y = 0; y < canvas.height; y += pixelSize) {
                for (let x = 0; x < canvas.width; x += pixelSize) {
                    if (input[index++] >= mask) {
                        ctx.fillStyle = "white";
                        ctx.fillRect(x, y, pixelSize, pixelSize);
                    }
                }
            }
            
        }
    }

    valid() {
        return this.hasInput("tex1d") && this.hasInput("mask") && this.hasOutput("out");
    }

    execute() {
        const input = this.getInput("tex1d");
        const mask = this.getInput("mask");

        return new BlockOutput()
            .set("out", input.map(e => e >= mask ? 1 : 0)); // Placeholder for actual masked texture data
    }
}
