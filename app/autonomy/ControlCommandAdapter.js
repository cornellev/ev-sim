/**
 * Validate and normalize stamped SI Ackermann commands into the simulator's
 * internal control shape. REP-103 steering (positive left) is converted to the
 * Three.js plant sign (positive right / negative left) once at the actuator
 * boundary via `rep103SteeringToThree`.
 */

export const CONTROL_MODES = Object.freeze(["velocity", "acceleration", "stop"]);

export function finiteOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function isFiniteNumber(value) {
    return Number.isFinite(Number(value));
}

/** Convert REP-103 steering (positive left) to Three.js bicycle steering (positive right). */
export function rep103SteeringToThree(steeringRad) {
    return -Number(steeringRad || 0);
}

/** Convert Three.js plant steering back to REP-103 for telemetry. */
export function threeSteeringToRep103(steeringRad) {
    return -Number(steeringRad || 0);
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

/**
 * Validate a stamped SI command payload. Returns { ok, code, message, command }.
 * Does not perform authority selection or actuator limiting.
 */
export function validateStampedAckermannCommand(value, { applyTimeNs = null } = {}) {
    if (value == null || typeof value !== "object") {
        return { ok: false, code: "malformed-payload", message: "Control command must be an object." };
    }
    if (!value.header?.stamp) {
        return { ok: false, code: "missing-stamp", message: "StampedAckermannDrive requires header.stamp." };
    }
    const mode = String(value.mode || "velocity").trim();
    if (!CONTROL_MODES.includes(mode)) {
        return { ok: false, code: "invalid-mode", message: `Mode must be one of ${CONTROL_MODES.join(", ")}.` };
    }
    const sequence = Number(value.sequence);
    if (!Number.isInteger(sequence) || sequence < 0) {
        return { ok: false, code: "invalid-sequence", message: "sequence must be a non-negative integer." };
    }
    const fields = ["steering_angle", "steering_angle_velocity", "speed", "acceleration", "jerk"];
    for (const field of fields) {
        if (value[field] !== undefined && value[field] !== null && !isFiniteNumber(value[field])) {
            return { ok: false, code: "non-finite", message: `${field} must be finite.` };
        }
    }
    const deadlineNs = value.deadline_ns === undefined || value.deadline_ns === null
        ? null
        : Number(value.deadline_ns);
    if (deadlineNs !== null && (!Number.isFinite(deadlineNs) || deadlineNs < 0)) {
        return { ok: false, code: "invalid-deadline", message: "deadline_ns must be a non-negative finite simulation time." };
    }
    // deadline_ns <= 0 means "no deadline" (unset).
    const effectiveDeadline = deadlineNs !== null && deadlineNs > 0 ? deadlineNs : null;
    if (effectiveDeadline !== null && Number.isFinite(applyTimeNs) && applyTimeNs > effectiveDeadline) {
        return { ok: false, code: "expired-deadline", message: "Command deadline has already passed." };
    }
    return { ok: true, code: null, message: null };
}

/**
 * Normalize a validated stamped SI payload into the internal control command.
 * Steering sign conversion happens here so plant consumers always see Three.js convention.
 */
export function normalizeStampedAckermannCommand(value, {
    applyTimeNs = null,
    producer = "candidate",
    source = "topic",
} = {}) {
    const validation = validateStampedAckermannCommand(value, { applyTimeNs });
    if (!validation.ok) {
        return { ...validation, command: null };
    }
    const stamp = value.header.stamp;
    const captureTimeNs = Math.floor(Number(stamp.sec) * 1e9 + Number(stamp.nanosec || 0));
    const mode = String(value.mode || "velocity").trim();
    const steeringRadRep103 = Number(value.steering_angle || 0);
    const command = emptyInternalCommand({
        mode: mode === "stop" ? "stop" : mode,
        sequence: Math.floor(Number(value.sequence)),
        captureTimeNs: Number.isFinite(captureTimeNs) ? captureTimeNs : null,
        deadlineNs: value.deadline_ns == null || Number(value.deadline_ns) <= 0 ? null : Number(value.deadline_ns),
        frameId: String(value.header?.frame_id || ""),
        speedMps: mode === "stop" ? 0 : Number(value.speed || 0),
        accelerationMps2: mode === "stop" ? 0 : Number(value.acceleration || 0),
        jerkMps3: Number(value.jerk || 0),
        steeringRadRep103: mode === "stop" ? 0 : steeringRadRep103,
        steeringRateRadps: Number(value.steering_angle_velocity || 0),
        steeringRadThree: mode === "stop" ? 0 : rep103SteeringToThree(steeringRadRep103),
        producer,
        source,
    });
    return { ok: true, code: null, message: null, command };
}

/** Build a stamped SI envelope from an internal command (for active.* / fallback). */
export function toStampedAckermannEnvelope(command, { applyTimeNs = 0, frameId = "base_link" } = {}) {
    const timeNs = Number.isFinite(command?.captureTimeNs) ? command.captureTimeNs : applyTimeNs;
    return {
        header: {
            stamp: {
                sec: Math.floor(timeNs / 1e9),
                nanosec: timeNs % 1e9,
            },
            frame_id: command?.frameId || frameId,
        },
        sequence: Math.max(0, Math.floor(Number(command?.sequence || 0))),
        mode: command?.mode || "stop",
        deadline_ns: command?.deadlineNs ?? 0,
        steering_angle: Number(command?.steeringRadRep103 || 0),
        steering_angle_velocity: Number(command?.steeringRateRadps || 0),
        speed: Number(command?.speedMps || 0),
        acceleration: Number(command?.accelerationMps2 || 0),
        jerk: Number(command?.jerkMps3 || 0),
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
