import { BlockOutput, UnitBlock } from "../ScriptManager.js";

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
            .set("some float64", Math.random() * 100) // placeholder for actual ROS data
            .set("some int32", Math.floor(Math.random() * 100)); // placeholder for actual ROS data
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
