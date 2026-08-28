import { createHash } from "node:crypto";

export const AUTONOMY_CATALOG_KIND = "cev-sim.autonomy-contract-catalog";
export const AUTONOMY_CATALOG_VERSION = 3;

export const PRODUCER_NAMESPACES = Object.freeze([
    "simulator",
    "candidate",
    "reference",
    "oracle",
    "replay",
    "bypass",
]);

export const AUTHORITY_MODES = Object.freeze([
    "candidate",
    "reference",
    "oracle",
    "replay",
    "bypass",
]);

export const CONTRACT_STAGES = Object.freeze([
    "platform",
    "perception",
    "localization",
    "controls",
]);

export const IMPLEMENTATION_MODES = Object.freeze(["live", "catalog-only", "stub"]);

/** Canonical ROS .msg text keyed by package/Message. Single source of truth for resolve + client sync. */
export const ROS_SCHEMA_DEFINITIONS = Object.freeze({
    "builtin_interfaces/Time": "int32 sec\nuint32 nanosec\n",
    "std_msgs/Header": "builtin_interfaces/Time stamp\nstring frame_id\n",
    "geometry_msgs/Point32": "float32 x\nfloat32 y\nfloat32 z\n",
    "geometry_msgs/Point": "float64 x\nfloat64 y\nfloat64 z\n",
    "geometry_msgs/Quaternion": "float64 x\nfloat64 y\nfloat64 z\nfloat64 w\n",
    "geometry_msgs/Vector3": "float64 x\nfloat64 y\nfloat64 z\n",
    "geometry_msgs/Pose": "geometry_msgs/Point position\ngeometry_msgs/Quaternion orientation\n",
    "geometry_msgs/PoseWithCovariance": "geometry_msgs/Pose pose\nfloat64[36] covariance\n",
    "geometry_msgs/Twist": "geometry_msgs/Vector3 linear\ngeometry_msgs/Vector3 angular\n",
    "geometry_msgs/TwistWithCovariance": "geometry_msgs/Twist twist\nfloat64[36] covariance\n",
    "geometry_msgs/Transform": "geometry_msgs/Vector3 translation\ngeometry_msgs/Quaternion rotation\n",
    "geometry_msgs/TransformStamped": "std_msgs/Header header\nstring child_frame_id\ngeometry_msgs/Transform transform\n",
    "sensor_msgs/Image": "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n",
    "sensor_msgs/CameraInfo": "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\nuint32 binning_y\n",
    "sensor_msgs/PointField": "uint8 INT8=1\nuint8 UINT8=2\nuint8 INT16=3\nuint8 UINT16=4\nuint8 INT32=5\nuint8 UINT32=6\nuint8 FLOAT32=7\nuint8 FLOAT64=8\nstring name\nuint32 offset\nuint8 datatype\nuint32 count\n",
    "sensor_msgs/PointCloud2": "std_msgs/Header header\nuint32 height\nuint32 width\nsensor_msgs/PointField[] fields\nbool is_bigendian\nuint32 point_step\nuint32 row_step\nuint8[] data\nbool is_dense\n",
    "sensor_msgs/Imu": "std_msgs/Header header\ngeometry_msgs/Quaternion orientation\nfloat64[9] orientation_covariance\ngeometry_msgs/Vector3 angular_velocity\nfloat64[9] angular_velocity_covariance\ngeometry_msgs/Vector3 linear_acceleration\nfloat64[9] linear_acceleration_covariance\n",
    "sensor_msgs/NavSatFix": "std_msgs/Header header\nsensor_msgs/NavSatStatus status\nfloat64 latitude\nfloat64 longitude\nfloat64 altitude\nfloat64[9] position_covariance\nuint8 COVARIANCE_TYPE_UNKNOWN=0\nuint8 COVARIANCE_TYPE_APPROXIMATED=1\nuint8 COVARIANCE_TYPE_DIAGONAL_KNOWN=2\nuint8 COVARIANCE_TYPE_KNOWN=3\nuint8 position_covariance_type\n",
    "sensor_msgs/NavSatStatus": "int8 STATUS_NO_FIX=-1\nint8 STATUS_FIX=0\nint8 STATUS_SBAS_FIX=1\nint8 STATUS_GBAS_FIX=2\nuint16 SERVICE_GPS=1\nuint16 SERVICE_GLONASS=2\nuint16 SERVICE_COMPASS=4\nuint16 SERVICE_GALILEO=8\nint8 status\nuint16 service\n",
    "nav_msgs/Odometry": "std_msgs/Header header\nstring child_frame_id\ngeometry_msgs/PoseWithCovariance pose\ngeometry_msgs/TwistWithCovariance twist\n",
    "tf2_msgs/TFMessage": "geometry_msgs/TransformStamped[] transforms\n",
    "rosgraph_msgs/Clock": "builtin_interfaces/Time clock\n",
    "sensor_fusion_msgs/AckermannDrive": "float32 steering_angle\nfloat32 steering_angle_velocity\nfloat32 speed\nfloat32 acceleration\nfloat32 jerk\n",
    "sensor_fusion_msgs/StampedAckermannDrive": "std_msgs/Header header\nuint32 sequence\nstring mode\nfloat64 deadline_ns\nfloat64 steering_angle\nfloat64 steering_angle_velocity\nfloat64 speed\nfloat64 acceleration\nfloat64 jerk\n",
    "sensor_fusion_msgs/Box": "int32 id\ngeometry_msgs/Point32 center\ngeometry_msgs/Point32 size\ngeometry_msgs/Point32 rotation\n",
    "sensor_fusion_msgs/Boxes": "sensor_fusion_msgs/Box[] boxes\n",
    "sensor_fusion_msgs/LaneBounds": "geometry_msgs/Point32[] points\n",
    "sensor_fusion_msgs/Lanes": "sensor_fusion_msgs/LaneBounds[] lanes\n",
    "sensor_fusion_msgs/CarPosition": "geometry_msgs/Point32 position\ngeometry_msgs/Point32 rotation\n",
});

