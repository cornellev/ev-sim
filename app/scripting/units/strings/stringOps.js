import { parseValueByType } from "../program/ProgramTypes.js";

export function asString(value) {
    return parseValueByType(value, "string");
}

export function concatString(a, b) {
    return asString(a) + asString(b);
}

export function stringLength(value) {
    return asString(value).length;
}

export function stringContains(value, search) {
    return asString(value).includes(asString(search));
}

export function stringStartsWith(value, search) {
    return asString(value).startsWith(asString(search));
}

export function stringEndsWith(value, search) {
    return asString(value).endsWith(asString(search));
}

export function trimString(value) {
    return asString(value).trim();
}

export function lowercaseString(value) {
    return asString(value).toLowerCase();
}

export function uppercaseString(value) {
    return asString(value).toUpperCase();
}

export function sliceString(value, start, end) {
    return asString(value).slice(start, end);
}

export function replaceString(value, search, replacement) {
    const source = asString(value);
    const needle = asString(search);
    if (needle.length === 0) return source;
    return source.split(needle).join(asString(replacement));
}

export function splitString(value, separator) {
    return asString(value).split(asString(separator));
}

export function joinString(values, separator) {
    if (!Array.isArray(values)) return "";
    return values.map((item) => asString(item)).join(asString(separator));
}
