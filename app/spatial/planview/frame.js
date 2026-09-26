import { getRoutePolyline } from "../../scenarios/route/Route.js";
import { buildDirectedRoadGraph, projectPointToRoadNetwork } from "../../scenarios/route/roadGraph.js";
import { TRAIL_HISTORY_MODES } from "../spatialLogModel.js";
import { planActorId } from "./selection.js";

const FALLBACK_BOX = Object.freeze({
    size: { x: 4.5, z: 2 },
    center: { x: 0, z: 0 },
});

const LANE_WINDOW_M = 25;
const TRAIL_KEEP_NS = 120_000_000_000;

let laneGraphCache = { key: "", graph: null };

function finite(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function vec(value) {
    return {
        x: finite(value?.x),
        y: finite(value?.y),
        z: finite(value?.z),
    };
}

function xz(point) {
    return { x: finite(point?.x), z: finite(point?.z) };
}

function actorIdOf(vehicle, index) {
    return planActorId(vehicle, index);
}

function boxOf(vehicle) {
    const box = vehicle?.manifest?.boundingBox ?? vehicle?.boundingBox;
    const size = box?.size;
    const center = box?.center;
    if (!size) return { ...FALLBACK_BOX, size: { ...FALLBACK_BOX.size }, center: { ...FALLBACK_BOX.center } };
    return {
        size: { x: Math.max(0.2, finite(size.x, FALLBACK_BOX.size.x)), z: Math.max(0.2, finite(size.z, FALLBACK_BOX.size.z)) },
        center: { x: finite(center?.x), z: finite(center?.z) },
    };
}

function collidingIds(contacts) {
    const ids = new Set();
    const active = contacts?.active ?? contacts ?? [];
    for (const key of active) {
        for (const part of String(key).split("|")) {
            if (part) ids.add(part);
        }
    }
    return ids;
}

function routePoints(route) {
    return getRoutePolyline(route).map(xz).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
}

function historyWindowNs(historyMode) {
    const mode = TRAIL_HISTORY_MODES.find((entry) => entry.id === historyMode);
    if (!mode?.windowUs) return null;
    return mode.windowUs * 1000;
}

export function clipTrail(samples, timeNs, historyMode) {
    const windowNs = historyWindowNs(historyMode);
    const source = Array.isArray(samples) ? samples : [];
    const cutoff = windowNs == null ? null : finite(timeNs) - windowNs;
    return source
        .filter((sample) => cutoff == null || finite(sample?.timeNs) >= cutoff)
        .map((sample) => ({ x: finite(sample.x), z: finite(sample.z), timeNs: finite(sample.timeNs) }));
}

/**
 * Append a sample when the actor has moved. Keeps at most the longest trail window.
 * `trails` is a Map of actor id to mutable sample arrays, owned by the view.
 */
export function appendPlanTrails(trails, vehicles, timeNs) {
    if (!trails) return;
    const seen = new Set();
    const cutoff = finite(timeNs) - TRAIL_KEEP_NS;
    vehicles.forEach((vehicle, index) => {
        const id = actorIdOf(vehicle, index);
        seen.add(id);
        const position = vec(vehicle?.position);
        const samples = trails.get(id) ?? [];
        const last = samples.at(-1);
        const moved = !last || Math.hypot(last.x - position.x, last.z - position.z) > 0.05;
        if (moved) samples.push({ x: position.x, z: position.z, timeNs: finite(timeNs) });
        while (samples.length > 1 && samples[0].timeNs < cutoff) samples.shift();
        trails.set(id, samples);
    });
    for (const id of [...trails.keys()]) {
        if (!seen.has(id)) trails.delete(id);
    }
}

function environmentKey(environment) {
    const roads = environment?.roads;
    if (!roads) return "";
    const edges = roads.edges ?? [];
    return `${roads.geometryVersion ?? 1}:${edges.map((edge) => edge?.id).join(",")}`;
}

function roadGraphFor(environment) {
    const key = environmentKey(environment);
    if (!key) return null;
    if (laneGraphCache.key === key && laneGraphCache.graph) return laneGraphCache.graph;
    const graph = buildDirectedRoadGraph(environment);
    laneGraphCache = { key, graph };
    return graph;
}

function pointAlong(start, end, distance) {
    const length = Math.hypot(end.x - start.x, end.z - start.z);
    if (length <= 1e-9) return xz(start);
    const t = distance / length;
    return {
        x: start.x + (end.x - start.x) * t,
        z: start.z + (end.z - start.z) * t,
    };
}

/** Clip a polyline to `radius` meters of arc length on either side of the closest point. */
function windowAround(points, origin, radius = LANE_WINDOW_M) {
    const source = (points ?? []).map(xz).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.z));
    if (source.length < 2) return source;
    const cumulative = [0];
    for (let index = 1; index < source.length; index += 1) {
        cumulative.push(cumulative[index - 1] + Math.hypot(source[index].x - source[index - 1].x, source[index].z - source[index - 1].z));
    }
    let bestDistance = Infinity;
    let along = 0;
    for (let index = 1; index < source.length; index += 1) {
        const start = source[index - 1];
        const end = source[index];
        const length = cumulative[index] - cumulative[index - 1];
        const t = length <= 1e-9
            ? 0
            : Math.max(0, Math.min(1, ((origin.x - start.x) * (end.x - start.x) + (origin.z - start.z) * (end.z - start.z)) / (length * length)));
        const projected = { x: start.x + (end.x - start.x) * t, z: start.z + (end.z - start.z) * t };
        const distance = Math.hypot(projected.x - origin.x, projected.z - origin.z);
        if (distance < bestDistance) {
            bestDistance = distance;
            along = cumulative[index - 1] + length * t;
        }
    }
    const from = Math.max(0, along - radius);
    const to = Math.min(cumulative.at(-1), along + radius);
    const clipped = [];
    const push = (point) => {
        const last = clipped.at(-1);
        if (!last || Math.hypot(last.x - point.x, last.z - point.z) > 1e-4) clipped.push(point);
    };
    for (let index = 1; index < source.length; index += 1) {
        const startDistance = cumulative[index - 1];
        const endDistance = cumulative[index];
        if (endDistance < from || startDistance > to) continue;
        if (startDistance < from) push(pointAlong(source[index - 1], source[index], from - startDistance));
        else push(source[index - 1]);
        if (endDistance > to) push(pointAlong(source[index - 1], source[index], to - startDistance));
        else push(source[index]);
    }
    return clipped;
}