const CONTRACT_DEFINITIONS = Object.freeze([
    {
        id: "clock",
        stage: "platform",
        direction: "output",
        defaultName: "/clock",
        schema: { type: "rosgraph_msgs/Clock", version: 1 },
        required: true,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
    },
    {
        id: "tf",
        stage: "platform",
        direction: "output",
        defaultName: "/tf",
        schema: { type: "tf2_msgs/TFMessage", version: 1 },
        required: false,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
        framePolicy: "map→odom→base_link→sensor",
        timestampPolicy: "capture",
    },
    {
        id: "tf-static",
        stage: "platform",
        direction: "output",
        defaultName: "/tf_static",
        schema: { type: "tf2_msgs/TFMessage", version: 1 },
        required: false,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
    },
    {
        id: "front-camera-image",
        stage: "perception",
        direction: "output",
        defaultName: "/sensors/front_camera/image_raw",
        schema: { type: "sensor_msgs/Image", version: 1 },
        required: true,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
        timestampPolicy: "capture",
    },
    {
        id: "front-camera-info",
        stage: "perception",
        direction: "output",
        defaultName: "/sensors/front_camera/camera_info",
        schema: { type: "sensor_msgs/CameraInfo", version: 1 },
        required: true,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
    },
    {
        id: "front-lidar-points",
        stage: "perception",
        direction: "output",
        defaultName: "/sensors/front_lidar/points",
        schema: { type: "sensor_msgs/PointCloud2", version: 1 },
        required: true,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
    },
    {
        id: "imu",
        stage: "localization",
        direction: "output",
        defaultName: "/sensors/imu/data",
        schema: { type: "sensor_msgs/Imu", version: 1 },
        units: "SI",
        required: false,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
        timestampPolicy: "capture",
    },
    {
        id: "gnss",
        stage: "localization",
        direction: "output",
        defaultName: "/sensors/gnss/fix",
        schema: { type: "sensor_msgs/NavSatFix", version: 1 },
        required: false,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
        timestampPolicy: "capture",
    },
    {
        id: "wheel-odometry",
        stage: "localization",
        direction: "output",
        defaultName: "/sensors/wheel/odometry",
        schema: { type: "nav_msgs/Odometry", version: 1 },
        required: false,
        implementation: "live",
        defaultProducer: "simulator",
        defaultAuthority: "reference",
        timestampPolicy: "capture",
    },
    {
        id: "truth-odometry",
        stage: "localization",
        direction: "output",
        defaultName: "/oracle/vehicle/odometry",
        schema: { type: "nav_msgs/Odometry", version: 1 },
        required: false,
        implementation: "live",
        defaultProducer: "oracle",
        defaultAuthority: "oracle",
        timestampPolicy: "capture",
    },
    {
        id: "vehicle-truth",
        stage: "localization",
        direction: "output",
        defaultName: "/oracle/vehicle/state",
        schema: { type: "sensor_fusion_msgs/CarPosition", version: 1 },
        required: false,
        implementation: "catalog-only",
        defaultProducer: "oracle",
        defaultAuthority: "oracle",
    },
    {
        id: "perception-detections",
        stage: "perception",
        direction: "input",
        defaultName: "/perception/detections",
        schema: { type: "sensor_fusion_msgs/Boxes", version: 1 },
        required: false,
        implementation: "catalog-only",
        defaultProducer: "candidate",
        defaultAuthority: "candidate",
        timeoutNs: 200_000_000,
        validityNs: 500_000_000,
    },
    {
        id: "perception-lanes",
        stage: "perception",
        direction: "input",
        defaultName: "/perception/lanes",
        schema: { type: "sensor_fusion_msgs/Lanes", version: 1 },
        required: false,
        implementation: "catalog-only",
        defaultProducer: "candidate",
        defaultAuthority: "candidate",
        timeoutNs: 200_000_000,
    },
    {
        id: "localization-estimate",
        stage: "localization",
        direction: "input",
        defaultName: "/localization/odometry",
        schema: { type: "nav_msgs/Odometry", version: 1 },
        units: "SI",
        required: false,
        implementation: "live",
        defaultProducer: "candidate",
        defaultAuthority: "candidate",
        timeoutNs: 100_000_000,
        validityNs: 500_000_000,
    },
    {
        id: "controls-command",
        stage: "controls",
        direction: "input",
        defaultName: "/controls/command",
        schema: { type: "sensor_fusion_msgs/StampedAckermannDrive", version: 1 },
        units: "SI",
        required: false,
        implementation: "catalog-only",
        defaultProducer: "candidate",
        defaultAuthority: "candidate",
        timeoutNs: 100_000_000,
        validityNs: 200_000_000,
        fallback: { contractId: "ackdrive-legacy", mode: "legacy-adapter" },
    },
    {
        id: "ackdrive-legacy",
        stage: "controls",
        direction: "input",
        defaultName: "/ackdrive",
        schema: { type: "sensor_fusion_msgs/AckermannDrive", version: 1 },
        units: "legacy-mph-deg",
        required: true,
        implementation: "live",
        defaultProducer: "candidate",
        defaultAuthority: "candidate",
        timeoutNs: 100_000_000,
    },
]);

