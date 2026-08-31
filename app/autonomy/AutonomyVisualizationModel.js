/**
 * Renderer-neutral primitives for candidate/oracle perception and localization overlays.
 * Capture-time metadata travels with each snapshot so replay does not need ROS re-decode.
 */

import {
    composeRep103Poses,
    extractHeaderCaptureTimeNs,
    rep103OrientationToThreeEuler,
    rep103PoseToThree,
    rep103ToThreeVector,
    rotateVectorByQuaternion,
} from "./CoordinateFrames.js";

export const VISUALIZATION_STATUS = Object.freeze({
    OK: "ok",
    STALE: "stale",
    INVALID: "invalid",
    REJECTED: "rejected",
    MISSING_FRAME: "missing-frame",
});

export function emptyPerceptionSnapshot(meta = {}) {
    return {
        captureTimeNs: meta.captureTimeNs ?? null,
        arrivalTimeNs: meta.arrivalTimeNs ?? null,
        applyTimeNs: meta.applyTimeNs ?? null,
        status: meta.status || VISUALIZATION_STATUS.OK,
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
        status: meta.status || VISUALIZATION_STATUS.OK,
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
        sequence: Math.max(0, Math.floor(Number(source.sequence) || 0)),
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

export function validateInboundPayload(contractId, typeStr, value) {
    if (value == null || typeof value !== "object") {
        return { ok: false, code: "malformed-payload", message: "Payload must be an object." };
    }
    switch (typeStr) {
        case "vision_msgs/Detection2DArray": {
            if (!value.header?.stamp) return { ok: false, code: "missing-stamp", message: "Detection2DArray requires header.stamp." };
            if (!Array.isArray(value.detections)) return { ok: false, code: "malformed-payload", message: "detections must be an array." };
            for (const det of value.detections) {
                const sizeX = finiteNumber(det?.bbox?.size_x);
                const sizeY = finiteNumber(det?.bbox?.size_y);
                const cx = finiteNumber(det?.bbox?.center?.position?.x);
                const cy = finiteNumber(det?.bbox?.center?.position?.y);
                if (sizeX === null || sizeY === null || cx === null || cy === null || sizeX < 0 || sizeY < 0) {
                    return { ok: false, code: "malformed-geometry", message: "Detection2D has non-finite or negative geometry." };
                }
            }
            return { ok: true };
        }
        case "vision_msgs/Detection3DArray": {
            if (!value.header?.stamp) return { ok: false, code: "missing-stamp", message: "Detection3DArray requires header.stamp." };
            if (!Array.isArray(value.detections)) return { ok: false, code: "malformed-payload", message: "detections must be an array." };
            for (const det of value.detections) {
                if (!isFiniteVec3(det?.bbox?.center?.position) || !isFiniteVec3(det?.bbox?.size)) {
                    return { ok: false, code: "malformed-geometry", message: "Detection3D has non-finite geometry." };
                }
                const size = det.bbox.size;
                if (Number(size.x) < 0 || Number(size.y) < 0 || Number(size.z) < 0) {
                    return { ok: false, code: "malformed-geometry", message: "Detection3D size must be non-negative." };
                }
            }
            return { ok: true };
        }
        case "sensor_fusion_msgs/StampedLanes": {
            if (!value.header?.stamp) return { ok: false, code: "missing-stamp", message: "StampedLanes requires header.stamp." };
            if (!Array.isArray(value.lanes)) return { ok: false, code: "malformed-payload", message: "lanes must be an array." };
            for (const lane of value.lanes) {
                if (!Array.isArray(lane?.points)) return { ok: false, code: "malformed-payload", message: "lane.points must be an array." };
                for (const point of lane.points) {
                    if (!isFiniteVec3(point)) return { ok: false, code: "malformed-geometry", message: "Lane point is non-finite." };
                }
            }
            return { ok: true };
        }
        case "sensor_fusion_msgs/Boxes": {
            if (!Array.isArray(value.boxes)) return { ok: false, code: "malformed-payload", message: "boxes must be an array." };
            for (const box of value.boxes) {
                if (!isFiniteVec3(box?.center) || !isFiniteVec3(box?.size)) {
                    return { ok: false, code: "malformed-geometry", message: "Legacy box has non-finite geometry." };
                }
            }
            return { ok: true };
        }
        case "sensor_fusion_msgs/Lanes": {
            if (!Array.isArray(value.lanes)) return { ok: false, code: "malformed-payload", message: "lanes must be an array." };
            return { ok: true };
        }
        case "sensor_msgs/Image": {
            if (!value.header?.stamp) return { ok: false, code: "missing-stamp", message: "Image requires header.stamp." };
            const height = Number(value.height);
            const width = Number(value.width);
            if (!Number.isInteger(height) || !Number.isInteger(width) || height < 0 || width < 0) {
                return { ok: false, code: "malformed-image", message: "Image height/width must be non-negative integers." };
            }
            if (contractId === "perception-semantic" && value.encoding && value.encoding !== "16UC1") {
                return { ok: false, code: "encoding-mismatch", message: `Semantic image expected 16UC1, got ${value.encoding}.` };
            }
            return { ok: true };
        }
        case "nav_msgs/Odometry": {
            if (!value.header?.stamp) return { ok: false, code: "missing-stamp", message: "Odometry requires header.stamp." };
            if (!isFiniteVec3(value?.pose?.pose?.position)) {
                return { ok: false, code: "malformed-geometry", message: "Odometry position is non-finite." };
            }
            if (!isFiniteQuat(value?.pose?.pose?.orientation)) {
                return { ok: false, code: "malformed-geometry", message: "Odometry orientation is non-finite." };
            }
            const cov = value?.pose?.covariance;
            if (cov != null && (!Array.isArray(cov) || cov.length !== 36 || cov.some((entry) => !Number.isFinite(Number(entry))))) {
                return { ok: false, code: "malformed-covariance", message: "Odometry pose.covariance must be 36 finite values." };
            }
            return { ok: true };
        }
        case "sensor_fusion_msgs/StampedAckermannDrive": {
            if (!value.header?.stamp) return { ok: false, code: "missing-stamp", message: "StampedAckermannDrive requires header.stamp." };
            const mode = String(value.mode || "velocity");
            if (!["velocity", "acceleration", "stop"].includes(mode)) {
                return { ok: false, code: "invalid-mode", message: `Invalid control mode "${mode}".` };
            }
            const sequence = Number(value.sequence);
            if (!Number.isInteger(sequence) || sequence < 0) {
                return { ok: false, code: "invalid-sequence", message: "sequence must be a non-negative integer." };
            }
            for (const field of ["steering_angle", "steering_angle_velocity", "speed", "acceleration", "jerk", "deadline_ns"]) {
                if (value[field] !== undefined && value[field] !== null && !Number.isFinite(Number(value[field]))) {
                    return { ok: false, code: "non-finite", message: `${field} must be finite.` };
                }
            }
            return { ok: true };
        }
        default:
            return { ok: true };
    }
}

function classFromResults(results = []) {
    const first = results[0]?.hypothesis || results[0];
    return {
        classId: String(first?.class_id ?? first?.classId ?? "unknown"),
        score: Number(first?.score ?? 1),
    };
}

export function normalizeDetections2D(payload, { source = "candidate", status = VISUALIZATION_STATUS.OK } = {}) {
    const stampNs = extractHeaderCaptureTimeNs(payload);
    const frameId = String(payload?.header?.frame_id || "");
    return (payload?.detections || []).map((det, index) => ({
        id: String(det.id || `${source}-2d-${index}`),
        source,
        status,
        frameId: String(det.header?.frame_id || frameId),
        captureTimeNs: extractHeaderCaptureTimeNs(det) ?? stampNs,
        ...classFromResults(det.results),
        box2d: {
            center: {
                x: Number(det.bbox?.center?.position?.x || 0),
                y: Number(det.bbox?.center?.position?.y || 0),
            },
            size: {
                x: Number(det.bbox?.size_x || 0),
                y: Number(det.bbox?.size_y || 0),
            },
            theta: Number(det.bbox?.center?.theta || 0),
        },
        visibility: Number(det.visibility ?? 1),
        occlusion: Number(det.occlusion ?? 0),
    }));
}

export function normalizeDetections3D(payload, {
    source = "candidate",
    status = VISUALIZATION_STATUS.OK,
    transformToMap = null,
} = {}) {
    const stampNs = extractHeaderCaptureTimeNs(payload);
    const frameId = String(payload?.header?.frame_id || "");
    return (payload?.detections || []).map((det, index) => {
        const center = {
            x: Number(det.bbox?.center?.position?.x || 0),
            y: Number(det.bbox?.center?.position?.y || 0),
            z: Number(det.bbox?.center?.position?.z || 0),
        };
        const orientation = det.bbox?.center?.orientation || { x: 0, y: 0, z: 0, w: 1 };
        const size = {
            x: Number(det.bbox?.size?.x || 0),
            y: Number(det.bbox?.size?.y || 0),
            z: Number(det.bbox?.size?.z || 0),
        };
        let mapPose = { position: center, rotation: orientation };
        let transformOk = true;
        const sourceFrameId = String(det.header?.frame_id || frameId);
        if (typeof transformToMap === "function") {
            const resolved = transformToMap({
                position: center,
                rotation: orientation,
                frameId: sourceFrameId,
                captureTimeNs: extractHeaderCaptureTimeNs(det) ?? stampNs,
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
            captureTimeNs: extractHeaderCaptureTimeNs(det) ?? stampNs,
            ...classFromResults(det.results),
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

export function normalizeLegacyBoxes(payload, { source = "candidate", status = VISUALIZATION_STATUS.OK } = {}) {
    return (payload?.boxes || []).map((box, index) => ({
        id: String(box.id ?? `${source}-legacy-${index}`),
        source,
        status,
        frameId: "map",
        captureTimeNs: null,
        classId: "unknown",
        score: 1,
        box3d: {
            center: { x: Number(box.center?.x || 0), y: Number(box.center?.y || 0), z: Number(box.center?.z || 0) },
            size: { x: Number(box.size?.x || 0), y: Number(box.size?.y || 0), z: Number(box.size?.z || 0) },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
            threeCenter: {
                x: Number(box.center?.x || 0),
                y: Number(box.center?.z || 0),
                z: Number(box.center?.y || 0),
            },
            threeSize: {
                x: Number(box.size?.x || 0),
                y: Number(box.size?.z || 0),
                z: Number(box.size?.y || 0),
            },
            threeRotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        },
        visibility: 1,
        occlusion: 0,
    }));
}

export function normalizeLanes(payload, {
    source = "candidate",
    status = VISUALIZATION_STATUS.OK,
    transformToMap = null,
} = {}) {
    const stampNs = extractHeaderCaptureTimeNs(payload);
    const frameId = String(payload?.header?.frame_id || "map");
    const lanes = payload?.lanes || [];
    return lanes.map((lane, index) => {
        const points = (lane.points || []).map((point) => {
            let position = {
                x: Number(point.x || 0),
                y: Number(point.y || 0),
                z: Number(point.z || 0),
            };
            if (typeof transformToMap === "function" && payload?.header) {
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
                three: {
                    x: position.x,
                    y: position.z,
                    z: position.y,
                },
            };
        });
        return {
            id: `${source}-lane-${index}`,
            source,
            status,
            frameId,
            captureTimeNs: stampNs,
            points,
        };
    });
}

export function normalizeSemanticImage(payload, { source = "candidate", status = VISUALIZATION_STATUS.OK } = {}) {
    if (!payload) return null;
    return {
        source,
        status,
        captureTimeNs: extractHeaderCaptureTimeNs(payload),
        frameId: String(payload.header?.frame_id || ""),
        height: Number(payload.height || 0),
        width: Number(payload.width || 0),
        encoding: String(payload.encoding || "16UC1"),
        step: Number(payload.step || 0),
        data: payload.data ?? null,
    };
}

export function normalizeOdometry(payload, {
    source = "candidate",
    status = VISUALIZATION_STATUS.OK,
} = {}) {
    if (!payload) return null;
    const position = payload.pose?.pose?.position || { x: 0, y: 0, z: 0 };
    const orientation = payload.pose?.pose?.orientation || { x: 0, y: 0, z: 0, w: 1 };
    const covariance = Array.isArray(payload.pose?.covariance) ? [...payload.pose.covariance] : new Array(36).fill(0);
    const three = rep103PoseToThree({
        position,
        rotation: { x: 0, y: 0, z: 0 },
    });
    return {
        source,
        status,
        captureTimeNs: extractHeaderCaptureTimeNs(payload),
        frameId: String(payload.header?.frame_id || ""),
        childFrameId: String(payload.child_frame_id || "base_link"),
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
        threePosition: {
            x: Number(position.x || 0),
            y: Number(position.z || 0),
            z: Number(position.y || 0),
        },
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
