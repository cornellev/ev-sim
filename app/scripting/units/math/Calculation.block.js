import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

export class CalculationBlock extends UnitBlock {
    register() {
        this.registerInput("input A", "float64");
        this.registerInput("input B", "float64");
        this.registerOutput("result", "float64");
    }

    serializeState() {
        return {
            operation: this.getStateValue("operation", this.uuid + "-operation", "add")
        };
    }

    valid() {
        return this.hasInput("input A") && this.hasInput("input B");
    }

    execute() {
        const a = this.getInput("input A");
        const b = this.getInput("input B");
        const operation = this.getStateValue("operation", this.uuid + "-operation", "add");

        let result;
        switch (operation) {
            case "add":
                result = a + b;
                break;
            case "subtract":
                result = a - b;
                break;
            case "multiply":
                result = a * b;
                break;
            case "divide":
                result = b !== 0 ? a / b : 0; // handle division by zero
                break;
            case "power":
                result = Math.pow(a, b);
                break;
            case "modulus":
                result = a % b;
                break;
            default:
                result = 0;
        }

        return new BlockOutput().set("result", result);
    }
}