const contractsById = new Map(CONTRACT_DEFINITIONS.map((entry) => [entry.id, Object.freeze({ ...entry })]));

export function listAutonomyContracts() {
    return CONTRACT_DEFINITIONS.map((entry) => ({ ...entry }));
}

export function getAutonomyContract(contractId) {
    return contractsById.get(String(contractId || "").trim()) ?? null;
}

export function catalogSchemas() {
    return { ...ROS_SCHEMA_DEFINITIONS };
}

function parseFieldTypes(definition) {
    const types = [];
    for (const rawLine of definition.split(/\r?\n/)) {
        const line = rawLine.split("#", 1)[0].trim();
        if (!line || line.includes("=")) continue;
        const parts = line.split(/\s+/);
        if (parts.length < 2) continue;
        const token = parts[0];
        const arrayMatch = /^([A-Za-z0-9_/]+)(\[(\d*)\])?$/.exec(token);
        if (!arrayMatch) continue;
        let typeName = arrayMatch[1];
        if (!typeName.includes("/") && !["string", "bool", "byte", "char", "float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"].includes(typeName.toLowerCase())) {
            const pkg = definition.includes("/") ? null : null;
            void pkg;
        }
        if (!typeName.includes("/") && !/^(string|bool|byte|char|float32|float64|int8|uint8|int16|uint16|int32|uint32|int64|uint64)$/i.test(typeName)) {
            continue;
        }
        types.push(typeName);
    }
    return types;
}

