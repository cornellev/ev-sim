/** Root orientation presets. Z-up is -90 degrees about X, xyzw. */

export const Y_UP_ORIENTATION = Object.freeze([0, 0, 0, 1]);
export const Z_UP_ORIENTATION = Object.freeze([-Math.SQRT1_2, 0, 0, Math.SQRT1_2]);

function matches(orientation, preset) {
    return Array.isArray(orientation)
        && orientation.length === preset.length
        && preset.every((value, index) => value === orientation[index]);
}

export function orientationId(orientation) {
    if (matches(orientation, Y_UP_ORIENTATION)) return "y-up";
    if (matches(orientation, Z_UP_ORIENTATION)) return "z-up";
    return "custom";
}
