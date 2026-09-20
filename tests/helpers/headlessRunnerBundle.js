import { buildCalibrationBundle } from "../../app/autonomy/CalibrationBundle.js";
import { createBindingManifest } from "../../app/scripting/bindings/BindingDocument.js";
import { verifyRoute } from "../../app/scenarios/route/Route.js";
import {
    RUN_BUNDLE_KIND,
    RUN_BUNDLE_VERSION,
    computeResolvedRunHash,
} from "../../app/simulation/RunManifest.js";
import { computeSimulationSemanticHash } from "../../app/simulation/kernel/SimulationHashes.js";
import { createLidarGeometryResource } from "../../app/simulation/lidar/LidarGeometry.js";
import { createPhysicsBackendSelection, PHYSICS_BACKEND_KIND, sortBackendSelections } from "../../app/physics/PhysicsBackend.js";
import { createRenderSceneResource } from "../../app/simulation/render/RenderScene.js";
import { resolveEnabledCameraRenderSelection } from "../../app/simulation/render/RenderSceneProviderRegistry.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import { StorageService } from "../../server/storage/StorageService.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const worldBoundFixtureUrl = new URL("../fixtures/visual-layer/world-bound-state.v11.json", import.meta.url);

async function resolveHermeticPortableBase() {
    const fixture = JSON.parse(await fs.readFile(worldBoundFixtureUrl, "utf8"));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-headless-bundle-"));
    try {
        await fs.mkdir(path.join(root, "environments"), { recursive: true });
        await fs.mkdir(path.join(root, "run-manifests"), { recursive: true });
        await fs.writeFile(
            path.join(root, "environments", "igvc.json"),
            JSON.stringify(fixture.resolved.environment.manifest),
        );
        await fs.writeFile(
            path.join(root, "run-manifests", "igvc-default.json"),
            JSON.stringify(fixture.manifest),
        );
        await fs.writeFile(
            path.join(root, "bindings.json"),
            JSON.stringify(createBindingManifest({
                bindings: fixture.resolved.bindings.entries,
                updatedAt: "2026-08-30T00:00:00.000Z",
            })),
        );
        return await new StorageService(root).resolveRunManifest("igvc-default");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}

export function createHeadlessImu(overrides = {}) {
    return {
        id: "imu",
        type: "imu",
        enabled: true,
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        rateHz: 60,
        phaseNs: 0,
        calibration: {
            gravity: 9.80665,
            noise: {},
            angularVelocityStdDev: { x: 0, y: 0, z: 0 },
            linearAccelerationStdDev: { x: 0, y: 0, z: 0 },
            angularRandomWalk: { x: 0, y: 0, z: 0 },
            accelerationRandomWalk: { x: 0, y: 0, z: 0 },
            turnOnBias: { randomize: false, angular: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 } },
        },
        latency: { fixedNs: 0, jitterNs: 0 },
        noise: { dropoutProbability: 0 },
        maxQueueFrames: 8,
        ...overrides,
    };
}

export function rehashRunBundle(bundle) {
    const next = structuredClone(bundle);
    next.resolved.backendSelections = sortBackendSelections([
        ...(next.resolved.backendSelections ?? []).filter((entry) => Number(entry.kind) !== PHYSICS_BACKEND_KIND),
        createPhysicsBackendSelection(next.resolved.world),
    ]);
    const requestsLidar = next.resolved.manifest.sensorRig.sensors.some(
        (sensor) => sensor.enabled !== false && sensor.type === "lidar3d",
    );
    if (requestsLidar) {
        next.resolved.lidarGeometry = createLidarGeometryResource(next.resolved.world, next.resolved.vehicles);
        next.resolved.dependencyHashes.lidarGeometry = next.resolved.lidarGeometry.hash;
    } else {
        delete next.resolved.lidarGeometry;
        delete next.resolved.dependencyHashes.lidarGeometry;
    }
    const requestsCamera = next.resolved.manifest.sensorRig.sensors.some(
        (sensor) => sensor.enabled !== false && sensor.type === "camera",
    );
    if (requestsCamera) {
        const selection = resolveEnabledCameraRenderSelection(
            next.resolved.manifest.sensorRig.sensors,
            { requireAvailable: true },
        );
        next.resolved.renderScene = createRenderSceneResource(
            next.resolved.world,
            next.resolved.vehicles,
            selection,
        );
        next.resolved.dependencyHashes.renderScene = next.resolved.renderScene.hash;
    } else {
        delete next.resolved.renderScene;
        delete next.resolved.dependencyHashes.renderScene;
    }
    next.resolved.definitionHash = computeResolvedRunHash(next.resolved.manifest);
    next.resolved.calibration = buildCalibrationBundle(next.resolved.manifest);
    next.resolved.dependencyHashes.calibration = next.resolved.calibration.hash;
    next.resolved.simulationSemanticHash = computeSimulationSemanticHash(next.resolved);
    next.resolved.resolvedHash = computeResolvedRunHash(next.resolved);
    next.manifest = structuredClone(next.resolved.manifest);
    next.resolvedHash = next.resolved.resolvedHash;
    next.simulationSemanticHash = next.resolved.simulationSemanticHash;
    return next;
}

