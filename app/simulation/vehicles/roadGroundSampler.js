/**
 * Cached paved-surface height and pitch for the kinematic bicycle plant.
 * Kernel-safe: no Three, DOM, or browser globals.
 */

import { projectPointToRoad } from "../../roads/RoadGeometry.js";
import {
    buildDirectedRoadGraph,
    hashEnvironmentRoadNetwork,
    projectPointToRoadNetwork,
} from "../../scenarios/route/roadGraph.js";
import { finiteNumber } from "../../scenarios/route/geometry.js";

const EPSILON = 1e-9;

function resolveEnvironment(source) {
    if (!source || typeof source !== "object") return null;
    if (typeof source.getEnvironment === "function") return resolveEnvironment(source.getEnvironment());
    if (source.description?.roads) return source.description;
    return source;
}

function resolveSamplerSource(options = {}) {
    if (typeof options.getEnvironment === "function") return { getEnvironment: options.getEnvironment };
    if (options.world?.description?.roads) return options.world.description;
    if (options.world?.roads) return options.world;
    if (options.environment) return options.environment;
    return null;
}

function plantOf(vehicle) {
    if (!vehicle) return null;
    if (typeof vehicle.setGroundSampler === "function") return vehicle;
    return vehicle.plant ?? null;
}

function pitchFromTangent(dx, dy, dz, yaw) {
    const lengthXZ = Math.hypot(dx, dz);
    if (lengthXZ <= EPSILON && Math.abs(dy) <= EPSILON) return 0;
    const headingX = Math.cos(finiteNumber(yaw, 0));
    const headingZ = -Math.sin(finiteNumber(yaw, 0));
    let sx = dx;
    let sy = dy;
    let sz = dz;
    if ((sx * headingX) + (sz * headingZ) < 0) {
        sx = -sx;
        sy = -sy;
        sz = -sz;
    }
    return Math.atan2(sy, Math.hypot(sx, sz));
}

function roadSegmentTangent(point, projection, graph) {
    const edge = graph.edges.get(String(projection.edgeId));
    if (!edge) return { dx: 1, dy: 0, dz: 0 };

    if (graph.geometryVersion === 2 && edge.compiled) {
        const compiled = projectPointToRoad(point, edge.compiled);
        const samples = edge.compiled.samples;
        const segment = Math.max(0, Math.min(samples.points.length - 2, compiled?.segment ?? 0));
        const start = samples.points[segment];
        const end = samples.points[segment + 1] ?? start;
        return {
            dx: end.x - start.x,
            dy: finiteNumber(end.y, 0) - finiteNumber(start.y, 0),
            dz: end.z - start.z,
        };
    }

    const start = graph.nodes.get(edge.startNodeId);
    const end = graph.nodes.get(edge.endNodeId);
    if (!start || !end) return { dx: 1, dy: 0, dz: 0 };
    return {
        dx: end.x - start.x,
        dy: finiteNumber(end.y, 0) - finiteNumber(start.y, 0),
        dz: end.z - start.z,
    };
}

/**
 * Project an XZ pose onto the paved union and return surface height plus pitch.
 * Pitch uses the 3D sample-segment delta, never compiled XZ tangents.
 */
export function sampleRoadGround(position, graph, yaw = 0) {
    if (!graph) return null;
    const point = {
        x: finiteNumber(position?.x, Number.NaN),
        z: finiteNumber(position?.z, Number.NaN),
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) return null;
    const projection = projectPointToRoadNetwork(point, null, { graph });
    if (!projection) return null;

    if (projection.kind === "intersection") {
        return {
            y: finiteNumber(projection.y, 0),
            pitch: 0,
            kind: "intersection",
            edgeId: null,
            nodeId: projection.nodeId ?? null,
        };
    }

    const tangent = roadSegmentTangent(point, projection, graph);
    return {
        y: finiteNumber(projection.y, finiteNumber(projection.point?.y, 0)),
        pitch: pitchFromTangent(tangent.dx, tangent.dy, tangent.dz, yaw),
        kind: "road",
        edgeId: projection.edgeId ?? null,
        nodeId: null,
    };
}

/**
 * Hash-keyed sampler over a world description, environment document, or getter.
 */
export function createRoadGroundSampler(source) {
    let graph = null;
    let hash = null;
    let graphBuilds = 0;

    const sampler = {
        get graphBuilds() {
            return graphBuilds;
        },
        sample(x, z, yaw = 0) {
            const environment = resolveEnvironment(source);
            if (!environment?.roads) return null;
            const nextHash = hashEnvironmentRoadNetwork(environment);
            if (!graph || nextHash !== hash) {
                graph = buildDirectedRoadGraph(environment);
                hash = nextHash;
                graphBuilds += 1;
            }
            return sampleRoadGround({ x, z }, graph, yaw);
        },
    };
    return sampler;
}

/** Attach a shared sample function to plant instances or `{ plant }` vehicles. */
export function bindRoadGroundSampler(vehicles, options = {}) {
    const source = resolveSamplerSource(options);
    const list = Array.isArray(vehicles) ? vehicles : [];
    if (!source) {
        for (const vehicle of list) plantOf(vehicle)?.setGroundSampler?.(null);
        return null;
    }
    const sampler = createRoadGroundSampler(source);
    const sampleFn = (x, z, yaw) => sampler.sample(x, z, yaw);
    for (const vehicle of list) plantOf(vehicle)?.setGroundSampler?.(sampleFn);
    return sampler;
}