function resolvePackage(typeName, rootPackage) {
    if (typeName.includes("/")) return typeName;
    const primitive = typeName.toLowerCase();
    if (["string", "bool", "byte", "char", "float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"].includes(primitive)) {
        return typeName;
    }
    return rootPackage ? `${rootPackage}/${typeName}` : typeName;
}

export function schemaClosureForTypes(types = []) {
    const schemas = { ...ROS_SCHEMA_DEFINITIONS };
    const queue = [...new Set(types.filter(Boolean))];
    const seen = new Set();
    while (queue.length > 0) {
        const typeName = queue.shift();
        if (seen.has(typeName)) continue;
        seen.add(typeName);
        const definition = schemas[typeName];
        if (!definition) continue;
        const packageName = typeName.includes("/") ? typeName.split("/")[0] : null;
        for (const rawField of definition.split(/\r?\n/)) {
            const line = rawField.split("#", 1)[0].trim();
            if (!line || line.includes("=")) continue;
            const parts = line.split(/\s+/);
            if (parts.length < 2) continue;
            const m = /^([A-Za-z0-9_/]+)(\[(\d*)\])?$/.exec(parts[0]);
            if (!m) continue;
            let dep = m[1];
            if (!dep.includes("/")) {
                const lower = dep.toLowerCase();
                if (["string", "bool", "byte", "char", "float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64"].includes(lower)) continue;
                dep = packageName ? `${packageName}/${dep}` : dep;
            }
            if (!schemas[dep] && ROS_SCHEMA_DEFINITIONS[dep]) schemas[dep] = ROS_SCHEMA_DEFINITIONS[dep];
            if (schemas[dep] && !seen.has(dep)) queue.push(dep);
        }
    }
    return schemas;
}

export function schemaClosureForManifest(manifest) {
    const types = (manifest?.topics || []).map((entry) => entry.schema?.type || entry.type).filter(Boolean);
    for (const sensor of manifest?.sensorRig?.sensors || []) {
        for (const rosType of Object.values(sensor.schema || {})) types.push(rosType);
    }
    return schemaClosureForTypes(types);
}

export function catalogMetadata() {
    return {
        kind: AUTONOMY_CATALOG_KIND,
        version: AUTONOMY_CATALOG_VERSION,
        hash: catalogHash(),
        contractCount: CONTRACT_DEFINITIONS.length,
    };
}

export function catalogHash() {
    const contractPayload = CONTRACT_DEFINITIONS.map((contract) => ({
        id: contract.id,
        stage: contract.stage,
        direction: contract.direction,
        defaultName: contract.defaultName,
        schema: contract.schema,
        required: contract.required,
        implementation: contract.implementation,
        defaultProducer: contract.defaultProducer,
        defaultAuthority: contract.defaultAuthority,
        timeoutNs: contract.timeoutNs ?? null,
        validityNs: contract.validityNs ?? null,
        framePolicy: contract.framePolicy ?? null,
        timestampPolicy: contract.timestampPolicy ?? null,
        units: contract.units ?? null,
        fallback: contract.fallback ?? null,
    })).sort((left, right) => left.id.localeCompare(right.id));
    const payload = JSON.stringify({
        kind: AUTONOMY_CATALOG_KIND,
        version: AUTONOMY_CATALOG_VERSION,
        contracts: contractPayload,
        schemas: Object.keys(ROS_SCHEMA_DEFINITIONS).sort(),
    });
    return createHash("sha256").update(payload).digest("hex");
}

