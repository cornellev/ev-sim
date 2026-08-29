/**
 * REP-103/105 coordinate helpers and Three.js scene ↔ ROS frame conversions.
 * Scene/vehicle coordinates remain Three.js (+X forward, +Y up, +Z left).
 * Manifest extrinsics and ROS payloads use REP-103 (+X forward, +Y left, +Z up).
 */

export function simulationStamp(timeNs) {
    const normalized = Math.max(0, Math.floor(Number(timeNs) || 0));
    return { sec: Math.floor(normalized / 1e9), nanosec: normalized % 1e9 };
}

/** Fixed basis change: REP-103 vector → Three.js vehicle-local vector. */
export function rep103ToThreeVector({ x = 0, y = 0, z = 0 } = {}) {
    return { x: Number(x), y: Number(z), z: Number(y) };
}

/** Fixed basis change: Three.js vehicle-local vector → REP-103. */
export function threeToRep103Vector({ x = 0, y = 0, z = 0 } = {}) {
    return { x: Number(x), y: Number(z), z: Number(y) };
}

/** REP-103 Euler XYZ (radians) → Three.js Euler XYZ (same axis order, basis-mapped components). */
export function rep103EulerToThree(euler = {}) {
    const rep = {
        x: Number(euler.x || 0),
        y: Number(euler.y || 0),
        z: Number(euler.z || 0),
        order: euler.order || "XYZ",
    };
    return { x: rep.x, y: rep.z, z: rep.y, order: rep.order };
}

export function threeEulerToRep103(euler = {}) {
    const three = {
        x: Number(euler.x || 0),
        y: Number(euler.y || 0),
        z: Number(euler.z || 0),
        order: euler.order || "XYZ",
    };
    return { x: three.x, y: three.z, z: three.y, order: three.order };
}

export function rep103PoseToThree(pose = {}) {
    return {
        position: rep103ToThreeVector(pose.position),
        rotation: rep103EulerToThree(pose.rotation),
    };
}

export function threePoseToRep103(pose = {}) {
    return {
        position: threeToRep103Vector(pose.position),
        rotation: threeEulerToRep103(pose.rotation),
    };
}

export function eulerToQuaternion(euler = {}) {
    const x = Number(euler.x || 0) / 2;
    const y = Number(euler.y || 0) / 2;
    const z = Number(euler.z || 0) / 2;
    const cx = Math.cos(x);
    const sx = Math.sin(x);
    const cy = Math.cos(y);
    const sy = Math.sin(y);
    const cz = Math.cos(z);
    const sz = Math.sin(z);
    const order = euler.order || "XYZ";
    if (order !== "XYZ") {
        // Manifest authoring uses XYZ; other orders fall back to sequential XYZ composition.
    }
    const qx = sx * cy * cz + cx * sy * sz;
    const qy = cx * sy * cz - sx * cy * sz;
    const qz = cx * cy * sz + sx * sy * cz;
    const qw = cx * cy * cz - sx * sy * sz;
    return { x: qx, y: qy, z: qz, w: qw };
}

/** Inverse of {@link eulerToQuaternion} for XYZ (intrinsic Rx Ry Rz). */
export function quaternionToEuler(q = {}, order = "XYZ") {
    const x = Number(q.x || 0);
    const y = Number(q.y || 0);
    const z = Number(q.z || 0);
    const w = Number(q.w ?? 1);
    const m00 = 1 - 2 * (y * y + z * z);
    const m01 = 2 * (x * y - z * w);
    const m02 = 2 * (x * z + y * w);
    const m11 = 1 - 2 * (x * x + z * z);
    const m12 = 2 * (y * z - x * w);
    const m21 = 2 * (y * z + x * w);
    const m22 = 1 - 2 * (x * x + y * y);
    const pitch = Math.asin(Math.max(-1, Math.min(1, m02)));
    if (Math.abs(m02) < 0.9999999) {
        return {
            x: Math.atan2(-m12, m22),
            y: pitch,
            z: Math.atan2(-m01, m00),
            order,
        };
    }
    return {
        x: Math.atan2(m21, m11),
        y: pitch,
        z: 0,
        order,
    };
}

/** REP-103 orientation (quaternion or XYZ euler) → Three.js Euler XYZ. */
export function rep103OrientationToThreeEuler(rotation = {}) {
    const euler = rotation?.w !== undefined
        ? quaternionToEuler(rotation)
        : { x: Number(rotation?.x || 0), y: Number(rotation?.y || 0), z: Number(rotation?.z || 0), order: rotation?.order || "XYZ" };
    return rep103EulerToThree(euler);
}

export function quaternionMultiply(a, b) {
    return {
        x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
        y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
        z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
        w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    };
}

