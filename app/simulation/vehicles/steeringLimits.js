/** Plant steer stop: authored angle, or 0.6 rad, and never past the bicycle cap. */
export function steeringAngleStop(maxAngleRad) {
    const angle = Number(maxAngleRad);
    const positive = Number.isFinite(angle) && angle > 0 ? angle : 0.6;
    return Math.min(positive, Math.PI * 0.49);
}

/**
 * Move the current steer toward the target by at most rate * dt, after the
 * target is clamped to the angle stop. A non-positive dt or rate holds.
 * @returns {{ angleRad: number, saturated: boolean, rateLimited: boolean }}
 */
export function slewSteeringAngle({
    currentRad = 0,
    targetRad,
    maxAngleRad,
    maxRateRadPerSec,
    dtSeconds,
} = {}) {
    const current = Number.isFinite(Number(currentRad)) ? Number(currentRad) : 0;
    const rate = Number(maxRateRadPerSec);
    const dt = Number(dtSeconds);
    if (!(dt > 0) || !(rate > 0)) {
        return { angleRad: current, saturated: false, rateLimited: false };
    }
    const target = Number.isFinite(Number(targetRad)) ? Number(targetRad) : current;
    const stop = steeringAngleStop(maxAngleRad);
    const clamped = Math.max(-stop, Math.min(stop, target));
    const maxDelta = rate * dt;
    const angleRad = Math.max(current - maxDelta, Math.min(current + maxDelta, clamped));
    return {
        angleRad,
        saturated: clamped !== target,
        rateLimited: angleRad !== clamped,
    };
}

/** Clamp a playground command to the angle stop. Non-finite input stays unset. */
export function clampPlaygroundSteerTarget(targetRad, maxAngleRad) {
    const target = Number(targetRad);
    if (!Number.isFinite(target)) return null;
    const stop = steeringAngleStop(maxAngleRad);
    return Math.max(-stop, Math.min(stop, target));
}

/**
 * Move the playground steer target one tick. The step is the slower of the
 * keyboard rate and the vehicle rate, and the result stays inside the stop.
 */
export function movePlaygroundSteerTarget(targetRad, {
    currentRad = 0,
    direction = 0,
    dtSeconds = 0,
    maxAngleRad,
    maxRateRadPerSec,
    keyboardRateRadPerSec,
} = {}) {
    const stop = steeringAngleStop(maxAngleRad);
    const keyboard = Number(keyboardRateRadPerSec);
    const vehicle = Number(maxRateRadPerSec);
    const keyboardRate = Number.isFinite(keyboard) && keyboard > 0 ? keyboard : 0;
    const vehicleRate = Number.isFinite(vehicle) && vehicle > 0 ? vehicle : keyboardRate;
    const rate = Math.min(keyboardRate, vehicleRate);
    const base = Number.isFinite(Number(targetRad))
        ? Number(targetRad)
        : (Number.isFinite(Number(currentRad)) ? Number(currentRad) : 0);
    const dt = Number(dtSeconds) > 0 ? Number(dtSeconds) : 0;
    const next = base + direction * rate * dt;
    return Math.max(-stop, Math.min(stop, next));
}