function lanePolyline(hit, graph) {
    if (!hit || hit.kind !== "road" || !hit.edgeId) return [];
    const edge = graph?.edges?.get?.(hit.edgeId);
    if (!edge) return [];
    const laneIndex = Number.isInteger(hit.laneIndex) ? hit.laneIndex : 0;
    const centerline = edge.compiled?.surface?.laneCenterlines?.[laneIndex]
        ?? edge.compiled?.fullLaneCenterlines?.[laneIndex]
        ?? edge.compiled?.samples?.points
        ?? null;
    if (Array.isArray(centerline) && centerline.length >= 2) return centerline;
    const start = graph.nodes?.get?.(edge.startNodeId);
    const end = graph.nodes?.get?.(edge.endNodeId);
    if (!start || !end) return [];
    return [start, end];
}

export function lanePointsFor(environment, pose) {
    if (!environment?.roads?.edges?.length || !pose) return [];
    let graph = null;
    try {
        graph = roadGraphFor(environment);
        if (!graph) return [];
        const hit = projectPointToRoadNetwork(pose, environment, { graph });
        const origin = xz(pose.position ?? pose);
        return windowAround(lanePolyline(hit, graph), origin);
    } catch {
        // A road document the graph cannot compile leaves the lane highlight blank.
        return [];
    }
}

function readPose(device, vehicle) {
    const position = typeof device?.getPosition === "function" ? device.getPosition() : vehicle?.position;
    const rotation = typeof device?.getRotation === "function" ? device.getRotation() : vehicle?.rotation;
    if (!position) return null;
    return {
        position: { x: finite(position.x), z: finite(position.z) },
        yaw: finite(rotation?.y ?? vehicle?.rotation?.y),
    };
}

