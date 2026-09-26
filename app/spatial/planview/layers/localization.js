import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "localization",
    label: "Localization",
    group: "autonomy",
    defaultVisible: true,
    project(frame) {
        const estimate = frame?.localization?.estimate;
        if (!estimate) return [];
        const ego = (frame.vehicles ?? []).find((actor) => actor.role === "ego") ?? frame.vehicles?.[0];
        const primitives = [{
            kind: "circle",
            center: { x: estimate.x, z: estimate.z },
            radiusPx: 5,
            fill: "none",
            stroke: PLAN_COLORS.estimate,
            strokeWidth: 2,
        }];
        if (ego) {
            primitives.unshift({
                kind: "polyline",
                points: [
                    { x: ego.position.x, z: ego.position.z },
                    { x: estimate.x, z: estimate.z },
                ],
                stroke: PLAN_COLORS.error,
                strokeWidth: 1.5,
                dash: "4 3",
            });
        }
        return primitives;
    },
});
