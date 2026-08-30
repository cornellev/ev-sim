import { lidarDirectionRep103 } from "../../autonomy/CoordinateFrames.js";

export function simulationStamp(timeNs) {
    const normalized = Math.max(0, Math.floor(Number(timeNs) || 0));
    return { sec: Math.floor(normalized / 1e9), nanosec: normalized % 1e9 };
}

export function sensorHeader(timeNs, frameId) {
    return { stamp: simulationStamp(timeNs), frame_id: String(frameId || "") };
}

export function flipRgbaRows(bytes, width, height) {
    const stride = width * 4;
    const output = new Uint8Array(bytes.length);
    for (let row = 0; row < height; row += 1) {
        const sourceOffset = (height - row - 1) * stride;
        output.set(bytes.subarray(sourceOffset, sourceOffset + stride), row * stride);
    }
    return output;
}

export function buildImageMessage({ data, width, height, timeNs, frameId, encoding = "rgba8" }) {
    const bytesPerPixel = {
        rgba8: 4,
        "32FC1": 4,
        "16UC1": 2,
        "32SC1": 4,
    }[encoding];
    if (!bytesPerPixel) throw new Error(`Unsupported image encoding "${encoding}".`);
    const view = data instanceof Uint8Array
        ? data
        : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data || []);
    if (view.byteLength !== width * height * bytesPerPixel) {
        throw new Error(`${encoding} image data has ${view.byteLength} bytes; expected ${width * height * bytesPerPixel}.`);
    }
    // Copy so GPU capture buffers can be reused on the next sample.
    const bytes = new Uint8Array(view);
    return {
        header: sensorHeader(timeNs, frameId),
        height,
        width,
        encoding,
        is_bigendian: 0,
        step: width * bytesPerPixel,
        data: bytes,
    };
}

export function buildCameraInfo({
    width,
    height,
    verticalFovDeg,
    timeNs,
    frameId,
    distortionModel = "plumb_bob",
    distortion = [],
    intrinsics = {},
}) {
    const fyDefault = height / (2 * Math.tan((Number(verticalFovDeg) || 75) * Math.PI / 360));
    const fx = Number(intrinsics.fx) || fyDefault;
    const fy = Number(intrinsics.fy) || fyDefault;
    const cx = Number.isFinite(Number(intrinsics.cx)) ? Number(intrinsics.cx) : (width - 1) / 2;
    const cy = Number.isFinite(Number(intrinsics.cy)) ? Number(intrinsics.cy) : (height - 1) / 2;
    return {
        header: sensorHeader(timeNs, frameId),
        height,
        width,
        distortion_model: distortionModel,
        d: [...distortion],
        k: [fx, 0, cx, 0, fy, cy, 0, 0, 1],
        r: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        p: [fx, 0, cx, 0, 0, fy, cy, 0, 0, 0, 1, 0],
        binning_x: 0,
        binning_y: 0,
    };
}

export function buildImuMessage({
    timeNs,
    frameId,
    angularVelocity = { x: 0, y: 0, z: 0 },
    linearAcceleration = { x: 0, y: 0, z: 0 },
    orientationCovariance = null,
    angularVelocityCovariance = null,
    linearAccelerationCovariance = null,
}) {
    const unavailable = new Array(9).fill(0);
    unavailable[0] = -1;
    return {
        header: sensorHeader(timeNs, frameId),
        orientation: { x: 0, y: 0, z: 0, w: 1 },
        orientation_covariance: orientationCovariance || unavailable,
        angular_velocity: {
            x: Number(angularVelocity.x || 0),
            y: Number(angularVelocity.y || 0),
            z: Number(angularVelocity.z || 0),
        },
        angular_velocity_covariance: angularVelocityCovariance || new Array(9).fill(0),
        linear_acceleration: {
            x: Number(linearAcceleration.x || 0),
            y: Number(linearAcceleration.y || 0),
            z: Number(linearAcceleration.z || 0),
        },
        linear_acceleration_covariance: linearAccelerationCovariance || new Array(9).fill(0),
    };
}

