import { canonicalStringify } from "./canonicalJson.js";
import { assertProtobufName, protobufFingerprint, PROTOBUF_LIMITS } from "../interfaces/ProtobufSchema.js";

const scalar = (type) => ({ type });
const record = (fields, optional = []) => ({ fields, optional });
const array = (item, length = null) => ({ item, length });
const vector = record({ x: scalar("double"), y: scalar("double"), z: scalar("double") });
const quaternion = record({ x: scalar("double"), y: scalar("double"), z: scalar("double"), w: scalar("double") });
const pose = record({ position: vector, orientation: quaternion });
const covariance = array(scalar("double"));
const covariance9 = array(scalar("double"), 9);
const detectionFields = { id: scalar("string"), classId: scalar("string"), score: scalar("double"), visibility: scalar("double"), occlusion: scalar("double") };
const vector2 = record({ x: scalar("double"), y: scalar("double") });
const shapes = {
    "cev.imu": record({ angularVelocity: vector, linearAcceleration: vector, orientation: quaternion,
        orientationAvailable: scalar("bool"), orientationCovariance: covariance9,
        angularVelocityCovariance: covariance9, linearAccelerationCovariance: covariance9 }, ["orientation"]),
    "cev.gnss": record({ valid: scalar("bool"), latitude: scalar("double"), longitude: scalar("double"),
        altitude: scalar("double"), status: scalar("int32"), service: scalar("uint32"), covariance: covariance9,
        covarianceType: scalar("uint32") }),
    "cev.odometry": record({ pose, linearVelocity: vector, angularVelocity: vector,
        poseCovariance: array(scalar("double"), 36), twistCovariance: array(scalar("double"), 36), childFrameId: scalar("string") }),
    "cev.points": record({ positions: array(scalar("float")), intensities: array(scalar("float")), count: scalar("uint32") }),
    "cev.semantic-points": record({ positions: array(scalar("float")), intensities: array(scalar("float")),
        count: scalar("uint32"), instanceIds: array(scalar("uint32")), semanticIds: array(scalar("uint32")), rayIndices: array(scalar("uint32")) }),
    "cev.image": record({ data: scalar("bytes"), width: scalar("uint32"), height: scalar("uint32"),
        pixelFormat: scalar("string"), strideBytes: scalar("uint32") }),
    "cev.camera-info": record({ width: scalar("uint32"), height: scalar("uint32"), distortionModel: scalar("string"),
        distortion: covariance, intrinsic: array(scalar("double"), 9), rectification: array(scalar("double"), 9), projection: array(scalar("double"), 12) }),
    "cev.detections-2d": record({ detections: array(record({ ...detectionFields, center: vector2, size: vector2 })) }),
    "cev.detections-3d": record({ detections: array(record({ ...detectionFields, pose, size: vector })) }),
    "cev.lanes": record({ lanes: array(record({ id: scalar("string"), points: array(vector) })) }),
    "cev.traffic-controls": record({ controls: array(record({ id: scalar("string"), classId: scalar("string"),
        kind: scalar("string"), state: scalar("string"), position: vector, visibility: scalar("double"), occlusion: scalar("double") })) }),
    "cev.transforms": record({ transforms: array(record({ parentFrameId: scalar("string"), childFrameId: scalar("string"), pose })) }),
    "cev.clock": record({ timeNs: scalar("timeNs") }),
    "cev.goal": record({ pose }),
    "cev.diagnostics": record({ entries: array(record({ name: scalar("string"), level: scalar("uint32"), message: scalar("string"), values: array(record({ key: scalar("string"), value: scalar("string") })) })) }),
    "cev.control-command": record({ runId: scalar("string"), mode: scalar("string"), sequence: scalar("uint64"),
        captureTimeNs: scalar("timeNs"), deadlineNs: scalar("timeNs"), frameId: scalar("string"), speedMps: scalar("double"),
        accelerationMps2: scalar("double"), jerkMps3: scalar("double"), steeringRad: scalar("double"), steeringRateRadps: scalar("double") }),
    "cev.scalar-f64": scalar("double"), "cev.scalar-i32": scalar("int32"), "cev.scalar-u32": scalar("uint32"),
    "cev.boolean": scalar("bool"), "cev.text": scalar("string"), "cev.vector3": vector, "cev.bytes": scalar("bytes"),
};

