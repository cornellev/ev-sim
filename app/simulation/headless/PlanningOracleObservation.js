import { compareUtf8 } from "../../math/compareUtf8.js";
import { canonicalEpisodeOverrides } from "../kernel/SimulationHashes.js";
import {
    MeasuredStateObservationBuilder,
    createMeasuredStateObservationSpace,
} from "./MeasuredStateObservation.js";
import { boxSpace, dictionarySpace, namedTensor, tensorMap } from "./TensorProtocol.js";

const FLOAT_BOUND = Number.MAX_VALUE;

export function planningActorIds(resolvedRun) {
    const egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
    const ids = new Set();
    for (const actor of resolvedRun?.scenario?.scenario?.actors || []) {
        if (actor?.id && actor.id !== egoId) ids.add(String(actor.id));
    }
    for (const vehicle of resolvedRun?.manifest?.initialState?.vehicles || []) {
        if (vehicle?.id && vehicle.id !== egoId) ids.add(String(vehicle.id));
    }
    for (const entry of resolvedRun?.vehicles || []) {
        if (entry?.actorId && entry.actorId !== egoId) ids.add(String(entry.actorId));
    }
    return [...ids].sort(compareUtf8);
}

export function createPlanningOracleObservationSpace(sensorDescriptors = [], actorCount = 0) {
    const base = createMeasuredStateObservationSpace(sensorDescriptors);
    const count = Math.max(0, Math.floor(Number(actorCount) || 0));
    const entries = [
        ...base.dictionary.entries,
        { key: "oracle/ego/pose", space: boxSpace("oracle/ego/pose", 1, "float64", [3], [-FLOAT_BOUND], [FLOAT_BOUND]) },
        { key: "oracle/ego/velocity", space: boxSpace("oracle/ego/velocity", 1, "float32", [3], [-FLOAT_BOUND], [FLOAT_BOUND]) },
        { key: "oracle/ego/steering", space: boxSpace("oracle/ego/steering", 1, "float32", [1], [-FLOAT_BOUND], [FLOAT_BOUND]) },
        { key: "oracle/actors/pose", space: boxSpace("oracle/actors/pose", 1, "float64", [count, 3], [-FLOAT_BOUND], [FLOAT_BOUND]) },
        { key: "oracle/actors/footprint", space: boxSpace("oracle/actors/footprint", 1, "float32", [count, 2], [-FLOAT_BOUND], [FLOAT_BOUND]) },
        { key: "oracle/actors/validity", space: boxSpace("oracle/actors/validity", 1, "bool", [count], [0], [1]) },
        { key: "oracle/goal", space: boxSpace("oracle/goal", 1, "float64", [3], [-FLOAT_BOUND], [FLOAT_BOUND]) },
        { key: "oracle/goal/validity", space: boxSpace("oracle/goal/validity", 1, "bool", [1], [0], [1]) },
    ];
    return dictionarySpace("planning-oracle", 1, entries);
}

function vehicleList(source) {
    const resolved = typeof source === "function" ? source() : source;
    if (Array.isArray(resolved?.vehicles)) return resolved.vehicles;
    if (typeof resolved?.list === "function") return resolved.list();
    return [];
}

function actorFootprint(resolvedRun, actorId) {
    const entry = (resolvedRun?.vehicles || []).find((vehicle) => vehicle.actorId === actorId);
    const size = entry?.manifest?.boundingBox?.size;
    return [Number(size?.x) || 0, Number(size?.z) || 0];
}

function egoKinematics(resolvedRun, egoId) {
    const entry = (resolvedRun?.vehicles || []).find((vehicle) => vehicle.actorId === egoId)
        ?? resolvedRun?.vehicles?.[0];
    return entry?.manifest?.kinematics || {};
}

export function goalFromBundle(resolvedRun, overrides = null) {
    const normalized = canonicalEpisodeOverrides(overrides);
    if (normalized?.goal) return normalized.goal;
    const routes = resolvedRun?.scenario?.scenario?.routes || [];
    const egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
    const route = routes.find((entry) => entry.actorId === egoId) ?? routes[0];
    const waypoints = route?.waypoints || [];
    const finish = waypoints.find((waypoint) => waypoint.kind === "finish") ?? waypoints.at(-1);
    const position = finish?.position;
    if (!position) return null;
    const polyline = route?.verification?.polyline || [];
    const previous = polyline.at(-2);
    const yaw = previous
        ? Math.atan2(-(position.z - previous.z), position.x - previous.x)
        : 0;
    return {
        x: Number(position.x) || 0,
        z: Number(position.z) || 0,
        yaw,
        positionToleranceM: 1,
        yawToleranceRad: Math.PI,
    };
}

export class PlanningOracleObservationBuilder {
    constructor(sensorManager, route, vehicleSource, resolvedRun) {
        this.state = new MeasuredStateObservationBuilder(sensorManager, route, vehicleSource);
        this.vehicleSource = vehicleSource;
        this.resolvedRun = resolvedRun;
        this.actorIds = planningActorIds(resolvedRun);
        this.egoId = resolvedRun?.manifest?.controls?.targetVehicleId || "ego";
    }

    reset() {
        this.state.reset();
    }

    build(options = {}) {
        const base = this.state.build(options);
        const vehicles = vehicleList(this.vehicleSource);
        const ego = vehicles.find((vehicle) => (vehicle.telemetryId || vehicle.id) === this.egoId) ?? vehicles[0] ?? null;
        const yaw = Number(ego?.rotation?.y) || 0;
        const velocity = ego?.velocity || { x: 0, y: 0, z: 0 };
        const steering = Number(ego?.steeringAngle ?? ego?.plant?.steeringAngle) || 0;
        const wheelbase = Number(egoKinematics(this.resolvedRun, this.egoId).wheelbase) || 0;
        const forwardSpeed = (Number(velocity.x) || 0) * Math.cos(yaw) + (Number(velocity.z) || 0) * -Math.sin(yaw);
        const yawRate = wheelbase > 0 ? (forwardSpeed / wheelbase) * Math.tan(steering) : 0;
        const goal = goalFromBundle(this.resolvedRun, options.overrides);
        const entries = [
            ...base.entries,
            namedTensor("oracle/ego/pose", "float64", [3], [Number(ego?.position?.x) || 0, Number(ego?.position?.z) || 0, yaw]),
            namedTensor("oracle/ego/velocity", "float32", [3], [Number(velocity.x) || 0, Number(velocity.z) || 0, yawRate]),
            namedTensor("oracle/ego/steering", "float32", [1], [steering]),
            namedTensor("oracle/actors/pose", "float64", [this.actorIds.length, 3], this.actorIds.flatMap((id) => {
                const actor = vehicles.find((vehicle) => (vehicle.telemetryId || vehicle.id) === id);
                return actor ? [Number(actor.position?.x) || 0, Number(actor.position?.z) || 0, Number(actor.rotation?.y) || 0] : [0, 0, 0];
            })),
            namedTensor("oracle/actors/footprint", "float32", [this.actorIds.length, 2], this.actorIds.flatMap((id) => actorFootprint(this.resolvedRun, id))),
            namedTensor("oracle/actors/validity", "bool", [this.actorIds.length], this.actorIds.map((id) => (
                vehicles.some((vehicle) => (vehicle.telemetryId || vehicle.id) === id)
            ))),
            namedTensor("oracle/goal", "float64", [3], goal ? [goal.x, goal.z, goal.yaw ?? 0] : [0, 0, 0]),
            namedTensor("oracle/goal/validity", "bool", [1], [Boolean(goal)]),
        ];
        return tensorMap(entries);
    }
}
