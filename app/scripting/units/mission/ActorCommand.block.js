import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { ACTOR_COMMAND_TYPE, normalizeActorCommand } from "../../types/PortTypes.js";

export class MakeActorCommandBlock extends UnitBlock {
    register() {
        this.registerInput("speed", "float64");
        this.registerInput("steering", "float64");
        this.registerInput("actorId", "string");
        this.registerOutput("command", ACTOR_COMMAND_TYPE);
    }

    valid() {
        return this.hasInput("speed") && this.hasInput("steering");
    }

    execute() {
        const speed = this.getInput("speed");
        const steering = this.getInput("steering");
        const actorId = this.hasInput("actorId") ? this.getInput("actorId") : "";
        return new BlockOutput().set("command", normalizeActorCommand({
            actorId,
            speedMps: speed,
            steeringRad: steering,
        }));
    }
}

export class SplitActorCommandBlock extends UnitBlock {
    register() {
        this.registerInput("command", ACTOR_COMMAND_TYPE);
        this.registerOutput("speed", "float64");
        this.registerOutput("steering", "float64");
        this.registerOutput("actorId", "string");
    }

    valid() {
        return this.hasInput("command");
    }

    execute() {
        const command = normalizeActorCommand(this.getInput("command"));
        return new BlockOutput()
            .set("speed", command.speedMps)
            .set("steering", command.steeringRad)
            .set("actorId", command.actorId);
    }
}
