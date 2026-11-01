import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";
import { waypointWorldPoint } from "../waypoints.js";

registerPlanLayer({
    id: "waypoints",
    label: "Waypoints",
    group: "task",
    defaultVisible: true,
    project(frame) {
        const mode = frame?.waypointFrame === "body" ? "body" : "global";
        const ego = (frame?.vehicles ?? []).find((actor) => actor.role === "ego") ?? frame?.vehicles?.[0] ?? null;
        const points = [];
        for (const point of frame?.waypoints ?? []) {
            const world = waypointWorldPoint(point, ego, mode);
            if (world) points.push(world);
        }
        if (!points.length) return [];
        const markers = points.map((center) => ({
            kind: "circle",
            center,
            radiusPx: 4,
            fill: PLAN_COLORS.waypoints,
            stroke: "none",
        }));
        if (points.length < 2) return markers;
        return [{
            kind: "polyline",
            points,
            stroke: PLAN_COLORS.waypoints,
            strokeWidth: 2.5,
        }, ...markers];
    },
});