function horizontalFovDeg(verticalFovDeg, width, height) {
    const vertical = finite(verticalFovDeg) * Math.PI / 180;
    const aspect = finite(width, 1) / Math.max(1e-6, finite(height, 1));
    return (2 * Math.atan(Math.tan(vertical / 2) * aspect) * 180) / Math.PI;
}

function readCamera(device) {
    const calibration = device?.config?.calibration;
    if (Number.isFinite(Number(calibration?.verticalFovDeg)) && Number.isFinite(Number(calibration?.far))) {
        return {
            kind: "camera",
            startDeg: -horizontalFovDeg(calibration.verticalFovDeg, calibration.width, calibration.height) / 2,
            endDeg: horizontalFovDeg(calibration.verticalFovDeg, calibration.width, calibration.height) / 2,
            range: finite(calibration.far),
        };
    }
    const camera = device?.cameraSettings;
    if (Number.isFinite(Number(camera?.fov))) {
        const fov = horizontalFovDeg(camera.fov, camera.width, camera.height);
        return {
            kind: "camera",
            startDeg: -fov / 2,
            endDeg: fov / 2,
            range: finite(camera.far, finite(device?.settings?.range, 20)),
        };
    }
    const fov = device?.config?.fov ?? device?.settings?.fov;
    const range = device?.config?.far ?? device?.settings?.far;
    if (Number.isFinite(Number(fov)) && Number.isFinite(Number(range))) {
        return { kind: "camera", startDeg: -finite(fov) / 2, endDeg: finite(fov) / 2, range: finite(range) };
    }
    return null;
}

function readLidar(device) {
    const range = device?.settings?.range ?? device?.range;
    const theta = device?.settings?.theta?.range ?? device?.thetaRange;
    if (!Number.isFinite(Number(range)) || !Array.isArray(theta) || theta.length < 2) return null;
    return {
        kind: "lidar",
        startDeg: finite(theta[0]),
        endDeg: finite(theta[1]),
        range: finite(range),
    };
}

function sensorOf(device, vehicle, vehicleId) {
    if (!device || device.enabled === false) return null;
    const spec = readCamera(device) ?? readLidar(device);
    const pose = readPose(device, vehicle);
    if (!spec || !pose) return null;
    return {
        id: String(device.telemetryId || device.id || device.name || `${vehicleId}-sensor`),
        vehicleId,
        ...spec,
        ...pose,
    };
}

function controlsFor(sources, actorId, timeNs) {
    if (sources.controlsById && Object.prototype.hasOwnProperty.call(sources.controlsById, actorId)) {
        return sources.controlsById[actorId];
    }
    const runtime = sources.controlRuntime;
    if (typeof runtime?.getSnapshot !== "function") return null;
    try {
        return runtime.getSnapshot(actorId, { applyTimeNs: timeNs });
    } catch {
        return null;
    }
}

function copyDetections(detections) {
    if (!Array.isArray(detections)) return [];
    return detections.map((detection) => ({
        box3d: detection?.box3d ?? null,
        center: detection?.center ?? null,
        size: detection?.size ?? null,
        yaw: detection?.yaw ?? null,
        position: detection?.position ?? null,
        dimensions: detection?.dimensions ?? null,
        rotation: detection?.rotation ?? null,
    }));
}

function trailSamples(trails, id) {
    if (!trails) return [];
    if (trails instanceof Map) return trails.get(id) ?? [];
    return trails[id] ?? [];
}

export function emptyPlanViewFrame() {
    return {
        timeNs: 0,
        historyMode: "10s",
        selectedActorId: null,
        vehicles: [],
        sensors: [],
        signals: [],
        lane: { points: [] },
        perception: { oracle: [], candidate: [] },
        localization: { estimate: null },
        controls: {},
    };
}

