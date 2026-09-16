import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { finiteFloat, finiteInt32 } from "../../types/PortTypes.js";

export class Float64ToInt32Block extends UnitBlock {
    static blockType = "Float64ToInt32Block";

    register() {
        this.registerInput("in", "float64");
        this.registerOutput("out", "int32");
    }

    valid() {
        return this.hasInput("in");
    }

    execute() {
        return new BlockOutput().set("out", finiteInt32(Math.floor(finiteFloat(this.getInput("in")))));
    }
}

export class Int32ToFloat64Block extends UnitBlock {
    static blockType = "Int32ToFloat64Block";

    register() {
        this.registerInput("in", "int32");
        this.registerOutput("out", "float64");
    }

    valid() {
        return this.hasInput("in");
    }

    execute() {
        return new BlockOutput().set("out", finiteFloat(finiteInt32(this.getInput("in"))));
    }
}
