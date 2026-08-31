import { normalizeAngle, vehicleForwardTangent } from "../../scenarios/route/geometry.js";
import { projectPoseToRoute, routeTangentAtPose } from "../../scenarios/route/Route.js";
import {
    boxSpace,
    dictionarySpace,
    hashSpace,
    namedTensor,
    tensorMap,
} from "./TensorProtocol.js";

const SENSOR_SHAPES = Object.freeze({
    imu: Object.freeze({ dtype: "float32", shape: [6] }),
    gnss: Object.freeze({ dtype: "float64", shape: [3] }),
    "wheel-odometry": Object.freeze({ dtype: "float32", shape: [13] }),
});

const FLOAT_BOUND = Number.MAX_VALUE;
const UINT64_BOUND = Number.MAX_SAFE_INTEGER;

export function metadataSpaces(prefix, validityShape = [1]) {
    return [
        { key: `${prefix}/validity`, space: boxSpace(`${prefix}/validity`, 1, "bool", validityShape, [0], [1]) },
        { key: `${prefix}/sequence`, space: boxSpace(`${prefix}/sequence`, 1, "uint64", [1], [0], [UINT64_BOUND]) },
        { key: `${prefix}/is_new`, space: boxSpace(`${prefix}/is_new`, 1, "bool", [1], [0], [1]) },
        { key: `${prefix}/age_steps`, space: boxSpace(`${prefix}/age_steps`, 1, "uint64", [1], [0], [UINT64_BOUND]) },
    ];
}

export function createMeasuredStateObservationSpace(sensorDescriptors = []) {
    const entries = [];
    for (const sensor of sensorDescriptors) {
        const layout = SENSOR_SHAPES[sensor.type];
        if (!layout) throw new TypeError(`Unsupported measured-state sensor type ${sensor.type}.`);
        const prefix = `sensors/${sensor.id}`;
        entries.push({
            key: `${prefix}/value`,
            space: boxSpace(`${prefix}/value`, 1, layout.dtype, layout.shape, [-FLOAT_BOUND], [FLOAT_BOUND]),
        });
        entries.push(...metadataSpaces(prefix));
    }
    entries.push({ key: "task/value", space: boxSpace("task/value", 1, "float32", [7], [-FLOAT_BOUND], [FLOAT_BOUND]) });
    entries.push(...metadataSpaces("task", [7]));
    return dictionarySpace("measured-state", 1, entries);
}

export function observationSpaceHash(sensorDescriptors) {
    return hashSpace(createMeasuredStateObservationSpace(sensorDescriptors));
}

