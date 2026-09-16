import Unit from "../Unit";
import {
    MakeActorCommandBlock,
    SplitActorCommandBlock,
} from "./ActorCommand.block.js";

export function MakeActorCommandUnit({ _uuid }) {
    return (
        <Unit
            title="Make Actor Command"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[
                { label: "speed", type: "float64" },
                { label: "steering", type: "float64" },
                { label: "actorId", type: "string" },
            ]}
            outputs={[{ label: "command", type: "actor_command" }]}
        />
    );
}

export function SplitActorCommandUnit({ _uuid }) {
    return (
        <Unit
            title="Split Actor Command"
            hasOptions={false}
            _uuid={_uuid}
            inputs={[{ label: "command", type: "actor_command" }]}
            outputs={[
                { label: "speed", type: "float64" },
                { label: "steering", type: "float64" },
                { label: "actorId", type: "string" },
            ]}
        />
    );
}

export {
    MakeActorCommandBlock,
    SplitActorCommandBlock,
} from "./ActorCommand.block.js";