export function buildNavSatFixMessage({
    timeNs,
    frameId,
    status = 0,
    service = 1,
    latitude = 0,
    longitude = 0,
    altitude = 0,
    positionCovariance = null,
    positionCovarianceType = 2,
}) {
    return {
        header: sensorHeader(timeNs, frameId),
        status: { status: Number(status), service: Number(service) },
        latitude: Number(latitude),
        longitude: Number(longitude),
        altitude: Number(altitude),
        position_covariance: positionCovariance || new Array(9).fill(0),
        position_covariance_type: Number(positionCovarianceType),
    };
}

export function buildOdometryMessage({
    timeNs,
    frameId,
    childFrameId = "base_link",
    position = { x: 0, y: 0, z: 0 },
    orientation = { x: 0, y: 0, z: 0, w: 1 },
    linearVelocity = { x: 0, y: 0, z: 0 },
    angularVelocity = { x: 0, y: 0, z: 0 },
    poseCovariance = null,
    twistCovariance = null,
}) {
    return {
        header: sensorHeader(timeNs, frameId),
        child_frame_id: String(childFrameId || "base_link"),
        pose: {
            pose: {
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
            },
            covariance: poseCovariance || new Array(36).fill(0),
        },
        twist: {
            twist: {
                linear: {
                    x: Number(linearVelocity.x || 0),
                    y: Number(linearVelocity.y || 0),
                    z: Number(linearVelocity.z || 0),
                },
                angular: {
                    x: Number(angularVelocity.x || 0),
                    y: Number(angularVelocity.y || 0),
                    z: Number(angularVelocity.z || 0),
                },
            },
            covariance: twistCovariance || new Array(36).fill(0),
        },
    };
}

function lidarGridMeta(calibration) {
    const rangeLimit = Number(calibration.range || 20);
    const azimuth = calibration.azimuth || { startDeg: -180, endDeg: 180, stepDeg: 2 };
    const elevation = calibration.elevation || { startDeg: -20, endDeg: 20, stepDeg: 1 };
    const azimuthCount = Math.ceil((azimuth.endDeg - azimuth.startDeg) / azimuth.stepDeg);
    return { rangeLimit, azimuth, elevation, azimuthCount };
}

function forEachLidarHit(buffer, calibration, bufferEncoding, onHit) {
    const { rangeLimit, azimuth, elevation, azimuthCount } = lidarGridMeta(calibration);
    const legacy = bufferEncoding === "legacy-normalized";
    for (let offset = 0; offset + 3 < buffer.length; offset += 4) {
        const hit = legacy ? buffer[offset + 3] > 0.5 : buffer[offset + 3] > 0 && buffer[offset] > 0;
        if (!hit) continue;
        const index = offset / 4;
        const azimuthIndex = index % azimuthCount;
        const elevationIndex = Math.floor(index / azimuthCount);
        const thetaDeg = azimuth.startDeg + azimuthIndex * azimuth.stepDeg;
        const phiDeg = elevation.startDeg + elevationIndex * elevation.stepDeg;
        if (thetaDeg > azimuth.endDeg || phiDeg > elevation.endDeg) continue;
        onHit({
            offset,
            index,
            theta: thetaDeg * Math.PI / 180,
            phi: phiDeg * Math.PI / 180,
            rangeLimit,
            legacy,
        });
    }
}

/** Pack PointCloud2 xyz+intensity without allocating per-hit objects. */
export function packPointCloud2DataJs({
    buffer,
    calibration,
    sampleRange = (range) => range,
    shouldDrop = () => false,
    onPointDrop = () => {},
    bufferEncoding = "legacy-normalized",
}) {
    // Single pass: shouldDrop / sampleRange may consume RNG and must not run twice.
    const maxPoints = Math.floor(buffer.length / 4);
    const data = new Uint8Array(maxPoints * 16);
    const view = new DataView(data.buffer);
    let width = 0;
    forEachLidarHit(buffer, calibration, bufferEncoding, ({ offset, index, theta, phi, rangeLimit, legacy }) => {
        if (shouldDrop(index)) {
            onPointDrop(index);
            return;
        }
        const rawDistance = legacy ? (1 - Number(buffer[offset])) * rangeLimit : Number(buffer[offset]);
        const measured = Math.max(0, Math.min(rangeLimit, sampleRange(rawDistance, index)));
        const direction = lidarDirectionRep103(theta, phi);
        const intensity = Math.max(0, Math.min(1, Number(legacy ? buffer[offset] : buffer[offset + 1]) || 0));
        const byteOffset = width * 16;
        view.setFloat32(byteOffset, measured * direction.x, true);
        view.setFloat32(byteOffset + 4, measured * direction.y, true);
        view.setFloat32(byteOffset + 8, measured * direction.z, true);
        view.setFloat32(byteOffset + 12, intensity, true);
        width += 1;
    });
    return { width, data: data.slice(0, width * 16), pointStep: 16 };
}

