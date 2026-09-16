import { BlockOutput, UnitBlock } from "../../../ScriptManager.js";
import { finiteFloat } from "../../../types/PortTypes.js";

export class ScaleBlock extends UnitBlock {
    register() {
        this.registerOutput("result", "tex1d");
        this.registerInput("scalar", "float64");
        this.registerInput("tex1d", "tex1d");
    }
    
    valid() {
        return this.hasInput("tex1d") && this.hasInput("scalar");
    }

    execute() {
        const texture = this.getInput("tex1d");
        if (!Array.isArray(texture)) throw new Error("Scale texture input must be an array.");
        const scalar = finiteFloat(this.getInput("scalar"));
        return new BlockOutput().set("result", texture.map((value) => value * scalar));
    }
}

export class MultiplyTexBlock extends UnitBlock {
    register() {
        this.registerOutput("result", "tex1d");
        this.registerInput("tex1d_a", "tex1d");
        this.registerInput("tex1d_b", "tex1d");
    }

    valid() {
        return this.hasInput("tex1d_a") && this.hasInput("tex1d_b");
    }

    execute() {
        const inputA = this.getInput("tex1d_a");
        const inputB = this.getInput("tex1d_b");

        if (!Array.isArray(inputA) || !Array.isArray(inputB)) {
            throw new Error("Multiply texture inputs must be arrays.");
        }
        if (inputA.length !== inputB.length) {
            throw new Error("Multiply texture inputs must have equal lengths.");
        }

        return new BlockOutput().set("result", inputA.map((value, index) => value * inputB[index]));
    }
}
