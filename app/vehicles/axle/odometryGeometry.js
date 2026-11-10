import { canonicalFiniteNumber } from "../../simulation/kernel/SimulationHashes.js";
import { proposeStandardPair, withinPairTolerance } from "./standardAxle.js";

export function rearOdometryGeometry(wheels = []) {
    const rear = wheels.filter((wheel) => wheel.axle === "rear");
    if (rear.length !== 2) return null;
    const left = rear.find((wheel) => wheel.side === "left");
    const right = rear.find((wheel) => wheel.side === "right");
    if (!left || !right) return null;
    if ([left, right].some((wheel) => ![wheel.position?.x, wheel.position?.y, wheel.position?.z, wheel.radius, wheel.width].every(Number.isFinite)
        || wheel.radius <= 0 || wheel.width <= 0)) return null;
    const pair = proposeStandardPair(left, right, { axle: "rear" });
    if (pair.issues.length || !pair.withinTolerance) return null;
    const trackWidth = canonicalFiniteNumber(Math.abs(left.position.z - right.position.z));
    const wheelRadius = canonicalFiniteNumber((left.radius + right.radius) / 2);
    return trackWidth > 0 && wheelRadius > 0 ? { trackWidth, wheelRadius } : null;
}

export function reviewOdometryGeometry(manifest) {
    const sensors = (manifest.sensors ?? []).filter((sensor) => sensor.type === "wheel-odometry");
    if (!sensors.length) return null;
    const geometry = rearOdometryGeometry(manifest.wheels);
    const mismatches = geometry ? sensors.filter((sensor) => Object.entries(geometry).some(([key, value]) => (
        !Number.isFinite(sensor.config?.[key]) || !withinPairTolerance(sensor.config[key], value)
    ))) : sensors;
    return mismatches.length ? { geometry, sensors: mismatches.map((sensor) => ({ id: sensor.id, config: { ...sensor.config } })) } : null;
}