export function defaultManifestTopics() {
    const liveDefaults = [
        ["clock", {}],
        ["tf", {}],
        ["tf-static", {}],
        ["front-camera-image", {}],
        ["front-camera-info", {}],
        ["front-lidar-points", {}],
        ["imu", {}],
        ["gnss", {}],
        ["wheel-odometry", {}],
        ["truth-odometry", {}],
        ["localization-estimate", {}],
        ["ackdrive-legacy", { id: "ackdrive" }],
    ];
    return liveDefaults.map(([contractId, overrides]) => topicFromContract(contractId, overrides));
}

export function topicFromContract(contractId, overrides = {}) {
    const contract = getAutonomyContract(contractId);
    if (!contract) throw new Error(`Unknown autonomy contract "${contractId}".`);
    const producer = overrides.producer || contract.defaultProducer;
    const authority = overrides.authority || contract.defaultAuthority;
    return {
        id: overrides.id || contract.id,
        contractId: contract.id,
        name: overrides.name || contract.defaultName,
        direction: contract.direction,
        type: contract.schema.type,
        schema: { ...contract.schema },
        required: overrides.required ?? contract.required,
        producer,
        authority,
        timeoutNs: overrides.timeoutNs ?? contract.timeoutNs ?? null,
        validityNs: overrides.validityNs ?? contract.validityNs ?? null,
        fallback: overrides.fallback ?? contract.fallback ?? null,
        units: contract.units ?? null,
        stage: contract.stage,
        implementation: contract.implementation,
    };
}

export function migrateLegacyTopic(source = {}, index = 0) {
    const name = String(source.name || "").trim();
    const type = String(source.type || source.schema?.type || "").trim();
    let contractId = String(source.contractId || "").trim();
    if (!contractId) {
        const match = CONTRACT_DEFINITIONS.find((entry) => entry.defaultName === name && (entry.schema.type === type || !type));
        contractId = match?.id || (name === "/ackdrive" ? "ackdrive-legacy" : "");
    }
    const contract = contractId ? getAutonomyContract(contractId) : null;
    const direction = ["input", "output"].includes(source.direction) ? source.direction : (contract?.direction || "output");
    const defaultProducer = direction === "input" ? "candidate" : "simulator";
    return {
        id: String(source.id || `topic-${index + 1}`).trim(),
        contractId: contractId || null,
        name: name || contract?.defaultName || `/topic-${index + 1}`,
        direction,
        type: type || contract?.schema.type || "std_msgs/String",
        schema: {
            type: type || contract?.schema.type || "std_msgs/String",
            version: Number(source.schema?.version ?? contract?.schema.version ?? 1),
        },
        required: source.required === true || contract?.required === true,
        producer: PRODUCER_NAMESPACES.includes(source.producer) ? source.producer : (contract?.defaultProducer || defaultProducer),
        authority: AUTHORITY_MODES.includes(source.authority) ? source.authority : (contract?.defaultAuthority || (direction === "input" ? "candidate" : "reference")),
        timeoutNs: source.timeoutNs ?? contract?.timeoutNs ?? null,
        validityNs: source.validityNs ?? contract?.validityNs ?? null,
        fallback: source.fallback ?? contract?.fallback ?? null,
        units: source.units ?? contract?.units ?? null,
        stage: contract?.stage ?? null,
        implementation: contract?.implementation ?? null,
    };
}

