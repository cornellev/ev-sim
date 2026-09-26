import { vehicleGroundFootprint } from "../../../scenarios/route/geometry.js";
import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

function detectionFootprint(detection) {
    const center = detection?.box3d?.threeCenter || detection?.center || detection?.position || {};
    const size = detection?.box3d?.threeSize || detection?.size || detection?.dimensions || {};
    const yaw = Number(detection?.box3d?.threeRotation?.y ?? detection?.yaw ?? detection?.rotation?.y ?? 0);
    const length = Math.max(0.4, Number(size.x || size.length || 1));
    const width = Math.max(0.4, Number(size.z || size.width || 1));
    return vehicleGroundFootprint(
        {
            position: { x: Number(center.x) || 0, y: Number(center.y) || 0, z: Number(center.z) || 0 },
            rotation: { y: yaw },
        },
        { x: length, z: width },
    );
}

function boxes(detections, stroke, fill) {
    return (detections ?? []).flatMap((detection) => {
        const corners = detectionFootprint(detection);
        if (!corners || corners.length < 3) return [];
        return [{
            kind: "polygon",
            points: corners.map((point) => ({ x: point.x, z: point.z })),
            fill,
            stroke,
            strokeWidth: 1.5,
            dash: "4 3",
        }];
    });
}

registerPlanLayer({
    id: "perception",
    label: "Perception",
    group: "autonomy",
    defaultVisible: false,
    project(frame) {
        return [
            ...boxes(frame?.perception?.oracle, PLAN_COLORS.oracle, "rgb(52 211 153 / 0.12)"),
            ...boxes(frame?.perception?.candidate, PLAN_COLORS.candidate, "rgb(56 189 248 / 0.12)"),
        ];
    },
});
