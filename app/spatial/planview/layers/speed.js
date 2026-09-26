import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "speed",
    label: "Speed",
    group: "actors",
    defaultVisible: true,
    project(frame) {
        return (frame?.vehicles ?? []).flatMap((actor) => {
            const vx = Number(actor.velocity?.x) || 0;
            const vz = Number(actor.velocity?.z) || 0;
            if (Math.hypot(vx, vz) < 0.05) return [];
            return [{
                kind: "polyline",
                points: [
                    { x: actor.position.x, z: actor.position.z },
                    { x: actor.position.x + vx, z: actor.position.z + vz },
                ],
                stroke: PLAN_COLORS.speed,
                strokeWidth: 1.5,
                opacity: 0.85,
            }];
        });
    },
});
