import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { finiteFloat } from "../../types/PortTypes.js";

export class NumberUnitClass extends UnitBlock {
    register() {
        this.registerOutput("number", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        const value = finiteFloat(this.getStoredData());
        return new BlockOutput().set("number", value);
    }
}
