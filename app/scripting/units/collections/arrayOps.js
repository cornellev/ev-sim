import { cloneValue } from "../../runtime/SignalStore.js";
import { finiteInt32, valuesEqual } from "../../types/PortTypes.js";
import { parseValueByType } from "../program/ProgramTypes.js";
import { asArray, isArrayValue, normalizeItemType } from "../valueOps.js";

export function arrayLength(values, itemType) {
    return finiteInt32(asArray(values, itemType).length);
}

export function arrayGet(values, index, fallback, itemType) {
    const items = asArray(values, itemType);
    const position = finiteInt32(index);
    if (position < 0 || position >= items.length) {
        return {
            value: parseValueByType(cloneValue(fallback), normalizeItemType(itemType)),
            found: false,
        };
    }
    return { value: cloneValue(items[position]), found: true };
}

export function arraySet(values, index, nextValue, itemType) {
    if (!isArrayValue(values)) return { value: [], changed: false };
    const items = asArray(values, itemType);
    const position = finiteInt32(index);
    if (position < 0 || position >= items.length) {
        return { value: items, changed: false };
    }
    const next = cloneValue(items);
    next[position] = parseValueByType(cloneValue(nextValue), normalizeItemType(itemType));
    return { value: next, changed: true };
}

export function arrayAppend(values, nextValue, itemType) {
    const items = asArray(values, itemType);
    items.push(parseValueByType(cloneValue(nextValue), normalizeItemType(itemType)));
    return items;
}

export function arrayConcat(a, b, itemType) {
    return asArray(a, itemType).concat(asArray(b, itemType));
}

export function arraySlice(values, start, end, itemType) {
    return asArray(values, itemType).slice(finiteInt32(start), finiteInt32(end));
}

export function arrayContains(values, needle, itemType) {
    const type = normalizeItemType(itemType);
    const expected = parseValueByType(cloneValue(needle), type);
    return asArray(values, type).some((item) => valuesEqual(item, expected));
}
