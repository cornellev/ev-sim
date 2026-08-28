import {
    composeRep103Poses,
    eulerToQuaternion,
    quaternionInverse,
    quaternionMultiply,
    rotateVectorByQuaternion,
    threePoseToRep103,
    threeToRep103Vector,
} from "./CoordinateFrames.js";
import { enuOffsetToWgs84 } from "../3d/earth/GeospatialTransform.js";

const GRAVITY = 9.80665;
const UNAVAILABLE_COVARIANCE = -1;

function vec3(value = {}, fallback = { x: 0, y: 0, z: 0 }) {
    return {
        x: Number(value.x ?? fallback.x),
        y: Number(value.y ?? fallback.y),
        z: Number(value.z ?? fallback.z),
    };
}

function axisVec3(source = {}, fallback = 0) {
    if (Array.isArray(source)) {
        return { x: Number(source[0] ?? fallback), y: Number(source[1] ?? fallback), z: Number(source[2] ?? fallback) };
    }
    return vec3(source, { x: fallback, y: fallback, z: fallback });
}

export function gaussianSample(rng) {
    const left = Math.max(Number.EPSILON, rng.next());
    return Math.sqrt(-2 * Math.log(left)) * Math.cos(2 * Math.PI * rng.next());
}

export function sampleAxisNoise(rng, stdDev, bias = { x: 0, y: 0, z: 0 }, drift = { x: 0, y: 0, z: 0 }) {
    const perturb = (axis) => (Number(bias[axis] || 0) + Number(drift[axis] || 0))
        + gaussianSample(rng) * Number(stdDev[axis] || 0);
    return { x: perturb("x"), y: perturb("y"), z: perturb("z") };
}

export function advanceCorrelatedDrift(state, tauSeconds, sigma, dtSeconds, rng) {
    const next = { ...state };
    for (const axis of ["x", "y", "z"]) {
        const tau = Math.max(Number.EPSILON, Number(tauSeconds[axis] ?? tauSeconds));
        const alpha = Math.exp(-dtSeconds / tau);
        const processNoise = Number(sigma[axis] || 0) * Math.sqrt(Math.max(0, 1 - alpha * alpha));
        next[axis] = alpha * Number(state[axis] || 0) + processNoise * gaussianSample(rng);
    }
    return next;
}

export function diagonalCovariance(values) {
    const matrix = new Array(9).fill(0);
    matrix[0] = values.x * values.x;
    matrix[4] = values.y * values.y;
    matrix[8] = values.z * values.z;
    return matrix;
}

export function expandPoseCovariance(values) {
    const matrix = new Array(36).fill(0);
    matrix[0] = values.x * values.x;
    matrix[7] = values.y * values.y;
    matrix[14] = values.z * values.z;
    matrix[35] = (values.yaw ?? values.z ?? 0) * (values.yaw ?? values.z ?? 0);
    return matrix;
}

export function expandTwistCovariance(values) {
    const matrix = new Array(36).fill(0);
    matrix[0] = values.x * values.x;
    matrix[7] = values.y * values.y;
    matrix[14] = values.z * values.z;
    matrix[35] = (values.yaw ?? values.z ?? 0) * (values.yaw ?? values.z ?? 0);
    return matrix;
}

export function saturateVector(vector, limit) {
    const max = Math.max(0, Number(limit) || Infinity);
    return {
        x: Math.max(-max, Math.min(max, vector.x)),
        y: Math.max(-max, Math.min(max, vector.y)),
        z: Math.max(-max, Math.min(max, vector.z)),
    };
}

export function rep103PoseFromVehicle(vehicle) {
    const position = vehicle?.position || vehicle?.getPosition?.();
    const rotation = vehicle?.rotation || vehicle?.getRotation?.();
    return threePoseToRep103({
        position: {
            x: Number(position?.x || 0),
            y: Number(position?.y || 0),
            z: Number(position?.z || 0),
        },
        rotation: {
            x: Number(rotation?.x || 0),
            y: Number(rotation?.y || 0),
            z: Number(rotation?.z || 0),
            order: rotation?.order || "XYZ",
        },
    });
}

