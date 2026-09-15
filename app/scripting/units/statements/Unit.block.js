import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { GENERIC_TYPE, UNIT, UNIT_TYPE } from "../../types/PortTypes.js";

export class NopBlock extends UnitBlock {
    register() {
        this.registerOutput("then", UNIT_TYPE);
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("then", UNIT);
    }
}

export class IgnoreBlock extends UnitBlock {
    static typeScheme = {
        variables: {
            T: {
                inputs: ["value"],
                outputs: []
            }
        }
    };

    register() {
        this.registerInput("value", GENERIC_TYPE);
        this.registerOutput("then", UNIT_TYPE);
    }

    valid() {
        return this.hasInput("value");
    }

    execute() {
        this.getInput("value");
        return new BlockOutput().set("then", UNIT);
    }
}

export class SequenceBlock extends UnitBlock {
    register() {
        this.registerInput("first", UNIT_TYPE);
        this.registerInput("second", UNIT_TYPE);
        this.registerOutput("then", UNIT_TYPE);
    }

    valid() {
        return this.hasInput("first") && this.hasInput("second");
    }

    execute() {
        this.getInput("first");
        this.getInput("second");
        return new BlockOutput().set("then", UNIT);
    }
}

export class PassthroughBlock extends UnitBlock {
    static typeScheme = {
        variables: {
            T: {
                inputs: ["value"],
                outputs: ["value"]
            }
        }
    };

    register() {
        this.registerInput("then", UNIT_TYPE);
        this.registerInput("value", GENERIC_TYPE);
        this.registerOutput("value", GENERIC_TYPE);
    }

    valid() {
        return this.hasInput("then") && this.hasInput("value");
    }

    execute() {
        this.getInput("then");
        const value = this.getInput("value");
        return new BlockOutput().set("value", value);
    }
}
