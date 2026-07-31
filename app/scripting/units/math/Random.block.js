import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { runtimeRandom } from "../../runtime/RuntimeRandom.js";

export class RandomNumberBlock extends UnitBlock {
    constructor(uuid) {
        super(uuid);

        this.cachedValue = null;
    }

    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true; // no inputs, so always valid
    }
    
    execute() {
        this.cachedValue ??= runtimeRandom(this);
        return new BlockOutput()
            .set("out", this.cachedValue);
    }
}
