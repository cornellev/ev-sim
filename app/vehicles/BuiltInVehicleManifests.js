import { BUILT_IN_VEHICLE_TYPES, normalizeVehicleManifest } from "./VehicleManifest.js";

const INCH = 0.0254;

/** Public shell model used by BigCar, with placement that matches its runtime load path. */
const BIG_CAR_MODEL = Object.freeze({
    asset: "/shell/shell.gltf",
    // BigCar applies 0.0015 then a fit-scale (~0.582) so the footprint matches 106" × 49".
    scale: 0.000873,
    rotation: { x: -Math.PI / 2, y: 0, z: Math.PI, order: "XYZ" },
    offset: { x: 0, y: 0, z: 0 },
});

const definitions = {
    "big-car": {
        id: "big-car",
        name: "Big Car",
        description: "Built-in BigCar runtime projection. Duplicate it to create an editable manifest vehicle.",
        model: { ...BIG_CAR_MODEL },
        boundingBox: {
            size: { x: 106 * INCH, y: 1.4, z: 49 * INCH },
            center: { x: 0, y: 0.7, z: 0 },
        },
        egoCenter: { x: 0, y: 0.7, z: 0 },
        wheels: [
            { id: "front-left", position: { x: 0.75, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "front-right", position: { x: 0.75, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: true },
            { id: "rear-left", position: { x: -0.75, y: 0.25, z: 0.55 }, radius: 0.25, width: 0.15, steerable: false },
            { id: "rear-right", position: { x: -0.75, y: 0.25, z: -0.55 }, radius: 0.25, width: 0.15, steerable: false },
        ],
        kinematics: {
            wheelbase: 49 * INCH,
            maxSteeringAngle: Math.PI * 0.49,
            maxSpeed: 20,
            maxAcceleration: 3.5,
            maxDeceleration: 6,
            maxJerk: 12,
            maxSteeringRate: 1.5,
            responseDelayNs: 0,
        },
        sensors: [
            {
                id: "roof-lidar",
                type: "lidar3d",
                pose: { position: { x: 0.35, y: 0.8, z: 0 }, rotation: {} },
                config: {},
            },
            {
                id: "front-stereo-camera",
                type: "camera",
                pose: { position: { x: 1.5, y: 0.5, z: 0 }, rotation: {} },
                config: { range: 20, thetaStep: 2, phiStep: 1, width: 320, height: 180, fov: 75, near: 0.1, far: 200 },
            },
        ],
        lidarZone: {},
    },
    "igvc-car": {
        id: "igvc-car",
        name: "IGVC Car",
        description: "Built-in IGVCCar runtime projection. Duplicate it to create an editable manifest vehicle.",
        model: { asset: null, scale: 1, rotation: {}, offset: {} },
        boundingBox: {
            size: { x: 38.933 * INCH, y: 18 * INCH, z: 26.94 * INCH },
            center: { x: 0, y: 9 * INCH, z: 0 },
        },
        egoCenter: { x: 0, y: 9 * INCH, z: 0 },
        wheels: [],
        kinematics: {
            wheelbase: 1.5,
            maxSteeringAngle: 0.6,
            maxSpeed: 8,
            maxAcceleration: 2.5,
            maxDeceleration: 4,
            maxJerk: 8,
            maxSteeringRate: 1.0,
            responseDelayNs: 0,
        },
        sensors: [
            {
                id: "roof-lidar",
                type: "lidar3d",
                pose: { position: { x: 0, y: 1, z: 0 }, rotation: {} },
                config: { range: 20, thetaStep: 2, thetaRange: [0, 360], phiStep: 0.5, phiRange: [-20, 20] },
            },
        ],
        lidarZone: {},
    },
    "scenario-car": {
        id: "scenario-car",
        name: "Scenario Car",
        description: "Built-in procedural ScenarioCar projection. Timeline keyframes remain a run-manifest concern.",
        model: { asset: null, scale: 1, rotation: {}, offset: {} },
        boundingBox: {
            size: { x: 4.5, y: 1.5, z: 2 },
            center: { x: 0, y: 0.75, z: 0 },
        },
        egoCenter: { x: 0, y: 0.75, z: 0 },
        wheels: [
            { id: "front-left", position: { x: 1.26, y: 0.24, z: 0.96 }, radius: 0.24, width: 0.24, steerable: false },
            { id: "front-right", position: { x: 1.26, y: 0.24, z: -0.96 }, radius: 0.24, width: 0.24, steerable: false },
            { id: "rear-left", position: { x: -1.26, y: 0.24, z: 0.96 }, radius: 0.24, width: 0.24, steerable: false },
            { id: "rear-right", position: { x: -1.26, y: 0.24, z: -0.96 }, radius: 0.24, width: 0.24, steerable: false },
        ],
        kinematics: {
            wheelbase: 2.52,
            maxSteeringAngle: 0.6,
            maxSpeed: 25,
            maxAcceleration: 4,
            maxDeceleration: 7,
            maxJerk: 15,
            maxSteeringRate: 1.8,
            responseDelayNs: 0,
        },
        sensors: [],
        lidarZone: {},
    },
};

const manifests = Object.fromEntries(BUILT_IN_VEHICLE_TYPES.map((id) => [
    id,
    normalizeVehicleManifest(definitions[id], { allowMissingKind: true }),
]));

export function isBuiltInVehicleManifest(id) {
    return Object.hasOwn(manifests, id);
}

export function getBuiltInVehicleManifest(id) {
    const manifest = manifests[id];
    return manifest ? structuredClone(manifest) : null;
}

export function listBuiltInVehicleManifests() {
    return BUILT_IN_VEHICLE_TYPES.map((id) => {
        const manifest = manifests[id];
        return {
            id,
            name: manifest.name,
            description: manifest.description,
            revision: null,
            definitionHash: null,
            modelAsset: manifest.model.asset,
            builtIn: true,
        };
    });
}
