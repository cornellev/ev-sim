/** Zoom-adaptive meter steps for the asset studio unit grid. Pure: no Three, no DOM. */

const MIN_STEP_METERS = 0.001;
const MAX_STEP_METERS = 1000;

function finitePositive(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function decadePower(value) {
    return 10 ** Math.floor(Math.log10(value) + 1e-12);
}

/** Smallest 1-2-5 step at or above `raw`, before the millimeter/kilometer clamp. */
function niceStep(raw) {
    if (!Number.isFinite(raw) || raw <= 0) return MIN_STEP_METERS;
    const pow = decadePower(raw);
    const fraction = raw / pow;
    let nice = 10;
    if (fraction <= 1) nice = 1;
    else if (fraction <= 2) nice = 2;
    else if (fraction <= 5) nice = 5;
    return nice * pow;
}

/** Next coarser 1-2-5 step. `1 → 2 → 5 → 10`. */
export function nextNiceStep(minorMeters) {
    const minor = finitePositive(minorMeters, MIN_STEP_METERS);
    const pow = decadePower(minor);
    const mantissa = minor / pow;
    if (mantissa < 1.5) return 2 * pow;
    if (mantissa < 3.5) return 5 * pow;
    return 10 * pow;
}

/**
 * World size of the view at the orbit target.
 * `metersPerPixel` is the vertical size of one screen pixel on that plane.
 */
export function visibleMetersAtTarget({ distance, fovDegrees, viewportHeightPx, viewportWidthPx } = {}) {
    const safeDistance = finitePositive(distance, 1);
    const heightPx = finitePositive(viewportHeightPx, 1);
    const widthPx = finitePositive(viewportWidthPx, 1);
    const fov = finitePositive(fovDegrees, 45);
    const clampedFov = Math.min(fov, 179);
    const height = 2 * safeDistance * Math.tan((clampedFov * Math.PI) / 360);
    const width = height * (widthPx / heightPx);
    return { height, width, metersPerPixel: height / heightPx };
}

/**
 * Minor cell size so lines sit about `minorTargetPx` apart, on a 1-2-5 ladder.
 * Major lines are ten minor cells. Steps clamp to 1 mm … 1 km.
 */
export function selectUnitStep(metersPerPixel, { minorTargetPx = 12 } = {}) {
    const pixels = finitePositive(minorTargetPx, 12);
    const raw = finitePositive(metersPerPixel, MIN_STEP_METERS) * pixels;
    let minorMeters = niceStep(raw);
    if (minorMeters < MIN_STEP_METERS) minorMeters = MIN_STEP_METERS;
    if (minorMeters > MAX_STEP_METERS) minorMeters = MAX_STEP_METERS;
    return { minorMeters, majorMeters: minorMeters * 10 };
}

function trimNumber(value) {
    const rounded = Math.round(value * 1000) / 1000;
    return String(rounded);
}

/** `1 mm`, `10 cm`, `1 m`, `2 m`, `1 km`. */
export function formatUnitLabel(meters) {
    const value = Math.abs(Number.isFinite(meters) ? meters : 0);
    if (value >= 1000) return `${trimNumber(value / 1000)} km`;
    if (value >= 1) return `${trimNumber(value)} m`;
    if (value >= 0.01) return `${trimNumber(value * 100)} cm`;
    return `${trimNumber(value * 1000)} mm`;
}

/** Signed tick text. Zero is `0`; other values keep the mm / cm / m / km rules. */
export function formatSignedUnitLabel(meters) {
    if (!Number.isFinite(meters) || Math.abs(meters) < 1e-9) return "0";
    const text = formatUnitLabel(Math.abs(meters));
    return meters < 0 ? `-${text}` : text;
}
