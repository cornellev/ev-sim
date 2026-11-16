import { Quaternion, Vector3 } from "three";
import { validateNativeTopicValue } from "../simulation/NativeTopicContracts.js";
/**
 * Renderer-neutral primitives for candidate/oracle perception and localization overlays.
 * Capture-time metadata travels with each snapshot for replay.
 */

import {
    composeRep103Poses,
    quaternionToEuler,
    rep103OrientationToThreeEuler,
    rep103PoseToThree,
    rep103ToThreeVector,
    rotateVectorByQuaternion,
} from "./CoordinateFrames.js";

export const VISUALIZATION_STATUS = Object.freeze({
    OK: "ok",
    WAITING: "waiting",
    INACTIVE: "inactive",
    STALE: "stale",
    INVALID: "invalid",
    REJECTED: "rejected",
    MISSING_FRAME: "missing-frame",
});

export function recentObstacleContacts(events, vehicleId) {
    const ids = new Set();
    for (const event of events) {
        if (event.category !== "contacts" || event.name !== "contact-start") continue;
        const { firstId, secondId } = event.payload || {};
        const other = firstId === vehicleId ? secondId : secondId === vehicleId ? firstId : null;
        if (other && !other.startsWith("ground:")) ids.add(other);
    }
    return [...ids].sort();
}

export function emptyPerceptionSnapshot(meta = {}) {
    return {
        captureTimeNs: meta.captureTimeNs ?? null,
        arrivalTimeNs: meta.arrivalTimeNs ?? null,
        applyTimeNs: meta.applyTimeNs ?? null,
        status: meta.status || VISUALIZATION_STATUS.WAITING,
        statusCode: meta.statusCode || null,
        ageNs: meta.ageNs ?? null,
        detections2d: [],
        detections3d: [],
        lanes: [],
        semantic: null,
    };
}

export function emptyLocalizationSnapshot(meta = {}) {
    return {
        captureTimeNs: meta.captureTimeNs ?? null,
        arrivalTimeNs: meta.arrivalTimeNs ?? null,
        applyTimeNs: meta.applyTimeNs ?? null,
        status: meta.status || VISUALIZATION_STATUS.WAITING,
        statusCode: meta.statusCode || null,
        ageNs: meta.ageNs ?? null,
        estimate: null,
        truth: null,
        error: null,
    };
}

export function emptyControlsSnapshot(meta = {}) {
    return {
        vehicleId: meta.vehicleId || "ego",
        captureTimeNs: meta.captureTimeNs ?? null,
        arrivalTimeNs: meta.arrivalTimeNs ?? null,
        applyTimeNs: meta.applyTimeNs ?? null,
        status: meta.status || VISUALIZATION_STATUS.OK,
        statusCode: meta.statusCode || null,
        ageNs: meta.ageNs ?? null,
        sequence: meta.sequence ?? 0,
        mode: meta.mode || "stop",
        authority: meta.authority || "candidate",
        ...(meta.commandSource ? { commandSource: String(meta.commandSource) } : {}),
        heartbeatAgeNs: meta.heartbeatAgeNs ?? null,
        delayNs: meta.delayNs ?? 0,
        flags: {
            timedOut: false,
            saturated: false,
            rateLimited: false,
            fallbackActive: false,
            delayed: false,
            ...(meta.flags || {}),
        },
        requested: null,
        applied: null,
        achieved: null,
        deltas: {
            requestedVsAppliedSpeed: 0,
            appliedVsAchievedSpeed: 0,
            requestedVsAppliedSteer: 0,
            appliedVsAchievedSteer: 0,
        },
        referenceShadow: null,
        wheelbase: meta.wheelbase ?? 1.5,
    };
}

export function normalizeControlsSnapshot(source = {}) {
    const base = emptyControlsSnapshot(source);
    const finitePair = (entry) => (entry && typeof entry === "object" ? {
        speedMps: Number(entry.speedMps) || 0,
        steeringRad: Number(entry.steeringRad) || 0,
        accelerationMps2: Number(entry.accelerationMps2) || 0,
    } : null);
    return {
        ...base,
        sequence: typeof source.sequence === "string" ? source.sequence : Math.max(0, Math.floor(Number(source.sequence) || 0)),
        mode: String(source.mode || base.mode),
        authority: String(source.authority || base.authority),
        heartbeatAgeNs: finiteNumber(source.heartbeatAgeNs),
        delayNs: Math.max(0, Math.floor(Number(source.delayNs) || 0)),
        flags: { ...base.flags, ...(source.flags || {}) },
        requested: finitePair(source.requested),
        applied: finitePair(source.applied),
        achieved: finitePair(source.achieved),
        deltas: {
            requestedVsAppliedSpeed: Number(source.deltas?.requestedVsAppliedSpeed) || 0,
            appliedVsAchievedSpeed: Number(source.deltas?.appliedVsAchievedSpeed) || 0,
            requestedVsAppliedSteer: Number(source.deltas?.requestedVsAppliedSteer) || 0,
            appliedVsAchievedSteer: Number(source.deltas?.appliedVsAchievedSteer) || 0,
        },
        referenceShadow: source.referenceShadow ? {
            speedMps: Number(source.referenceShadow.speedMps) || 0,
            steeringRad: Number(source.referenceShadow.steeringRad) || 0,
        } : null,
        wheelbase: Number(source.wheelbase) > 0 ? Number(source.wheelbase) : base.wheelbase,
    };
}

function finiteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function isFiniteVec3(v) {
    return v && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) && Number.isFinite(Number(v.z));
}

function isFiniteQuat(q) {
    return q
        && Number.isFinite(Number(q.x))
        && Number.isFinite(Number(q.y))
        && Number.isFinite(Number(q.z))
        && Number.isFinite(Number(q.w));
}

function assertNativeVisualization(payload, valueContract, id) {
    if (valueContract?.id !== id || valueContract.version !== 1) throw new Error(`Visualization requires ${id}@1.`);
    const validation = validateNativeTopicValue(valueContract, payload);
    if (!validation.ok) throw new Error(validation.message);
    return true;
}

export function normalizeDetections2D(payload, { source = "candidate", status = VISUALIZATION_STATUS.OK, valueContract = null, metadata = {} } = {}) {
    assertNativeVisualization(payload, valueContract, "cev.detections-2d");
    const stampNs = metadata.captureTimeNs;
    const frameId = String(metadata.frameId || "");
    return (payload?.detections || []).map((det, index) => ({
        id: String(det.id || `${source}-2d-${index}`),
        source,
        status,
        frameId: frameId,
        captureTimeNs: stampNs,
        ...({ classId: det.classId, score: det.score }),
        box2d: {
            center: {
                x: Number(det.center.x),
                y: Number(det.center.y),
            },
            size: {
                x: Number(det.size.x),
                y: Number(det.size.y),
            },
            theta: Number(det.theta || 0),
        },
        visibility: Number(det.visibility ?? 1),
        occlusion: Number(det.occlusion ?? 0),
    }));
}

export function normalizeDetections3D(payload, {
    source = "candidate",
    status = VISUALIZATION_STATUS.OK,
    transformToMap = null,
    valueContract = null, metadata = {},
} = {}) {
    assertNativeVisualization(payload, valueContract, "cev.detections-3d");
    const stampNs = metadata.captureTimeNs;
    const frameId = String(metadata.frameId || "");
    return (payload?.detections || []).map((det, index) => {
        const center = {
            x: Number(det.pose.position.x),
            y: Number(det.pose.position.y),
            z: Number(det.pose.position.z),
        };
        const orientation = det.pose.orientation;
        const size = {
            x: Number(det.size.x),
            y: Number(det.size.y),
            z: Number(det.size.z),
        };
        let mapPose = { position: center, rotation: orientation };
        let transformOk = true;
        const sourceFrameId = frameId;
        if (typeof transformToMap === "function") {
            const resolved = transformToMap({
                position: center,
                rotation: orientation,
                frameId: sourceFrameId,
                captureTimeNs: stampNs,
            });
            if (resolved?.ok) mapPose = resolved.pose;
            else transformOk = false;
        }
        const threeCenter = rep103ToThreeVector(mapPose.position);
        const threeRotation = rep103OrientationToThreeEuler(mapPose.rotation);
        return {
            id: String(det.id || `${source}-3d-${index}`),
            source,
            status: transformOk ? status : VISUALIZATION_STATUS.MISSING_FRAME,
            frameId: sourceFrameId,
            captureTimeNs: stampNs,
            ...({ classId: det.classId, score: det.score }),
            box3d: {
                center: mapPose.position,
                size,
                orientation: mapPose.rotation,
                threeCenter,
                threeSize: { x: size.x, y: size.z, z: size.y },
                threeRotation,
            },
            visibility: Number(det.visibility ?? 1),
            occlusion: Number(det.occlusion ?? 0),
        };
    });
}

