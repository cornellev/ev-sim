import { BlockOutput, UnitBlock } from "../../../ScriptManager.js";

export class NoiseBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "tex1d");
    }
    
    valid() {
        return this.hasOutput("out");
    }

    execute() {
        return new BlockOutput()
            .set("out", this.manager.getStoredData(this.uuid) || []);
    }
}
