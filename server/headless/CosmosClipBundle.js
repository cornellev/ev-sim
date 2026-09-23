import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EnvironmentDocument } from "../../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../../app/3d/editor/commands/EnvironmentCommandService.js";
import { topicFromContract } from "../../app/autonomy/AutonomyContractCatalog.js";
import { threeToRep103Vector } from "../../app/autonomy/CoordinateFrames.js";
import { createDefaultRunManifest } from "../../app/simulation/RunManifest.js";
import { createRunSensor } from "../../app/simulation/sensors/SensorTypeRegistry.js";
import { getBuiltInVehicleManifest } from "../../app/vehicles/BuiltInVehicleManifests.js";
import { StorageService } from "../storage/StorageService.js";

export const COSMOS_CLIP_ENVIRONMENT_ID = "corridor-acceptance";
export const COSMOS_CLIP_SCENARIO_ID = "cosmos-nano-corridor";
export const COSMOS_CLIP_MANIFEST_ID = "cosmos-nano-clip";
export const COSMOS_CLIP_CAMERA_ID = "front-camera";
export const COSMOS_CLIP_SEED = "42";
export const COSMOS_CLIP_STEP_NS = 11_111_111;
export const COSMOS_CLIP_MAX_STEPS = 363;
export const COSMOS_CLIP_FRAME_COUNT = 121;
export const COSMOS_CLIP_CAPTURE_INTERVAL_NS = 33_333_333;
export const COSMOS_CLIP_WIDTH = 1280;
export const COSMOS_CLIP_HEIGHT = 720;
export const COSMOS_CLIP_FOCAL_PX = 469.16113422283404;
export const COSMOS_CLIP_SPEED_MPS = 2;
export const COSMOS_CLIP_LEAD_GAP_M = 13;
export const COSMOS_CLIP_ROAD_LENGTH_M = 120;

const ZERO_AXIS = Object.freeze({ x: 0, y: 0, z: 0 });

export function cosmosClipVerticalFovDeg() {
    return (2 * Math.atan(COSMOS_CLIP_HEIGHT / (2 * COSMOS_CLIP_FOCAL_PX)) * 180) / Math.PI;
}

export function cosmosClipPolicyAction() {
    const maxSpeed = getBuiltInVehicleManifest("big-car")?.kinematics?.maxSpeed;
    if (!(maxSpeed > 0)) throw new Error("big-car maxSpeed is required to command the clip speed.");
    return [COSMOS_CLIP_SPEED_MPS / maxSpeed, 0];
}

function pointOnEdge(nodes, edge, fraction) {
    const start = nodes.get(edge.startNodeId);
    const end = nodes.get(edge.endNodeId);
    return {
        x: start.x + (end.x - start.x) * fraction,
        y: 0,
        z: start.z + (end.z - start.z) * fraction,
    };
}

function routeDraft({ id, name, actorId, edge, nodes, startFraction, finishFraction }) {
    const waypoint = (waypointId, kind, fraction) => ({
        id: waypointId,
        kind,
        position: pointOnEdge(nodes, edge, fraction),
        heading: 0,
        anchor: {
            kind: "road",
            id: edge.id,
            fraction,
            laneMode: "fixed",
            laneIndex: 0,
        },
    });
    return {
        id,
        name,
        actorId,
        initialSpeedMps: COSMOS_CLIP_SPEED_MPS,
        controller: { kind: "route-follower" },
        waypoints: [
            waypoint(`${id}-start`, "start", startFraction),
            waypoint(`${id}-finish`, "finish", finishFraction),
        ],
    };
}

