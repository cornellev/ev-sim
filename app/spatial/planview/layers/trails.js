import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

const TRAIL_COLORS = Object.freeze([
    PLAN_COLORS.trail,
    PLAN_COLORS.cyclist,
    PLAN_COLORS.goal,
    PLAN_COLORS.collision,
    PLAN_COLORS.commanded,
    PLAN_COLORS.achieved,
]);

registerPlanLayer({
    id: "trails",
    label: "Trails",
    group: "actors",
    defaultVisible: true,
    project(frame) {
        return (frame?.vehicles ?? []).flatMap((actor, index) => {
            const points = actor.trail ?? [];
            if (points.length < 2) return [];
            return [{
                kind: "polyline",
                points,
                stroke: actor.role === "ego" ? PLAN_COLORS.ego : TRAIL_COLORS[index % TRAIL_COLORS.length],
                strokeWidth: actor.role === "ego" ? 2.5 : 2,
                opacity: 0.9,
            }];
        });
    },
});
