import { CONTACT_BICYCLE_MODEL, normalizeVehicleManifest } from "../../app/vehicles/VehicleManifest.js";

export const RC_TEST_DYNAMICS = Object.freeze({
    mass: 3, yawInertia: 0.032661, corneringStiffnessFront: 160, corneringStiffnessRear: 160,
    frictionMu: 0.9, rollingResistance: 0.015,
});

export function rcVehicleManifest(dynamics = { model: CONTACT_BICYCLE_MODEL }) {
    return normalizeVehicleManifest({
        id: "synthetic-rc-car",
        boundingBox: { size: { x: 0.297, y: 0.117, z: 0.206 }, center: { x: 0, y: 0.0585, z: 0 } },
        dynamics: { ...dynamics, ...RC_TEST_DYNAMICS },
        kinematics: { wheelbase: 0.18688, maxSpeed: 1, maxAcceleration: 0.5, maxDeceleration: 1, maxJerk: 3, maxSteeringAngle: 0.4 },
        wheels: [true, false].flatMap((front) => [1, -1].map((side) => ({
            id: `${front ? "front" : "rear"}-${side === 1 ? "left" : "right"}`,
            position: { x: front ? 0.09344 : -0.09344, y: 0.055, z: side * 0.0835 },
            radius: 0.055, width: 0.04, steerable: front,
        }))),
    });
}
