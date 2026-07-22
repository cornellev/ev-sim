import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

export class RandomNumberBlock extends UnitBlock {
    constructor(uuid) {
        super(uuid);

        this.cachedValue = Math.random(); // cache the random value to maintain consistency during execution
    }

    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true; // no inputs, so always valid
    }
    
    execute() {
        return new BlockOutput()
            .set("out", this.cachedValue);
    }
}
