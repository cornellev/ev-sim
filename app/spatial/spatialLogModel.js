import { getRoutePolyline } from "../scenarios/route/Route.js";
import { resolveEgoRoute } from "../simulation/headless/MeasuredStateObservation.js";
import { headingFromPose, worldPointFromPose } from "./trajectorySimplify.js";

export const SPATIAL_LAYER_DEFAULTS = Object.freeze({
    environment: true,
    route: true,
    trails: true,
    cursor: true,
    events: true,
    localization: true,
    perception: false,
    controls: false,
});

export const TRAIL_HISTORY_MODES = Object.freeze([
    { id: "full", label: "Full path", windowUs: null },
    { id: "120s", label: "Last 120 s", windowUs: 120_000_000 },
    { id: "30s", label: "Last 30 s", windowUs: 30_000_000 },
    { id: "10s", label: "Last 10 s", windowUs: 10_000_000 },
]);

export const TRAIL_COLORS = Object.freeze([
    "#38bdf8",
    "#34d399",
    "#f59e0b",
    "#fb7185",
    "#a78bfa",
    "#22d3ee",
]);

export function discoverVehiclePosePaths(descriptors = []) {
    return descriptors
        .filter((descriptor) => descriptor.type === "pose3" && descriptor.path.startsWith("vehicles."))
        .map((descriptor) => ({
            path: descriptor.path,
            entityId: descriptor.path.split(".")[1] || descriptor.path,
        }));
}

export function poseAtTime(samples, timeUs) {
    if (!samples?.length) return null;
    let previous = samples[0];
    for (const sample of samples) {
        if (sample.timeUs > timeUs) break;
        previous = sample;
    }
    return previous;
}

export function trailSegmentForTime(samples, timeUs, historyMode = "full") {
    if (!samples?.length) return [];
    const mode = TRAIL_HISTORY_MODES.find((entry) => entry.id === historyMode) || TRAIL_HISTORY_MODES[0];
    const startUs = mode.windowUs == null ? samples[0].timeUs : Math.max(samples[0].timeUs, timeUs - mode.windowUs);
    const segment = samples.filter((sample) => sample.timeUs >= startUs && sample.timeUs <= timeUs);
    return segment.length ? segment : [poseAtTime(samples, timeUs)].filter(Boolean);
}

export function routePolylinePoints(route) {
    if (!route) return [];
    return getRoutePolyline(route).map((point) => ({
        x: Number(point.x) || Number(point.position?.x) || 0,
        z: Number(point.z) || Number(point.position?.z) || 0,
    }));
}

export function spatialFitPoints({ environment, route, trails = [] }) {
    const points = [];
    if (environment) {
        for (const node of environment.roads?.nodes || []) {
            points.push({ x: Number(node.x) || 0, z: Number(node.z) || 0 });
        }
        for (const building of environment.buildings || []) {
            for (const footprint of building.footprint || []) {
                points.push({ x: Number(footprint.x) || 0, z: Number(footprint.z) || 0 });
            }
        }
    }
    for (const point of routePolylinePoints(route)) points.push(point);
    for (const trail of trails) {
        for (const sample of trail.samples || []) points.push(worldPointFromPose(sample));
    }
    return points;
}

export function buildSpatialLogModel({
    environment = null,
    resolvedRun = null,
    route = null,
    trails = [],
    events = [],
    timeUs = 0,
    historyMode = "full",
    layers = SPATIAL_LAYER_DEFAULTS,
    primaryEntityId = null,
}) {
    const resolvedRoute = route || resolveEgoRoute(resolvedRun);
    const activeEntity = primaryEntityId
        || trails.find((trail) => trail.entityId === "ego")?.entityId
        || trails[0]?.entityId
        || null;
    const primaryTrail = trails.find((trail) => trail.entityId === activeEntity) || trails[0] || null;
    const cursorPose = primaryTrail ? poseAtTime(primaryTrail.samples, timeUs) : null;
    const visibleTrails = layers.trails
        ? trails.map((trail, index) => ({
            ...trail,
            color: trail.color || TRAIL_COLORS[index % TRAIL_COLORS.length],
            segment: trailSegmentForTime(trail.samples, timeUs, historyMode),
        }))
        : [];
    const visibleEvents = layers.events
        ? events.filter((event) => event.timeUs <= timeUs).slice(-200)
        : [];

    return {
        environment: layers.environment ? environment : null,
        route: layers.route ? resolvedRoute : null,
        routePoints: layers.route ? routePolylinePoints(resolvedRoute) : [],
        trails: visibleTrails,
        cursor: layers.cursor ? cursorPose : null,
        cursorHeading: cursorPose ? headingFromPose(cursorPose) : 0,
        events: visibleEvents,
        fitPoints: spatialFitPoints({
            environment: layers.environment ? environment : null,
            route: layers.route ? resolvedRoute : null,
            trails,
        }),
        primaryEntityId: activeEntity,
        worldHash: resolvedRun?.resolvedHash || resolvedRun?.manifest?.definitionHash || null,
    };
}

export function samplePolyline(points) {
    if (!points?.length) return "";
    return points.map((point) => `${point.x},${point.z}`).join(" ");
}

export function nearestSampleTime(samples, worldPoint) {
    if (!samples?.length || !worldPoint) return null;
    let best = samples[0];
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const sample of samples) {
        const point = worldPointFromPose(sample);
        const distance = Math.hypot(point.x - worldPoint.x, point.z - worldPoint.z);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = sample;
        }
    }
    return best.timeUs;
}
