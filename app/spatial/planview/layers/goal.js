import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "goal",
    label: "Goal",
    group: "task",
    defaultVisible: true,
    project(frame) {
        return (frame?.vehicles ?? []).flatMap((actor) => {
            const goal = actor.route?.at?.(-1);
            if (!goal) return [];
            return [{
                kind: "circle",
                center: { x: goal.x, z: goal.z },
                radiusPx: 5,
                fill: "none",
                stroke: PLAN_COLORS.goal,
                strokeWidth: 2,
            }];
        });
    },
});