function clipCamera() {
    return createRunSensor("camera", {
        id: COSMOS_CLIP_CAMERA_ID,
        parentId: "ego",
        mountFrameId: "front_camera_link",
        measurementFrameId: "front_camera_optical_frame",
        frameId: "front_camera_optical_frame",
        syncGroupId: "perception-primary",
        rateHz: 30,
        phaseNs: 0,
        latency: { fixedNs: 0, jitterNs: 0 },
        pose: {
            // Authored big-car mount is Three.js {x:1.5, y:0.5, z:0}. Manifest v11 stores REP-103.
            position: threeToRep103Vector({ x: 1.5, y: 0.5, z: 0 }),
            rotation: { x: 0, y: 0, z: 0 },
        },
        noise: { model: "none", standardDeviation: 0, bias: 0, dropoutProbability: 0 },
        outputs: {
            imageTopicId: "front-camera-image",
            cameraInfoTopicId: "front-camera-info",
            depthTopicId: "front-camera-depth",
        },
        calibration: {
            width: COSMOS_CLIP_WIDTH,
            height: COSMOS_CLIP_HEIGHT,
            verticalFovDeg: cosmosClipVerticalFovDeg(),
            near: 0.1,
            far: 200,
            distortionModel: "none",
            distortion: [],
            intrinsics: {
                fx: COSMOS_CLIP_FOCAL_PX,
                fy: COSMOS_CLIP_FOCAL_PX,
                cx: (COSMOS_CLIP_WIDTH - 1) / 2,
                cy: (COSMOS_CLIP_HEIGHT - 1) / 2,
            },
            products: {
                rgb: true,
                cameraInfo: true,
                depth: true,
                semantic: false,
                instance: false,
                detections2d: false,
                detections3d: false,
                lanes: false,
                trafficControls: false,
                diagnostics: false,
            },
        },
    });
}

function clipImu() {
    return createRunSensor("imu", {
        id: "imu",
        parentId: "ego",
        mountFrameId: "imu_link",
        measurementFrameId: "imu_link",
        frameId: "imu_link",
        syncGroupId: "localization-primary",
        outputs: { imuTopicId: "imu" },
        calibration: {
            angularVelocityStdDev: { ...ZERO_AXIS },
            linearAccelerationStdDev: { ...ZERO_AXIS },
            angularRandomWalk: { ...ZERO_AXIS },
            accelerationRandomWalk: { ...ZERO_AXIS },
            turnOnBias: {
                randomize: false,
                angular: { ...ZERO_AXIS },
                acceleration: { ...ZERO_AXIS },
            },
        },
    });
}

function clipTopics() {
    return [
        "clock",
        "tf",
        "tf-static",
        "controls-command",
        "front-camera-image",
        "front-camera-info",
        "front-camera-depth",
        "imu",
    ].map((contractId) => topicFromContract(contractId));
}

async function createCorridor(storage) {
    const document = new EnvironmentDocument({
        environmentId: COSMOS_CLIP_ENVIRONMENT_ID,
        roads: { nodes: [], edges: [] },
    });
    const commands = createEnvironmentCommandService({ document });
    commands.run("createRoad", {
        kind: "polyline",
        points: [
            { x: 0, y: 0, z: 0 },
            { x: COSMOS_CLIP_ROAD_LENGTH_M, y: 0, z: 0 },
        ],
    });
    await storage.createEnvironment({
        id: COSMOS_CLIP_ENVIRONMENT_ID,
        name: "Corridor Acceptance",
        templateId: "blank",
        initialManifest: { document: document.toManifest() },
    });
    return storage.getEnvironment(COSMOS_CLIP_ENVIRONMENT_ID, { full: true });
}

async function verifyClipRoute(storage, scenario, routeId) {
    const verified = await storage.verifyScenarioRoute(scenario.id, { scenario, routeId });
    if (!verified.ok) {
        throw new Error(`Could not verify ${routeId}: ${verified.issues?.[0]?.message || "unknown route error"}`);
    }
    const route = scenario.routes.find((entry) => entry.id === routeId);
    route.waypoints = verified.waypoints;
    route.verification = verified.verification;
}

