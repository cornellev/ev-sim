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
export function stepKeyboardDrive(state, { down, dt, enabled } = {}) {
    const current = state ?? createKeyboardDriveState();
    if (!enabled) return { state: current, command: null };
    const held = heldKeys(down);
    const driving = held.has("w") || held.has("a") || held.has("s") || held.has("d");
    if (!driving && !current.latched) return { state: current, command: null };
    const step = Number(dt);
    const dtSafe = Number.isFinite(step) && step > 0 ? step : 0;
    let steeringRadThree = current.steeringRadThree;
    if (held.has("a")) steeringRadThree += KEYBOARD_STEER_RATE_RAD * dtSafe;
    if (held.has("d")) steeringRadThree -= KEYBOARD_STEER_RATE_RAD * dtSafe;
    const speedMps = held.has("w")
        ? KEYBOARD_DRIVE_SPEED_MPS
        : held.has("s") ? -KEYBOARD_DRIVE_SPEED_MPS : 0;
    return {
        state: { latched: true, steeringRadThree },
        command: {
            mode: "velocity",
            speedMps,
            steeringRadRep103: steeringRadThree === 0 ? 0 : -steeringRadThree,
        },
    };
}