export function resolveEgoRoute(resolvedRun) {
    const scenario = resolvedRun?.scenario?.scenario
        ?? (resolvedRun?.scenario?.kind === "cev-sim.scenario" ? resolvedRun.scenario : null);
    const ego = scenario?.actors?.find((actor) => actor.id === "ego" || actor.role === "ego") ?? scenario?.actors?.[0];
    const route = scenario?.routes?.find((entry) => entry.actorId === ego?.id)
        ?? scenario?.routes?.find((entry) => entry.actorId === "ego")
        ?? null;
    return route?.verification
        ? { ...route, ...route.verification, totalLength: route.totalLength ?? route.verification.totalLength }
        : route;
}

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function measureTaskSignals(route, vehicle, scenarioSnapshot = null) {
    const position = vehicle?.position;
    const projection = position && route ? projectPoseToRoute(route, position) : null;
    const tangentInfo = position && route ? routeTangentAtPose(route, position) : null;
    const totalLength = Math.max(0, finite(route?.totalLength));
    const distanceAlong = Math.max(0, Math.min(totalLength, finite(projection?.distanceAlong)));
    const metrics = scenarioSnapshot?.metrics ?? {};
    const metricProgress = Number(metrics["route-progress-ratio"]);
    const progress = Number.isFinite(metricProgress)
        ? Math.max(0, Math.min(1, metricProgress))
        : (scenarioSnapshot ? 0 : (totalLength > 0 && projection ? distanceAlong / totalLength : 0));
    let crossTrack = 0;
    let headingError = 0;
    if (projection && tangentInfo) {
        const errorX = finite(position.x) - finite(projection.point?.x ?? projection.x);
        const errorZ = finite(position.z) - finite(projection.point?.z ?? projection.z);
        crossTrack = tangentInfo.tangent.x * errorZ - tangentInfo.tangent.z * errorX;
        const forward = vehicleForwardTangent(vehicle?.rotation?.y);
        const dot = forward.x * tangentInfo.tangent.x + forward.z * tangentInfo.tangent.z;
        const cross = forward.x * tangentInfo.tangent.z - forward.z * tangentInfo.tangent.x;
        headingError = normalizeAngle(Math.atan2(cross, dot));
    }
    const offRoad = typeof metrics["off-road"] === "number" ? metrics["off-road"] : Number.NaN;
    const wrongWay = typeof metrics["wrong-way"] === "number" ? metrics["wrong-way"] : Number.NaN;
    const routeValid = Boolean(projection && tangentInfo && totalLength > 0);
    return {
        value: [
            progress,
            1 - progress,
            crossTrack,
            headingError,
            Math.max(0, totalLength - distanceAlong),
            Number.isFinite(offRoad) ? offRoad : 0,
            Number.isFinite(wrongWay) ? wrongWay : 0,
        ],
        validity: [routeValid, routeValid, routeValid, routeValid, routeValid, Number.isFinite(offRoad), Number.isFinite(wrongWay)],
    };
}

export class MeasuredStateObservationBuilder {
    constructor(sensorManager, route, vehicleSource) {
        this.sensorManager = sensorManager;
        this.route = route;
        this.vehicleSource = vehicleSource;
        this.lastGenerations = new Map();
        this.taskSequence = 0;
    }

    reset() {
        this.lastGenerations.clear();
        this.taskSequence = 0;
    }

    build({ step = 0, policyStep = 0, scenario = null } = {}) {
        const entries = [];
        for (const record of this.sensorManager.getObservationRecords(step)) {
            const prefix = `sensors/${record.id}`;
            const sample = record.sample;
            const generation = sample?.generation ?? 0;
            const isNew = Boolean(sample && generation !== (this.lastGenerations.get(record.id) ?? 0));
            if (sample) this.lastGenerations.set(record.id, generation);
            const zeros = new Array(record.shape.reduce((total, value) => total * value, 1)).fill(0);
            entries.push(namedTensor(`${prefix}/value`, record.dtype, record.shape, sample?.value ?? zeros));
            entries.push(namedTensor(`${prefix}/validity`, "bool", [1], [sample?.validity === true]));
            entries.push(namedTensor(`${prefix}/sequence`, "uint64", [1], [BigInt(sample?.sequence ?? 0)]));
            entries.push(namedTensor(`${prefix}/is_new`, "bool", [1], [isNew]));
            entries.push(namedTensor(`${prefix}/age_steps`, "uint64", [1], [BigInt(record.ageSteps)]));
        }
        const vehicles = typeof this.vehicleSource === "function" ? this.vehicleSource() : this.vehicleSource;
        const vehicle = vehicles?.vehicles?.find((entry) => (entry.telemetryId || entry.id) === this.route?.actorId) ?? vehicles?.vehicles?.[0] ?? null;
        const task = measureTaskSignals(this.route, vehicle, scenario);
        this.taskSequence = policyStep;
        entries.push(namedTensor("task/value", "float32", [7], task.value));
        entries.push(namedTensor("task/validity", "bool", [7], task.validity));
        entries.push(namedTensor("task/sequence", "uint64", [1], [BigInt(this.taskSequence)]));
        entries.push(namedTensor("task/is_new", "bool", [1], [true]));
        entries.push(namedTensor("task/age_steps", "uint64", [1], [0n]));
        return tensorMap(entries);
    }
}
