import { vehicleGroundFootprint } from "../../../scenarios/route/geometry.js";
import { PLAN_COLORS } from "../primitives.js";
import { registerPlanLayer } from "../registry.js";

function strokeFor(actor) {
    if (actor.colliding) return PLAN_COLORS.collision;
    if (actor.offRoad) return PLAN_COLORS.offRoad;
    if (actor.role === "ego") return PLAN_COLORS.ego;
    if (actor.class === "pedestrian") return PLAN_COLORS.pedestrian;
    if (actor.class === "cyclist") return PLAN_COLORS.cyclist;
    return PLAN_COLORS.vehicle;
}

function fillFor(actor) {
    if (actor.role === "ego") return "rgb(248 250 252 / 0.08)";
    if (actor.class === "pedestrian") return "rgb(251 146 60 / 0.85)";
    if (actor.class === "cyclist") return "rgb(52 211 153 / 0.35)";
    return "rgb(56 189 248 / 0.28)";
}

function footprintSize(actor) {
    const size = actor.box?.size ?? { x: 4.5, z: 2 };
    if (actor.class === "cyclist") return { x: size.x, z: Math.max(0.45, size.z * 0.45) };
    return { x: size.x, z: size.z };
}

function projectActor(actor) {
    const stroke = strokeFor(actor);
    const selected = actor.id === actor.selectedActorId;
    if (actor.class === "pedestrian") {
        return {
            kind: "circle",
            center: { x: actor.position.x, z: actor.position.z },
            radiusM: 0.35,
            actorId: actor.id,
            fill: fillFor(actor),
            stroke,
            strokeWidth: actor.colliding || selected ? 2.5 : 1.5,
        };
    }
    const corners = vehicleGroundFootprint(
        { position: actor.position, rotation: { y: actor.yaw } },
        footprintSize(actor),
        actor.box?.center ?? { x: 0, z: 0 },
    );
    if (!corners) return null;
    return {
        kind: "polygon",
        points: corners.map((point) => ({ x: point.x, z: point.z })),
        actorId: actor.id,
        fill: fillFor(actor),
        stroke,
        strokeWidth: actor.colliding || actor.offRoad || actor.role === "ego" || selected ? 2 : 1.25,
    };
}

registerPlanLayer({
    id: "actors",
    label: "Actors",
    group: "actors",
    defaultVisible: true,
    project(frame) {
        return (frame?.vehicles ?? []).map((actor) => projectActor({
            ...actor,
            selectedActorId: frame.selectedActorId,
        }));
    },
});
