/** Playground and run-keyboard share these targets. The plant still rate-limits. */
export const KEYBOARD_DRIVE_SPEED_MPS = 5;
export const KEYBOARD_STEER_RATE_RAD = 50 * Math.PI / 180;

const QUIET = new Set();

export function createKeyboardDriveState() {
    return { latched: false, steeringRadThree: 0 };
}

function heldKeys(down) {
    return down && typeof down.has === "function" ? down : QUIET;
}

/**
 * One fixed step of browser WASD. `null` leaves the plant in control passthrough.
 * After the first press, later quiet steps keep the latched wheel at speed 0.
 */
export function keyboardDriveSpeed(limits) {
    return Number.isFinite(limits?.maxSpeed) && limits.maxSpeed >= 0
        ? Math.min(KEYBOARD_DRIVE_SPEED_MPS, limits.maxSpeed) : 0;
}

export function stepKeyboardDrive(state, { down, dt, enabled, limits, currentSteeringRad } = {}) {
    const current = state ?? createKeyboardDriveState();
    if (!enabled) return { state: current, command: null };
    if (!Number.isFinite(limits?.maxSpeed) || limits.maxSpeed < 0
        || !Number.isFinite(limits?.maxSteeringAngle) || limits.maxSteeringAngle < 0) {
        return { state: createKeyboardDriveState(), command: null };
    }
    const held = heldKeys(down);
    const driving = held.has("w") || held.has("a") || held.has("s") || held.has("d");
    if (!driving && !current.latched) return { state: current, command: null };
    const step = Number(dt);
    const dtSafe = Number.isFinite(step) && step > 0 ? step : 0;
    const steering = held.has("a") || held.has("d");
    let steeringRadThree = (!current.latched || steering) && Number.isFinite(currentSteeringRad) ? currentSteeringRad : current.steeringRadThree;
    const rate = Number.isFinite(limits.maxSteeringRate) ? Math.max(0, Math.min(KEYBOARD_STEER_RATE_RAD, limits.maxSteeringRate)) : KEYBOARD_STEER_RATE_RAD;
    if (held.has("a")) steeringRadThree += rate * dtSafe;
    if (held.has("d")) steeringRadThree -= rate * dtSafe;
    steeringRadThree = Math.max(-limits.maxSteeringAngle, Math.min(limits.maxSteeringAngle, steeringRadThree));
    const speedMps = held.has("w")
        ? keyboardDriveSpeed(limits)
        : held.has("s") ? -keyboardDriveSpeed(limits) : 0;
    return {
        state: { latched: true, steeringRadThree },
        command: {
            mode: "velocity",
            speedMps,
            steeringRadRep103: steeringRadThree,
        },
    };
}
