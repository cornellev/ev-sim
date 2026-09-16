import { finiteFloat, finiteResult, orderedBounds } from "../../types/PortTypes.js";

export function add(a, b) {
    return finiteResult(finiteFloat(a) + finiteFloat(b));
}

export function sub(a, b) {
    return finiteResult(finiteFloat(a) - finiteFloat(b));
}

export function mul(a, b) {
    return finiteResult(finiteFloat(a) * finiteFloat(b));
}

export function div(a, b) {
    const denominator = finiteFloat(b);
    if (denominator === 0) return 0;
    return finiteResult(finiteFloat(a) / denominator);
}

export function mod(a, b) {
    const denominator = finiteFloat(b);
    if (denominator === 0) return 0;
    return finiteResult(finiteFloat(a) % denominator);
}

export function pow(a, b) {
    return finiteResult(Math.pow(finiteFloat(a), finiteFloat(b)));
}

export function min(a, b) {
    return finiteResult(Math.min(finiteFloat(a), finiteFloat(b)));
}

export function max(a, b) {
    return finiteResult(Math.max(finiteFloat(a), finiteFloat(b)));
}

export function neg(value) {
    return finiteResult(-finiteFloat(value));
}

export function abs(value) {
    return finiteResult(Math.abs(finiteFloat(value)));
}

export function sign(value) {
    return finiteResult(Math.sign(finiteFloat(value)));
}

export function sqrt(value) {
    const x = finiteFloat(value);
    if (x < 0) return 0;
    return finiteResult(Math.sqrt(x));
}

export function exp(value) {
    return finiteResult(Math.exp(finiteFloat(value)));
}

export function ln(value) {
    const x = finiteFloat(value);
    if (x <= 0) return 0;
    return finiteResult(Math.log(x));
}

export function log10(value) {
    const x = finiteFloat(value);
    if (x <= 0) return 0;
    return finiteResult(Math.log10(x));
}

export function clamp(value, minValue, maxValue) {
    const bounds = orderedBounds(minValue, maxValue);
    const x = finiteFloat(value);
    return finiteResult(Math.max(bounds.min, Math.min(bounds.max, x)));
}

export function lerp(a, b, t) {
    const start = finiteFloat(a);
    const end = finiteFloat(b);
    const amount = finiteFloat(t);
    return finiteResult(start + amount * (end - start));
}

export function inverseLerp(value, minValue, maxValue) {
    const bounds = orderedBounds(minValue, maxValue);
    if (bounds.min === bounds.max) return 0;
    return finiteResult((finiteFloat(value) - bounds.min) / (bounds.max - bounds.min));
}

export function smoothstep(value, minValue, maxValue) {
    const t = Math.max(0, Math.min(1, inverseLerp(value, minValue, maxValue)));
    return finiteResult(t * t * (3 - 2 * t));
}

export function deadband(value, width) {
    const x = finiteFloat(value);
    const band = Math.abs(finiteFloat(width));
    return Math.abs(x) <= band ? 0 : x;
}

export function sin(value) {
    return finiteResult(Math.sin(finiteFloat(value)));
}

export function cos(value) {
    return finiteResult(Math.cos(finiteFloat(value)));
}

export function tan(value) {
    return finiteResult(Math.tan(finiteFloat(value)));
}

export function asin(value) {
    const x = finiteFloat(value);
    if (x < -1 || x > 1) return 0;
    return finiteResult(Math.asin(x));
}

export function acos(value) {
    const x = finiteFloat(value);
    if (x < -1 || x > 1) return 0;
    return finiteResult(Math.acos(x));
}

export function atan(value) {
    return finiteResult(Math.atan(finiteFloat(value)));
}

export function degToRad(value) {
    return finiteResult(finiteFloat(value) * (Math.PI / 180));
}

export function radToDeg(value) {
    return finiteResult(finiteFloat(value) * (180 / Math.PI));
}

export function wrapRadians(value) {
    const x = finiteFloat(value);
    return finiteResult(Math.atan2(Math.sin(x), Math.cos(x)));
}

export function atan2(y, x) {
    return finiteResult(Math.atan2(finiteFloat(y), finiteFloat(x)));
}