export function normalizeLanes(payload, {
    source = "candidate",
    status = VISUALIZATION_STATUS.OK,
    transformToMap = null,
    valueContract = null, metadata = {},
} = {}) {
    assertNativeVisualization(payload, valueContract, "cev.lanes");
    const stampNs = metadata.captureTimeNs;
    const frameId = String(metadata.frameId || "");
    const lanes = payload?.lanes || [];
    return lanes.map((lane, index) => {
        const points = (lane.points || []).map((point) => {
            let position = {
                x: Number(point.x || 0),
                y: Number(point.y || 0),
                z: Number(point.z || 0),
            };
            if (typeof transformToMap === "function" && true) {
                const resolved = transformToMap({
                    position,
                    rotation: { x: 0, y: 0, z: 0, w: 1 },
                    frameId,
                    captureTimeNs: stampNs,
                });
                if (resolved?.ok) position = resolved.pose.position;
            }
            return {
                ...position,
                three: rep103ToThreeVector(position),
            };
        });
        return {
            id: lane.id,
            source,
            status,
            frameId,
            captureTimeNs: stampNs,
            points,
        };
    });
}

const WORLD_OCCUPANCY_FRAMES = new Set(["", "map", "world"]);

export function normalizeOccupancy(payload, { valueContract, metadata = {}, transformToMap = null } = {}) {
    assertNativeVisualization(payload, valueContract, "cev.occupancy");
    const frameId = String(metadata.frameId || "");
    let originX = Number(payload.origin.x);
    let originZ = Number(payload.origin.z);
    let yawRad = 0;
    let status = VISUALIZATION_STATUS.OK;
    if (transformToMap && !WORLD_OCCUPANCY_FRAMES.has(frameId)) {
        const resolved = transformToMap({
            position: payload.origin,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
            frameId,
            captureTimeNs: metadata.captureTimeNs,
        });
        if (!resolved?.ok) return { status: VISUALIZATION_STATUS.MISSING_FRAME };
        const three = rep103PoseToThree({
            position: resolved.pose.position,
            rotation: quaternionToEuler(resolved.pose.rotation || {}),
        });
        originX = three.position.x;
        originZ = three.position.z;
        yawRad = three.rotation.y;
    }
    return {
        status,
        cells: payload.data,
        width: payload.width,
        height: payload.height,
        originX,
        originZ,
        resolutionM: payload.resolutionM,
        yawRad,
        palette: payload.encoding,
        captureTimeNs: metadata.captureTimeNs,
        frameId,
    };
}

export function normalizePath(payload, { valueContract, metadata = {}, transformToMap = null } = {}) {
    assertNativeVisualization(payload, valueContract, "cev.path");
    let status = VISUALIZATION_STATUS.OK;
    const points = payload.points.map((point) => {
        let position = point;
        if (transformToMap) {
            const resolved = transformToMap({ position: point, rotation: { x: 0, y: 0, z: 0, w: 1 }, frameId: metadata.frameId, captureTimeNs: metadata.captureTimeNs });
            if (resolved?.ok) position = resolved.pose.position;
            else status = VISUALIZATION_STATUS.MISSING_FRAME;
        }
        return { ...position, three: rep103ToThreeVector(position) };
    });
    return { points, status, captureTimeNs: metadata.captureTimeNs, sequenceId: metadata.sequenceId, frameId: metadata.frameId };
}

export function normalizeSemanticImage(payload, { source = "candidate", status = VISUALIZATION_STATUS.OK, valueContract = null, metadata = {} } = {}) {
    if (!payload) return null;
    assertNativeVisualization(payload, valueContract, "cev.image");
    return {
        source,
        status,
        captureTimeNs: metadata.captureTimeNs,
        frameId: String(metadata.frameId || ""),
        height: Number(payload.height || 0),
        width: Number(payload.width || 0),
        encoding: String(payload.pixelFormat),
        step: Number(payload.strideBytes),
        data: payload.data ?? null,
    };
}

export function normalizeOdometry(payload, {
    source = "candidate",
    status = VISUALIZATION_STATUS.OK,
    valueContract = null, metadata = {},
} = {}) {
    if (!payload) return null;
    assertNativeVisualization(payload, valueContract, "cev.odometry");
    const position = payload.pose.position;
    const orientation = payload.pose.orientation;
    const covariance = [...payload.poseCovariance];
    const three = rep103PoseToThree({
        position,
        rotation: { x: 0, y: 0, z: 0 },
    });
    return {
        source,
        status,
        captureTimeNs: metadata.captureTimeNs,
        frameId: String(metadata.frameId || ""),
        childFrameId: payload.childFrameId,
        position: {
            x: Number(position.x || 0),
            y: Number(position.y || 0),
            z: Number(position.z || 0),
        },
        orientation: {
            x: Number(orientation.x || 0),
            y: Number(orientation.y || 0),
            z: Number(orientation.z || 0),
            w: Number(orientation.w ?? 1),
        },
        covariance,
        threePosition: rep103ToThreeVector({
            x: Number(position.x || 0),
            y: Number(position.y || 0),
            z: Number(position.z || 0),
        }),
        // Horizontal (xy) covariance ellipse radii from pose covariance indices 0 and 7.
        covarianceEllipse: {
            sigmaX: Math.sqrt(Math.max(0, Number(covariance[0] || 0))),
            sigmaY: Math.sqrt(Math.max(0, Number(covariance[7] || 0))),
        },
        three,
    };
}