export async function createPortableHeadlessBundle({
    sensors = [createHeadlessImu()],
    assertions = [],
    triggers = [{
        id: "finish",
        name: "Finish",
        enabled: true,
        once: true,
        condition: { kind: "step", step: 2 },
        actions: [{ kind: "finish" }],
    }],
    completion = { conditions: [] },
    environment = null,
} = {}) {
    const resolved = await resolveHermeticPortableBase();
    if (environment) {
        const source = environment.document ? structuredClone(environment) : {
            environmentId: String(environment.environmentId),
            templateId: "blank",
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: true,
            document: {
                ...structuredClone(environment),
                roadsAuthored: true,
                buildings: structuredClone(environment.buildings ?? []),
                features: structuredClone(environment.features ?? []),
            },
        };
        const environmentHash = computeResolvedRunHash(source);
        resolved.manifest.environment = { id: source.environmentId, expectedHash: environmentHash };
        resolved.environment = { hash: environmentHash, manifest: source };
        resolved.world = createWorldResource(source);
        resolved.dependencyHashes.environment = environmentHash;
        resolved.dependencyHashes.world = resolved.world.hash;
    }
    resolved.manifest.sensorRig.sensors = sensors;
    resolved.manifest.sensorRig.syncGroups = [];
    resolved.manifest.clock.modules.physics = true;
    resolved.manifest.clock.modules.sensors = true;
    resolved.manifest.clock.maxSteps = null;
    resolved.manifest.controls.authority = "candidate";
    resolved.manifest.assertions = assertions;
    const initial = resolved.manifest.initialState.vehicles.find((entry) => entry.id === "ego")
        ?? resolved.manifest.initialState.vehicles[0];
    const roads = resolved.environment.manifest.document.roads;
    const edge = roads.edges[0];
    const nodes = new Map(roads.nodes.map((node) => [node.id, node]));
    const start = nodes.get(edge.startNodeId);
    const finish = nodes.get(edge.endNodeId);
    if (environment) initial.pose.position = { x: start.x, y: start.y ?? 0, z: start.z };
    const verified = verifyRoute(resolved.environment.manifest, {
        id: "ego-route",
        actorId: initial.id,
        waypoints: [
            { id: "start", position: { x: start.x, y: 0, z: start.z } },
            { id: "finish", position: { x: finish.x, y: 0, z: finish.z } },
        ],
    });
    if (!verified.ok) throw new Error("Could not build the headless test route.");
    resolved.scenario = {
        scenario: {
            kind: "cev-sim.scenario",
            version: 1,
            id: "headless-runner-test",
            actors: [{ id: initial.id, role: "ego", name: "Ego" }],
            routes: [{
                id: "ego-route",
                actorId: initial.id,
                waypoints: verified.waypoints,
                verification: verified.verification,
            }],
            zones: [],
            triggers,
            completion,
            expectedOutcomes: [],
        },
    };
    return rehashRunBundle({
        kind: RUN_BUNDLE_KIND,
        version: RUN_BUNDLE_VERSION,
        exportedAt: "2026-08-30T00:00:00.000Z",
        manifest: resolved.manifest,
        resolved,
        resolvedHash: resolved.resolvedHash,
        simulationSemanticHash: resolved.simulationSemanticHash,
    });
}

export function successfulTape(overrides = {}) {
    return {
        kind: "cev-sim.headless.policy-action-tape",
        version: 1,
        episodeSpec: { actionRepeat: 5, ...overrides },
        actions: [{ policyStep: 1, action: [0, 0] }],
        expect: {},
    };
}
