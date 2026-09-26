import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";
import { sectorPoints } from "../transform.js";

function spanDeg(sensor) {
    return Math.abs((Number(sensor.endDeg) || 0) - (Number(sensor.startDeg) || 0));
}

registerPlanLayer({
    id: "sensors",
    label: "Sensor wedges",
    group: "sensors",
    defaultVisible: true,
    project(frame) {
        return (frame?.sensors ?? []).flatMap((sensor) => {
            const color = sensor.kind === "lidar" ? PLAN_COLORS.lidar : PLAN_COLORS.camera;
            if (sensor.kind === "lidar" && spanDeg(sensor) >= 350) {
                return [{
                    kind: "circle",
                    center: sensor.position,
                    radiusM: sensor.range,
                    fill: "rgb(167 139 250 / 0.08)",
                    stroke: color,
                    strokeWidth: 1.25,
                }];
            }
            return [{
                kind: "polygon",
                points: sectorPoints(sensor.position, sensor.yaw, sensor.range, sensor.startDeg, sensor.endDeg),
                fill: sensor.kind === "lidar" ? "rgb(167 139 250 / 0.08)" : "rgb(56 189 248 / 0.08)",
                stroke: color,
                strokeWidth: 1.25,
            }];
        });
    },
});
