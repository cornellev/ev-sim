import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

function splitAtDistance(points, distance) {
    if (!points.length) return { driven: [], remaining: [] };
    if (!Number.isFinite(distance) || distance <= 0) return { driven: [], remaining: points };
    let walked = 0;
    const driven = [points[0]];
    for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const next = points[index];
        const segment = Math.hypot(next.x - previous.x, next.z - previous.z);
        if (walked + segment >= distance) {
            const t = segment <= 1e-9 ? 0 : (distance - walked) / segment;
            const mid = {
                x: previous.x + (next.x - previous.x) * t,
                z: previous.z + (next.z - previous.z) * t,
            };
            driven.push(mid);
            return { driven, remaining: [mid, ...points.slice(index)] };
        }
        walked += segment;
        driven.push(next);
    }
    return { driven: points, remaining: [] };
}

registerPlanLayer({
    id: "route",
    label: "Route",
    group: "task",
    defaultVisible: true,
    project(frame) {
        return (frame?.vehicles ?? []).flatMap((actor) => {
            const points = actor.route ?? [];
            if (points.length < 2) return [];
            if (!Number.isFinite(actor.routeProgress)) {
                return [{
                    kind: "polyline",
                    points,
                    stroke: PLAN_COLORS.routeRemaining,
                    strokeWidth: 2,
                    dash: "6 5",
                }];
            }
            const { driven, remaining } = splitAtDistance(points, actor.routeProgress);
            const lines = [];
            if (driven.length >= 2) {
                lines.push({
                    kind: "polyline",
                    points: driven,
                    stroke: PLAN_COLORS.routeDriven,
                    strokeWidth: 2.5,
                });
            }
            if (remaining.length >= 2) {
                lines.push({
                    kind: "polyline",
                    points: remaining,
                    stroke: PLAN_COLORS.routeRemaining,
                    strokeWidth: 2,
                    dash: "6 5",
                });
            }
            return lines;
        });
    },
});
