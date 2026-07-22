import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

export class NumberUnitClass extends UnitBlock {
    register() {
        this.registerOutput("number", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        const value = this.getStoredData();
        return new BlockOutput().set("number", value);
    }
}
