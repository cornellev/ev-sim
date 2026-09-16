import { cloneValue } from "../runtime/SignalStore.js";
import { parseValueByType } from "./program/ProgramTypes.js";

export const ARRAY_ITEM_TYPES = Object.freeze(["float64", "int32", "boolean", "string", "json"]);

export function normalizeItemType(value, fallback = "float64") {
    if (ARRAY_ITEM_TYPES.includes(value)) return value;
    if (ARRAY_ITEM_TYPES.includes(fallback)) return fallback;
    return "float64";
}

export function arrayType(itemType) {
    return `array[${normalizeItemType(itemType)}]`;
}

export function isArrayValue(value) {
    if (Array.isArray(value)) return true;
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    if (trimmed.length === 0) return false;
    try {
        return Array.isArray(JSON.parse(trimmed));
    } catch {
        return false;
    }
}

export function asArray(value, itemType = "float64") {
    const type = normalizeItemType(itemType);
    let source = value;
    if (typeof source === "string") {
        const trimmed = source.trim();
        if (trimmed.length === 0) return [];
        try {
            source = JSON.parse(trimmed);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(source)) return [];
    return cloneValue(source.map((item) => parseValueByType(item, type)));
}
