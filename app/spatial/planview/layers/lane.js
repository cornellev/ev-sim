import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "lane",
    label: "Lane",
    group: "task",
    defaultVisible: true,
    project(frame) {
        const points = frame?.lane?.points ?? [];
        if (points.length < 2) return [];
        return [{
            kind: "polyline",
            points,
            stroke: PLAN_COLORS.lane,
            strokeWidth: 3,
            opacity: 0.85,
        }];
    },
});