export const NATIVE_SENSOR_OUTPUT_CONTRACTS = Object.freeze({ imuTopicId: "cev.imu", gnssTopicId: "cev.gnss", odometryTopicId: "cev.odometry",
    pointCloudTopicId: "cev.points", semanticPointCloudTopicId: "cev.semantic-points", imageTopicId: "cev.image",
    depthTopicId: "cev.image", semanticTopicId: "cev.image", instanceTopicId: "cev.image", cameraInfoTopicId: "cev.camera-info",
    detections2dTopicId: "cev.detections-2d", detections3dTopicId: "cev.detections-3d", lanesTopicId: "cev.lanes",
    trafficControlsTopicId: "cev.traffic-controls", diagnosticsTopicId: "cev.diagnostics" });

export function getNativeTopicContract(id, version = 1) {
    if (version !== 1 || !Object.hasOwn(shapes, id)) throw new Error(`Unavailable native topic contract ${id}@${version}.`);
    return { id, version, shape: structuredClone(shapes[id]) };
}

export function nativeShapeAt(shape, path, label = path) {
    for (const part of (path ? path.split(".") : [])) {
        assertProtobufName(part);
        if (!shape?.fields || !Object.hasOwn(shape.fields, part)) throw new Error(`${label}: unavailable field or collection descent.`);
        shape = shape.fields[part];
    }
    return shape;
}

export function assertNativeValue(shape, value, { partial = false, label = "value" } = {}) {
    let nodes = PROTOBUF_LIMITS.valueNodes;
    let bytes = 0;
    const walk = (shape, value, path, depth) => {
        if (--nodes < 0 || depth > PROTOBUF_LIMITS.depth) throw new Error(`${path}: value is too complex.`);
        const fail = () => { throw new Error(`${path}: invalid ${shape.type || "structured"} value.`); };
        if (shape.fields) {
            if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
            for (const key of Object.keys(value)) {
                if (!Object.hasOwn(shape.fields, key)) fail();
                walk(shape.fields[key], value[key], `${path}.${key}`, depth + 1);
            }
            if (!partial) for (const key of Object.keys(shape.fields)) if (!Object.hasOwn(value, key) && !shape.optional?.includes(key)) fail();
        } else if (shape.item) {
            if (!Array.isArray(value) && !(ArrayBuffer.isView(value) && !(value instanceof DataView))) fail();
            if (shape.length != null && value.length !== shape.length) fail();
            if (value.length > nodes || (Array.isArray(value) && Object.keys(value).length !== value.length)) fail();
            for (let index = 0; index < value.length; index++) walk(shape.item, value[index], `${path}.${index}`, depth + 1);
        } else if (shape.type === "bytes") {
            if (!(value instanceof Uint8Array)) fail();
            bytes += value.byteLength;
        } else if (shape.type === "string") {
            if (typeof value !== "string") fail();
            bytes += new TextEncoder().encode(value).length;
        } else if (shape.type === "bool") {
            if (typeof value !== "boolean") fail();
        } else if (shape.type === "uint64" || shape.type === "int64") {
            if (!(typeof value === "number" && Number.isSafeInteger(value)) && typeof value !== "bigint"
                && !(typeof value === "string" && /^(0|-?[1-9]\d*)$/.test(value))) fail();
            const n = BigInt(value);
            if (n < (shape.type === "uint64" ? 0n : -(1n << 63n)) || n >= (shape.type === "uint64" ? 1n << 64n : 1n << 63n)) fail();
        } else {
            if (!["double", "float", "timeNs", "uint32", "int32"].includes(shape.type)) fail();
            if (typeof value !== "number" || !Number.isFinite(value)) fail();
            if (shape.type === "float" && !Number.isFinite(Math.fround(value))) fail();
            if (shape.type === "timeNs" && (!Number.isSafeInteger(value) || value < 0)) fail();
            if (shape.type === "uint32" && (!Number.isInteger(value) || value < 0 || value >= 2 ** 32)) fail();
            if (shape.type === "int32" && (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31)) fail();
        }
        if (bytes > PROTOBUF_LIMITS.payloadBytes) throw new Error(`${path}: value bytes exceed the limit.`);
    };
    walk(shape, value, label, 0);
}

