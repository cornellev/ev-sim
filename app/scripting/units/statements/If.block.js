import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

export class IfBlock extends UnitBlock {
    register() {
        const outputType = this.getStateValue("type", this.uuid + "-type", "float64");

        this.registerInput("condition", "boolean");
        this.registerInput("true value", outputType);
        this.registerInput("false value", outputType);
        this.registerOutput("out", outputType);
    }

    serializeState() {
        return {
            type: this.getStateValue("type", this.uuid + "-type", "float64")
        };
    }
    
    valid() {
        return this.hasInput("condition") && this.hasInput("true value") && this.hasInput("false value") && this.hasOutput("out");
    }

    execute() {
        const condition = this.getInput("condition");
        const trueValue = this.getInput("true value");
        const falseValue = this.getInput("false value");

        const outputValue = condition ? trueValue : falseValue;
        return new BlockOutput().set("out", outputValue);
    }
}
