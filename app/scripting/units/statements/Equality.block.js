import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

export class EqualityBlock extends UnitBlock {
    register() {
        this.registerInput("input a", "float64");
        this.registerInput("input b", "float64");
        this.registerOutput("out", "boolean");
    }

    valid() {
        return this.hasInput("input a") && this.hasInput("input b") && this.hasOutput("out");
    }

    execute() {
        const a = this.getInput("input a");
        const b = this.getInput("input b");

        let result;
        const typ = this.getStoredData();
        switch (typ) {
            case "eq":
                result = a === b;
                break;
            case "neq":
                result = a !== b;
                break;
            case "gt":
                result = a > b;
                break;
            case "lt":
                result = a < b;
                break;
            case "gte":
                result = a >= b;
                break;
            case "lte":
                result = a <= b;
                break;
            default:
                throw new Error("Invalid equality type");
        }

        return new BlockOutput()
            .set("out", result);
    }
}

export class ConjugationBlock extends UnitBlock {
    register() {
        this.registerInput("bool a", "boolean");
        this.registerInput("bool b", "boolean");
        this.registerOutput("out", "boolean");
    }

    valid() {
        return this.hasInput("bool a") && this.hasInput("bool b") && this.hasOutput("out");
    }

    execute() {
        const a = this.getInput("bool a");
        const b = this.getInput("bool b");
        
        let result;
        const typ = this.getStoredData();
        switch (typ) {
            case "and":
                result = a && b;
                break;
            case "or":
                result = a || b;
                break;
            case "xor":
                result = (a || b) && !(a && b);
                break;
            default:
                throw new Error("Invalid conjugation type");
        }

        return new BlockOutput()
            .set("out", result);
    }
}