export function rep103BodyVelocity(vehicle) {
    const velocity = vehicle?.velocity || { x: 0, y: 0, z: 0 };
    return threeToRep103Vector({
        x: Number(velocity.x || 0),
        y: Number(velocity.y || 0),
        z: Number(velocity.z || 0),
    });
}

export function captureVehicleSnapshot(vehicle, captureTimeNs, previous = null, stepNs = 16_666_667) {
    const pose = rep103PoseFromVehicle(vehicle);
    const orientation = eulerToQuaternion(pose.rotation);
    const bodyVelocity = rep103BodyVelocity(vehicle);
    const wheelbase = Number(vehicle?.manifest?.kinematics?.wheelbase || vehicle?.wheelbase || 2.5);
    const steeringAngle = Number(vehicle?.steeringAngle || 0);
    const speed = bodyVelocity.x;
    const yawRate = wheelbase > 0 ? (speed / wheelbase) * Math.tan(steeringAngle) : 0;
    const bodyAngularVelocity = { x: 0, y: 0, z: yawRate };

    let bodyAcceleration = { x: 0, y: 0, z: 0 };
    if (previous?.captureTimeNs != null && captureTimeNs > previous.captureTimeNs) {
        const dt = (captureTimeNs - previous.captureTimeNs) / 1e9;
        if (dt > 0) {
            bodyAcceleration = {
                x: (bodyVelocity.x - previous.bodyVelocity.x) / dt,
                y: (bodyVelocity.y - previous.bodyVelocity.y) / dt,
                z: (bodyVelocity.z - previous.bodyVelocity.z) / dt,
            };
        }
    }

    return {
        captureTimeNs,
        pose,
        orientation,
        bodyVelocity,
        bodyAngularVelocity,
        bodyAcceleration,
        wheelbase,
        steeringAngle,
        speed,
    };
}

export function sensorFrameRotation(sensorPose = {}) {
    const mountPose = {
        position: vec3(sensorPose.position),
        rotation: eulerToQuaternion(sensorPose.rotation || {}),
    };
    return mountPose.rotation;
}

export function vectorToSensorFrame(vector, sensorRotation) {
    const inverse = quaternionInverse(sensorRotation);
    return rotateVectorByQuaternion(vector, inverse);
}

export function gravityRep103(magnitude = GRAVITY) {
    return { x: 0, y: 0, z: -Number(magnitude) };
}

export function specificForceRep103(bodyAcceleration, sensorRotation, gravityMagnitude = GRAVITY) {
    const gravity = gravityRep103(gravityMagnitude);
    const specificWorld = {
        x: bodyAcceleration.x - gravity.x,
        y: bodyAcceleration.y - gravity.y,
        z: bodyAcceleration.z - gravity.z,
    };
    return vectorToSensorFrame(specificWorld, sensorRotation);
}

export function unavailableOrientationCovariance() {
    const matrix = new Array(9).fill(0);
    matrix[0] = UNAVAILABLE_COVARIANCE;
    return matrix;
}