export function validateNativeTopicValue(contract, value) {
    try {
        const { id, shape } = typeof contract === "string" ? getNativeTopicContract(contract) : getNativeTopicContract(contract.id, contract.version);
        assertNativeValue(shape, value);
        const quaternionValid = (q) => q && Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) <= 1e-6;
        const poses = id === "cev.odometry" || id === "cev.goal" ? [value.pose]
            : id === "cev.transforms" ? value.transforms.map((item) => item.pose)
                : id === "cev.detections-3d" ? value.detections.map((item) => item.pose) : [];
        if (poses.some((pose) => !quaternionValid(pose.orientation))) throw new Error("Pose requires a unit quaternion.");
        if (id === "cev.imu" && value.orientationAvailable && !quaternionValid(value.orientation)) throw new Error("Available IMU orientation requires a unit quaternion.");
        if (id === "cev.control-command" && (typeof value.sequence !== "string" || !["velocity", "acceleration", "stop"].includes(value.mode)
            || !value.runId || !value.frameId || (value.deadlineNs > 0 && value.deadlineNs < value.captureTimeNs))) throw new Error("Invalid native command identity, mode, or deadline.");
        if (id === "cev.points" || id === "cev.semantic-points") {
            if (value.positions.length !== value.count * 3 || value.intensities.length !== value.count
                || (id === "cev.semantic-points" && [value.instanceIds, value.semanticIds, value.rayIndices].some((a) => a.length !== value.count))) throw new Error("Point product lengths do not match count.");
        }
        if (id === "cev.image") {
            const bytesPerPixel = { rgba8: 4, "depth-f32-le": 4, "semantic-u16-le": 2, "instance-u32-le": 4 }[value.pixelFormat];
            if (!bytesPerPixel || !value.width || !value.height || value.strideBytes * value.height !== value.data.byteLength || value.strideBytes < value.width * bytesPerPixel) throw new Error("Image layout does not match bytes.");
        }
        return { ok: true };
    } catch (error) { return { ok: false, code: "native-value-invalid", message: error.message }; }
}

export function normalizeNativeTopic(topic) {
    if (!topic || topic.type !== undefined || topic.schema !== undefined) throw new Error("Native topics require valueContract, without legacy type/schema fields.");
    if (topic.valueContract?.version !== 1 || Object.keys(topic.valueContract).some((key) => !["id", "version"].includes(key))) throw new Error("Native topics require an exact id/version contract reference.");
    if (typeof topic.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(topic.id)
        || typeof topic.name !== "string" || !topic.name || !["input", "output"].includes(topic.direction)) throw new Error("Native topics require an id, name and input/output direction.");
    if (!["simulator", "oracle", "candidate", "reference", "replay", "bypass"].includes(topic.producer)) throw new Error("Native topic producer is unavailable.");
    if (topic.authority !== undefined && !["candidate", "reference", "oracle", "replay", "bypass"].includes(topic.authority)) throw new Error("Native topic authority is unavailable.");
    if (topic.routeDownstream !== undefined && typeof topic.routeDownstream !== "boolean") throw new Error("Native topic downstream selection must be boolean.");
    for (const key of ["timeoutNs", "validityNs"]) if (topic[key] != null && (!Number.isSafeInteger(topic[key]) || topic[key] < 0)) throw new Error("Native topic time windows require integer nanoseconds.");
    getNativeTopicContract(topic.valueContract?.id, topic.valueContract?.version);
    return structuredClone(topic);
}

export function createNativeTopicContractResource(topics) {
    const contracts = [...new Map(topics.map((topic) => {
        const contract = getNativeTopicContract(topic.valueContract?.id, topic.valueContract?.version);
        return [contract.id, contract];
    })).values()].sort((a, b) => a.id.localeCompare(b.id));
    const document = { kind: "cev-sim.native-topic-contracts", version: 1, contracts };
    return { document, hash: protobufFingerprint(new TextEncoder().encode(canonicalStringify(document))) };
}

export function assertNativeTopicContractResource(resource, topics) {
    const expected = createNativeTopicContractResource(topics);
    if (!resource || resource.hash !== expected.hash || canonicalStringify(resource.document) !== canonicalStringify(expected.document)) throw new Error("Native topic contract resource does not match the run.");
    return expected;
}