/** Pack semantic PointCloud2 without allocating per-hit objects. */
export function packSemanticPointCloud2DataJs({
    buffer,
    calibration,
    bufferEncoding = "metric-v2",
}) {
    const pointStep = 28;
    const maxPoints = Math.floor(buffer.length / 4);
    const data = new Uint8Array(maxPoints * pointStep);
    const view = new DataView(data.buffer);
    let width = 0;
    forEachLidarHit(buffer, calibration, bufferEncoding, ({ offset, index, theta, phi, rangeLimit, legacy }) => {
        const rawDistance = legacy ? (1 - Number(buffer[offset])) * rangeLimit : Number(buffer[offset]);
        const direction = lidarDirectionRep103(theta, phi);
        const byteOffset = width * pointStep;
        view.setFloat32(byteOffset, rawDistance * direction.x, true);
        view.setFloat32(byteOffset + 4, rawDistance * direction.y, true);
        view.setFloat32(byteOffset + 8, rawDistance * direction.z, true);
        view.setFloat32(byteOffset + 12, Math.max(0, Math.min(1, Number(legacy ? 1 : buffer[offset + 1]) || 0)), true);
        view.setUint32(byteOffset + 16, legacy ? 1 : Math.round(Number(buffer[offset + 3]) || 0) >>> 0, true);
        view.setUint16(byteOffset + 20, Math.max(0, Math.round(Number(legacy ? buffer[offset + 1] * 255 : buffer[offset + 2]) || 0)), true);
        view.setUint16(byteOffset + 22, 0, true);
        view.setUint32(byteOffset + 24, index, true);
        width += 1;
    });
    return { width, data: data.slice(0, width * pointStep), pointStep };
}

const POINTCLOUD2_FIELDS = Object.freeze([
    { name: "x", offset: 0, datatype: 7, count: 1 },
    { name: "y", offset: 4, datatype: 7, count: 1 },
    { name: "z", offset: 8, datatype: 7, count: 1 },
    { name: "intensity", offset: 12, datatype: 7, count: 1 },
]);

const SEMANTIC_POINTCLOUD2_FIELDS = Object.freeze([
    { name: "x", offset: 0, datatype: 7, count: 1 },
    { name: "y", offset: 4, datatype: 7, count: 1 },
    { name: "z", offset: 8, datatype: 7, count: 1 },
    { name: "cos_incidence", offset: 12, datatype: 7, count: 1 },
    { name: "instance_id", offset: 16, datatype: 6, count: 1 },
    { name: "semantic_id", offset: 20, datatype: 4, count: 1 },
    { name: "ray_index", offset: 24, datatype: 6, count: 1 },
]);

export function buildPointCloud2(options = {}) {
    const {
        buffer,
        calibration,
        timeNs,
        frameId,
        sampleRange = (range) => range,
        shouldDrop = () => false,
        onPointDrop = () => {},
        bufferEncoding = "legacy-normalized",
    } = options;
    const packed = packPointCloud2DataJs({
        buffer,
        calibration,
        sampleRange,
        shouldDrop,
        onPointDrop,
        bufferEncoding,
    });
    return {
        header: sensorHeader(timeNs, frameId),
        height: 1,
        width: packed.width,
        fields: POINTCLOUD2_FIELDS.map((field) => ({ ...field })),
        is_bigendian: false,
        point_step: packed.pointStep,
        row_step: packed.width * packed.pointStep,
        data: packed.data,
        is_dense: true,
    };
}

export function buildSemanticPointCloud2({ buffer, calibration, timeNs, frameId, bufferEncoding = "metric-v2" }) {
    const packed = packSemanticPointCloud2DataJs({ buffer, calibration, bufferEncoding });
    return {
        header: sensorHeader(timeNs, frameId),
        height: 1,
        width: packed.width,
        fields: SEMANTIC_POINTCLOUD2_FIELDS.map((field) => ({ ...field })),
        is_bigendian: false,
        point_step: packed.pointStep,
        row_step: packed.width * packed.pointStep,
        data: packed.data,
        is_dense: true,
    };
}

