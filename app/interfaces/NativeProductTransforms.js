import { eulerToQuaternion, quaternionInverse, quaternionMultiply, quaternionToEuler, rotateVectorByQuaternion, threeToRep103Vector } from "../autonomy/CoordinateFrames.js";
import { resolveMeasurementToRoot } from "../autonomy/CalibrationBundle.js";

export function assertRigidPose(pose) {
    if (!pose || ![pose.position?.x, pose.position?.y, pose.position?.z,
        pose.orientation?.x, pose.orientation?.y, pose.orientation?.z, pose.orientation?.w].every(Number.isFinite)
        || Math.abs(Math.hypot(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w) - 1) > 1e-6) throw new Error("A finite pose with unit quaternion is required.");
    return pose;
}

export function poseAtOffset(pose, offset) {
    assertRigidPose(pose);
    if (!offset || ![offset.x, offset.y, offset.z].every(Number.isFinite)) throw new Error("A finite offset is required.");
    const rotated = rotateVectorByQuaternion(offset, pose.orientation);
    return { position: { x: pose.position.x + rotated.x, y: pose.position.y + rotated.y, z: pose.position.z + rotated.z }, orientation: { ...pose.orientation } };
}

export function frameTransform(value, from, to) {
    assertRigidPose(from); assertRigidPose(to);
    const inverse = quaternionInverse(to.orientation);
    const orientation = quaternionMultiply(inverse, from.orientation);
    const offset = rotateVectorByQuaternion({ x: from.position.x - to.position.x, y: from.position.y - to.position.y, z: from.position.z - to.position.z }, inverse);
    if (value.orientation) {
        assertRigidPose(value);
        const position = rotateVectorByQuaternion(value.position, orientation);
        return { position: { x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z }, orientation: quaternionMultiply(orientation, value.orientation) };
    }
    if (![value.x, value.y, value.z].every(Number.isFinite)) throw new Error("A finite point is required.");
    const position = rotateVectorByQuaternion(value, orientation);
    return { x: position.x + offset.x, y: position.y + offset.y, z: position.z + offset.z };
}

const MAX_OCCUPANCY_CELLS = 1_000_000;

/** Onboarding grid: planning +y is scene −Z, and cost paint treats only 1 as blocked. */
export function stackOccupancy(grid) {
    const width = grid?.width;
    const height = grid?.height;
    const resolution = grid?.resolution_m;
    const origin = grid?.origin;
    const weights = grid?.weights;
    const cells = Number.isInteger(width) && Number.isInteger(height) ? width * height : NaN;
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1
        || !Number.isSafeInteger(cells) || cells > MAX_OCCUPANCY_CELLS
        || typeof resolution !== "number" || !(resolution > 0)
        || typeof origin?.x !== "number" || typeof origin?.y !== "number"
        || ![origin.x, origin.y].every(Number.isFinite)
        || !Array.isArray(weights) || weights.length !== cells) {
        throw new Error("Occupancy grid dimensions, resolution, origin, or storage are invalid.");
    }
    const data = new Uint8Array(cells);
    for (let row = 0; row < height; row++) {
        const source = (height - 1 - row) * width;
        for (let col = 0; col < width; col++) {
            const weight = weights[source + col];
            if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 0 || weight > 0xffffffff) {
                throw new Error("Occupancy weights must be unsigned 32-bit integers.");
            }
            data[row * width + col] = weight >= 128 ? 1 : 0;
        }
    }
    return {
        data, width, height, resolutionM: resolution, encoding: "cost",
        origin: { x: origin.x, y: 0, z: -(origin.y + height * resolution) },
    };
}

export function applyNativeOperation(operation, value, args) {
    if (operation === "poseAtOffset") return poseAtOffset(value, args.offsetFrom);
    if (operation === "frameTransform") return frameTransform(value, args.fromFrame, args.toFrame);
    if (operation === "quaternionYaw") {
        assertRigidPose({ position: { x: 0, y: 0, z: 0 }, orientation: value });
        return quaternionToEuler(value).z;
    }
    if (operation === "stackOccupancy") return stackOccupancy(value);
    throw new Error(`Unavailable native operation ${operation}.`);
}

export function bindNativeProductContext(selection = {}, resolvedRun = {}) {
    const result = {};
    if (selection.vehicleId !== undefined || selection.rearWheelIds !== undefined) {
        const entry = resolvedRun.vehicles?.find((entry) => entry.actorId === selection.vehicleId);
        if (!entry?.manifest) throw new Error("Native binding requires an exact resolved vehicle actor ID.");
        const manifest = entry.manifest;
        result.vehicle = { wheelbase: manifest.kinematics.wheelbase, length: manifest.boundingBox.size.x, width: manifest.boundingBox.size.z };
        if (selection.rearWheelIds) {
            const pair = selection.rearWheelIds.map((id) => manifest.wheels.find((wheel) => wheel.id === id));
            if (pair.some((wheel) => !wheel || wheel.steerable || ![wheel.position.x, wheel.position.y, wheel.position.z].every(Number.isFinite))
                || Math.abs(pair[0].position.x - pair[1].position.x) > 1e-6
                || Math.abs(pair[0].position.y - pair[1].position.y) > 1e-6
                || Math.abs(pair[0].position.z + pair[1].position.z) > 1e-6
                || Math.abs(pair[0].position.z - pair[1].position.z) <= 1e-6
                || pair.some((wheel) => wheel.axle && wheel.axle !== "rear")) throw new Error("Select an explicit fixed rear wheel pair with matching axle geometry.");
            result.vehicle.rearAxleInBase = threeToRep103Vector({ x: (pair[0].position.x + pair[1].position.x) / 2,
                y: (pair[0].position.y + pair[1].position.y) / 2, z: (pair[0].position.z + pair[1].position.z) / 2 });
        }
    }
    if (selection.sensorId !== undefined) {
        const sensor = resolvedRun.calibration?.sensors?.find((sensor) => sensor.id === selection.sensorId);
        const pose = resolveMeasurementToRoot(resolvedRun.calibration, selection.sensorId);
        if (!sensor || !pose || (selection.vehicleId && sensor.parentId !== selection.vehicleId)) throw new Error("Native binding requires a matching resolved sensor calibration.");
        const poseInRoot = { position: { ...pose.position }, orientation: eulerToQuaternion(pose.rotation) };
        assertRigidPose(poseInRoot);
        const mapMounted = sensor.poseReference === "map";
        if (mapMounted && selection.vehicleId) throw new Error("Map-mounted sensors cannot bind a vehicle base frame.");
        result.sensor = { poseInRoot, rootFrameId: mapMounted ? resolvedRun.calibration.frames.map : resolvedRun.calibration.frames.baseLink,
            [mapMounted ? "poseInMap" : "poseInBase"]: poseInRoot, frameId: sensor.measurementFrameId };
        if (result.vehicle?.rearAxleInBase) result.sensor.poseInRearAxle = { position: {
            x: poseInRoot.position.x - result.vehicle.rearAxleInBase.x,
            y: poseInRoot.position.y - result.vehicle.rearAxleInBase.y,
            z: poseInRoot.position.z - result.vehicle.rearAxleInBase.z }, orientation: { ...poseInRoot.orientation } };
    }
    return result;
}
