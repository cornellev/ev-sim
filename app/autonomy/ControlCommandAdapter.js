/**
 * Convert SI commands into the simulator's
 * internal control shape. REP-103 and the plant share a sign: positive is left
 * (yaw increases). `rep103SteeringToThree` keeps that sign.
 */

export const CONTROL_MODES = Object.freeze(["velocity", "acceleration", "stop"]);

export function finiteOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}

/** REP-103 and the plant share a sign. Positive is left. */
export function rep103SteeringToThree(steeringRad) {
    return Number(steeringRad || 0);
}

/** Plant steering back to REP-103. Same sign. */
export function threeSteeringToRep103(steeringRad) {
    return Number(steeringRad || 0);
}

export function emptyInternalCommand(overrides = {}) {
    return {
        mode: "stop",
        sequence: 0,
        captureTimeNs: null,
        deadlineNs: null,
        frameId: "",
        speedMps: 0,
        accelerationMps2: 0,
        jerkMps3: 0,
        steeringRadRep103: 0,
        steeringRateRadps: 0,
        steeringRadThree: 0,
        producer: null,
        source: null,
        ...overrides,
    };
}

/** Convert a simple SI speed/steer pair (scenario/reference) into an internal command. */
export function internalCommandFromSi({
    speedMps = 0,
    steeringRadRep103 = 0,
    accelerationMps2 = 0,
    mode = "velocity",
    sequence = 0,
    captureTimeNs = null,
    deadlineNs = null,
    producer = "reference",
    source = "scenario",
} = {}) {
    const stop = mode === "stop";
    return emptyInternalCommand({
        mode: stop ? "stop" : mode,
        sequence,
        captureTimeNs,
        deadlineNs,
        speedMps: stop ? 0 : Number(speedMps || 0),
        accelerationMps2: stop ? 0 : Number(accelerationMps2 || 0),
        steeringRadRep103: stop ? 0 : Number(steeringRadRep103 || 0),
        steeringRadThree: stop ? 0 : rep103SteeringToThree(steeringRadRep103),
        producer,
        source,
    });
}
