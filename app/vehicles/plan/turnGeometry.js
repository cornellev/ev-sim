/**
 * Vehicle-plan turn geometry.
 * The clamp and radius match KinematicVehiclePlant: positive steering curves
 * toward -Z, and the simulator center stays on the origin. Ideal Ackermann is
 * an illustration about the authored rear axle. It does not drive the plant.
 */

const PLANT_STEERING_CAP = Math.PI * 0.49;

function finiteOr(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function plantSteeringLimit(maxSteeringAngle) {
    return Math.min(finiteOr(maxSteeringAngle, 0.6), PLANT_STEERING_CAP);
}

/** Same clamp as KinematicVehiclePlant, including the 0.6 default. */
export function clampPlantSteering(angle, maxSteeringAngle) {
    const limit = plantSteeringLimit(maxSteeringAngle);
    const requested = finiteOr(angle, 0);
    return Math.max(-limit, Math.min(limit, requested));
}

export function simulatorTurn({ wheelbase, steeringAngle, maxSteeringAngle } = {}) {
    const requestedAngle = finiteOr(steeringAngle, 0);
    const appliedAngle = clampPlantSteering(requestedAngle, maxSteeringAngle);
    const length = Math.max(1e-9, finiteOr(wheelbase, 1.5));
    const straight = appliedAngle === 0;
    const extreme = Math.abs(Math.abs(appliedAngle) - PLANT_STEERING_CAP) <= 1e-12;
    if (straight) {
        return {
            requestedAngle,
            appliedAngle,
            wheelbase: length,
            straight: true,
            extreme: false,
            radius: null,
            center: null,
        };
    }
    const radius = length / Math.tan(appliedAngle);
    return {
        requestedAngle,
        appliedAngle,
        wheelbase: length,
        straight: false,
        extreme,
        radius,
        center: { x: 0, z: -radius },
    };
}

/**
 * Fold atan2(L, lateral) into (-π/2, π/2). A negative command then mirrors
 * the positive one instead of wrapping toward π when the center is on +Z.
 */
function ackermannYaw(longitudinal, lateral) {
    if (lateral === 0) return Math.sign(longitudinal || 1) * (Math.PI / 2);
    return Math.atan2(longitudinal * Math.sign(lateral), Math.abs(lateral));
}

export function idealAckermann({
    rearAxleX,
    frontAxleX,
    halfTrack,
    steeringAngle,
    maxSteeringAngle,
} = {}) {
    const rear = finiteOr(rearAxleX, 0);
    const front = finiteOr(frontAxleX, 0);
    const track = Math.abs(finiteOr(halfTrack, 0));
    const geometricWheelbase = front - rear;
    const appliedAngle = clampPlantSteering(steeringAngle, maxSteeringAngle);
    const unavailable = {
        available: false,
        rearAxleX: rear,
        geometricWheelbase,
        radius: null,
        center: null,
        leftAngle: null,
        rightAngle: null,
        innerSide: null,
        outerSide: null,
        singular: false,
    };
    if (!(geometricWheelbase > 0)) return unavailable;
    if (appliedAngle === 0) {
        return {
            ...unavailable,
            available: true,
            leftAngle: 0,
            rightAngle: 0,
        };
    }
    const radius = geometricWheelbase / Math.tan(appliedAngle);
    const center = { x: rear, z: -radius };
    if (Math.abs(radius) <= track) {
        return {
            available: true,
            rearAxleX: rear,
            geometricWheelbase,
            radius,
            center,
            leftAngle: null,
            rightAngle: null,
            innerSide: null,
            outerSide: null,
            singular: true,
        };
    }
    const leftAngle = ackermannYaw(geometricWheelbase, track - center.z);
    const rightAngle = ackermannYaw(geometricWheelbase, -track - center.z);
    const innerSide = appliedAngle > 0 ? "right" : "left";
    const outerSide = appliedAngle > 0 ? "left" : "right";
    return {
        available: true,
        rearAxleX: rear,
        geometricWheelbase,
        radius,
        center,
        leftAngle,
        rightAngle,
        innerSide,
        outerSide,
        singular: false,
    };
}

function axlePair(wheels, axle) {
    const members = (wheels ?? []).filter((wheel) => wheel.axle === axle);
    const left = members.find((wheel) => wheel.side === "left") ?? null;
    const right = members.find((wheel) => wheel.side === "right") ?? null;
    if (!left || !right || members.length !== 2) return null;
    return { left, right };
}

export function describeTurnGeometry(manifest, steeringAngle = 0) {
    const simulator = simulatorTurn({
        wheelbase: manifest?.kinematics?.wheelbase,
        steeringAngle,
        maxSteeringAngle: manifest?.kinematics?.maxSteeringAngle,
    });
    const version3 = Number(manifest?.version) === 3;
    const front = version3 ? axlePair(manifest?.wheels, "front") : null;
    const rear = version3 ? axlePair(manifest?.wheels, "rear") : null;
    const ackermann = front && rear
        ? idealAckermann({
            rearAxleX: rear.left.position?.x,
            frontAxleX: front.left.position?.x,
            halfTrack: front.left.position?.z,
            steeringAngle,
            maxSteeringAngle: manifest?.kinematics?.maxSteeringAngle,
        })
        : {
            available: false,
            rearAxleX: null,
            geometricWheelbase: null,
            radius: null,
            center: null,
            leftAngle: null,
            rightAngle: null,
            innerSide: null,
            outerSide: null,
            singular: false,
        };
    return { simulator, ackermann };
}

export function visualWheelYaws(manifest, appliedAngle) {
    const described = describeTurnGeometry(manifest, appliedAngle);
    const ideal = described.ackermann.available
        && !described.ackermann.singular
        && described.ackermann.leftAngle != null
        && described.ackermann.rightAngle != null;
    return (manifest?.wheels ?? []).map((wheel) => {
        if (wheel.steerable !== true) return { wheelId: wheel.id, yaw: 0 };
        if (ideal && wheel.axle === "front" && wheel.side === "left") {
            return { wheelId: wheel.id, yaw: described.ackermann.leftAngle };
        }
        if (ideal && wheel.axle === "front" && wheel.side === "right") {
            return { wheelId: wheel.id, yaw: described.ackermann.rightAngle };
        }
        return { wheelId: wheel.id, yaw: described.simulator.appliedAngle };
    });
}
