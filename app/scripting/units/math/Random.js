import { BlockOutput, UnitBlock } from "../../ScriptManager";
import Unit from "../Unit";

export function RandomNumber({ _uuid }) {
    return (
        <Unit title="Random Number" hasOptions={false} _uuid={_uuid}
            inputs={[]}
            outputs={
                [
                    {label: "out", type: "float64"}
                ]
            }>
        </Unit>
    );
}

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