export function localizationError(estimate, truth) {
    if (!estimate || !truth) return null;
    const dx = Number(estimate.position.x) - Number(truth.position.x);
    const dy = Number(estimate.position.y) - Number(truth.position.y);
    const dz = Number(estimate.position.z) - Number(truth.position.z);
    return {
        dx,
        dy,
        dz,
        horizontalM: Math.hypot(dx, dy),
        positionM: Math.hypot(dx, dy, dz),
        // Wrapped REP-103 yaw difference, positive when the estimate is left of truth.
        headingRad: wrapPi(quaternionToEuler(estimate.orientation || {}).z - quaternionToEuler(truth.orientation || {}).z),
        truthCaptureTimeNs: truth.captureTimeNs ?? null,
    };
}

function wrapPi(angle) {
    const tau = Math.PI * 2;
    return ((angle + Math.PI) % tau + tau) % tau - Math.PI;
}

export function formatPositionError(error) {
    return error ? `${Number(error.positionM || 0).toFixed(3)} m` : "—";
}

export function formatHeadingError(error) {
    return error && Number.isFinite(Number(error.headingRad))
        ? `${(Number(error.headingRad) * 180 / Math.PI).toFixed(1)}°`
        : "—";
}

/**
 * Truth pose at `captureTimeNs`, interpolated between the two nearest samples.
 * `history` holds normalized truth odometry sorted by ascending `captureTimeNs`.
 * Returns null when the time is outside the history.
 */
export function truthAtCaptureTime(history, captureTimeNs) {
    if (!Array.isArray(history) || history.length === 0 || !Number.isFinite(captureTimeNs)) return null;
    let high = history.length - 1;
    if (captureTimeNs > history[high].captureTimeNs || captureTimeNs < history[0].captureTimeNs) return null;
    let low = 0;
    while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (history[middle].captureTimeNs <= captureTimeNs) low = middle;
        else high = middle;
    }
    const before = history[low];
    const after = history[high];
    if (before.captureTimeNs === captureTimeNs) return before;
    if (after.captureTimeNs === captureTimeNs) return after;
    const alpha = (captureTimeNs - before.captureTimeNs) / (after.captureTimeNs - before.captureTimeNs);
    const interpolated = new Vector3().lerpVectors(
        new Vector3().copy(before.position),
        new Vector3().copy(after.position),
        alpha,
    );
    const position = { x: interpolated.x, y: interpolated.y, z: interpolated.z };
    const rotation = new Quaternion().copy(before.orientation).slerp(new Quaternion().copy(after.orientation), alpha);
    return {
        ...before,
        captureTimeNs,
        position,
        orientation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
        threePosition: rep103ToThreeVector(position),
    };
}

export function transformPoseIntoMap(pose, frameId, lookup) {
    if (!lookup) {
        return { ok: true, pose };
    }
    if (!frameId || frameId === "map") {
        return { ok: true, pose };
    }
    const chain = lookup(frameId);
    if (!chain?.ok) {
        return { ok: false, code: chain?.code || "missing-frame", message: chain?.message };
    }
    let composed = pose;
    for (const link of chain.transforms || []) {
        composed = composeRep103Poses(link, composed);
    }
    return { ok: true, pose: composed };
}

export function ageNs(captureTimeNs, applyTimeNs) {
    if (!Number.isFinite(captureTimeNs) || !Number.isFinite(applyTimeNs)) return null;
    return Math.max(0, applyTimeNs - captureTimeNs);
}

export function rotateSizeAxes(size, orientation) {
    if (!orientation || orientation.w === undefined) return size;
    const axes = [
        rotateVectorByQuaternion({ x: size.x, y: 0, z: 0 }, orientation),
        rotateVectorByQuaternion({ x: 0, y: size.y, z: 0 }, orientation),
        rotateVectorByQuaternion({ x: 0, y: 0, z: size.z }, orientation),
    ];
    return {
        x: Math.hypot(axes[0].x, axes[1].x, axes[2].x),
        y: Math.hypot(axes[0].y, axes[1].y, axes[2].y),
        z: Math.hypot(axes[0].z, axes[1].z, axes[2].z),
    };
}
