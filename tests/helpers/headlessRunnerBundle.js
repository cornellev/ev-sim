import { buildCalibrationBundle } from "../../app/autonomy/CalibrationBundle.js";
import { createBindingManifest } from "../../app/scripting/bindings/BindingDocument.js";
import { verifyRoute } from "../../app/scenarios/route/Route.js";
import {
    RUN_BUNDLE_KIND,
    RUN_BUNDLE_VERSION,
    computeResolvedRunHash,
    normalizeRunManifest,
} from "../../app/simulation/RunManifest.js";
import { WORLD_BOUND_PLUGINS_IDENTITY } from "../../app/simulation/kernel/RunIdentity.js";
import { createPluginPackage, verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { createPluginSensorsResource } from "../../app/plugin/PluginSensorIdentity.js";
import { pluginDependencyHashes } from "../../app/plugin/PluginSelection.js";
import { computeSimulationSemanticHash } from "../../app/simulation/kernel/SimulationHashes.js";
import { createLidarGeometryResource } from "../../app/simulation/lidar/LidarGeometry.js";
import {
    CPU_LIDAR_BACKEND_KIND,
    createCpuLidarBackendSelection,
} from "../../app/simulation/sensors/CpuLidarBackend.js";
import { planSensorAdmission } from "../../app/simulation/sensors/SensorAdmission.js";
import { createSensorDefinitionRegistry } from "../../app/simulation/sensors/SensorTypeRegistry.js";
import { createPhysicsBackendSelection, PHYSICS_BACKEND_KIND, sortBackendSelections } from "../../app/physics/PhysicsBackend.js";
import { createRenderSceneResource } from "../../app/simulation/render/RenderScene.js";
import { resolveEnabledCameraRenderSelection } from "../../app/simulation/render/RenderSceneProviderRegistry.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";
import { StorageService } from "../../server/storage/StorageService.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const worldBoundFixtureUrl = new URL("../fixtures/visual-layer/world-bound-state.v11.json", import.meta.url);
const pluginSensorFixtureUrl = new URL("../fixtures/plugins/test.range-image-fixture/", import.meta.url);

export async function pluginSensorFixtureResource() {
    const [document, runtime] = await Promise.all([
        fs.readFile(new URL("plugin.json", pluginSensorFixtureUrl), "utf8"),
        fs.readFile(new URL("runtime/index.js", pluginSensorFixtureUrl), "utf8"),
    ]);
    return createPluginPackage({
        "plugin.json": document,
        "runtime/index.js": runtime,
    });
}

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

export function createPluginRangeImageFixtureSensor(overrides = {}) {
    return {
        id: "fixture",
        type: "test.range-image-fixture.synthetic-3x4",
        enabled: true,
        parentId: "ego",
        pose: {
            position: { x: 0, y: 0, z: 0.5 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        },
        rateHz: 60,
        phaseNs: 0,
        calibration: {
            parameters: { measurementScale: 1, statusEvery: 2 },
            products: { points: true, packets: true },
        },
        outputs: { pointCloudTopicId: "front-lidar-points" },
        latency: { fixedNs: 0, jitterNs: 0 },
        noise: {
            model: "gaussian",
            bias: 0,
            standardDeviation: 0,
            dropoutProbability: 0,
            pointDropoutProbability: 0,
        },
        maxQueueFrames: 8,
        maxQueueBytes: 1024 * 1024,
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
    ) || Boolean(next.resolved.pluginSensors);
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
    sensorTransports = null,
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
    if (sensorTransports) resolved.manifest.sensorTransports = sensorTransports;
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

export async function createPluginPortableHeadlessBundle(resource, options = {}) {
    const verified = verifyPluginPackage(resource);
    const plugins = [{
        pluginId: verified.document.id,
        version: verified.document.version,
        packageHash: verified.resource.packageHash,
        runtimeHash: verified.resource.runtimeHash,
        capabilities: [...(verified.document.capabilities || [])],
    }];
    const bundle = await createPortableHeadlessBundle(options);
    const sensorRegistry = createSensorDefinitionRegistry([verified]);
    bundle.resolved.manifest = normalizeRunManifest({
        ...bundle.resolved.manifest,
        plugins: {
            enabled: true,
            artifacts: [{
                pluginId: verified.document.id,
                expectedHash: verified.resource.packageHash,
                capabilities: [...(verified.document.capabilities || [])],
            }],
        },
    }, { sensorRegistry });
    bundle.resolved.identityProfile = { ...WORLD_BOUND_PLUGINS_IDENTITY };
    bundle.resolved.plugins = plugins;
    bundle.resolved.pluginPackages = [structuredClone(resource)];
    bundle.resolved.dependencyHashes = {
        ...bundle.resolved.dependencyHashes,
        plugins: pluginDependencyHashes(plugins),
    };
    const requestsPluginSensor = bundle.resolved.manifest.sensorRig.sensors.some(
        (sensor) => sensor.enabled !== false && sensorRegistry.get(sensor.type)?.pluginSensor,
    );
    if (requestsPluginSensor) {
        bundle.resolved.backendSelections = sortBackendSelections([
            ...(bundle.resolved.backendSelections ?? [])
                .filter((entry) => Number(entry.kind) !== CPU_LIDAR_BACKEND_KIND),
            createCpuLidarBackendSelection({ version: 2 }),
        ]);
        const admission = planSensorAdmission({
            manifest: bundle.resolved.manifest,
            sensorRegistry,
            backendSelections: bundle.resolved.backendSelections,
        });
        bundle.resolved.pluginSensors = createPluginSensorsResource(admission);
        bundle.resolved.dependencyHashes.pluginSensors = bundle.resolved.pluginSensors.hash;
    }
    return rehashRunBundle(bundle);
}

export async function createPluginPcapHeadlessBundle(options = {}) {
    const resource = options.resource ?? await pluginSensorFixtureResource();
    return createPluginPortableHeadlessBundle(resource, {
        sensors: options.sensors ?? [createHeadlessImu(), createPluginRangeImageFixtureSensor()],
        sensorTransports: options.sensorTransports ?? {
            kind: "cev-sim.sensor-transports",
            version: 1,
            bindings: [
                {
                    sensorId: "fixture",
                    productId: "packets",
                    streamId: "data",
                    adapter: "pcap",
                    endpointId: "camera-data",
                },
                {
                    sensorId: "fixture",
                    productId: "packets",
                    streamId: "status",
                    adapter: "pcap",
                    endpointId: "camera-status",
                },
            ],
        },
        triggers: options.triggers ?? [{
            id: "finish",
            name: "Finish",
            enabled: true,
            once: true,
            condition: { kind: "step", step: 4 },
            actions: [{ kind: "finish" }],
        }],
        ...options.bundleOptions,
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