export function validateTopicAgainstCatalog(topic, index = 0) {
    const issues = [];
    const path = (suffix) => `topics.${index}.${suffix}`;
    if (!topic.id) issues.push({ path: path("id"), message: "A stable id is required." });
    if (!topic.name) issues.push({ path: path("name"), message: "Topic wire name is required." });
    if (!["input", "output"].includes(topic.direction)) {
        issues.push({ path: path("direction"), message: "Direction must be input or output." });
    }
    if (!topic.schema?.type && !topic.type) {
        issues.push({ path: path("schema.type"), message: "ROS schema type is required." });
    }
    const rosType = topic.schema?.type || topic.type;
    if (rosType && !ROS_SCHEMA_DEFINITIONS[rosType]) {
        issues.push({ path: path("schema.type"), message: `Unknown ROS type "${rosType}" in autonomy catalog.` });
    }
    if (topic.contractId) {
        const contract = getAutonomyContract(topic.contractId);
        if (!contract) {
            issues.push({ path: path("contractId"), message: `Unknown contract id "${topic.contractId}".` });
        } else {
            if (contract.direction !== topic.direction) {
                issues.push({ path: path("direction"), message: `Contract "${topic.contractId}" expects direction "${contract.direction}".` });
            }
            if (contract.schema.type !== rosType) {
                issues.push({ path: path("schema.type"), message: `Contract "${topic.contractId}" requires type "${contract.schema.type}".` });
            }
        }
    }
    if (topic.producer && !PRODUCER_NAMESPACES.includes(topic.producer)) {
        issues.push({ path: path("producer"), message: `Invalid producer namespace "${topic.producer}".` });
    }
    if (topic.authority && !AUTHORITY_MODES.includes(topic.authority)) {
        issues.push({ path: path("authority"), message: `Invalid authority mode "${topic.authority}".` });
    }
    if (topic.fallback?.contractId && !getAutonomyContract(topic.fallback.contractId)) {
        issues.push({ path: path("fallback.contractId"), message: `Unknown fallback contract "${topic.fallback.contractId}".` });
    }
    return issues;
}

export function validateManifestTopicAuthority(manifest) {
    const issues = [];
    const byContract = new Map();
    for (const [index, topic] of (manifest.topics || []).entries()) {
        const key = topic.contractId || topic.id;
        if (!byContract.has(key)) byContract.set(key, []);
        byContract.get(key).push({ index, topic });
    }
    for (const [contractKey, entries] of byContract) {
        const authorities = new Set(entries.map((entry) => entry.topic.authority).filter(Boolean));
        if (authorities.size > 1) {
            for (const { index } of entries) {
                issues.push({
                    path: `topics.${index}.authority`,
                    message: `Conflicting authority modes for contract "${contractKey}".`,
                });
            }
        }
    }
    const names = new Map();
    for (const [index, topic] of (manifest.topics || []).entries()) {
        if (names.has(topic.name)) {
            issues.push({ path: `topics.${index}.name`, message: `Duplicate topic name "${topic.name}".` });
        }
        names.set(topic.name, index);
    }
    return issues;
}

/** Minimal schema-valid fixture payloads for loopback encode/decode tests. */
export function fixturePayloadForType(typeStr) {
    const stamp = { sec: 1, nanosec: 500_000_000 };
    const header = { stamp, frame_id: "base_link" };
    switch (typeStr) {
        case "rosgraph_msgs/Clock":
            return { clock: stamp };
        case "sensor_msgs/Image":
            return { header, height: 1, width: 1, encoding: "rgba8", is_bigendian: 0, step: 4, data: new Uint8Array([0, 0, 0, 255]) };
        case "sensor_msgs/CameraInfo":
            return {
                header, height: 1, width: 1, distortion_model: "plumb_bob", d: [], k: [1, 0, 0, 0, 1, 0, 0, 0, 1], r: [1, 0, 0, 0, 1, 0, 0, 0, 1], p: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], binning_x: 0, binning_y: 0,
            };
        case "sensor_msgs/PointCloud2":
            return { header, height: 1, width: 0, fields: [], is_bigendian: false, point_step: 0, row_step: 0, data: new Uint8Array(0), is_dense: true };
        case "sensor_msgs/Imu":
            return {
                header,
                orientation: { x: 0, y: 0, z: 0, w: 1 },
                orientation_covariance: new Array(9).fill(0),
                angular_velocity: { x: 0, y: 0, z: 0 },
                angular_velocity_covariance: new Array(9).fill(0),
                linear_acceleration: { x: 0, y: 0, z: 9.81 },
                linear_acceleration_covariance: new Array(9).fill(0),
            };
        case "sensor_msgs/NavSatFix":
            return { header, status: { status: 0, service: 1 }, latitude: 42.0, longitude: -76.0, altitude: 200, position_covariance: new Array(9).fill(0), position_covariance_type: 0 };
        case "nav_msgs/Odometry":
            return {
                header, child_frame_id: "base_link",
                pose: { pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, covariance: new Array(36).fill(0) },
                twist: { twist: { linear: { x: 0, y: 0, z: 0 }, angular: { x: 0, y: 0, z: 0 } }, covariance: new Array(36).fill(0) },
            };
        case "tf2_msgs/TFMessage":
            return { transforms: [] };
        case "sensor_fusion_msgs/AckermannDrive":
            return { steering_angle: 0, steering_angle_velocity: 0, speed: 0, acceleration: 0, jerk: 0 };
        case "sensor_fusion_msgs/StampedAckermannDrive":
            return { header, sequence: 1, mode: "velocity", deadline_ns: 0, steering_angle: 0, steering_angle_velocity: 0, speed: 0, acceleration: 0, jerk: 0 };
        case "sensor_fusion_msgs/Boxes":
            return { boxes: [] };
        case "sensor_fusion_msgs/Lanes":
            return { lanes: [] };
        case "sensor_fusion_msgs/CarPosition":
            return { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } };
        default:
            return {};
    }
}

