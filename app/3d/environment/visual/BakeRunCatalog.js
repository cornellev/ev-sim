import { eulerToQuaternion } from "../../../autonomy/CoordinateFrames.js";
import {
    canonicalExactStringify,
    sha256ExactBytes,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";
import {
    createVisualCameraCalibration,
    serializeCaptureProductLittleEndian,
    VISUAL_CAPTURE_PASS_FAMILIES,
    VISUAL_CAPTURE_PRODUCT_LAYOUTS,
    VISUAL_CAPTURE_PRODUCTS,
} from "./VisualCapturePipeline.js";
import { normalizeBakeConstruction } from "./BakeConstructionPolicy.js";

export const BAKE_RUN_CONFIG_KIND = "cev-sim.bake-run-config";
export const BAKE_SOURCE_SNAPSHOT_KIND = "cev-sim.bake-source-snapshot";
export const BAKE_CAPTURE_PLAN_KIND = "cev-sim.bake-capture-plan";
export const BAKE_PROVIDER_REQUEST_KIND = "cev-sim.bake-provider-request";
export const BAKE_PROVIDER_RESPONSE_KIND = "cev-sim.bake-provider-response";
export const BAKE_JOB_STATUS_KIND = "cev-sim.bake-job-status";
export const BAKE_CONTRACT_VERSION = 1;
export const BAKE_CONTRACT_VERSION_V2 = 2;

export const CAPTURED_APPEARANCE_PROVIDER = Object.freeze({
    id: "captured-appearance",
    version: 1,
});
export const STATIC_SNAPSHOT_POLICY = Object.freeze({
    id: "static-snapshot",
    version: 1,
});
export const BAKE_CAPTURE_MODE = "calibrated-projection@1";
export const BAKE_PLANNER_ID = "building-region@1";
export const BAKE_SAMPLING_ID = "integer-index@1";

export const BAKE_JOB_STATES = Object.freeze({
    queued: "queued",
    running: "running",
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    superseded: "superseded",
});
export const BAKE_JOB_PHASES = Object.freeze({
    prepare: "prepare",
    capture: "capture",
    provider: "provider",
    terminal: "terminal",
});
export const BAKE_TERMINAL_STATES = Object.freeze([
    BAKE_JOB_STATES.completed,
    BAKE_JOB_STATES.failed,
    BAKE_JOB_STATES.cancelled,
    BAKE_JOB_STATES.superseded,
]);

export const BAKE_OUTPUT_ROLES = Object.freeze([...VISUAL_CAPTURE_PRODUCTS[VISUAL_CAPTURE_PASS_FAMILIES.visual]]);
export const BAKE_PRODUCT_RESULT_KEYS = Object.freeze({
    beauty: "beauty",
    "axial-depth": "axialDepth",
    "geometric-normal": "geometricNormal",
    "object-id": "objectId",
    "material-id": "materialId",
    "world-position": "worldPosition",
    confidence: "confidence",
    validity: "validity",
    "semantic-id": "semanticId",
    "instance-id": "instanceId",
});

export const CAPTURED_APPEARANCE_DEFAULT_OPTIONS = Object.freeze({
    transform: "identity",
});
export const DEFAULT_BAKE_CACHE_POLICY = Object.freeze({
    mode: "none",
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();
const CONFIG_KEYS = Object.freeze([
    "kind", "version", "environmentId", "seed", "paths", "views", "buildings",
    "passPolicy", "planner", "sampling", "ordering", "seedKeys", "outputRoles",
    "provider", "providerOptions", "cachePolicy", "snapshotPolicy", "operational",
]);
const CONFIG_KEYS_V2 = Object.freeze([...CONFIG_KEYS, "construction"]);
const RECIPE_KEYS = Object.freeze(CONFIG_KEYS.filter((key) => key !== "operational"));
const RECIPE_KEYS_V2 = Object.freeze(CONFIG_KEYS_V2.filter((key) => key !== "operational"));
const OPERATIONAL_KEYS = Object.freeze([
    "runId", "host", "endpoint", "roundTrip", "debug", "splat", "createdAt", "modelSettings",
]);
const SNAPSHOT_KEYS = Object.freeze([
    "kind", "version", "snapshotPolicy", "worldHash", "environmentRevision", "bakeGeneration",
    "visualDescriptorHash", "visualAccessHash", "sourceUseHashes", "selectedChunks",
    "geometryState", "materialState", "lightingState", "algorithms", "outputRoles",
    "dynamicActorPolicy", "resourceClosure", "calibrations",
]);
const PLAN_KEYS = Object.freeze([
    "kind", "version", "recipeHash", "snapshotHash", "captureTimeNs", "views", "samples",
]);
const REQUEST_KEYS = Object.freeze([
    "kind", "version", "recipeHash", "snapshotHash", "planHash", "provider", "providerOptions",
    "cachePolicy", "seed", "inputs",
]);
const RESPONSE_KEYS = Object.freeze([
    "kind", "version", "requestHash", "outputs", "providerRevision", "modelRevision",
    "weightsDigest", "prompts", "configuration", "runtimeOptions", "seed",
    "sourceDimensions", "effectiveDimensions", "codecRevisions", "runtimeStack",
    "nondeterminismScope", "cachePolicy",
]);
const STATUS_KEYS = Object.freeze([
    "kind", "version", "jobId", "generation", "phase", "state", "progress",
    "timestamps", "logs", "failure", "recipeHash", "snapshotHash", "planHash",
    "requestHash", "responseHash",
]);
const DIGEST_RECORD_KEYS = Object.freeze([
    "sampleId", "viewId", "role", "mediaType", "encoding", "byteSize", "width", "height", "sha256",
]);
const DEFAULT_OUTPUT_ROLES = Object.freeze(["beauty", "validity"]);

function bakeError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function fail(path, message) {
    throw bakeError("BAKE_CONTRACT_INVALID", `${path}: ${message}`);
}

function plainObject(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
    return value;
}

function allowedKeys(value, allowed, path) {
    const object = plainObject(value, path);
    const unknown = Object.keys(object).find((key) => !allowed.includes(key));
    if (unknown) fail(path, `${unknown} is not supported`);
    return object;
}

function denseArray(value, path) {
    if (!Array.isArray(value)) fail(path, "expected an array");
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        fail(path, "sparse or extended arrays are outside the JSON data model");
    }
    return value;
}

function text(value, path, { identifier = false, allowEmpty = false } = {}) {
    if (typeof value !== "string") fail(path, "expected a string");
    if (!allowEmpty && value.length === 0) fail(path, "expected a non-empty string");
    if (identifier && value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
    return value;
}

function finite(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
    return Object.is(value, -0) ? 0 : value;
}

function integer(value, path, { min = 0 } = {}) {
    const number = finite(value, path);
    if (!Number.isSafeInteger(number) || number < min) {
        fail(path, `expected a safe integer >= ${min}`);
    }
    return number;
}

function boolean(value, path) {
    if (typeof value !== "boolean") fail(path, "expected a boolean");
    return value;
}

function digest(value, path) {
    const result = text(value, path);
    if (!SHA256_PATTERN.test(result)) fail(path, "expected a lowercase SHA-256 digest");
    return result;
}

function digestOrNull(value, path) {
    if (value === null) return null;
    return digest(value, path);
}

function stringOrNull(value, path) {
    if (value === null) return null;
    return text(value, path, { allowEmpty: true });
}

export function compareUtf8(left, right) {
    const a = textEncoder.encode(String(left));
    const b = textEncoder.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function uniqueSorted(values, path, normalizeEntry = (entry, itemPath) => text(entry, itemPath, { identifier: true })) {
    const list = denseArray(values, path).map((entry, index) => normalizeEntry(entry, `${path}.${index}`));
    const seen = new Set(list);
    if (seen.size !== list.length) fail(path, "contains duplicate entries");
    return [...list].sort(compareUtf8);
}

function freezeDeep(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        for (const entry of value) freezeDeep(entry);
        return Object.freeze(value);
    }
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
}

function hashDocument(value) {
    return sha256ExactUtf8(canonicalExactStringify(value));
}

function vector3(value, path) {
    const source = value?.isVector3 || value?.clone
        ? { x: value.x, y: value.y, z: value.z }
        : plainObject(value, path);
    allowedKeys(source, ["x", "y", "z"], path);
    return Object.freeze({
        x: finite(source.x, `${path}.x`),
        y: finite(source.y, `${path}.y`),
        z: finite(source.z, `${path}.z`),
    });
}

function quaternion(value, path) {
    const source = value?.isQuaternion
        ? { x: value.x, y: value.y, z: value.z, w: value.w }
        : plainObject(value, path);
    const qx = finite(source.x ?? 0, `${path}.x`);
    const qy = finite(source.y ?? 0, `${path}.y`);
    const qz = finite(source.z ?? 0, `${path}.z`);
    const qw = finite(source.w ?? 1, `${path}.w`);
    const norm = Math.hypot(qx, qy, qz, qw);
    if (norm <= Number.EPSILON) fail(path, "rotation must not be the zero quaternion");
    return Object.freeze({
        x: Object.is(qx / norm, -0) ? 0 : qx / norm,
        y: Object.is(qy / norm, -0) ? 0 : qy / norm,
        z: Object.is(qz / norm, -0) ? 0 : qz / norm,
        w: Object.is(qw / norm, -0) ? 0 : qw / norm,
    });
}

export function rotationToQuaternion(value, path = "rotation") {
    if (value == null) return quaternion({ x: 0, y: 0, z: 0, w: 1 }, path);
    if (value.isEuler || (value.order !== undefined && value.w === undefined)) {
        const order = value.order || "XYZ";
        if (order !== "XYZ") fail(path, "order must be intrinsic XYZ");
        return quaternion(eulerToQuaternion({
            x: finite(value.x ?? 0, `${path}.x`),
            y: finite(value.y ?? 0, `${path}.y`),
            z: finite(value.z ?? 0, `${path}.z`),
            order: "XYZ",
        }), path);
    }
    if (value.w !== undefined) return quaternion(value, path);
    if (value.order !== undefined && value.order !== "XYZ") fail(path, "order must be intrinsic XYZ");
    return quaternion(eulerToQuaternion({
        x: finite(value.x ?? 0, `${path}.x`),
        y: finite(value.y ?? 0, `${path}.y`),
        z: finite(value.z ?? 0, `${path}.z`),
        order: "XYZ",
    }), path);
}

function pose(value, path) {
    const source = plainObject(value, path);
    allowedKeys(source, ["position", "rotation"], path);
    return Object.freeze({
        position: vector3(source.position, `${path}.position`),
        rotation: rotationToQuaternion(source.rotation, `${path}.rotation`),
    });
}

function slerp(a, b, t) {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    let bx = b.x;
    let by = b.y;
    let bz = b.z;
    let bw = b.w;
    if (dot < 0) {
        dot = -dot;
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }
    if (dot > 0.9995) {
        return quaternion({
            x: a.x + t * (bx - a.x),
            y: a.y + t * (by - a.y),
            z: a.z + t * (bz - a.z),
            w: a.w + t * (bw - a.w),
        }, "rotation");
    }
    const theta = Math.acos(Math.min(1, dot));
    const sin = Math.sin(theta);
    const wa = Math.sin((1 - t) * theta) / sin;
    const wb = Math.sin(t * theta) / sin;
    return quaternion({
        x: a.x * wa + bx * wb,
        y: a.y * wa + by * wb,
        z: a.z * wa + bz * wb,
        w: a.w * wa + bw * wb,
    }, "rotation");
}

function lerpVector(a, b, t) {
    return Object.freeze({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
    });
}

function hypot3(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function providerRef(value, path = "provider") {
    if (value == null) return { ...CAPTURED_APPEARANCE_PROVIDER };
    const source = plainObject(value, path);
    allowedKeys(source, ["id", "version"], path);
    return Object.freeze({
        id: text(source.id, `${path}.id`, { identifier: true }),
        version: integer(source.version, `${path}.version`, { min: 1 }),
    });
}

function providerKey(provider) {
    return `${provider.id}@${provider.version}`;
}

function acceptCalibration(value, path = "calibration") {
    if (value?.kind === "cev-sim.visual-camera-calibration" && value?.version === 1 && value?.image) {
        return createVisualCameraCalibration({
            width: value.image.width,
            height: value.image.height,
            near: value.clipping.near,
            far: value.clipping.far,
            intrinsics: value.intrinsics,
            distortion: value.distortion,
        });
    }
    try {
        return createVisualCameraCalibration(value);
    } catch (error) {
        error.message = `${path}: ${error.message}`;
        throw error;
    }
}

function defaultCalibration(camera = {}) {
    const width = integer(camera.width ?? 1920, "camera.width", { min: 1 });
    const height = integer(camera.height ?? 1080, "camera.height", { min: 1 });
    const fov = finite(camera.fov ?? 75, "camera.fov");
    if (fov <= 0 || fov >= 180) fail("camera.fov", "must be in (0, 180)");
    const near = finite(camera.near ?? 0.1, "camera.near");
    const far = finite(camera.far ?? 500, "camera.far");
    const fy = camera.intrinsics?.fy ?? ((height / 2) / Math.tan((fov * Math.PI) / 360));
    const fx = camera.intrinsics?.fx ?? fy;
    return createVisualCameraCalibration({
        width,
        height,
        near,
        far,
        intrinsics: {
            fx,
            fy,
            cx: camera.intrinsics?.cx ?? (width - 1) / 2,
            cy: camera.intrinsics?.cy ?? (height - 1) / 2,
        },
        distortionModel: camera.distortionModel ?? "none",
        distortion: camera.distortion ?? [],
    });
}

function cameraFromCalibration(calibration) {
    const { width, height } = calibration.image;
    const fy = calibration.intrinsics.fy;
    const fov = (2 * Math.atan((height / 2) / fy) * 180) / Math.PI;
    return Object.freeze({
        width,
        height,
        fov,
        near: calibration.clipping.near,
        far: calibration.clipping.far,
        intrinsics: calibration.intrinsics,
        distortionModel: calibration.distortion.model,
        distortion: calibration.distortion.coefficients,
    });
}

function tags(value, path) {
    if (value == null) return Object.freeze([]);
    return Object.freeze(uniqueSorted(value, path, (entry, itemPath) => text(entry, itemPath)));
}

function passDescriptor(value, path) {
    const source = allowedKeys(value, [
        "id", "kind", "includeTags", "excludeTags", "upload", "buildingId",
        "maskTags", "processTag", "modelSeedKey", "chainProcess",
    ], path);
    const kind = text(source.kind ?? "render", `${path}.kind`);
    if (!["render", "mask", "depth"].includes(kind)) fail(`${path}.kind`, "unsupported pass kind");
    return Object.freeze({
        id: text(source.id, `${path}.id`, { identifier: true }),
        kind,
        includeTags: tags(source.includeTags ?? [], `${path}.includeTags`),
        excludeTags: tags(source.excludeTags ?? [], `${path}.excludeTags`),
        upload: boolean(source.upload ?? true, `${path}.upload`),
        buildingId: source.buildingId == null ? null : text(source.buildingId, `${path}.buildingId`, { identifier: true }),
        maskTags: tags(source.maskTags ?? [], `${path}.maskTags`),
        processTag: source.processTag == null ? null : text(source.processTag, `${path}.processTag`),
        modelSeedKey: source.modelSeedKey == null ? null : text(source.modelSeedKey, `${path}.modelSeedKey`),
        chainProcess: boolean(source.chainProcess ?? false, `${path}.chainProcess`),
    });
}

function outputRoles(value, path = "outputRoles") {
    const roles = value == null ? [...DEFAULT_OUTPUT_ROLES] : denseArray(value, path).map((entry) => text(entry, path));
    const unique = uniqueSorted(roles, path, (entry, itemPath) => text(entry, itemPath));
    for (const role of unique) {
        if (!BAKE_OUTPUT_ROLES.includes(role)) fail(path, `unsupported output role ${role}`);
    }
    if (!unique.includes("validity")) unique.push("validity");
    return Object.freeze(BAKE_OUTPUT_ROLES.filter((role) => unique.includes(role)));
}

const DEFAULT_PATH_VERTICES = Object.freeze([
    Object.freeze({
        position: Object.freeze({ x: -25.120153743222073, y: 0.5, z: 1.1525929487085005 }),
        rotation: rotationToQuaternion({ x: 0, y: Math.PI / 4, z: 0, order: "XYZ" }, "path.rotation"),
    }),
    Object.freeze({
        position: Object.freeze({ x: -24.40545504348329, y: 0.5, z: 50.754401939102294 }),
        rotation: rotationToQuaternion({ x: 0, y: Math.PI / 4, z: 0, order: "XYZ" }, "path.rotation"),
    }),
]);

function pathVertex(value, path) {
    const source = value?.position ? value : { position: value, rotation: value?.rotation };
    allowedKeys(source, ["position", "rotation"], path);
    return Object.freeze({
        position: vector3(source.position, `${path}.position`),
        rotation: rotationToQuaternion(source.rotation, `${path}.rotation`),
    });
}

function normalizePath(value, path, fallbackId) {
    const source = Array.isArray(value) ? { id: fallbackId, vertices: value } : plainObject(value, path);
    allowedKeys(source, ["id", "vertices"], path);
    const vertices = denseArray(source.vertices ?? DEFAULT_PATH_VERTICES, `${path}.vertices`)
        .map((entry, index) => pathVertex(entry, `${path}.vertices.${index}`));
    if (vertices.length === 0) fail(`${path}.vertices`, "at least one vertex is required");
    return Object.freeze({
        id: text(source.id ?? fallbackId, `${path}.id`, { identifier: true }),
        vertices: Object.freeze(vertices),
    });
}

function normalizeView(value, path) {
    const source = plainObject(value, path);
    allowedKeys(source, [
        "id", "name", "position", "rotation", "pose", "camera", "calibration",
        "includeTags", "excludeTags", "products", "passes", "masks", "lidar", "channels",
        "maxFramesPerChannel",
    ], path);
    const calibration = source.calibration
        ? acceptCalibration(source.calibration, `${path}.calibration`)
        : defaultCalibration(source.camera ?? {});
    const products = outputRoles(source.products ?? source.passes?.map((pass) => (
        pass?.id === "beauty" || pass?.kind === "render" ? "beauty" : null
    )).filter(Boolean) ?? DEFAULT_OUTPUT_ROLES, `${path}.products`);
    const passes = Object.freeze(
        denseArray(source.passes ?? [{
            id: "beauty",
            kind: "render",
            excludeTags: source.excludeTags ?? ["sign", "vehicle"],
        }], `${path}.passes`).map((entry, index) => passDescriptor(entry, `${path}.passes.${index}`)),
    );
    const passIds = passes.map((entry) => entry.id);
    if (new Set(passIds).size !== passIds.length) fail(`${path}.passes`, "contains duplicate IDs");
    const poseValue = source.pose ?? {
        position: source.position ?? { x: 0, y: 1.6, z: 0 },
        rotation: source.rotation ?? { x: 0, y: 0, z: 0, order: "XYZ" },
    };
    return Object.freeze({
        id: text(source.id ?? source.name ?? "bake/view/main", `${path}.id`, { identifier: true }),
        pose: pose(poseValue, `${path}.pose`),
        calibration,
        camera: cameraFromCalibration(calibration),
        includeTags: tags(source.includeTags ?? [], `${path}.includeTags`),
        excludeTags: tags(source.excludeTags ?? ["sign", "vehicle"], `${path}.excludeTags`),
        products,
        passes,
        masks: Object.freeze({
            minPixels: integer(source.masks?.minPixels ?? 64, `${path}.masks.minPixels`),
            skipEmpty: boolean(source.masks?.skipEmpty ?? true, `${path}.masks.skipEmpty`),
        }),
    });
}

function normalizeBuilding(value, path) {
    const source = allowedKeys(value, [
        "buildingId", "footprint", "height", "textureId", "tags", "meshName",
    ], path);
    return Object.freeze({
        buildingId: text(source.buildingId, `${path}.buildingId`, { identifier: true }),
        footprint: Object.freeze(denseArray(source.footprint ?? [], `${path}.footprint`)
            .map((entry, index) => vector3(entry, `${path}.footprint.${index}`))),
        height: finite(source.height ?? 0, `${path}.height`),
        textureId: integer(source.textureId ?? 0, `${path}.textureId`),
        tags: tags(source.tags ?? [], `${path}.tags`),
        meshName: text(source.meshName ?? source.buildingId, `${path}.meshName`),
    });
}

function normalizePassPolicy(value = {}) {
    const source = allowedKeys(value, [
        "beautyAlways", "activeBuildingMask", "processAllVisibleBuildings", "contextMask", "skipEmptyMasks",
    ], "passPolicy");
    return Object.freeze({
        beautyAlways: boolean(source.beautyAlways ?? true, "passPolicy.beautyAlways"),
        activeBuildingMask: boolean(source.activeBuildingMask ?? true, "passPolicy.activeBuildingMask"),
        processAllVisibleBuildings: boolean(source.processAllVisibleBuildings ?? true, "passPolicy.processAllVisibleBuildings"),
        contextMask: boolean(source.contextMask ?? false, "passPolicy.contextMask"),
        skipEmptyMasks: boolean(source.skipEmptyMasks ?? true, "passPolicy.skipEmptyMasks"),
    });
}

function normalizePlanner(value = {}) {
    const source = allowedKeys(value, ["id", "rotationIndex", "tieBreak"], "planner");
    const id = text(source.id ?? BAKE_PLANNER_ID, "planner.id", { identifier: true });
    if (id !== BAKE_PLANNER_ID) fail("planner.id", `unsupported planner ${id}`);
    const tieBreak = text(source.tieBreak ?? "utf8-entity-id", "planner.tieBreak");
    if (tieBreak !== "utf8-entity-id") fail("planner.tieBreak", "unsupported tie-break");
    return Object.freeze({
        id,
        rotationIndex: integer(source.rotationIndex ?? 0, "planner.rotationIndex"),
        tieBreak,
    });
}

function normalizeSampling(value = {}) {
    const source = allowedKeys(value, [
        "id", "deltaDistance", "includeEndpoints", "zeroLengthPolicy", "captureTimeNs",
    ], "sampling");
    const id = text(source.id ?? BAKE_SAMPLING_ID, "sampling.id", { identifier: true });
    if (id !== BAKE_SAMPLING_ID) fail("sampling.id", `unsupported sampler ${id}`);
    const zeroLengthPolicy = text(source.zeroLengthPolicy ?? "hold-start", "sampling.zeroLengthPolicy");
    if (zeroLengthPolicy !== "hold-start") fail("sampling.zeroLengthPolicy", "unsupported zero-length policy");
    const deltaDistance = finite(source.deltaDistance ?? 2, "sampling.deltaDistance");
    if (deltaDistance <= 0) fail("sampling.deltaDistance", "must be greater than zero");
    return Object.freeze({
        id,
        deltaDistance,
        includeEndpoints: boolean(source.includeEndpoints ?? true, "sampling.includeEndpoints"),
        zeroLengthPolicy,
        captureTimeNs: integer(source.captureTimeNs ?? 0, "sampling.captureTimeNs"),
    });
}

function normalizeOrdering(value = {}) {
    const source = allowedKeys(value, ["entityId", "paths", "views", "samples"], "ordering");
    const entityId = text(source.entityId ?? "utf8", "ordering.entityId");
    if (entityId !== "utf8") fail("ordering.entityId", "unsupported entity ordering");
    return Object.freeze({
        entityId,
        paths: text(source.paths ?? "id", "ordering.paths"),
        views: text(source.views ?? "id", "ordering.views"),
        samples: text(source.samples ?? "path-index-view", "ordering.samples"),
    });
}

function normalizeSeedKeys(value = {}, seed = 42) {
    const source = allowedKeys(value, ["run", "sample"], "seedKeys");
    return Object.freeze({
        run: text(source.run ?? `bake-${seed}`, "seedKeys.run"),
        sample: text(source.sample ?? "sample", "seedKeys.sample"),
    });
}

function normalizeSnapshotPolicy(value = {}) {
    const source = value && typeof value === "object" && !Array.isArray(value)
        ? allowedKeys(value, ["id", "version"], "snapshotPolicy")
        : {};
    const policy = Object.freeze({
        id: text(source.id ?? STATIC_SNAPSHOT_POLICY.id, "snapshotPolicy.id", { identifier: true }),
        version: integer(source.version ?? STATIC_SNAPSHOT_POLICY.version, "snapshotPolicy.version", { min: 1 }),
    });
    if (policy.id !== STATIC_SNAPSHOT_POLICY.id || policy.version !== STATIC_SNAPSHOT_POLICY.version) {
        fail("snapshotPolicy", "VIS-07 supports only static-snapshot@1");
    }
    return policy;
}

function normalizeCachePolicy(value = {}) {
    const source = allowedKeys(value ?? {}, ["mode"], "cachePolicy");
    const mode = text(source.mode ?? DEFAULT_BAKE_CACHE_POLICY.mode, "cachePolicy.mode");
    if (!["none", "reuse-request"].includes(mode)) fail("cachePolicy.mode", "unsupported cache mode");
    return Object.freeze({ mode });
}

function capturedAppearanceOptions(value = {}) {
    const source = allowedKeys(value, ["transform"], "providerOptions");
    const transform = text(source.transform ?? CAPTURED_APPEARANCE_DEFAULT_OPTIONS.transform, "providerOptions.transform");
    if (transform !== "identity") fail("providerOptions.transform", "captured-appearance@1 is identity-only");
    return Object.freeze({ transform });
}

function normalizeProviderOptions(value, provider, providers) {
    const adapter = providers?.get(provider);
    const incoming = value && typeof value === "object" ? value : {};
    if (adapter?.normalizeOptions) return adapter.normalizeOptions(incoming);
    if (provider.id === CAPTURED_APPEARANCE_PROVIDER.id && provider.version === 1) {
        return capturedAppearanceOptions({ ...CAPTURED_APPEARANCE_DEFAULT_OPTIONS, ...incoming });
    }
    const keys = Object.keys(incoming).sort(compareUtf8);
    const normalized = {};
    for (const key of keys) {
        const entry = incoming[key];
        if (typeof entry === "number") normalized[key] = finite(entry, `providerOptions.${key}`);
        else if (typeof entry === "boolean") normalized[key] = entry;
        else if (typeof entry === "string") normalized[key] = entry;
        else if (entry === null) normalized[key] = null;
        else fail(`providerOptions.${key}`, "unsupported provider option type");
    }
    return Object.freeze(normalized);
}

function normalizeRoundTrip(value = {}) {
    const source = allowedKeys(value, [
        "useModel", "pollIntervalMs", "timeoutMs", "resultEndpoint",
    ], "operational.roundTrip");
    return Object.freeze({
        useModel: boolean(source.useModel ?? false, "operational.roundTrip.useModel"),
        pollIntervalMs: integer(source.pollIntervalMs ?? 1000, "operational.roundTrip.pollIntervalMs", { min: 1 }),
        timeoutMs: integer(source.timeoutMs ?? 300000, "operational.roundTrip.timeoutMs", { min: 1 }),
        resultEndpoint: text(source.resultEndpoint ?? "/bake/result", "operational.roundTrip.resultEndpoint"),
    });
}

function normalizeDebug(value = {}) {
    const source = allowedKeys(value, [
        "saveRawCaptures", "logPipeline", "buildingTileMaterials", "buildingTileSize",
    ], "operational.debug");
    return Object.freeze({
        saveRawCaptures: boolean(source.saveRawCaptures ?? false, "operational.debug.saveRawCaptures"),
        logPipeline: boolean(source.logPipeline ?? false, "operational.debug.logPipeline"),
        buildingTileMaterials: boolean(source.buildingTileMaterials ?? false, "operational.debug.buildingTileMaterials"),
        buildingTileSize: finite(source.buildingTileSize ?? 2, "operational.debug.buildingTileSize"),
    });
}

function normalizeSplat(value = {}) {
    const source = allowedKeys(value, [
        "enabled", "excludeTags", "bandNear", "bandFar", "maxSplatDistance", "renderMode",
        "maxPointsPerFrame", "coverageVoxelSize", "coverageNeighbor", "radius", "adaptiveRadius",
        "hideBakedGeometry", "hideThreshold", "maxSplats", "projectedTexture", "updateSliver",
    ], "operational.splat");
    const projected = allowedKeys(source.projectedTexture ?? {}, [
        "enabled", "opacity", "cellSizePx", "maxPixelDistancePx", "maxDepthDelta",
        "maxTriangleDepthDelta", "surfaceOffset",
    ], "operational.splat.projectedTexture");
    const sliver = allowedKeys(source.updateSliver ?? {}, [
        "enabled", "widthPx", "minMaskPixels", "requireBuildingHit",
    ], "operational.splat.updateSliver");
    return Object.freeze({
        enabled: boolean(source.enabled ?? true, "operational.splat.enabled"),
        excludeTags: tags(source.excludeTags ?? ["road"], "operational.splat.excludeTags"),
        bandNear: finite(source.bandNear ?? 0, "operational.splat.bandNear"),
        bandFar: finite(source.bandFar ?? 15, "operational.splat.bandFar"),
        maxSplatDistance: finite(source.maxSplatDistance ?? 60, "operational.splat.maxSplatDistance"),
        renderMode: text(source.renderMode ?? "projectedTexture", "operational.splat.renderMode"),
        maxPointsPerFrame: integer(source.maxPointsPerFrame ?? 20000, "operational.splat.maxPointsPerFrame", { min: 1 }),
        coverageVoxelSize: finite(source.coverageVoxelSize ?? 0.02, "operational.splat.coverageVoxelSize"),
        coverageNeighbor: boolean(source.coverageNeighbor ?? true, "operational.splat.coverageNeighbor"),
        radius: finite(source.radius ?? 0.01, "operational.splat.radius"),
        adaptiveRadius: boolean(source.adaptiveRadius ?? true, "operational.splat.adaptiveRadius"),
        hideBakedGeometry: boolean(source.hideBakedGeometry ?? false, "operational.splat.hideBakedGeometry"),
        hideThreshold: integer(source.hideThreshold ?? 50, "operational.splat.hideThreshold"),
        maxSplats: integer(source.maxSplats ?? 500000, "operational.splat.maxSplats", { min: 1 }),
        projectedTexture: Object.freeze({
            enabled: boolean(projected.enabled ?? true, "operational.splat.projectedTexture.enabled"),
            opacity: finite(projected.opacity ?? 1, "operational.splat.projectedTexture.opacity"),
            cellSizePx: integer(projected.cellSizePx ?? 10, "operational.splat.projectedTexture.cellSizePx", { min: 1 }),
            maxPixelDistancePx: integer(projected.maxPixelDistancePx ?? 16, "operational.splat.projectedTexture.maxPixelDistancePx"),
            maxDepthDelta: finite(projected.maxDepthDelta ?? 1.5, "operational.splat.projectedTexture.maxDepthDelta"),
            maxTriangleDepthDelta: finite(projected.maxTriangleDepthDelta ?? 1, "operational.splat.projectedTexture.maxTriangleDepthDelta"),
            surfaceOffset: finite(projected.surfaceOffset ?? 0.005, "operational.splat.projectedTexture.surfaceOffset"),
        }),
        updateSliver: Object.freeze({
            enabled: boolean(sliver.enabled ?? true, "operational.splat.updateSliver.enabled"),
            widthPx: integer(sliver.widthPx ?? 320, "operational.splat.updateSliver.widthPx", { min: 1 }),
            minMaskPixels: integer(sliver.minMaskPixels ?? 1, "operational.splat.updateSliver.minMaskPixels"),
            requireBuildingHit: boolean(sliver.requireBuildingHit ?? true, "operational.splat.updateSliver.requireBuildingHit"),
        }),
    });
}

function normalizeOperational(value = {}, seed = 42) {
    const source = value == null ? {} : allowedKeys(value, OPERATIONAL_KEYS, "operational");
    return Object.freeze({
        runId: text(source.runId ?? `bake-${seed}`, "operational.runId"),
        host: text(source.host ?? "http://localhost:8000", "operational.host"),
        endpoint: text(source.endpoint ?? "/bake", "operational.endpoint"),
        roundTrip: normalizeRoundTrip(source.roundTrip ?? {}),
        debug: normalizeDebug(source.debug ?? {}),
        splat: normalizeSplat(source.splat ?? {}),
        createdAt: source.createdAt == null ? null : text(source.createdAt, "operational.createdAt"),
        modelSettings: Object.freeze({
            steps: integer(source.modelSettings?.steps ?? 36, "operational.modelSettings.steps", { min: 1 }),
            guidance: finite(source.modelSettings?.guidance ?? 14, "operational.modelSettings.guidance"),
        }),
    });
}

export function adaptLegacyBakeRunConfigInput(options = {}) {
    const source = options && typeof options === "object" ? options : {};
    if (source.kind === BAKE_RUN_CONFIG_KIND) return source;
    const views = source.views ?? [{
        name: "bake/view/main",
        position: source.views?.[0]?.position ?? { x: 0, y: 1.6, z: 0 },
        rotation: source.views?.[0]?.rotation ?? { x: 0, y: 0, z: 0, order: "XYZ" },
        excludeTags: ["sign", "vehicle"],
        camera: source.views?.[0]?.camera ?? { width: 1920, height: 1080, fov: 75 },
        passes: source.views?.[0]?.passes ?? [{
            id: "beauty",
            kind: "render",
            excludeTags: ["sign", "vehicle"],
        }],
    }];
    const version = source.version ?? BAKE_CONTRACT_VERSION;
    return {
        kind: BAKE_RUN_CONFIG_KIND,
        version,
        environmentId: source.environmentId ?? "igvc",
        seed: source.seed ?? 42,
        paths: source.paths ?? [{
            id: "path-0",
            vertices: source.pathVertices ?? DEFAULT_PATH_VERTICES,
        }],
        views,
        buildings: source.buildings ?? [],
        passPolicy: source.passPolicy,
        planner: source.planner,
        sampling: {
            deltaDistance: source.deltaDistance ?? 2,
            ...(source.sampling ?? {}),
        },
        ordering: source.ordering,
        seedKeys: source.seedKeys,
        outputRoles: source.outputRoles,
        provider: source.provider,
        providerOptions: source.providerOptions,
        cachePolicy: source.cachePolicy,
        snapshotPolicy: source.snapshotPolicy,
        ...(Number(version) >= 2 || source.construction ? { construction: source.construction } : {}),
        operational: {
            runId: source.runId,
            host: source.host,
            endpoint: source.endpoint,
            roundTrip: source.roundTrip,
            debug: source.debug,
            splat: source.splat,
            createdAt: source.createdAt ?? null,
            modelSettings: source.modelSettings,
        },
    };
}

export function normalizeBakeRunConfig(value = {}, { providers = null } = {}) {
    const adapted = adaptLegacyBakeRunConfigInput(value);
    if (adapted.kind !== BAKE_RUN_CONFIG_KIND) fail("kind", `expected ${BAKE_RUN_CONFIG_KIND}`);
    const version = integer(adapted.version ?? BAKE_CONTRACT_VERSION, "version", { min: 1 });
    if (version !== BAKE_CONTRACT_VERSION && version !== BAKE_CONTRACT_VERSION_V2) {
        fail("version", "unsupported bake-run-config version");
    }
    allowedKeys(adapted, version >= 2 ? CONFIG_KEYS_V2 : CONFIG_KEYS, "bakeRunConfig");
    const seed = integer(adapted.seed ?? 42, "seed");
    const provider = providerRef(adapted.provider);
    const paths = Object.freeze(
        denseArray(adapted.paths ?? [{ id: "path-0", vertices: DEFAULT_PATH_VERTICES }], "paths")
            .map((entry, index) => normalizePath(entry, `paths.${index}`, `path-${index}`)),
    );
    const pathIds = paths.map((entry) => entry.id);
    if (new Set(pathIds).size !== pathIds.length) fail("paths", "contains duplicate IDs");
    const views = Object.freeze(
        denseArray(adapted.views ?? [{}], "views")
            .map((entry, index) => normalizeView(entry, `views.${index}`)),
    );
    const viewIds = views.map((entry) => entry.id);
    if (new Set(viewIds).size !== viewIds.length) fail("views", "contains duplicate IDs");
    const buildings = Object.freeze(
        denseArray(adapted.buildings ?? [], "buildings")
            .map((entry, index) => normalizeBuilding(entry, `buildings.${index}`)),
    );
    const buildingIds = buildings.map((entry) => entry.buildingId);
    if (new Set(buildingIds).size !== buildingIds.length) fail("buildings", "contains duplicate IDs");
    const roles = outputRoles(adapted.outputRoles ?? views[0]?.products);
    const construction = version >= 2
        ? normalizeBakeConstruction(adapted.construction ?? {})
        : undefined;
    const config = freezeDeep({
        kind: BAKE_RUN_CONFIG_KIND,
        version,
        environmentId: text(adapted.environmentId ?? "igvc", "environmentId", { identifier: true }),
        seed,
        paths: Object.freeze([...paths].sort((left, right) => compareUtf8(left.id, right.id))),
        views: Object.freeze([...views].sort((left, right) => compareUtf8(left.id, right.id))),
        buildings: Object.freeze([...buildings].sort((left, right) => compareUtf8(left.buildingId, right.buildingId))),
        passPolicy: normalizePassPolicy(adapted.passPolicy ?? {}),
        planner: normalizePlanner(adapted.planner ?? {}),
        sampling: normalizeSampling(adapted.sampling ?? {}),
        ordering: normalizeOrdering(adapted.ordering ?? {}),
        seedKeys: normalizeSeedKeys(adapted.seedKeys ?? {}, seed),
        outputRoles: roles,
        provider,
        providerOptions: normalizeProviderOptions(adapted.providerOptions, provider, providers),
        cachePolicy: normalizeCachePolicy(adapted.cachePolicy ?? {}),
        snapshotPolicy: normalizeSnapshotPolicy(adapted.snapshotPolicy ?? {}),
        operational: normalizeOperational(adapted.operational ?? {}, seed),
        ...(construction ? { construction } : {}),
    });
    return config;
}

export function bakeRecipeIdentity(config) {
    const normalized = config?.kind === BAKE_RUN_CONFIG_KIND && config?.operational
        ? config
        : normalizeBakeRunConfig(config);
    const keys = normalized.version >= 2 ? RECIPE_KEYS_V2 : RECIPE_KEYS;
    const identity = {};
    for (const key of keys) identity[key] = normalized[key];
    return freezeDeep(identity);
}

export function assertBakeRunConfig(value, { providers = null } = {}) {
    const normalized = normalizeBakeRunConfig(value, { providers });
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("bakeRunConfig", "immutable config is not in canonical normalized form");
    }
    return value;
}

export function hashBakeRunConfig(value, { providers = null } = {}) {
    const normalized = normalizeBakeRunConfig(value, { providers });
    return hashDocument(bakeRecipeIdentity(normalized));
}

export function mediaTypeForBakeRole(role) {
    if (role === "beauty") return "image/x.cev-sim.rgba8-srgb";
    const layout = VISUAL_CAPTURE_PRODUCT_LAYOUTS[role];
    if (!layout) fail("role", `unsupported bake role ${role}`);
    if (layout.arrayType === "Uint8Array") return "application/x.cev-sim.uint8";
    if (layout.arrayType === "Uint32Array") return "application/x.cev-sim.uint32-le";
    return "application/x.cev-sim.float32-le";
}

export function encodingForBakeRole(role) {
    return VISUAL_CAPTURE_PRODUCT_LAYOUTS[role]?.encoding ?? "little-endian";
}

export function pathLengthMeters(path) {
    const vertices = path?.vertices ?? [];
    if (vertices.length < 2) return 0;
    let total = 0;
    for (let index = 0; index < vertices.length - 1; index += 1) {
        total += hypot3(vertices[index].position, vertices[index + 1].position);
    }
    return total;
}

export function planIntegerSampleDistances(totalLength, sampling) {
    const length = finite(totalLength, "path.totalLength");
    if (length < 0) fail("path.totalLength", "must be non-negative");
    const delta = sampling.deltaDistance;
    const includeEndpoints = sampling.includeEndpoints !== false;
    if (!(length > 0)) return Object.freeze([0]);
    const distances = [];
    let index = 0;
    while (index * delta < length || (index === 0 && length === 0)) {
        distances.push(index * delta);
        index += 1;
        if (index > 1_000_000) fail("sampling", "sample count exceeded");
    }
    if (includeEndpoints && distances[distances.length - 1] !== length) distances.push(length);
    return Object.freeze(distances);
}

export function interpolateBakePathSample(vertices, distance) {
    const points = denseArray(vertices, "path.vertices").map((entry, index) => pathVertex(entry, `path.vertices.${index}`));
    if (points.length === 0) return null;
    if (points.length === 1 || !(pathLengthMeters({ vertices: points }) > 0)) {
        return Object.freeze({
            position: points[0].position,
            rotation: points[0].rotation,
            distance: 0,
            segmentIndex: 0,
            t: 0,
        });
    }
    const total = pathLengthMeters({ vertices: points });
    const clamped = Math.max(0, Math.min(finite(distance, "distance"), total));
    let accumulated = 0;
    for (let index = 0; index < points.length - 1; index += 1) {
        const start = points[index];
        const end = points[index + 1];
        const segmentLength = hypot3(start.position, end.position);
        const segmentEnd = accumulated + segmentLength;
        const isLast = index === points.length - 2;
        if (clamped > segmentEnd && !isLast) {
            accumulated = segmentEnd;
            continue;
        }
        if (!(segmentLength > 0)) {
            if (!isLast) {
                accumulated = segmentEnd;
                continue;
            }
            return Object.freeze({
                position: start.position,
                rotation: start.rotation,
                distance: clamped,
                segmentIndex: index,
                t: 0,
            });
        }
        const local = Math.max(0, Math.min(segmentLength, clamped - accumulated));
        const t = local / segmentLength;
        return Object.freeze({
            position: lerpVector(start.position, end.position, t),
            rotation: slerp(start.rotation, end.rotation, t),
            distance: clamped,
            segmentIndex: index,
            t,
        });
    }
    const last = points[points.length - 1];
    return Object.freeze({
        position: last.position,
        rotation: last.rotation,
        distance: total,
        segmentIndex: Math.max(0, points.length - 2),
        t: 1,
    });
}

export function canonicalizePlannerCandidates(entries = []) {
    const list = denseArray(entries, "planner.candidates").map((entry, index) => {
        const source = plainObject(entry, `planner.candidates.${index}`);
        const id = text(source.id ?? source.entityId, `planner.candidates.${index}.id`, { identifier: true });
        return Object.freeze({ ...source, id, entityId: text(source.entityId ?? id, `planner.candidates.${index}.entityId`, { identifier: true }) });
    });
    return Object.freeze([...list].sort((left, right) => (
        compareUtf8(left.id, right.id) || compareUtf8(left.entityId, right.entityId)
    )));
}

function chunkRecord(value, path) {
    const source = allowedKeys(value, ["id", "lodSignature", "lodUri", "lodIndex"], path);
    return Object.freeze({
        id: text(source.id, `${path}.id`, { identifier: true }),
        lodSignature: text(source.lodSignature ?? "", `${path}.lodSignature`, { allowEmpty: true }),
        lodUri: source.lodUri == null ? null : text(source.lodUri, `${path}.lodUri`),
        lodIndex: source.lodIndex == null ? null : integer(source.lodIndex, `${path}.lodIndex`),
    });
}

function geometryRecord(value, path) {
    const source = allowedKeys(value, ["entityId", "geometryDigest", "matrix", "visible"], path);
    return Object.freeze({
        entityId: text(source.entityId, `${path}.entityId`, { identifier: true }),
        geometryDigest: digest(source.geometryDigest, `${path}.geometryDigest`),
        matrix: Object.freeze(denseArray(source.matrix, `${path}.matrix`).map((entry, index) => finite(entry, `${path}.matrix.${index}`))),
        visible: boolean(source.visible ?? true, `${path}.visible`),
    });
}

function materialRecord(value, path) {
    const source = allowedKeys(value, ["entityId", "materialDigest", "opacity", "transparent"], path);
    return Object.freeze({
        entityId: text(source.entityId, `${path}.entityId`, { identifier: true }),
        materialDigest: digest(source.materialDigest, `${path}.materialDigest`),
        opacity: finite(source.opacity ?? 1, `${path}.opacity`),
        transparent: boolean(source.transparent ?? false, `${path}.transparent`),
    });
}

function lightingRecord(value, path) {
    const source = allowedKeys(value, ["id", "kind", "color", "intensity", "position", "quaternion"], path);
    return Object.freeze({
        id: text(source.id, `${path}.id`, { identifier: true }),
        kind: text(source.kind, `${path}.kind`),
        color: integer(source.color ?? 0, `${path}.color`),
        intensity: finite(source.intensity ?? 1, `${path}.intensity`),
        position: vector3(source.position ?? { x: 0, y: 0, z: 0 }, `${path}.position`),
        quaternion: quaternion(source.quaternion ?? { x: 0, y: 0, z: 0, w: 1 }, `${path}.quaternion`),
    });
}

export function normalizeBakeSourceSnapshot(value = {}) {
    if (value.kind !== BAKE_SOURCE_SNAPSHOT_KIND) fail("kind", `expected ${BAKE_SOURCE_SNAPSHOT_KIND}`);
    if (value.version !== BAKE_CONTRACT_VERSION) fail("version", "unsupported bake-source-snapshot version");
    allowedKeys(value, SNAPSHOT_KEYS, "snapshot");
    const policy = normalizeSnapshotPolicy(value.snapshotPolicy ?? STATIC_SNAPSHOT_POLICY);
    const uses = Object.freeze(uniqueSorted(value.sourceUseHashes ?? [], "sourceUseHashes", (entry, path) => digest(entry, path)));
    const selectedChunks = Object.freeze(
        denseArray(value.selectedChunks ?? [], "selectedChunks")
            .map((entry, index) => chunkRecord(entry, `selectedChunks.${index}`))
            .sort((left, right) => compareUtf8(left.id, right.id)),
    );
    const chunkIds = selectedChunks.map((entry) => entry.id);
    if (new Set(chunkIds).size !== chunkIds.length) fail("selectedChunks", "contains duplicate IDs");
    const closure = allowedKeys(value.resourceClosure ?? { complete: true, assetDigests: [] }, [
        "complete", "assetDigests",
    ], "resourceClosure");
    const assetDigests = Object.freeze(uniqueSorted(closure.assetDigests ?? [], "resourceClosure.assetDigests", (entry, path) => digest(entry, path)));
    if (boolean(closure.complete ?? true, "resourceClosure.complete") !== true) {
        throw bakeError("BAKE_CLOSURE_INCOMPLETE", "Bake snapshot requires a complete asset closure.");
    }
    const algorithms = allowedKeys(value.algorithms ?? {}, [
        "captureMode", "planner", "sampling", "lodPolicyHash",
    ], "algorithms");
    const captureMode = text(algorithms.captureMode ?? BAKE_CAPTURE_MODE, "algorithms.captureMode");
    if (captureMode !== BAKE_CAPTURE_MODE) fail("algorithms.captureMode", "unsupported capture mode");
    const dynamicActorPolicy = normalizeSnapshotPolicy(value.dynamicActorPolicy ?? policy);
    const snapshot = freezeDeep({
        kind: BAKE_SOURCE_SNAPSHOT_KIND,
        version: BAKE_CONTRACT_VERSION,
        snapshotPolicy: policy,
        worldHash: digest(value.worldHash, "worldHash"),
        environmentRevision: integer(value.environmentRevision ?? 0, "environmentRevision"),
        bakeGeneration: integer(value.bakeGeneration ?? 1, "bakeGeneration", { min: 1 }),
        visualDescriptorHash: digestOrNull(value.visualDescriptorHash ?? null, "visualDescriptorHash"),
        visualAccessHash: digestOrNull(value.visualAccessHash ?? null, "visualAccessHash"),
        sourceUseHashes: uses,
        selectedChunks,
        geometryState: Object.freeze(
            denseArray(value.geometryState ?? [], "geometryState")
                .map((entry, index) => geometryRecord(entry, `geometryState.${index}`))
                .sort((left, right) => compareUtf8(left.entityId, right.entityId)),
        ),
        materialState: Object.freeze(
            denseArray(value.materialState ?? [], "materialState")
                .map((entry, index) => materialRecord(entry, `materialState.${index}`))
                .sort((left, right) => compareUtf8(left.entityId, right.entityId)),
        ),
        lightingState: Object.freeze(
            denseArray(value.lightingState ?? [], "lightingState")
                .map((entry, index) => lightingRecord(entry, `lightingState.${index}`))
                .sort((left, right) => compareUtf8(left.id, right.id)),
        ),
        algorithms: Object.freeze({
            captureMode,
            planner: text(algorithms.planner ?? BAKE_PLANNER_ID, "algorithms.planner"),
            sampling: text(algorithms.sampling ?? BAKE_SAMPLING_ID, "algorithms.sampling"),
            lodPolicyHash: digestOrNull(algorithms.lodPolicyHash ?? null, "algorithms.lodPolicyHash"),
        }),
        outputRoles: outputRoles(value.outputRoles ?? DEFAULT_OUTPUT_ROLES),
        dynamicActorPolicy,
        resourceClosure: Object.freeze({ complete: true, assetDigests }),
        calibrations: Object.freeze(
            denseArray(value.calibrations ?? [], "calibrations")
                .map((entry, index) => Object.freeze({
                    viewId: text(entry.viewId, `calibrations.${index}.viewId`, { identifier: true }),
                    calibration: acceptCalibration(entry.calibration, `calibrations.${index}.calibration`),
                }))
                .sort((left, right) => compareUtf8(left.viewId, right.viewId)),
        ),
    });
    const geometryIds = snapshot.geometryState.map((entry) => entry.entityId);
    if (new Set(geometryIds).size !== geometryIds.length) fail("geometryState", "contains duplicate IDs");
    return snapshot;
}

export function assertBakeSourceSnapshot(value) {
    const normalized = normalizeBakeSourceSnapshot(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("snapshot", "immutable snapshot is not in canonical normalized form");
    }
    return value;
}

export function hashBakeSourceSnapshot(value) {
    return hashDocument(normalizeBakeSourceSnapshot(value));
}

function planView(value, path) {
    const source = allowedKeys(value, ["viewId", "pose", "calibration"], path);
    return Object.freeze({
        viewId: text(source.viewId, `${path}.viewId`, { identifier: true }),
        pose: pose(source.pose, `${path}.pose`),
        calibration: acceptCalibration(source.calibration, `${path}.calibration`),
    });
}

function planSample(value, path) {
    const source = allowedKeys(value, [
        "sampleId", "pathId", "sampleIndex", "segmentIndex", "t", "distance",
        "viewId", "pose", "products", "activeBuildingId", "visibleBuildingIds",
    ], path);
    return Object.freeze({
        sampleId: text(source.sampleId, `${path}.sampleId`, { identifier: true }),
        pathId: text(source.pathId, `${path}.pathId`, { identifier: true }),
        sampleIndex: integer(source.sampleIndex, `${path}.sampleIndex`),
        segmentIndex: integer(source.segmentIndex, `${path}.segmentIndex`),
        t: finite(source.t, `${path}.t`),
        distance: finite(source.distance, `${path}.distance`),
        viewId: text(source.viewId, `${path}.viewId`, { identifier: true }),
        pose: pose(source.pose, `${path}.pose`),
        products: outputRoles(source.products, `${path}.products`),
        activeBuildingId: source.activeBuildingId == null
            ? null
            : text(source.activeBuildingId, `${path}.activeBuildingId`, { identifier: true }),
        visibleBuildingIds: Object.freeze(uniqueSorted(
            source.visibleBuildingIds ?? [],
            `${path}.visibleBuildingIds`,
        )),
    });
}

export function normalizeBakeCapturePlan(value = {}) {
    if (value.kind !== BAKE_CAPTURE_PLAN_KIND) fail("kind", `expected ${BAKE_CAPTURE_PLAN_KIND}`);
    if (value.version !== BAKE_CONTRACT_VERSION) fail("version", "unsupported bake-capture-plan version");
    allowedKeys(value, PLAN_KEYS, "plan");
    const views = Object.freeze(
        denseArray(value.views ?? [], "plan.views")
            .map((entry, index) => planView(entry, `plan.views.${index}`))
            .sort((left, right) => compareUtf8(left.viewId, right.viewId)),
    );
    const viewIds = views.map((entry) => entry.viewId);
    if (new Set(viewIds).size !== viewIds.length) fail("plan.views", "contains duplicate IDs");
    const samples = Object.freeze(
        denseArray(value.samples ?? [], "plan.samples")
            .map((entry, index) => planSample(entry, `plan.samples.${index}`))
            .sort((left, right) => compareUtf8(left.sampleId, right.sampleId) || compareUtf8(left.viewId, right.viewId)),
    );
    const sampleIds = samples.map((entry) => `${entry.sampleId}:${entry.viewId}`);
    if (new Set(sampleIds).size !== sampleIds.length) fail("plan.samples", "contains duplicate IDs");
    return freezeDeep({
        kind: BAKE_CAPTURE_PLAN_KIND,
        version: BAKE_CONTRACT_VERSION,
        recipeHash: digest(value.recipeHash, "plan.recipeHash"),
        snapshotHash: digest(value.snapshotHash, "plan.snapshotHash"),
        captureTimeNs: integer(value.captureTimeNs ?? 0, "plan.captureTimeNs"),
        views,
        samples,
    });
}

export function assertBakeCapturePlan(value) {
    const normalized = normalizeBakeCapturePlan(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("plan", "immutable plan is not in canonical normalized form");
    }
    return value;
}

export function hashBakeCapturePlan(value) {
    return hashDocument(normalizeBakeCapturePlan(value));
}

export function composeBakePoses(pathPose, viewPose) {
    const rotation = quaternion({
        x: pathPose.rotation.w * viewPose.rotation.x + pathPose.rotation.x * viewPose.rotation.w
            + pathPose.rotation.y * viewPose.rotation.z - pathPose.rotation.z * viewPose.rotation.y,
        y: pathPose.rotation.w * viewPose.rotation.y - pathPose.rotation.x * viewPose.rotation.z
            + pathPose.rotation.y * viewPose.rotation.w + pathPose.rotation.z * viewPose.rotation.x,
        z: pathPose.rotation.w * viewPose.rotation.z + pathPose.rotation.x * viewPose.rotation.y
            - pathPose.rotation.y * viewPose.rotation.x + pathPose.rotation.z * viewPose.rotation.w,
        w: pathPose.rotation.w * viewPose.rotation.w - pathPose.rotation.x * viewPose.rotation.x
            - pathPose.rotation.y * viewPose.rotation.y - pathPose.rotation.z * viewPose.rotation.z,
    }, "composed.rotation");
    const vx = viewPose.position.x;
    const vy = viewPose.position.y;
    const vz = viewPose.position.z;
    const qx = pathPose.rotation.x;
    const qy = pathPose.rotation.y;
    const qz = pathPose.rotation.z;
    const qw = pathPose.rotation.w;
    const ix = qw * vx + qy * vz - qz * vy;
    const iy = qw * vy + qz * vx - qx * vz;
    const iz = qw * vz + qx * vy - qy * vx;
    const iw = -qx * vx - qy * vy - qz * vz;
    const rotated = {
        x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
        y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
        z: iz * qw + iw * -qz + ix * -qy - iy * -qx,
    };
    return Object.freeze({
        position: Object.freeze({
            x: pathPose.position.x + rotated.x,
            y: pathPose.position.y + rotated.y,
            z: pathPose.position.z + rotated.z,
        }),
        rotation,
    });
}

export function buildBakeCapturePlan({ config, snapshot, regionsBySample = {} } = {}) {
    const normalizedConfig = normalizeBakeRunConfig(config);
    const normalizedSnapshot = normalizeBakeSourceSnapshot(snapshot);
    const recipeHash = hashBakeRunConfig(normalizedConfig);
    const snapshotHash = hashBakeSourceSnapshot(normalizedSnapshot);
    const views = normalizedConfig.views.map((view) => ({
        viewId: view.id,
        pose: view.pose,
        calibration: view.calibration,
    }));
    const samples = [];
    for (const path of normalizedConfig.paths) {
        const distances = planIntegerSampleDistances(pathLengthMeters(path), normalizedConfig.sampling);
        for (let sampleIndex = 0; sampleIndex < distances.length; sampleIndex += 1) {
            const interpolated = interpolateBakePathSample(path.vertices, distances[sampleIndex]);
            for (const view of normalizedConfig.views) {
                const sampleId = `${normalizedConfig.seedKeys.run}:${path.id}:${sampleIndex}`;
                const regionKey = `${sampleId}:${view.id}`;
                const region = regionsBySample[regionKey] ?? {
                    activeBuildingId: null,
                    visibleBuildingIds: [],
                };
                samples.push({
                    sampleId,
                    pathId: path.id,
                    sampleIndex,
                    segmentIndex: interpolated.segmentIndex,
                    t: interpolated.t,
                    distance: interpolated.distance,
                    viewId: view.id,
                    pose: composeBakePoses(interpolated, view.pose),
                    products: view.products,
                    activeBuildingId: region.activeBuildingId ?? null,
                    visibleBuildingIds: region.visibleBuildingIds ?? [],
                });
            }
        }
    }
    return normalizeBakeCapturePlan({
        kind: BAKE_CAPTURE_PLAN_KIND,
        version: BAKE_CONTRACT_VERSION,
        recipeHash,
        snapshotHash,
        captureTimeNs: normalizedConfig.sampling.captureTimeNs,
        views,
        samples,
    });
}

export function normalizeDigestRecord(value = {}, path = "digest") {
    const source = allowedKeys(value, DIGEST_RECORD_KEYS, path);
    const role = text(source.role, `${path}.role`);
    if (!BAKE_OUTPUT_ROLES.includes(role) && !VISUAL_CAPTURE_PRODUCTS[VISUAL_CAPTURE_PASS_FAMILIES.analytic]?.includes(role)) {
        fail(`${path}.role`, `unsupported output role ${role}`);
    }
    const width = integer(source.width, `${path}.width`, { min: 1 });
    const height = integer(source.height, `${path}.height`, { min: 1 });
    const byteSize = integer(source.byteSize, `${path}.byteSize`, { min: 0 });
    const layout = VISUAL_CAPTURE_PRODUCT_LAYOUTS[role];
    const bytesPerValue = layout.arrayType === "Uint8Array" ? 1 : 4;
    const expected = width * height * layout.channels * bytesPerValue;
    if (byteSize !== expected) fail(`${path}.byteSize`, `expected ${expected} bytes`);
    return Object.freeze({
        sampleId: text(source.sampleId, `${path}.sampleId`, { identifier: true }),
        viewId: text(source.viewId, `${path}.viewId`, { identifier: true }),
        role,
        mediaType: text(source.mediaType, `${path}.mediaType`),
        encoding: text(source.encoding, `${path}.encoding`),
        byteSize,
        width,
        height,
        sha256: digest(source.sha256, `${path}.sha256`),
    });
}

export function hashCaptureProductBuffer(data) {
    return sha256ExactBytes(serializeCaptureProductLittleEndian(data));
}

export function createBakeProductDigest({
    sampleId,
    viewId,
    role,
    data,
    width,
    height,
} = {}) {
    const layout = VISUAL_CAPTURE_PRODUCT_LAYOUTS[role];
    if (!layout) fail("role", `unsupported bake role ${role}`);
    const bytes = serializeCaptureProductLittleEndian(data);
    return normalizeDigestRecord({
        sampleId,
        viewId,
        role,
        mediaType: mediaTypeForBakeRole(role),
        encoding: encodingForBakeRole(role),
        byteSize: bytes.byteLength,
        width,
        height,
        sha256: sha256ExactBytes(bytes),
    });
}

export function normalizeBakeProviderRequest(value = {}) {
    if (value.kind !== BAKE_PROVIDER_REQUEST_KIND) fail("kind", `expected ${BAKE_PROVIDER_REQUEST_KIND}`);
    if (value.version !== BAKE_CONTRACT_VERSION) fail("version", "unsupported bake-provider-request version");
    allowedKeys(value, REQUEST_KEYS, "request");
    const inputs = Object.freeze(
        denseArray(value.inputs ?? [], "request.inputs")
            .map((entry, index) => normalizeDigestRecord(entry, `request.inputs.${index}`))
            .sort((left, right) => compareUtf8(`${left.sampleId}:${left.viewId}:${left.role}`, `${right.sampleId}:${right.viewId}:${right.role}`)),
    );
    const keys = inputs.map((entry) => `${entry.sampleId}:${entry.viewId}:${entry.role}`);
    if (new Set(keys).size !== keys.length) fail("request.inputs", "contains duplicate outputs");
    return freezeDeep({
        kind: BAKE_PROVIDER_REQUEST_KIND,
        version: BAKE_CONTRACT_VERSION,
        recipeHash: digest(value.recipeHash, "request.recipeHash"),
        snapshotHash: digest(value.snapshotHash, "request.snapshotHash"),
        planHash: digest(value.planHash, "request.planHash"),
        provider: providerRef(value.provider, "request.provider"),
        providerOptions: Object.freeze({ ...(value.providerOptions ?? {}) }),
        cachePolicy: normalizeCachePolicy(value.cachePolicy ?? {}),
        seed: integer(value.seed ?? 0, "request.seed"),
        inputs,
    });
}

export function assertBakeProviderRequest(value) {
    const normalized = normalizeBakeProviderRequest(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("request", "immutable request is not in canonical normalized form");
    }
    return value;
}

export function hashBakeProviderRequest(value) {
    return hashDocument(normalizeBakeProviderRequest(value));
}

function dimensionRecord(value, path) {
    const source = allowedKeys(value ?? {}, ["width", "height"], path);
    return Object.freeze({
        width: integer(source.width ?? 0, `${path}.width`),
        height: integer(source.height ?? 0, `${path}.height`),
    });
}

export function normalizeBakeProviderResponse(value = {}) {
    if (value.kind !== BAKE_PROVIDER_RESPONSE_KIND) fail("kind", `expected ${BAKE_PROVIDER_RESPONSE_KIND}`);
    if (value.version !== BAKE_CONTRACT_VERSION) fail("version", "unsupported bake-provider-response version");
    allowedKeys(value, RESPONSE_KEYS, "response");
    const outputs = Object.freeze(
        denseArray(value.outputs ?? [], "response.outputs")
            .map((entry, index) => normalizeDigestRecord(entry, `response.outputs.${index}`))
            .sort((left, right) => compareUtf8(`${left.sampleId}:${left.viewId}:${left.role}`, `${right.sampleId}:${right.viewId}:${right.role}`)),
    );
    const keys = outputs.map((entry) => `${entry.sampleId}:${entry.viewId}:${entry.role}`);
    if (new Set(keys).size !== keys.length) fail("response.outputs", "contains duplicate outputs");
    const runtimeStack = allowedKeys(value.runtimeStack ?? {}, ["kind", "version"], "response.runtimeStack");
    const codecRevisions = allowedKeys(value.codecRevisions ?? {}, ["capture"], "response.codecRevisions");
    return freezeDeep({
        kind: BAKE_PROVIDER_RESPONSE_KIND,
        version: BAKE_CONTRACT_VERSION,
        requestHash: digest(value.requestHash, "response.requestHash"),
        outputs,
        providerRevision: text(value.providerRevision, "response.providerRevision"),
        modelRevision: stringOrNull(value.modelRevision ?? null, "response.modelRevision"),
        weightsDigest: digestOrNull(value.weightsDigest ?? null, "response.weightsDigest"),
        prompts: value.prompts == null ? null : freezeDeep(value.prompts),
        configuration: freezeDeep(value.configuration ?? {}),
        runtimeOptions: freezeDeep(value.runtimeOptions ?? {}),
        seed: integer(value.seed ?? 0, "response.seed"),
        sourceDimensions: dimensionRecord(value.sourceDimensions, "response.sourceDimensions"),
        effectiveDimensions: dimensionRecord(value.effectiveDimensions, "response.effectiveDimensions"),
        codecRevisions: Object.freeze({
            capture: text(codecRevisions.capture ?? "aligned-products@1", "response.codecRevisions.capture"),
        }),
        runtimeStack: Object.freeze({
            kind: text(runtimeStack.kind ?? "local-no-model", "response.runtimeStack.kind"),
            version: integer(runtimeStack.version ?? 1, "response.runtimeStack.version", { min: 1 }),
        }),
        nondeterminismScope: text(value.nondeterminismScope ?? "none", "response.nondeterminismScope"),
        cachePolicy: normalizeCachePolicy(value.cachePolicy ?? {}),
    });
}

export function assertBakeProviderResponse(value) {
    const normalized = normalizeBakeProviderResponse(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("response", "immutable response is not in canonical normalized form");
    }
    return value;
}

export function hashBakeProviderResponse(value) {
    return hashDocument(normalizeBakeProviderResponse(value));
}

export function validateProviderResponseAgainstRequest(response, request, { generation = null, jobGeneration = null } = {}) {
    const normalizedRequest = normalizeBakeProviderRequest(request);
    const normalizedResponse = normalizeBakeProviderResponse(response);
    const requestHash = hashBakeProviderRequest(normalizedRequest);
    if (normalizedResponse.requestHash !== requestHash) {
        throw bakeError("BAKE_RESPONSE_MISMATCH", "Provider response requestHash does not match the active request.");
    }
    if (generation != null && jobGeneration != null && generation !== jobGeneration) {
        throw bakeError("BAKE_GENERATION_MISMATCH", "Provider response generation does not match the active bake generation.");
    }
    const inputByKey = new Map(normalizedRequest.inputs.map((entry) => [
        `${entry.sampleId}:${entry.viewId}:${entry.role}`,
        entry,
    ]));
    const outputKeys = new Set();
    for (const output of normalizedResponse.outputs) {
        const key = `${output.sampleId}:${output.viewId}:${output.role}`;
        if (outputKeys.has(key)) {
            throw bakeError("BAKE_RESPONSE_MISMATCH", "Provider response contains duplicate output roles.");
        }
        outputKeys.add(key);
        const input = inputByKey.get(key);
        if (!input) {
            throw bakeError("BAKE_RESPONSE_MISMATCH", `Provider response includes extra role ${output.role}.`);
        }
        if (output.width !== input.width || output.height !== input.height) {
            throw bakeError("BAKE_RESPONSE_MISMATCH", `Provider output dimensions do not match role ${output.role}.`);
        }
        if (output.encoding !== input.encoding || output.mediaType !== input.mediaType) {
            throw bakeError("BAKE_RESPONSE_MISMATCH", `Provider output encoding does not match role ${output.role}.`);
        }
        if (output.sha256 !== input.sha256 || output.byteSize !== input.byteSize) {
            throw bakeError("BAKE_RESPONSE_MISMATCH", `Provider output digest does not match role ${output.role}.`);
        }
    }
    for (const key of inputByKey.keys()) {
        if (!outputKeys.has(key)) {
            throw bakeError("BAKE_RESPONSE_MISMATCH", `Provider response is missing required role ${key}.`);
        }
    }
    if (!normalizedResponse.providerRevision) {
        throw bakeError("BAKE_RESPONSE_MISMATCH", "Provider response is missing provenance.");
    }
    return normalizedResponse;
}

export function normalizeBakeJobStatus(value = {}) {
    if (value.kind !== BAKE_JOB_STATUS_KIND) fail("kind", `expected ${BAKE_JOB_STATUS_KIND}`);
    if (value.version !== BAKE_CONTRACT_VERSION) fail("version", "unsupported bake-job-status version");
    allowedKeys(value, STATUS_KEYS, "status");
    const state = text(value.state, "status.state");
    if (!Object.values(BAKE_JOB_STATES).includes(state)) fail("status.state", "unsupported job state");
    const phase = text(value.phase, "status.phase");
    if (!Object.values(BAKE_JOB_PHASES).includes(phase)) fail("status.phase", "unsupported job phase");
    const progress = allowedKeys(value.progress ?? {}, ["completedSamples", "totalSamples"], "status.progress");
    const timestamps = allowedKeys(value.timestamps ?? {}, ["createdAt", "startedAt", "finishedAt"], "status.timestamps");
    const logs = Object.freeze(denseArray(value.logs ?? [], "status.logs").map((entry, index) => {
        const log = allowedKeys(entry, ["at", "level", "message"], `status.logs.${index}`);
        return Object.freeze({
            at: integer(log.at, `status.logs.${index}.at`),
            level: text(log.level, `status.logs.${index}.level`),
            message: text(log.message, `status.logs.${index}.message`, { allowEmpty: true }),
        });
    }));
    const failure = value.failure == null ? null : freezeDeep({
        code: text(value.failure.code, "status.failure.code"),
        message: text(value.failure.message, "status.failure.message"),
    });
    return freezeDeep({
        kind: BAKE_JOB_STATUS_KIND,
        version: BAKE_CONTRACT_VERSION,
        jobId: text(value.jobId, "status.jobId"),
        generation: integer(value.generation, "status.generation", { min: 1 }),
        phase,
        state,
        progress: Object.freeze({
            completedSamples: integer(progress.completedSamples ?? 0, "status.progress.completedSamples"),
            totalSamples: integer(progress.totalSamples ?? 0, "status.progress.totalSamples"),
        }),
        timestamps: Object.freeze({
            createdAt: integer(timestamps.createdAt ?? 0, "status.timestamps.createdAt"),
            startedAt: timestamps.startedAt == null ? null : integer(timestamps.startedAt, "status.timestamps.startedAt"),
            finishedAt: timestamps.finishedAt == null ? null : integer(timestamps.finishedAt, "status.timestamps.finishedAt"),
        }),
        logs,
        failure,
        recipeHash: digestOrNull(value.recipeHash ?? null, "status.recipeHash"),
        snapshotHash: digestOrNull(value.snapshotHash ?? null, "status.snapshotHash"),
        planHash: digestOrNull(value.planHash ?? null, "status.planHash"),
        requestHash: digestOrNull(value.requestHash ?? null, "status.requestHash"),
        responseHash: digestOrNull(value.responseHash ?? null, "status.responseHash"),
    });
}

export function isTerminalBakeState(state) {
    return BAKE_TERMINAL_STATES.includes(state);
}

function createCapturedAppearanceProvider() {
    return {
        id: CAPTURED_APPEARANCE_PROVIDER.id,
        version: CAPTURED_APPEARANCE_PROVIDER.version,
        local: true,
        requiresModel: false,
        available: true,
        supportsBoundedStreaming: true,
        defaultOptions: { ...CAPTURED_APPEARANCE_DEFAULT_OPTIONS },
        normalizeOptions: capturedAppearanceOptions,
        async execute(request) {
            const normalized = normalizeBakeProviderRequest(request);
            const requestHash = hashBakeProviderRequest(normalized);
            const first = normalized.inputs[0];
            return normalizeBakeProviderResponse({
                kind: BAKE_PROVIDER_RESPONSE_KIND,
                version: BAKE_CONTRACT_VERSION,
                requestHash,
                outputs: normalized.inputs.map((entry) => ({ ...entry })),
                providerRevision: "captured-appearance@1",
                modelRevision: null,
                weightsDigest: null,
                prompts: null,
                configuration: { transform: "identity" },
                runtimeOptions: normalized.providerOptions,
                seed: normalized.seed,
                sourceDimensions: first ? { width: first.width, height: first.height } : { width: 0, height: 0 },
                effectiveDimensions: first ? { width: first.width, height: first.height } : { width: 0, height: 0 },
                codecRevisions: { capture: "aligned-products@1" },
                runtimeStack: { kind: "local-no-model", version: 1 },
                nondeterminismScope: "none",
                cachePolicy: normalized.cachePolicy,
            });
        },
    };
}

export class BakeProviderRegistry {
    constructor(providers = []) {
        this._providers = new Map();
        for (const provider of providers) this.register(provider);
    }

    register(provider) {
        if (!provider?.id || !Number.isSafeInteger(provider.version)) {
            throw bakeError("BAKE_PROVIDER_INVALID", "A provider id and version are required.");
        }
        this._providers.set(providerKey(provider), provider);
        return this;
    }

    get(provider) {
        return this._providers.get(providerKey(providerRef(provider))) ?? null;
    }

    has(provider) {
        const adapter = this.get(provider);
        return Boolean(adapter && adapter.available !== false);
    }

    preflight(provider, { incremental = false } = {}) {
        const requested = providerRef(provider);
        const adapter = this.get(requested);
        if (!adapter || adapter.available === false) {
            throw bakeError(
                "BAKE_PROVIDER_UNAVAILABLE",
                `Requested bake provider ${requested.id}@${requested.version} is unavailable.`,
            );
        }
        if (adapter.requiresModel === true) {
            throw bakeError(
                "BAKE_PROVIDER_UNAVAILABLE",
                `Requested bake provider ${requested.id}@${requested.version} requires a model capability.`,
            );
        }
        if (incremental && adapter.supportsBoundedStreaming !== true) {
            throw bakeError(
                "BAKE_PROVIDER_UNAVAILABLE",
                `Requested bake provider ${requested.id}@${requested.version} does not support bounded streaming capture.`,
            );
        }
        return adapter;
    }

    list() {
        return [...this._providers.values()].map((provider) => ({
            id: provider.id,
            version: provider.version,
            available: provider.available !== false,
            local: provider.local === true,
            requiresModel: provider.requiresModel === true,
            supportsBoundedStreaming: provider.supportsBoundedStreaming === true,
        }));
    }
}

export function createDefaultBakeProviderRegistry() {
    return new BakeProviderRegistry([createCapturedAppearanceProvider()]);
}

function cloneStatus(status, patch = {}) {
    return normalizeBakeJobStatus({
        ...status,
        ...patch,
        progress: { ...status.progress, ...(patch.progress ?? {}) },
        timestamps: { ...status.timestamps, ...(patch.timestamps ?? {}) },
        logs: patch.logs ?? status.logs,
        failure: patch.failure === undefined ? status.failure : patch.failure,
    });
}

export class BakeRunCatalog {
    constructor({ providers = createDefaultBakeProviderRegistry(), now = () => Date.now() } = {}) {
        this.providers = providers;
        this.now = now;
        this._jobs = new Map();
        this._seq = 0;
    }

    createJob(config, { jobId = null, generation = 1, incremental = false } = {}) {
        const normalized = normalizeBakeRunConfig(config, { providers: this.providers });
        this.providers.preflight(normalized.provider, { incremental });
        const recipeHash = hashBakeRunConfig(normalized, { providers: this.providers });
        this._seq += 1;
        const id = jobId ?? `bake-job-${this._seq}`;
        if (this._jobs.has(id)) throw bakeError("BAKE_CONTRACT_INVALID", `Duplicate bake job id ${id}.`);
        const createdAt = this.now();
        const status = normalizeBakeJobStatus({
            kind: BAKE_JOB_STATUS_KIND,
            version: BAKE_CONTRACT_VERSION,
            jobId: id,
            generation: integer(generation, "generation", { min: 1 }),
            phase: BAKE_JOB_PHASES.prepare,
            state: BAKE_JOB_STATES.queued,
            progress: { completedSamples: 0, totalSamples: 0 },
            timestamps: { createdAt, startedAt: null, finishedAt: null },
            logs: [],
            failure: null,
            recipeHash,
            snapshotHash: null,
            planHash: null,
            requestHash: null,
            responseHash: null,
        });
        const job = {
            jobId: id,
            generation: status.generation,
            config: normalized,
            recipeHash,
            snapshot: null,
            snapshotHash: null,
            plan: null,
            planHash: null,
            request: null,
            requestHash: null,
            response: null,
            responseHash: null,
            status,
        };
        this._jobs.set(id, job);
        return job;
    }

    get(jobId) {
        return this._jobs.get(jobId) ?? null;
    }

    list() {
        return [...this._jobs.values()];
    }

    updateStatus(jobId, patch = {}) {
        const job = this._require(jobId);
        job.status = cloneStatus(job.status, patch);
        return job;
    }

    appendLog(jobId, message, { level = "info" } = {}) {
        const job = this._require(jobId);
        job.status = cloneStatus(job.status, {
            logs: [...job.status.logs, { at: this.now(), level, message }],
        });
        return job;
    }

    attachSnapshot(jobId, snapshot) {
        const job = this._requireActive(jobId);
        const normalized = normalizeBakeSourceSnapshot(snapshot);
        job.snapshot = normalized;
        job.snapshotHash = hashBakeSourceSnapshot(normalized);
        job.status = cloneStatus(job.status, { snapshotHash: job.snapshotHash });
        return job;
    }

    attachPlan(jobId, plan) {
        const job = this._requireActive(jobId);
        const normalized = normalizeBakeCapturePlan(plan);
        if (normalized.recipeHash !== job.recipeHash || normalized.snapshotHash !== job.snapshotHash) {
            throw bakeError("BAKE_CONTRACT_INVALID", "Capture plan hashes do not match the active job.");
        }
        job.plan = normalized;
        job.planHash = hashBakeCapturePlan(normalized);
        job.status = cloneStatus(job.status, {
            planHash: job.planHash,
            progress: { totalSamples: normalized.samples.length, completedSamples: job.status.progress.completedSamples },
        });
        return job;
    }

    attachRequest(jobId, request) {
        const job = this._requireActive(jobId);
        const normalized = normalizeBakeProviderRequest(request);
        if (
            normalized.recipeHash !== job.recipeHash
            || normalized.snapshotHash !== job.snapshotHash
            || normalized.planHash !== job.planHash
        ) {
            throw bakeError("BAKE_CONTRACT_INVALID", "Provider request hashes do not match the active job.");
        }
        job.request = normalized;
        job.requestHash = hashBakeProviderRequest(normalized);
        job.status = cloneStatus(job.status, {
            phase: BAKE_JOB_PHASES.provider,
            requestHash: job.requestHash,
        });
        return job;
    }

    attachResponse(jobId, response, { generation = null } = {}) {
        const job = this._require(jobId);
        if (isTerminalBakeState(job.status.state) || job.status.state === BAKE_JOB_STATES.superseded) {
            throw bakeError("BAKE_JOB_TERMINAL", "Late provider responses cannot attach to a terminal or superseded job.");
        }
        if (!job.request) {
            throw bakeError("BAKE_CONTRACT_INVALID", "A provider request is required before attaching a response.");
        }
        if (generation != null && generation !== job.generation) {
            throw bakeError("BAKE_GENERATION_MISMATCH", "Provider response generation does not match the active bake generation.");
        }
        const normalized = validateProviderResponseAgainstRequest(response, job.request, {
            generation,
            jobGeneration: job.generation,
        });
        if (normalized.requestHash !== job.requestHash) {
            throw bakeError("BAKE_RESPONSE_MISMATCH", "Provider response requestHash does not match the active request.");
        }
        job.response = normalized;
        job.responseHash = hashBakeProviderResponse(normalized);
        job.status = cloneStatus(job.status, { responseHash: job.responseHash });
        return job;
    }

    complete(jobId) {
        const job = this._requireActive(jobId);
        job.status = cloneStatus(job.status, {
            phase: BAKE_JOB_PHASES.terminal,
            state: BAKE_JOB_STATES.completed,
            timestamps: { finishedAt: this.now() },
        });
        return job;
    }

    fail(jobId, error) {
        const job = this._require(jobId);
        job.status = cloneStatus(job.status, {
            phase: BAKE_JOB_PHASES.terminal,
            state: BAKE_JOB_STATES.failed,
            timestamps: { finishedAt: this.now() },
            failure: {
                code: error?.code ?? "BAKE_JOB_FAILED",
                message: error?.message ?? String(error),
            },
        });
        return job;
    }

    cancel(jobId) {
        const job = this._require(jobId);
        if (isTerminalBakeState(job.status.state)) {
            throw bakeError("BAKE_JOB_TERMINAL", "A terminal job cannot be cancelled.");
        }
        job.status = cloneStatus(job.status, {
            phase: BAKE_JOB_PHASES.terminal,
            state: BAKE_JOB_STATES.cancelled,
            timestamps: { finishedAt: this.now() },
        });
        return job;
    }

    supersede(jobId) {
        const job = this._require(jobId);
        if (isTerminalBakeState(job.status.state) && job.status.state !== BAKE_JOB_STATES.superseded) {
            throw bakeError("BAKE_JOB_TERMINAL", "A terminal job cannot be superseded.");
        }
        job.status = cloneStatus(job.status, {
            phase: BAKE_JOB_PHASES.terminal,
            state: BAKE_JOB_STATES.superseded,
            timestamps: { finishedAt: this.now() },
        });
        return job;
    }

    _require(jobId) {
        const job = this._jobs.get(jobId);
        if (!job) throw bakeError("BAKE_CONTRACT_INVALID", `Unknown bake job ${jobId}.`);
        return job;
    }

    _requireActive(jobId) {
        const job = this._require(jobId);
        if (isTerminalBakeState(job.status.state)) {
            throw bakeError("BAKE_JOB_TERMINAL", `Bake job ${jobId} is already ${job.status.state}.`);
        }
        return job;
    }
}
