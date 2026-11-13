import { forEachLidarHit } from "./SensorMessages.js";
import { lidarShaderDirectionToRep103 } from "../../autonomy/CoordinateFrames.js";

const vector = (value = {}) => ({ x: Number(value.x ?? 0), y: Number(value.y ?? 0), z: Number(value.z ?? 0) });
const orientation = (value = {}) => ({ ...vector(value), w: Number(value.w ?? 1) });

export function buildNativeImu({ angularVelocity, linearAcceleration, orientationCovariance, angularVelocityCovariance, linearAccelerationCovariance } = {}) {
    return { angularVelocity: vector(angularVelocity), linearAcceleration: vector(linearAcceleration), orientationAvailable: false,
        orientationCovariance: orientationCovariance ?? [-1, ...new Array(8).fill(0)],
        angularVelocityCovariance: angularVelocityCovariance ?? new Array(9).fill(0), linearAccelerationCovariance: linearAccelerationCovariance ?? new Array(9).fill(0) };
}

export function buildNativeGnss({ status = 0, service = 1, latitude = 0, longitude = 0, altitude = 0, positionCovariance, positionCovarianceType = 2 } = {}) {
    return { valid: status >= 0, status, service, latitude, longitude, altitude, covariance: positionCovariance ?? new Array(9).fill(0), covarianceType: positionCovarianceType };
}

export function buildNativeOdometry({ position, orientation: rotation, linearVelocity, angularVelocity, poseCovariance, twistCovariance, childFrameId = "base_link" } = {}) {
    return { pose: { position: vector(position), orientation: orientation(rotation) }, linearVelocity: vector(linearVelocity), angularVelocity: vector(angularVelocity),
        poseCovariance: poseCovariance ?? new Array(36).fill(0), twistCovariance: twistCovariance ?? new Array(36).fill(0), childFrameId };
}

export function buildNativeImage({ data, width, height, encoding = "rgba8" }) {
    const format = { rgba8: ["rgba8", 4], "32FC1": ["depth-f32-le", 4], "16UC1": ["semantic-u16-le", 2], "32SC1": ["instance-u32-le", 4] }[encoding];
    if (!format || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new Error("Invalid native image layout.");
    const view = data instanceof Uint8Array ? data : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (view.byteLength !== width * height * format[1]) throw new Error("Native image bytes do not match dimensions.");
    return { data: new Uint8Array(view), width, height, pixelFormat: format[0], strideBytes: width * format[1] };
}

export function buildNativeCameraInfo({ width, height, verticalFovDeg, distortionModel = "plumb_bob", distortion = [], intrinsics = {} }) {
    const defaultFocal = height / (2 * Math.tan((Number(verticalFovDeg) || 75) * Math.PI / 360));
    const fx = Number(intrinsics.fx) || defaultFocal, fy = Number(intrinsics.fy) || defaultFocal;
    const cx = Number.isFinite(Number(intrinsics.cx)) ? Number(intrinsics.cx) : (width - 1) / 2;
    const cy = Number.isFinite(Number(intrinsics.cy)) ? Number(intrinsics.cy) : (height - 1) / 2;
    return { width, height, distortionModel, distortion: [...distortion], intrinsic: [fx, 0, cx, 0, fy, cy, 0, 0, 1],
        rectification: [1, 0, 0, 0, 1, 0, 0, 0, 1], projection: [fx, 0, cx, 0, 0, fy, cy, 0, 0, 0, 1, 0] };
}

export function buildNativePoints({ buffer, calibration, sampleRange = (range) => range, shouldDrop = () => false, onPointDrop = () => {}, onMeasured = () => {}, bufferEncoding = "metric-v2", semantic = false }) {
    const capacity = Math.floor(buffer.length / 4);
    const positions = new Float32Array(capacity * 3), intensities = new Float32Array(capacity);
    const instanceIds = semantic ? new Uint32Array(capacity) : null, semanticIds = semantic ? new Uint32Array(capacity) : null, rayIndices = semantic ? new Uint32Array(capacity) : null;
    let count = 0;
    forEachLidarHit(buffer, calibration, bufferEncoding, ({ offset, index, theta, phi, rangeLimit, legacy }) => {
        if (shouldDrop(index)) { onPointDrop(index); onMeasured(index, 0, 0, false); return; }
        const raw = legacy ? (1 - Number(buffer[offset])) * rangeLimit : Number(buffer[offset]);
        const range = Math.max(0, Math.min(rangeLimit, sampleRange(raw, index)));
        const direction = lidarShaderDirectionToRep103(theta, phi);
        const intensity = Math.max(0, Math.min(1, Number(legacy ? (semantic ? 1 : buffer[offset]) : buffer[offset + 1]) || 0));
        onMeasured(index, range, intensity, true);
        positions.set([range * direction.x, range * direction.y, range * direction.z], count * 3);
        intensities[count] = intensity;
        if (semantic) { instanceIds[count] = legacy ? 1 : Math.round(Number(buffer[offset + 3]) || 0) >>> 0; semanticIds[count] = Math.max(0, Math.round(Number(legacy ? buffer[offset + 1] * 255 : buffer[offset + 2]) || 0)); rayIndices[count] = index; }
        count++;
    });
    return { positions: positions.slice(0, count * 3), intensities: intensities.slice(0, count), count,
        ...(semantic ? { instanceIds: instanceIds.slice(0, count), semanticIds: semanticIds.slice(0, count), rayIndices: rayIndices.slice(0, count) } : {}) };
}

export function buildNativeDetections({ detections = [], dimension = 3 }) {
    return { detections: detections.filter((item) => dimension === 2 || item.worldBounds).map((item) => ({
        id: String(item.instanceId || 0), classId: String(item.semanticClass || item.semanticId || "unknown"), score: Number(item.score ?? 1),
        visibility: Number(item.visibility ?? 1), occlusion: Number(item.occlusion ?? 0),
        ...(dimension === 2 ? { center: { x: Number(item.imageBounds?.center?.x || 0), y: Number(item.imageBounds?.center?.y || 0) }, size: { x: Number(item.imageBounds?.size?.x || 0), y: Number(item.imageBounds?.size?.y || 0) } }
            : { pose: { position: vector(item.worldBounds.center), orientation: orientation() }, size: vector(item.worldBounds.size) }) })) };
}
export function buildNativeDetections2D(options) { return buildNativeDetections({ ...options, dimension: 2 }); }

export function buildNativeLanes({ lanes = [] }) { return { lanes: lanes.map((lane, index) => ({ id: String(lane.id ?? index), points: (lane.points || lane.left || []).map(vector) })) }; }
export function buildNativeTrafficControls({ controls = [] }) { return { controls: controls.map((item) => ({ id: String(item.instanceId || 0), classId: String(item.semanticClass || item.classId || "unknown"), kind: String(item.kind || "unknown"), state: String(item.state || "unknown"), position: vector(item.position), visibility: Number(item.visibility ?? 1), occlusion: Number(item.occlusion ?? 0) })) }; }
export function buildNativeDiagnostics({ sensorId, metrics = {}, level = 0, message = "OK" }) { return { entries: [{ name: `sensor/${sensorId}`, level, message, values: Object.entries(metrics).filter(([, value]) => ["number", "string", "boolean"].includes(typeof value)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => ({ key, value: String(value) })) }] }; }
