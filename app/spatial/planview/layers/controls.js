import { sampleAckermannCenterline } from "../../../autonomy/ControlsPathArc.js";
import { rep103SteeringToThree } from "../../../autonomy/ControlCommandAdapter.js";
import { localToWorld } from "../transform.js";
import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

function arc(actor, steeringRad, stroke, dash) {
    if (!Number.isFinite(Number(steeringRad))) return null;
    const wheelbase = Number(actor.box?.size?.x) > 0 ? Math.max(0.8, actor.box.size.x * 0.55) : 1.5;
    const snapshotWheelbase = Number(actor.controls?.wheelbase);
    const local = sampleAckermannCenterline(rep103SteeringToThree(steeringRad), {
        wheelbase: Number.isFinite(snapshotWheelbase) && snapshotWheelbase > 0 ? snapshotWheelbase : wheelbase,
        lookahead: 8,
        segments: 16,
    });
    return {
        kind: "polyline",
        points: local.map((point) => localToWorld(actor.position, actor.yaw, point)),
        stroke,
        strokeWidth: 2,
        dash,
        opacity: 0.9,
    };
}

registerPlanLayer({
    id: "controls",
    label: "Control arc",
    group: "autonomy",
    defaultVisible: true,
    project(frame) {
        return (frame?.vehicles ?? []).flatMap((actor) => {
            if (actor.role !== "ego" && actor.id !== frame.selectedActorId) return [];
            const snapshot = frame.controls?.[actor.id];
            if (!snapshot) return [];
            const withControls = { ...actor, controls: snapshot };
            return [
                arc(withControls, snapshot.applied?.steeringRad, PLAN_COLORS.commanded, "5 4"),
                arc(withControls, snapshot.achieved?.steeringRad, PLAN_COLORS.achieved, null),
            ].filter(Boolean);
        });
    },
});
