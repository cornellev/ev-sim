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
    return {
        header: sensorHeader(timeNs, frameId),
        height,
        width,
        encoding,
        is_bigendian: 0,
        step: width * 4,
        data,
    };
}

export function buildCameraInfo({ width, height, verticalFovDeg, timeNs, frameId, distortionModel = "plumb_bob", distortion = [] }) {
    const fy = height / (2 * Math.tan((Number(verticalFovDeg) || 75) * Math.PI / 360));
    const fx = fy;
    const cx = (width - 1) / 2;
    const cy = (height - 1) / 2;
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

export function buildPointCloud2({ buffer, calibration, timeNs, frameId, sampleRange = (range) => range, shouldDrop = () => false }) {
    const rangeLimit = Number(calibration.range || 20);
    const azimuth = calibration.azimuth || { startDeg: -180, endDeg: 180, stepDeg: 2 };
    const elevation = calibration.elevation || { startDeg: -20, endDeg: 20, stepDeg: 1 };
    const azimuthCount = Math.ceil((azimuth.endDeg - azimuth.startDeg) / azimuth.stepDeg);
    const points = [];
    for (let offset = 0; offset + 3 < buffer.length; offset += 4) {
        if (buffer[offset + 3] <= 0.5 || shouldDrop(offset / 4)) continue;
        const index = offset / 4;
        const azimuthIndex = index % azimuthCount;
        const elevationIndex = Math.floor(index / azimuthCount);
        const thetaDeg = azimuth.startDeg + azimuthIndex * azimuth.stepDeg;
        const phiDeg = elevation.startDeg + elevationIndex * elevation.stepDeg;
        if (thetaDeg > azimuth.endDeg || phiDeg > elevation.endDeg) continue;
        const theta = thetaDeg * Math.PI / 180;
        const phi = phiDeg * Math.PI / 180;
        const measured = Math.max(0, Math.min(rangeLimit, sampleRange((1 - buffer[offset]) * rangeLimit, index)));
        const direction = lidarDirectionRep103(theta, phi);
        points.push({
            x: measured * direction.x,
            y: measured * direction.y,
            z: measured * direction.z,
            intensity: Math.max(0, Math.min(1, Number(buffer[offset]) || 0)),
        });
    }
    const data = new Uint8Array(points.length * 16);
    const view = new DataView(data.buffer);
    points.forEach((point, index) => {
        const offset = index * 16;
        view.setFloat32(offset, point.x, true);
        view.setFloat32(offset + 4, point.y, true);
        view.setFloat32(offset + 8, point.z, true);
        view.setFloat32(offset + 12, point.intensity, true);
    });
    return {
        header: sensorHeader(timeNs, frameId),
        height: 1,
        width: points.length,
        fields: [
            { name: "x", offset: 0, datatype: 7, count: 1 },
            { name: "y", offset: 4, datatype: 7, count: 1 },
            { name: "z", offset: 8, datatype: 7, count: 1 },
            { name: "intensity", offset: 12, datatype: 7, count: 1 },
        ],
        is_bigendian: false,
        point_step: 16,
        row_step: points.length * 16,
        data,
        is_dense: true,
    };
}
