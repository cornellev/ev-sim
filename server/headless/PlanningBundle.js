import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    normalizeVehiclePluginLocks,
    stampManifestPluginSelectionForVehicleLock,
} from "../../app/plugin/PluginSensorAuthoring.js";
import { createDefaultRunManifest } from "../../app/simulation/RunManifest.js";
import { getBuiltInVehicleManifest } from "../../app/vehicles/BuiltInVehicleManifests.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import { StorageService } from "../storage/StorageService.js";

const STATE_SENSOR_TYPES = new Set(["imu", "gnss", "wheel-odometry"]);
const DROPPED_TOPIC_PREFIXES = ["front-camera", "front-lidar", "oracle-"];
const FREE_DRIVE_FLAG = "cev-sim.free-drive.stop";

export function yawFromDirection(dx, dz) {
    return Math.atan2(-dz, dx);
}

export function selectRouteEndpoints(environment, {
    initialPosition = { x: 0, z: 0 },
    roadId = null,
    startNodeId = null,
    finishNodeId = null,
    required = true,
} = {}) {
    const roads = environment?.document?.roads;
    const nodes = new Map((roads?.nodes || []).map((node) => [node.id, node]));
    let candidates = (roads?.edges || []).flatMap((edge) => {
        const start = nodes.get(edge.startNodeId);
        const end = nodes.get(edge.endNodeId);
        if (!start || !end) return [];
        return [
            { edge, start, finish: end, startFraction: 0, finishFraction: 1 },
            ...(edge.bidirectional
                ? [{ edge, start: end, finish: start, startFraction: 1, finishFraction: 0 }]
                : []),
        ];
    });
    if (roadId) candidates = candidates.filter((entry) => entry.edge.id === roadId);
    if (startNodeId) candidates = candidates.filter((entry) => entry.start.id === startNodeId);
    if (finishNodeId) candidates = candidates.filter((entry) => entry.finish.id === finishNodeId);
    candidates.sort((left, right) => {
        const leftDistance = Math.hypot(left.start.x - initialPosition.x, left.start.z - initialPosition.z);
        const rightDistance = Math.hypot(right.start.x - initialPosition.x, right.start.z - initialPosition.z);
        return leftDistance - rightDistance
            || Buffer.from(left.edge.id).compare(Buffer.from(right.edge.id))
            || left.startFraction - right.startFraction;
    });
    if (candidates.length === 0) {
        if (!required) return null;
        throw new Error("The planning bundle environment has no routable road edge for the requested endpoints.");
    }
    return candidates[0];
}

export function nodePairEndpoints(environment, startNodeId, finishNodeId) {
    const nodes = new Map((environment?.document?.roads?.nodes || []).map((node) => [node.id, node]));
    const start = nodes.get(startNodeId);
    const finish = nodes.get(finishNodeId);
    if (!start || !finish || start.id === finish.id) {
        throw new Error(`Road nodes "${startNodeId}" and "${finishNodeId}" are not a usable start and finish.`);
    }
    return { edge: null, start, finish, startFraction: 0, finishFraction: 1 };
}

export function vehicleFootprint(position, yaw, size) {
    const forward = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const right = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const halfLength = size.x / 2;
    const halfWidth = size.z / 2;
    return [-1, 1].flatMap((along) => [-1, 1].map((across) => ({
        x: position.x + along * halfLength * forward.x + across * halfWidth * right.x,
        z: position.z + along * halfLength * forward.z + across * halfWidth * right.z,
    })));
}

function obstaclePolygon(obstacle) {
    if (Array.isArray(obstacle?.footprint) && obstacle.footprint.length >= 3) return obstacle.footprint;
    const min = obstacle?.bounds?.min;
    const max = obstacle?.bounds?.max;
    if (!min || !max) return null;
    return [
        { x: min.x, z: min.z },
        { x: max.x, z: min.z },
        { x: max.x, z: max.z },
        { x: min.x, z: max.z },
    ];
}

function roundPlane(value) {
    return Number(value.toFixed(6));
}

function planePoint(vertex) {
    if (Array.isArray(vertex)) return { x: Number(vertex[0]), z: Number(vertex[2]) };
    return { x: Number(vertex?.x), z: Number(vertex?.z) };
}