function identityPoseWithCovariance(position = { x: 0, y: 0, z: 0 }) {
    return {
        pose: {
            position: {
                x: Number(position.x || 0),
                y: Number(position.y || 0),
                z: Number(position.z || 0),
            },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
        covariance: new Array(36).fill(0),
    };
}

function detectionResult(record) {
    return [{
        hypothesis: {
            class_id: String(record.semanticClass || record.semanticId || "unknown"),
            score: Number(record.score ?? 1),
        },
        pose: identityPoseWithCovariance(record.worldBounds?.center || record.position),
    }];
}

export function buildDetection2DArray({ detections = [], timeNs, frameId }) {
    const header = sensorHeader(timeNs, frameId);
    return {
        header,
        detections: detections.map((record) => ({
            header,
            results: detectionResult(record),
            bbox: {
                center: {
                    position: {
                        x: Number(record.imageBounds?.center?.x || 0),
                        y: Number(record.imageBounds?.center?.y || 0),
                    },
                    theta: 0,
                },
                size_x: Number(record.imageBounds?.size?.x || 0),
                size_y: Number(record.imageBounds?.size?.y || 0),
            },
            id: String(record.instanceId || 0),
            visibility: Number(record.visibility ?? 1),
            occlusion: Number(record.occlusion ?? 0),
        })),
    };
}

export function buildDetection3DArray({ detections = [], timeNs, frameId }) {
    const header = sensorHeader(timeNs, frameId);
    return {
        header,
        detections: detections
            .filter((record) => record.worldBounds)
            .map((record) => ({
                header,
                results: detectionResult(record),
                bbox: {
                    center: {
                        position: { ...record.worldBounds.center },
                        orientation: { x: 0, y: 0, z: 0, w: 1 },
                    },
                    size: { ...record.worldBounds.size },
                },
                id: String(record.instanceId || 0),
                visibility: Number(record.visibility ?? 1),
                occlusion: Number(record.occlusion ?? 0),
            })),
    };
}

export function buildDiagnosticArray({ timeNs, frameId, sensorId, metrics = {}, level = 0, message = "OK" }) {
    const values = Object.entries(metrics)
        .filter(([, value]) => ["number", "string", "boolean"].includes(typeof value))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value: String(value) }));
    return {
        header: sensorHeader(timeNs, frameId),
        status: [{
            level: Number(level),
            name: `sensor/${sensorId}`,
            message: String(message),
            hardware_id: String(sensorId),
            values,
        }],
    };
}

export function buildStampedLanes({
    lanes = [],
    timeNs,
    frameId,
    sequence = 0,
    syncGroupKey = "",
    calibrationHash = "",
}) {
    return {
        header: sensorHeader(timeNs, frameId),
        sequence,
        sync_group_key: String(syncGroupKey || ""),
        calibration_hash: String(calibrationHash || ""),
        lanes: lanes.map((lane) => ({
            points: (lane.points || lane.left || []).map((point) => ({
                x: Number(point.x || 0),
                y: Number(point.y || 0),
                z: Number(point.z || 0),
            })),
        })),
    };
}

export function buildTrafficControlStates({
    controls = [],
    timeNs,
    frameId,
    sequence = 0,
    syncGroupKey = "",
    calibrationHash = "",
}) {
    return {
        header: sensorHeader(timeNs, frameId),
        sequence,
        sync_group_key: String(syncGroupKey || ""),
        calibration_hash: String(calibrationHash || ""),
        controls: controls.map((control) => ({
            instance_id: Number(control.instanceId || 0),
            class_id: String(control.semanticClass || control.classId || "unknown"),
            kind: String(control.kind || "unknown"),
            state: String(control.state || "unknown"),
            position: {
                x: Number(control.position?.x || 0),
                y: Number(control.position?.y || 0),
                z: Number(control.position?.z || 0),
            },
            visibility: Number(control.visibility ?? 1),
            occlusion: Number(control.occlusion ?? 0),
        })),
    };
}