export function buildImuMeasurement(snapshot, sensorConfig, rng, state = {}) {
    const sensorRotation = sensorFrameRotation(sensorConfig.pose);
    const angularVelocity = vectorToSensorFrame(snapshot.bodyAngularVelocity, sensorRotation);
    const specificForce = specificForceRep103(snapshot.bodyAcceleration, sensorRotation, sensorConfig.calibration.gravity);
    const noise = sensorConfig.calibration.noise || {};
    const turnOnBias = state.turnOnBias || sensorConfig.calibration.turnOnBias || { x: 0, y: 0, z: 0 };
    const drift = state.drift || { angular: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 } };
    const dt = state.lastCaptureTimeNs != null && snapshot.captureTimeNs > state.lastCaptureTimeNs
        ? (snapshot.captureTimeNs - state.lastCaptureTimeNs) / 1e9
        : 1 / Math.max(1, sensorConfig.rateHz);

    const nextDrift = {
        angular: advanceCorrelatedDrift(
            drift.angular,
            noise.angularDriftTauSec || sensorConfig.calibration.angularDriftTauSec || 100,
            noise.angularRandomWalk || sensorConfig.calibration.angularRandomWalk || { x: 0, y: 0, z: 0 },
            dt,
            rng,
        ),
        acceleration: advanceCorrelatedDrift(
            drift.acceleration,
            noise.accelerationDriftTauSec || sensorConfig.calibration.accelerationDriftTauSec || 100,
            noise.accelerationRandomWalk || sensorConfig.calibration.accelerationRandomWalk || { x: 0, y: 0, z: 0 },
            dt,
            rng,
        ),
    };

    const angularNoise = sampleAxisNoise(
        rng,
        noise.angularVelocityStdDev || sensorConfig.calibration.angularVelocityStdDev || { x: 0, y: 0, z: 0 },
        turnOnBias.angular || turnOnBias,
        nextDrift.angular,
    );
    const accelerationNoise = sampleAxisNoise(
        rng,
        noise.linearAccelerationStdDev || sensorConfig.calibration.linearAccelerationStdDev || { x: 0, y: 0, z: 0 },
        turnOnBias.acceleration || { x: 0, y: 0, z: 0 },
        nextDrift.acceleration,
    );

    const measuredAngular = saturateVector({
        x: angularVelocity.x + angularNoise.x,
        y: angularVelocity.y + angularNoise.y,
        z: angularVelocity.z + angularNoise.z,
    }, sensorConfig.calibration.angularVelocitySaturation);
    const measuredAcceleration = saturateVector({
        x: specificForce.x + accelerationNoise.x,
        y: specificForce.y + accelerationNoise.y,
        z: specificForce.z + accelerationNoise.z,
    }, sensorConfig.calibration.linearAccelerationSaturation);

    return {
        measurement: {
            angularVelocity: measuredAngular,
            linearAcceleration: measuredAcceleration,
            orientationCovariance: unavailableOrientationCovariance(),
            angularVelocityCovariance: diagonalCovariance(noise.angularVelocityStdDev || sensorConfig.calibration.angularVelocityStdDev || { x: 0, y: 0, z: 0 }),
            linearAccelerationCovariance: diagonalCovariance(noise.linearAccelerationStdDev || sensorConfig.calibration.linearAccelerationStdDev || { x: 0, y: 0, z: 0 }),
        },
        nextState: {
            turnOnBias,
            drift: nextDrift,
            lastCaptureTimeNs: snapshot.captureTimeNs,
            saturated: measuredAngular.x !== angularVelocity.x + angularNoise.x
                || measuredAcceleration.z !== specificForce.z + accelerationNoise.z,
        },
    };
}

