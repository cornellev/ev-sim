import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

export class StringBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "string");
    }

    valid() {
        return this.hasOutput("out");
    }

    execute() {
        const value = this.getStoredData() || "";
        return new BlockOutput().set("out", value);
    }
}