/**
 * Copy live sources into a plain frame. Layers read this object only.
 * @param {object} sources
 */
export function buildPlanViewFrame(sources = {}) {
    const timeNs = finite(sources.timeNs);
    const historyMode = sources.historyMode || "10s";
    const scenario = sources.scenario ?? null;
    const actors = Array.isArray(scenario?.actors) ? scenario.actors : [];
    const routes = Array.isArray(scenario?.routes) ? scenario.routes : [];
    const metrics = sources.metrics ?? null;
    const colliding = collidingIds(sources.contacts);
    const offRoad = metrics?.["off-road"] === 1;
    const routeProgress = Number.isFinite(Number(metrics?.["route-progress"])) ? Number(metrics["route-progress"]) : null;
    const vehicles = [];
    const sensors = [];
    const controls = {};

    (sources.vehicles ?? []).forEach((vehicle, index) => {
        const id = actorIdOf(vehicle, index);
        const actor = actors.find((entry) => entry.id === id) ?? null;
        const role = actor?.role === "ego" || id === "ego" ? "ego" : (actor?.role || "actor");
        const actorClass = vehicle?.actorClass || vehicle?.class || actor?.class || "vehicle";
        const position = vec(vehicle?.position);
        const velocity = vec(vehicle?.velocity);
        const route = routes.filter((entry) => entry.actorId === id).flatMap(routePoints);
        vehicles.push({
            id,
            role,
            class: actorClass,
            position,
            yaw: finite(vehicle?.rotation?.y),
            velocity,
            speed: Math.hypot(velocity.x, velocity.z),
            steeringAngle: finite(vehicle?.steeringAngle),
            box: boxOf(vehicle),
            offRoad: role === "ego" && offRoad,
            colliding: colliding.has(id),
            route,
            routeProgress: role === "ego" ? routeProgress : null,
            trail: clipTrail(trailSamples(sources.trails, id), timeNs, historyMode),
        });
        const snapshot = controlsFor(sources, id, timeNs);
        if (snapshot) controls[id] = snapshot;
        for (const device of vehicle?.devices ?? []) {
            const sensor = sensorOf(device, vehicle, id);
            if (sensor) sensors.push(sensor);
        }
    });

    const ego = vehicles.find((entry) => entry.role === "ego") ?? vehicles[0] ?? null;
    const perception = sources.perception ?? {};
    const localization = sources.localization ?? {};
    const estimate = localization.estimate?.position ? xz(localization.estimate.position) : null;

    return {
        timeNs,
        historyMode,
        selectedActorId: sources.selectedActorId ? String(sources.selectedActorId) : null,
        vehicles,
        sensors,
        signals: Array.isArray(sources.signals) ? sources.signals.map((signal) => ({
            id: String(signal.id ?? ""),
            position: xz(signal.position),
            state: signal.state || "unknown",
        })) : [],
        lane: { points: lanePointsFor(sources.environment, ego) },
        perception: {
            oracle: copyDetections(perception.oracle?.detections3d),
            candidate: copyDetections(perception.detections3d),
        },
        localization: { estimate },
        controls,
    };
}

/** Read the live simulation into the plain object `buildPlanViewFrame` accepts. */
export function planViewSourcesFromData(data, extras = {}) {
    const simulation = data?.simulation?.();
    const scenarioRuntime = simulation?.scenarioRuntime;
    const scenarioSnapshot = scenarioRuntime?.getSnapshot?.() ?? null;
    return {
        vehicles: data?.vehicles?.()?.vehicles ?? [],
        scenario: scenarioRuntime?.scenario ?? null,
        metrics: scenarioSnapshot?.metrics ?? null,
        contacts: simulation?.kernel?.lastContacts?.active ?? [],
        perception: simulation?.candidateOutputRuntime?.lastPerception ?? null,
        localization: simulation?.candidateOutputRuntime?.lastLocalization ?? null,
        controlRuntime: simulation?.controlRuntime ?? null,
        timeNs: simulation?.timeNs ?? simulation?.kernel?.timeNs ?? 0,
        ...extras,
    };
}
