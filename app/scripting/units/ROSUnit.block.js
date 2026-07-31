import { BlockOutput, UnitBlock } from "../ScriptManager.js";
import { runtimeRandom } from "../runtime/RuntimeRandom.js";

export class ROSInputBlock extends UnitBlock {
    register() {
        this.registerOutput("some float64", "float64");
        this.registerOutput("some int32", "int32");
    }

    valid() {
        return this.hasOutput("some float64") && this.hasOutput("some int32");
    }

    execute() {
        return new BlockOutput()
            .set("some float64", runtimeRandom(this) * 100)
            .set("some int32", Math.floor(runtimeRandom(this) * 100));
    }
}

export class ROSOutputBlock extends UnitBlock {
    register() {
        this.registerInput("some float", "float64");
    }

    valid() {
        return this.hasInput("some float");
    }

    execute() {
        const floatData = this.getInput("some float");

        // Placeholder: In a real implementation, this would publish to a ROS topic
        console.log("Publishing to ROS topic:", floatData);
    }
}
