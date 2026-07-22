import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

export class Float64ToInt32Block extends UnitBlock {
    register() {
        this.registerInput("in", "float64");
        this.registerOutput("out", "int32");
    }

    valid() {
        return this.hasInput("in") && this.hasOutput("out");
    }

    execute() {
        const inputValue = this.getInput("in");
        const outputValue = Math.floor(inputValue); // simple conversion, can be improved with error handling
        return new BlockOutput().set("out", outputValue);
    }
}

export class Int32ToFloat64Block extends UnitBlock {
    register() {
        this.registerInput("in", "int32");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("in") && this.hasOutput("out");
    }

    execute() {
        const inputValue = this.getInput("in");
        const outputValue = Number(inputValue); // simple conversion, can be improved with error handling
        return new BlockOutput().set("out", outputValue);
    }
}