export async function createCosmosClipBundle({
    storageFactory = (root) => new StorageService(root),
} = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-cosmos-clip-"));
    try {
        const storage = storageFactory(root);
        const environment = await createCorridor(storage);
        const edge = environment.document.roads.edges[0];
        if (!edge) throw new Error("corridor-acceptance has no road.");
        const nodes = new Map(environment.document.roads.nodes.map((node) => [node.id, node]));
        const leadFraction = COSMOS_CLIP_LEAD_GAP_M / COSMOS_CLIP_ROAD_LENGTH_M;
        const scenario = {
            kind: "cev-sim.scenario",
            version: 1,
            id: COSMOS_CLIP_SCENARIO_ID,
            name: "Cosmos Nano Corridor",
            description: "Straight corridor with a lead vehicle for a 121-frame analytic RGB/depth clip.",
            folderId: null,
            environment: { id: COSMOS_CLIP_ENVIRONMENT_ID, expectedHash: null },
            actors: [
                { id: "ego", name: "Ego", role: "ego", vehicleId: null, enabled: true },
                { id: "lead", name: "Lead", role: "actor", vehicleId: "big-car", enabled: true },
            ],
            routes: [
                routeDraft({
                    id: "ego-route",
                    name: "Ego route",
                    actorId: "ego",
                    edge,
                    nodes,
                    startFraction: 0.2,
                    finishFraction: 0.85,
                }),
                routeDraft({
                    id: "lead-route",
                    name: "Lead route",
                    actorId: "lead",
                    edge,
                    nodes,
                    startFraction: 0.2 + leadFraction,
                    finishFraction: 0.95,
                }),
            ],
            zones: [],
            triggers: [],
            completion: {
                conditions: [{
                    id: "clip-horizon",
                    name: "Clip horizon",
                    kind: "max-duration",
                    durationNs: 30_000_000_000,
                }],
            },
            expectedOutcomes: [],
            sensorAliases: [],
            parameters: [],
        };
        await verifyClipRoute(storage, scenario, "ego-route");
        await verifyClipRoute(storage, scenario, "lead-route");
        const egoStart = scenario.routes[0].waypoints[0].position;
        const leadStart = scenario.routes[1].waypoints[0].position;
        const gap = Math.hypot(leadStart.x - egoStart.x, leadStart.z - egoStart.z);
        if (gap < 12 || gap > 15) {
            throw new Error(`Lead vehicle gap ${gap} m is outside 12–15 m.`);
        }
        const storedScenario = await storage.createScenario(scenario);
        const manifest = createDefaultRunManifest({
            id: COSMOS_CLIP_MANIFEST_ID,
            name: "Cosmos Nano Clip",
            description: "Fixed-step analytic RGB and depth clip. Wall pacing is unbounded; the simulation clock is the 11111111 ns step.",
            seed: COSMOS_CLIP_SEED,
            scenario: {
                id: storedScenario.id,
                expectedHash: storedScenario.definitionHash,
                egoVehicleId: "big-car",
                sensorBindings: {},
                parameterValues: {},
            },
            environment: { id: COSMOS_CLIP_ENVIRONMENT_ID, expectedHash: null },
            clock: {
                stepNs: COSMOS_CLIP_STEP_NS,
                pacing: "unbounded",
                speed: 1,
                maxSteps: COSMOS_CLIP_MAX_STEPS,
                publishClock: true,
                modules: {
                    inputs: true,
                    scripting: true,
                    vehicles: true,
                    physics: true,
                    sensors: true,
                    assertions: true,
                },
            },
            initialState: {
                vehicles: [
                    { id: "ego", type: "big-car", pose: { position: egoStart, rotation: {} }, linearVelocity: { x: COSMOS_CLIP_SPEED_MPS, y: 0, z: 0 }, steeringAngle: 0 },
                    { id: "lead", type: "big-car", pose: { position: leadStart, rotation: {} }, linearVelocity: { x: COSMOS_CLIP_SPEED_MPS, y: 0, z: 0 }, steeringAngle: 0 },
                ],
                signals: {},
            },
            sensorRig: {
                mapFrameId: "map",
                odomFrameId: "odom",
                rootFrameId: "base_link",
                vehicleId: "ego",
                syncGroups: [
                    {
                        id: "perception-primary",
                        description: "Front camera RGB, CameraInfo, and oracle depth.",
                        topicIds: ["front-camera-image", "front-camera-info", "front-camera-depth"],
                    },
                    {
                        id: "localization-primary",
                        description: "Zero-noise IMU required for headless state-sensor admission.",
                        topicIds: ["imu"],
                    },
                ],
                sensors: [clipCamera(), clipImu()],
            },
            scripts: { enabled: false, artifacts: [], bindingIds: [], expectedBindingsHash: null, embeddedBindings: [] },
            topics: clipTopics(),
            controls: { authority: "candidate", targetVehicleId: "ego" },
            logging: { policy: "required", profileId: "simulation-run-full-sensors" },
        });
        await storage.createRunManifest(manifest);
        return storage.exportRunManifest(manifest.id);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
}
