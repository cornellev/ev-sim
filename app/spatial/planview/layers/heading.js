import { offsetByVehicleYaw } from "../../trajectorySimplify.js";
import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

registerPlanLayer({
    id: "heading",
    label: "Heading",
    group: "actors",
    defaultVisible: true,
    project(frame) {
        return (frame?.vehicles ?? []).flatMap((actor) => {
            if (actor.class === "pedestrian") return [];
            const length = Math.max(1.2, (actor.box?.size?.x ?? 2) * 0.65);
            const origin = { x: actor.position.x, z: actor.position.z };
            const tip = offsetByVehicleYaw(origin, actor.yaw, length);
            return [{
                kind: "polyline",
                points: [origin, { x: tip.x, z: tip.z }],
                stroke: actor.role === "ego" ? PLAN_COLORS.ego : PLAN_COLORS.vehicle,
                strokeWidth: 2,
            }];
        });
    },
});