export function quaternionInverse(q) {
    const norm = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
    if (norm <= Number.EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
    return { x: -q.x / norm, y: -q.y / norm, z: -q.z / norm, w: q.w / norm };
}

export function rotateVectorByQuaternion(v, q) {
    const qv = { x: v.x, y: v.y, z: v.z, w: 0 };
    const qi = quaternionInverse(q);
    const rotated = quaternionMultiply(quaternionMultiply(q, qv), qi);
    return { x: rotated.x, y: rotated.y, z: rotated.z };
}

/** ROS RPY: R = Rz(yaw) * Ry(pitch) * Rx(roll). Not the same as XYZ euler. */
export function rpyToQuaternion({ roll = 0, pitch = 0, yaw = 0 } = {}) {
    return quaternionMultiply(
        eulerToQuaternion({ x: 0, y: 0, z: yaw, order: "XYZ" }),
        quaternionMultiply(
            eulerToQuaternion({ x: 0, y: pitch, z: 0, order: "XYZ" }),
            eulerToQuaternion({ x: roll, y: 0, z: 0, order: "XYZ" }),
        ),
    );
}

/** Standard REP-103 camera_link → camera_optical rotation (fixed, no translation). */
export function cameraLinkToOpticalRotation() {
    return rpyToQuaternion({ roll: -Math.PI / 2, pitch: 0, yaw: -Math.PI / 2 });
}

/**
 * Three.js PerspectiveCamera looks along local -Z with +Y up.
 * Vehicle/mount forward is +X. Yaw -90° about +Y so the camera looks along
 * mount forward. Do not apply {@link cameraLinkToOpticalRotation} in Three.js
 * space — that quaternion is REP-103 TF only. Applied here it aims the
 * camera backward into the vehicle.
 */
export function threeCameraLookAlongMountForwardEuler() {
    return { x: 0, y: -Math.PI / 2, z: 0, order: "XYZ" };
}

export function threeCameraLookAlongMountForwardRotation() {
    return eulerToQuaternion(threeCameraLookAlongMountForwardEuler());
}

export function buildTransformStamped({
    timeNs = 0,
    parentFrameId = "",
    childFrameId = "",
    translation = { x: 0, y: 0, z: 0 },
    rotation = null,
    euler = null,
}) {
    const rot = rotation || eulerToQuaternion(euler || { x: 0, y: 0, z: 0, order: "XYZ" });
    return {
        header: { stamp: simulationStamp(timeNs), frame_id: String(parentFrameId) },
        child_frame_id: String(childFrameId),
        transform: {
            translation: {
                x: Number(translation.x || 0),
                y: Number(translation.y || 0),
                z: Number(translation.z || 0),
            },
            rotation: {
                x: Number(rot.x),
                y: Number(rot.y),
                z: Number(rot.z),
                w: Number(rot.w),
            },
        },
    };
}

export function buildTFMessage(transforms = []) {
    return { transforms: [...transforms] };
}

/** Compose REP-103 poses: parent * child (child rotation as euler or quaternion). */
export function composeRep103Poses(parent, child) {
    const pQ = parent.rotation?.w !== undefined
        ? parent.rotation
        : eulerToQuaternion(parent.rotation || {});
    const cQ = child.rotation?.w !== undefined
        ? child.rotation
        : eulerToQuaternion(child.rotation || {});
    const q = quaternionMultiply(pQ, cQ);
    const rotated = rotateVectorByQuaternion(child.position || { x: 0, y: 0, z: 0 }, pQ);
    return {
        position: {
            x: Number(parent.position?.x || 0) + rotated.x,
            y: Number(parent.position?.y || 0) + rotated.y,
            z: Number(parent.position?.z || 0) + rotated.z,
        },
        rotation: q,
    };
}

/** LiDAR spherical directions in REP-103 sensor frame (+X forward at az=0, el=0). */
export function lidarDirectionRep103(thetaRad, phiRad) {
    const cosPhi = Math.cos(phiRad);
    return {
        x: cosPhi * Math.cos(thetaRad),
        y: cosPhi * Math.sin(thetaRad),
        z: Math.sin(phiRad),
    };
}

/** Convert Three.js shader-local direction to REP-103 sensor frame. */
export function lidarShaderDirectionToRep103(thetaRad, phiRad) {
    const three = {
        x: Math.cos(phiRad) * Math.cos(thetaRad),
        y: Math.sin(phiRad),
        z: Math.cos(phiRad) * Math.sin(thetaRad),
    };
    return threeToRep103Vector(three);
}

export function stampToTimeNs(stamp = {}) {
    const sec = Number(stamp.sec || 0);
    const nanosec = Number(stamp.nanosec || 0);
    return sec * 1e9 + nanosec;
}

export function extractHeaderCaptureTimeNs(value) {
    const header = value?.header;
    if (!header?.stamp) return null;
    return stampToTimeNs(header.stamp);
}