export function msgFilePathsForCatalog() {
    return {
        "builtin_interfaces/Time": "/messages/builtin_interfaces/msg/Time.msg",
        "std_msgs/Header": "/messages/std_msgs/msg/Header.msg",
        "geometry_msgs/Point32": "/messages/geometry_msgs/msg/Point32.msg",
        "geometry_msgs/Point": "/messages/geometry_msgs/msg/Point.msg",
        "geometry_msgs/Quaternion": "/messages/geometry_msgs/msg/Quaternion.msg",
        "geometry_msgs/Vector3": "/messages/geometry_msgs/msg/Vector3.msg",
        "geometry_msgs/Pose": "/messages/geometry_msgs/msg/Pose.msg",
        "geometry_msgs/PoseWithCovariance": "/messages/geometry_msgs/msg/PoseWithCovariance.msg",
        "geometry_msgs/Twist": "/messages/geometry_msgs/msg/Twist.msg",
        "geometry_msgs/TwistWithCovariance": "/messages/geometry_msgs/msg/TwistWithCovariance.msg",
        "geometry_msgs/Transform": "/messages/geometry_msgs/msg/Transform.msg",
        "geometry_msgs/TransformStamped": "/messages/geometry_msgs/msg/TransformStamped.msg",
        "sensor_msgs/Image": "/messages/sensor_msgs/msg/Image.msg",
        "sensor_msgs/CameraInfo": "/messages/sensor_msgs/msg/CameraInfo.msg",
        "sensor_msgs/PointField": "/messages/sensor_msgs/msg/PointField.msg",
        "sensor_msgs/PointCloud2": "/messages/sensor_msgs/msg/PointCloud2.msg",
        "sensor_msgs/Imu": "/messages/sensor_msgs/msg/Imu.msg",
        "sensor_msgs/NavSatFix": "/messages/sensor_msgs/msg/NavSatFix.msg",
        "sensor_msgs/NavSatStatus": "/messages/sensor_msgs/msg/NavSatStatus.msg",
        "nav_msgs/Odometry": "/messages/nav_msgs/msg/Odometry.msg",
        "tf2_msgs/TFMessage": "/messages/tf2_msgs/msg/TFMessage.msg",
        "rosgraph_msgs/Clock": "/messages/rosgraph_msgs/msg/Clock.msg",
        "sensor_fusion_msgs/AckermannDrive": "/messages/sensor_fusion_msgs/msg/AckermannDrive.msg",
        "sensor_fusion_msgs/StampedAckermannDrive": "/messages/sensor_fusion_msgs/msg/StampedAckermannDrive.msg",
        "sensor_fusion_msgs/Box": "/messages/sensor_fusion_msgs/msg/Box.msg",
        "sensor_fusion_msgs/Boxes": "/messages/sensor_fusion_msgs/msg/Boxes.msg",
        "sensor_fusion_msgs/LaneBounds": "/messages/sensor_fusion_msgs/msg/LaneBounds.msg",
        "sensor_fusion_msgs/Lanes": "/messages/sensor_fusion_msgs/msg/Lanes.msg",
        "sensor_fusion_msgs/CarPosition": "/messages/sensor_fusion_msgs/msg/CarPosition.msg",
    };
}
