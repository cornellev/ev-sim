import { BlockOutput, UnitBlock } from "../../ScriptManager.js";

export class PIBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }
    
    execute() {
        return new BlockOutput().set("out", Math.PI);
    }
}

export class EBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }
    
    execute() {
        return new BlockOutput().set("out", Math.E);
    }
}

export class TauBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }
    
    execute() {
        return new BlockOutput().set("out", 2 * Math.PI);
    }
}

export class GoldenRatioBlock extends UnitBlock {
    register() {
        this.registerOutput("out", "float64");
    }

    valid() {
        return true;
    }
    
    execute() {
        return new BlockOutput().set("out", (1 + Math.sqrt(5)) / 2);
    }
}