/** Convex hull of mesh vertices on the ground plane. Fewer than three points yields null. */
export function convexHullXZ(vertices) {
    const unique = [];
    const seen = new Set();
    for (const vertex of vertices ?? []) {
        const point = planePoint(vertex);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
        const key = `${point.x.toFixed(6)},${point.z.toFixed(6)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({ x: roundPlane(point.x), z: roundPlane(point.z) });
    }
    unique.sort((left, right) => left.x - right.x || left.z - right.z);
    if (unique.length < 3) return null;
    const cross = (origin, left, right) => (
        (left.x - origin.x) * (right.z - origin.z) - (left.z - origin.z) * (right.x - origin.x)
    );
    const chain = (points) => {
        const built = [];
        for (const point of points) {
            while (built.length >= 2 && cross(built[built.length - 2], built[built.length - 1], point) <= 0) {
                built.pop();
            }
            built.push(point);
        }
        return built;
    };
    const hull = chain(unique).slice(0, -1).concat(chain(unique.slice().reverse()).slice(0, -1));
    return hull.length >= 3 ? hull : null;
}

/**
 * Building and feature rings, plus the ground projection of each physics collider.
 * Asset-proxy collision meshes and scene primitives are the same solids the physics step uses.
 */
export function planningObstacleFootprints(description) {
    const footprints = [];
    for (const obstacle of description?.obstacles ?? []) {
        const footprint = obstaclePolygon(obstacle);
        if (!footprint) continue;
        footprints.push({
            id: String(obstacle.id ?? `obstacle-${footprints.length}`),
            footprint,
        });
    }
    for (const proxy of description?.assetProxies ?? []) {
        for (const mesh of proxy?.collision ?? []) {
            const footprint = convexHullXZ(mesh?.vertices);
            if (!footprint) continue;
            footprints.push({
                id: String(mesh?.id ?? proxy?.id ?? `proxy-${footprints.length}`),
                footprint,
            });
        }
    }
    for (const solid of description?.primitives ?? []) {
        const footprint = convexHullXZ(solid?.vertices);
        if (!footprint) continue;
        footprints.push({
            id: String(solid?.id ?? `primitive-${footprints.length}`),
            footprint,
        });
    }
    return footprints;
}

function polygonsOverlap(left, right) {
    if (!left || !right || left.length < 3 || right.length < 3) return false;
    return left.some((point) => pointInRing(point, right))
        || right.some((point) => pointInRing(point, left))
        || edgesCross(left, right);
}

function pointInRing(point, ring) {
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
        const current = ring[index];
        const prior = ring[previous];
        const crosses = (current.z > point.z) !== (prior.z > point.z)
            && point.x < ((prior.x - current.x) * (point.z - current.z)) / ((prior.z - current.z) || Number.EPSILON) + current.x;
        if (crosses) inside = !inside;
    }
    return inside;
}

function edgesCross(left, right) {
    const segments = (ring) => ring.map((point, index) => [point, ring[(index + 1) % ring.length]]);
    return segments(left).some(([a, b]) => segments(right).some(([c, d]) => segmentsIntersect(a, b, c, d)));
}

function segmentsIntersect(a, b, c, d) {
    const side = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
    return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

export function firstClearRouteIndex(polyline, size, obstacles) {
    const polygons = obstacles.map(obstaclePolygon).filter(Boolean);
    return polyline.findIndex((point, index) => {
        if (index >= polyline.length - 1) return false;
        const next = polyline[index + 1];
        const yaw = yawFromDirection(next.x - point.x, next.z - point.z);
        const footprint = vehicleFootprint(point, yaw, size);
        return !polygons.some((polygon) => polygonsOverlap(footprint, polygon));
    });
}

function freeDriveTrigger(actorId) {
    return {
        id: "free-drive",
        name: "Free drive",
        enabled: true,
        once: true,
        condition: {
            kind: "flag",
            flag: FREE_DRIVE_FLAG,
            actorId,
            operator: "eq",
            expected: true,
        },
        actions: [{ kind: "finish" }],
    };
}

function scenarioDraft({ environmentId, actorId, endpoints, bundleId, finish = "route" }) {
    const point = (node) => ({ x: node.x, y: 0, z: node.z });
    const finishPoint = point(endpoints.finish);
    const draft = {
        kind: "cev-sim.scenario",
        version: 1,
        id: bundleId,
        name: bundleId,
        description: "Verified ego route generated for planner and controller testing.",
        folderId: null,
        environment: { id: environmentId, expectedHash: null },
        actors: [{
            id: actorId,
            name: "Ego",
            role: "ego",
            vehicleId: null,
            enabled: true,
        }],
        routes: [{
            id: "ego-route",
            name: "Ego route",
            actorId,
            initialSpeedMps: 0,
            waypoints: [{
                id: "start",
                order: 0,
                kind: "start",
                position: point(endpoints.start),
                heading: 0,
                ...(endpoints.edge ? {
                    anchor: { kind: "road", id: endpoints.edge.id, fraction: endpoints.startFraction },
                } : {}),
            }, {
                id: "finish",
                order: 1,
                kind: "finish",
                position: finishPoint,
                heading: 0,
                ...(endpoints.edge ? {
                    anchor: { kind: "road", id: endpoints.edge.id, fraction: endpoints.finishFraction },
                } : {}),
            }],
        }],
        zones: [{
            id: "finish-zone",
            name: "Finish",
            parentId: null,
            center: finishPoint,
            size: { x: 8, y: 4, z: 8 },
        }],
        triggers: [{
            id: "enter-finish",
            name: "Finish at route end",
            enabled: true,
            once: true,
            condition: { kind: "zone-enter", zoneId: "finish-zone", actorId },
            actions: [{ kind: "finish" }],
        }],
        completion: { conditions: [] },
        expectedOutcomes: [],
        sensorAliases: [],
        parameters: [],
    };
    if (finish === "none") {
        draft.zones = [];
        draft.triggers = [freeDriveTrigger(actorId)];
    }
    return draft;
}

function defaultStateSensors() {
    const defaults = createDefaultRunManifest();
    const sensors = defaults.sensorRig.sensors.filter((sensor) => STATE_SENSOR_TYPES.has(sensor.type));
    const topicIds = new Set(sensors.flatMap((sensor) => Object.values(sensor.outputs || {}).filter(Boolean)));
    return {
        sensors,
        topics: defaults.topics.filter((topic) => topicIds.has(topic.id)),
    };
}

function stateSensorManifest(source, {
    environmentId,
    storedScenario,
    bundleId,
    sensors,
    maxSteps,
    vehicleType = null,
}) {
    const manifest = structuredClone(source);
    const ego = manifest.initialState?.vehicles?.find((entry) => entry.id === "ego")
        ?? manifest.initialState?.vehicles?.[0];
    if (vehicleType) {
        if (!ego) throw new Error("The planning bundle manifest has no ego vehicle.");
        ego.type = vehicleType;
    }
    let kept = sensors === "all"
        ? manifest.sensorRig.sensors
        : manifest.sensorRig.sensors.filter((sensor) => STATE_SENSOR_TYPES.has(sensor.type));
    if (sensors !== "all" && kept.length === 0) {
        const defaults = defaultStateSensors();
        kept = defaults.sensors;
        const present = new Set(manifest.topics.map((topic) => topic.id));
        manifest.topics.push(...defaults.topics.filter((topic) => !present.has(topic.id)));
    }
    manifest.id = bundleId;
    manifest.name = bundleId;
    manifest.description = "Planner test run with a verified ego route.";
    manifest.environment = { id: environmentId, expectedHash: null };
    manifest.clock = {
        ...manifest.clock,
        pacing: "unbounded",
        maxSteps: maxSteps == null ? null : maxSteps,
    };
    manifest.controls = { ...manifest.controls, authority: "candidate", targetVehicleId: "ego" };
    manifest.sensorRig = { ...manifest.sensorRig, vehicleId: "ego", sensors: kept };
    if (sensors !== "all") {
        manifest.topics = manifest.topics.filter((topic) => (
            !DROPPED_TOPIC_PREFIXES.some((prefix) => String(topic.id).startsWith(prefix))
        ));
    }
    manifest.scenario = {
        id: storedScenario.id,
        expectedHash: storedScenario.definitionHash,
        egoVehicleId: manifest.initialState.vehicles.find((entry) => entry.id === "ego")?.type
            ?? manifest.initialState.vehicles[0]?.type,
        sensorBindings: {},
        parameterValues: {},
    };
    return manifest;
}

function applyStartPose(manifest, point, yaw) {
    const vehicles = manifest.initialState?.vehicles || [];
    const vehicle = vehicles.find((entry) => entry.id === "ego") ?? vehicles[0];
    if (!vehicle) throw new Error("The planning bundle manifest has no ego vehicle.");
    vehicle.pose = {
        position: { x: point.x, y: vehicle.pose?.position?.y ?? 0, z: point.z },
        rotation: { x: 0, y: yaw, z: 0, order: vehicle.pose?.rotation?.order || "XYZ" },
    };
    vehicle.linearVelocity = { x: 0, y: 0, z: 0 };
    vehicle.steeringAngle = 0;
}

function assertPlanningPlantLock(manifest) {
    const plantId = typeof manifest?.dynamics?.plant === "string" ? manifest.dynamics.plant : "";
    if (!plantId) return;
    const locks = Array.isArray(manifest.pluginLocks) ? manifest.pluginLocks : [];
    if (!locks.some((lock) => Array.isArray(lock?.plants) && lock.plants.includes(plantId))) {
        throw new Error(`Plant "${plantId}" has no matching plugin lock.`);
    }
}

async function copyPlanningPluginPackages(live, storage, manifest) {
    const locks = normalizeVehiclePluginLocks(manifest?.pluginLocks) ?? [];
    for (const lock of locks) {
        let resource;
        try {
            resource = await live.plugins.getPackage(lock.packageHash);
        } catch (error) {
            throw new Error(`Plugin "${lock.pluginId}" must be installed in the data directory.`, { cause: error });
        }
        if (live !== storage) await storage.plugins.putPackage(resource);
    }
}

function applyVehiclePluginSelection(manifest, vehicle) {
    const locks = normalizeVehiclePluginLocks(vehicle?.pluginLocks) ?? [];
    if (locks.length === 0) return manifest;
    let selection = manifest.plugins ?? null;
    for (const lock of locks) {
        selection = stampManifestPluginSelectionForVehicleLock(selection, lock);
    }
    if (selection) manifest.plugins = structuredClone(selection);
    return manifest;
}

async function resolvePlanningVehicle(live, storage, vehicleId, copyStored) {
    const builtIn = getBuiltInVehicleManifest(vehicleId);
    if (builtIn) return builtIn;
    const snapshot = await live.readVehicleSnapshot(vehicleId);
    if (!snapshot?.manifest) throw new Error(`Vehicle "${vehicleId}" does not exist.`);
    assertPlanningPlantLock(snapshot.manifest);
    await copyPlanningPluginPackages(live, storage, snapshot.manifest);
    if (copyStored) {
        for (const file of snapshot.files || []) {
            await storage.putVehicleAsset(vehicleId, file.name, file.bytes);
        }
        await storage.createVehicleManifest(snapshot.manifest);
    }
    return snapshot.manifest;
}

async function verifyDraft(storage, scenario) {
    const verified = await storage.verifyScenarioRoute(scenario.id, {
        scenario,
        routeId: scenario.routes[0].id,
    });
    if (!verified.ok) {
        throw new Error(verified.issues?.[0]?.message || verified.error || "Route verification failed.");
    }
    return verified;
}

export async function createPlanningBundle({
    sourceManifestId = "igvc-default",
    environmentId = null,
    dataDir = null,
    roadId = null,
    startNodeId = null,
    finishNodeId = null,
    sensors = "state",
    maxSteps = null,
    bundleId = "planning-route",
    vehicleId = null,
    finish = "route",
    storageFactory = null,
} = {}) {
    if (!["state", "all"].includes(sensors)) {
        throw new Error('sensors must be "state" or "all".');
    }
    if (!["route", "none"].includes(finish)) {
        throw new Error('finish must be "route" or "none".');
    }
    const ownedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cev-planning-bundle-"));
    const storage = storageFactory
        ? storageFactory(ownedRoot)
        : new StorageService(ownedRoot);
    try {
        const live = dataDir ? new StorageService(dataDir) : storage;
        const source = await live.getRunManifest(sourceManifestId);
        if (!source) throw new Error(`Run manifest "${sourceManifestId}" does not exist.`);
        const selectedEnvironmentId = environmentId || source.environment?.id;
        const environment = await live.getEnvironment(selectedEnvironmentId, { full: true });
        if (!environment) throw new Error(`Environment "${selectedEnvironmentId}" was not found.`);
        if (dataDir) {
            await live.assertEditorAssetPins(environment);
            await storage.copyVisualLayerClosure(live, environment);
            await storage.putEnvironment(selectedEnvironmentId, structuredClone(environment), {
                create: true,
                trustedAssetPins: true,
            });
        }
        const initial = source.initialState?.vehicles?.find((vehicle) => vehicle.id === "ego")
            ?? source.initialState?.vehicles?.[0];
        if (!initial) throw new Error("The planning bundle manifest has no ego vehicle.");
        const selectedVehicleId = vehicleId || initial.type;
        const vehicle = await resolvePlanningVehicle(live, storage, selectedVehicleId, Boolean(dataDir));
        const size = vehicle?.boundingBox?.size;
        if (!size?.x || !size?.z) throw new Error(`Vehicle "${selectedVehicleId}" has no bounding box.`);
        const networkRoute = Boolean(startNodeId && finishNodeId && !roadId);
        const endpoints = selectRouteEndpoints(environment, {
            initialPosition: initial.pose?.position || { x: 0, z: 0 },
            roadId,
            startNodeId,
            finishNodeId,
            required: !networkRoute,
        }) ?? nodePairEndpoints(environment, startNodeId, finishNodeId);
        let scenario = scenarioDraft({
            environmentId: selectedEnvironmentId,
            actorId: initial.id,
            endpoints,
            bundleId,
            finish,
        });
        let verified = await verifyDraft(storage, scenario);
        const obstacles = planningObstacleFootprints(createWorldResource(environment).description);
        const clearIndex = firstClearRouteIndex(verified.verification.polyline, size, obstacles);
        if (clearIndex < 0) throw new Error("The route has no start pose clear of obstacles.");
        if (clearIndex > 0) {
            const polyline = verified.verification.polyline;
            const distances = verified.verification.cumulativeDistances;
            const next = polyline[Math.min(polyline.length - 1, clearIndex + 1)];
            scenario = scenarioDraft({
                environmentId: selectedEnvironmentId,
                actorId: initial.id,
                endpoints: {
                    ...endpoints,
                    start: polyline[clearIndex],
                    startFraction: distances[clearIndex] / verified.verification.totalLength,
                },
                bundleId,
                finish,
            });
            scenario.routes[0].waypoints[0].heading = yawFromDirection(
                next.x - polyline[clearIndex].x,
                next.z - polyline[clearIndex].z,
            );
            verified = await verifyDraft(storage, scenario);
        }
        scenario.routes[0].waypoints = verified.waypoints;
        scenario.routes[0].verification = verified.verification;
        const start = verified.verification.polyline[0];
        const second = verified.verification.polyline[1];
        const yaw = yawFromDirection(second.x - start.x, second.z - start.z);
        const storedScenario = await storage.createScenario(scenario);
        const manifest = applyVehiclePluginSelection(stateSensorManifest(source, {
            environmentId: selectedEnvironmentId,
            storedScenario,
            bundleId,
            sensors,
            maxSteps,
            vehicleType: selectedVehicleId,
        }), vehicle);
        applyStartPose(manifest, start, yaw);
        const created = await storage.createRunManifest(manifest);
        const validation = await storage.validateRunManifest(created.id);
        if (!validation.ok) {
            const message = validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
            throw new Error(message || "Run manifest validation failed.");
        }
        return await storage.exportRunManifest(created.id);
    } finally {
        await fs.rm(ownedRoot, { recursive: true, force: true });
    }
}

export function routeHeadingChange(polyline) {
    if (!Array.isArray(polyline) || polyline.length < 3) return 0;
    const first = yawFromDirection(polyline[1].x - polyline[0].x, polyline[1].z - polyline[0].z);
    const lastIndex = polyline.length - 1;
    const last = yawFromDirection(
        polyline[lastIndex].x - polyline[lastIndex - 1].x,
        polyline[lastIndex].z - polyline[lastIndex - 1].z,
    );
    return Math.atan2(Math.sin(last - first), Math.cos(last - first));
}
