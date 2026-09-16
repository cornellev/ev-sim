import { cloneValue } from "../../runtime/SignalStore.js";
import { finiteFloat, finiteInt32 } from "../../types/PortTypes.js";

export function floorToInt(value) {
    return finiteInt32(Math.floor(finiteFloat(value)));
}

export function ceilToInt(value) {
    return finiteInt32(Math.ceil(finiteFloat(value)));
}

export function roundToInt(value) {
    return finiteInt32(Math.round(finiteFloat(value)));
}

export function truncToInt(value) {
    return finiteInt32(Math.trunc(finiteFloat(value)));
}

export function boolToInt(value) {
    return Boolean(value) ? 1 : 0;
}

export function boolToFloat(value) {
    return Boolean(value) ? 1 : 0;
}

export function intToBool(value) {
    return finiteInt32(value) !== 0;
}

export function floatToBool(value) {
    return finiteFloat(value) !== 0;
}

export function floatToString(value) {
    return String(finiteFloat(value));
}

export function intToString(value) {
    return String(finiteInt32(value));
}

export function boolToString(value) {
    return Boolean(value) ? "true" : "false";
}

export function stringToFloat(text) {
    const trimmed = String(text ?? "").trim();
    if (trimmed.length === 0) return { value: 0, valid: false };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return { value: 0, valid: false };
    return { value: parsed, valid: true };
}

export function stringToInt(text) {
    const trimmed = String(text ?? "").trim();
    if (!/^-?\d+$/.test(trimmed)) return { value: 0, valid: false };
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < -2147483648 || parsed > 2147483647) {
        return { value: 0, valid: false };
    }
    return { value: parsed, valid: true };
}

export function stringToBool(text) {
    const trimmed = String(text ?? "").trim().toLowerCase();
    if (trimmed === "true" || trimmed === "1") return { value: true, valid: true };
    if (trimmed === "false" || trimmed === "0") return { value: false, valid: true };
    return { value: false, valid: false };
}

export function parseJson(text) {
    if (typeof text !== "string") return { value: null, valid: false };
    const trimmed = text.trim();
    if (trimmed.length === 0) return { value: null, valid: false };
    try {
        return { value: cloneValue(JSON.parse(trimmed)), valid: true };
    } catch {
        return { value: null, valid: false };
    }
}

export function stringifyJson(value) {
    try {
        const text = JSON.stringify(value);
        if (typeof text !== "string") return { value: "", valid: false };
        return { value: text, valid: true };
    } catch {
        return { value: "", valid: false };
    }
}