export function buildGnssMeasurement(snapshot, sensorConfig, rng, state = {}) {
    const faults = sensorConfig.calibration.faults || {};
    const datum = sensorConfig.calibration.datum || { latitude: 42.4430, longitude: -76.4840, altitude: 200 };
    const positionEnu = {
        east: snapshot.pose.position.x,
        north: snapshot.pose.position.y,
        up: snapshot.pose.position.z,
    };
    const dt = state.lastCaptureTimeNs != null && snapshot.captureTimeNs > state.lastCaptureTimeNs
        ? (snapshot.captureTimeNs - state.lastCaptureTimeNs) / 1e9
        : 1 / Math.max(1, sensorConfig.rateHz);

    const nextMultipath = advanceCorrelatedDrift(
        state.multipath || { x: 0, y: 0, z: 0 },
        faults.multipathTauSec || 30,
        faults.multipathStdDev || sensorConfig.calibration.positionNoiseEnu || { x: 0, y: 0, z: 0 },
        dt,
        rng,
    );

    const dropoutProbability = Number(faults.dropoutProbability ?? sensorConfig.noise?.dropoutProbability ?? 0);
    if (dropoutProbability > 0 && rng.next() < dropoutProbability) {
        return { measurement: null, nextState: { ...state, multipath: nextMultipath, lastCaptureTimeNs: snapshot.captureTimeNs, dropped: true } };
    }

    const outageProbability = Number(faults.outageProbability ?? 0);
    const inOutage = state.inOutage || (outageProbability > 0 && rng.next() < outageProbability);
    if (inOutage) {
        return {
            measurement: {
                status: -1,
                service: 1,
                latitude: Number.NaN,
                longitude: Number.NaN,
                altitude: Number.NaN,
                positionCovariance: new Array(9).fill(0),
                positionCovarianceType: 0,
                noFix: true,
            },
            nextState: { ...state, multipath: nextMultipath, inOutage: true, lastCaptureTimeNs: snapshot.captureTimeNs },
        };
    }

    const positionNoise = sampleAxisNoise(
        rng,
        sensorConfig.calibration.positionNoiseEnu || { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        nextMultipath,
    );
    const noisyEnu = {
        east: positionEnu.east + positionNoise.x,
        north: positionEnu.north + positionNoise.y,
        up: positionEnu.up + positionNoise.z,
    };
    const wgs84 = enuOffsetToWgs84(noisyEnu.east, noisyEnu.north, noisyEnu.up, datum);
    const positionCovariance = diagonalCovariance(sensorConfig.calibration.positionNoiseEnu || { x: 0, y: 0, z: 0 });

    return {
        measurement: {
            status: 0,
            service: 1,
            latitude: wgs84.lat,
            longitude: wgs84.lng,
            altitude: wgs84.alt,
            positionCovariance,
            positionCovarianceType: 2,
            noFix: false,
        },
        nextState: { ...state, multipath: nextMultipath, inOutage: false, lastCaptureTimeNs: snapshot.captureTimeNs, dropped: false },
    };
}

export function quantizeTravel(distanceMeters, wheelRadius, ticksPerRevolution) {
    const circumference = 2 * Math.PI * Math.max(Number.EPSILON, wheelRadius);
    const ticks = Math.round((distanceMeters / circumference) * ticksPerRevolution);
    return (ticks / ticksPerRevolution) * circumference;
}

export function wheelTravelFromBicycle(snapshot, trackWidth, slipFactor = 0) {
    const speed = snapshot.speed;
    const yawRate = snapshot.bodyAngularVelocity.z;
    const dt = 1 / Math.max(1, snapshot.rateHz || 50);
    const centerTravel = speed * dt;
    const leftTravel = centerTravel * (1 - slipFactor) - (yawRate * trackWidth * dt) / 2;
    const rightTravel = centerTravel * (1 - slipFactor) + (yawRate * trackWidth * dt) / 2;
    return { leftTravel, rightTravel, centerTravel, dt };
}

export function integrateWheelOdometry(state, leftTravel, rightTravel, trackWidth) {
    const averageTravel = (leftTravel + rightTravel) / 2;
    const deltaYaw = trackWidth > 0 ? (rightTravel - leftTravel) / trackWidth : 0;
    const heading = Number(state.heading || 0) + deltaYaw / 2;
    const nextHeading = heading + deltaYaw / 2;
    const dx = averageTravel * Math.cos(nextHeading);
    const dy = averageTravel * Math.sin(nextHeading);
    return {
        position: {
            x: Number(state.position?.x || 0) + dx,
            y: Number(state.position?.y || 0) + dy,
            z: Number(state.position?.z || 0),
        },
        heading: nextHeading,
        linearVelocity: {
            x: averageTravel / Math.max(Number.EPSILON, state.dt || 0.02),
            y: 0,
            z: 0,
        },
        angularVelocity: { x: 0, y: 0, z: deltaYaw / Math.max(Number.EPSILON, state.dt || 0.02) },
    };
}

export function buildWheelOdometryMeasurement(snapshot, sensorConfig, rng, state = {}) {
    const calibration = sensorConfig.calibration;
    snapshot.rateHz = sensorConfig.rateHz;
    const { leftTravel, rightTravel, dt } = wheelTravelFromBicycle(
        snapshot,
        calibration.trackWidth,
        calibration.slipFactor,
    );
    const leftQuantized = quantizeTravel(leftTravel, calibration.wheelRadius, calibration.ticksPerRevolution);
    const rightQuantized = quantizeTravel(rightTravel, calibration.wheelRadius, calibration.ticksPerRevolution);
    const integrated = integrateWheelOdometry(
        { ...state.odometry, dt },
        leftQuantized,
        rightQuantized,
        calibration.trackWidth,
    );

    const poseNoise = sampleAxisNoise(rng, calibration.poseNoise || { x: 0, y: 0, z: 0 });
    const twistNoise = sampleAxisNoise(rng, calibration.twistNoise || { x: 0, y: 0, z: 0 });
    const yaw = integrated.heading;
    const halfYaw = yaw / 2;

    return {
        measurement: {
            position: {
                x: integrated.position.x + poseNoise.x,
                y: integrated.position.y + poseNoise.y,
                z: integrated.position.z + poseNoise.z,
            },
            orientation: { x: 0, y: 0, z: Math.sin(halfYaw), w: Math.cos(halfYaw) },
            linearVelocity: {
                x: integrated.linearVelocity.x + twistNoise.x,
                y: integrated.linearVelocity.y + twistNoise.y,
                z: integrated.linearVelocity.z + twistNoise.z,
            },
            angularVelocity: {
                x: integrated.angularVelocity.x,
                y: integrated.angularVelocity.y,
                z: integrated.angularVelocity.z + twistNoise.z,
            },
            poseCovariance: expandPoseCovariance(calibration.poseNoise || { x: 0, y: 0, z: 0 }),
            twistCovariance: expandTwistCovariance(calibration.twistNoise || { x: 0, y: 0, z: 0 }),
            childFrameId: sensorConfig.calibration.childFrameId || "base_link",
        },
        nextState: {
            odometry: integrated,
            leftTicks: Number(state.leftTicks || 0) + Math.round((leftQuantized / (2 * Math.PI * calibration.wheelRadius)) * calibration.ticksPerRevolution),
            rightTicks: Number(state.rightTicks || 0) + Math.round((rightQuantized / (2 * Math.PI * calibration.wheelRadius)) * calibration.ticksPerRevolution),
            lastCaptureTimeNs: snapshot.captureTimeNs,
        },
    };
}

export function buildTruthOdometry(snapshot, frames = {}) {
    const pose = snapshot.pose;
    const orientation = snapshot.orientation;
    return {
        position: { ...pose.position },
        orientation: { ...orientation },
        linearVelocity: { ...snapshot.bodyVelocity },
        angularVelocity: { ...snapshot.bodyAngularVelocity },
        childFrameId: frames.baseLink || "base_link",
        headerFrameId: frames.odom || "odom",
        poseCovariance: new Array(36).fill(0),
        twistCovariance: new Array(36).fill(0),
    };
}

export function createMeasurementSeedState(sensorConfig, seed) {
    const rng = typeof seed === "object" && seed.next ? seed : null;
    const turnOnBias = {
        angular: axisVec3(sensorConfig.calibration?.turnOnBias?.angular || sensorConfig.calibration?.turnOnBias, 0),
        acceleration: axisVec3(sensorConfig.calibration?.turnOnBias?.acceleration, 0),
    };
    if (rng && sensorConfig.type === "imu") {
        const biasScale = sensorConfig.calibration?.turnOnBias?.randomize === false ? 0 : 1;
        if (biasScale > 0) {
            turnOnBias.angular = {
                x: gaussianSample(rng) * (sensorConfig.calibration.turnOnBias?.angular?.x || 0.001),
                y: gaussianSample(rng) * (sensorConfig.calibration.turnOnBias?.angular?.y || 0.001),
                z: gaussianSample(rng) * (sensorConfig.calibration.turnOnBias?.angular?.z || 0.001),
            };
            turnOnBias.acceleration = {
                x: gaussianSample(rng) * (sensorConfig.calibration.turnOnBias?.acceleration?.x || 0.01),
                y: gaussianSample(rng) * (sensorConfig.calibration.turnOnBias?.acceleration?.y || 0.01),
                z: gaussianSample(rng) * (sensorConfig.calibration.turnOnBias?.acceleration?.z || 0.01),
            };
        }
    }
    return {
        turnOnBias,
        drift: { angular: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 } },
        multipath: { x: 0, y: 0, z: 0 },
        odometry: { position: { x: 0, y: 0, z: 0 }, heading: 0 },
        leftTicks: 0,
        rightTicks: 0,
        inOutage: false,
        lastCaptureTimeNs: null,
        vehicleSnapshot: null,
    };
}

export { GRAVITY, UNAVAILABLE_COVARIANCE, axisVec3, vec3, composeRep103Poses };
