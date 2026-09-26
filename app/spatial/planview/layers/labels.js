import { registerPlanLayer } from "../registry.js";

function labelFor(actor) {
    const speed = Number.isFinite(actor.speed) ? `${actor.speed.toFixed(1)} m/s` : "";
    return speed ? `${actor.id}  ${speed}` : actor.id;
}

registerPlanLayer({
    id: "labels",
    label: "Labels",
    group: "actors",
    defaultVisible: true,
    project(frame) {
        return (frame?.vehicles ?? []).flatMap((actor) => {
            const selected = actor.id === frame.selectedActorId;
            if (actor.role !== "ego" && !selected) return [];
            return [{
                kind: "label",
                anchor: { x: actor.position.x, z: actor.position.z },
                text: labelFor(actor),
                actorId: actor.id,
            }];
        });
    },
});
