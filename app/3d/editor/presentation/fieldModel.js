/**
 * Pure field model behind the generic inspector controls: number formatting
 * and parsing, keyboard stepping and drag scrubbing, grouping descriptors into
 * sections, mixed values across a multi-selection, and mapping validation
 * issues back to the field that raised them. No React or DOM.
 */

import { fieldPathKey, getFieldValue, isPlainObject } from "../objects/ObjectOptions.js";

export const DEFAULT_GROUP = "General";
export const SCRUB_PIXELS_PER_STEP = 4;

export function fieldKey(descriptor) {
    return fieldPathKey(descriptor?.path ?? []);
}

/** Decimal places implied by a step (`1` → 0, `0.5` → 1, `0.05` → 2); two when unknown. */
export function precisionForStep(step) {
    if (!Number.isFinite(step) || step <= 0) return 2;
    if (Number.isInteger(step)) return 0;
    const text = String(step);
    if (text.includes("e-")) return Math.min(6, Number(text.split("e-")[1]) || 2);
    return Math.min(6, (text.split(".")[1] ?? "").length);
}

export function formatFieldNumber(value, descriptor = {}) {
    if (!Number.isFinite(value)) return "";
    const precision = precisionForStep(descriptor.step);
    const text = value.toFixed(precision);
    // Trim trailing zeros beyond the step precision only when the step is unknown.
    return descriptor.step === undefined ? text.replace(/\.?0+$/, "") || "0" : text;
}

/**
 * Parse typed input: trims whitespace and a trailing units suffix, accepts a
 * comma decimal separator. Never clamps; range issues come from validation so
 * the user sees them instead of a silently corrected value.
 */
export function parseNumberDraft(text, descriptor = {}) {
    let source = String(text ?? "").trim();
    if (!source) return { ok: false, reason: "empty" };
    if (descriptor.units && source.toLowerCase().endsWith(String(descriptor.units).toLowerCase())) {
        source = source.slice(0, -String(descriptor.units).length).trim();
    }
    source = source.replace(",", ".");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(source)) return { ok: false, reason: "not-a-number" };
    const value = Number(source);
    if (!Number.isFinite(value)) return { ok: false, reason: "not-a-number" };
    return { ok: true, value };
}

export function clampToDescriptor(value, descriptor = {}) {
    let next = value;
    if (Number.isFinite(descriptor.min)) next = Math.max(descriptor.min, next);
    if (Number.isFinite(descriptor.max)) next = Math.min(descriptor.max, next);
    return next;
}

/** Snap to the step grid anchored at `min` (or zero) and round away float noise. */
export function snapToStep(value, descriptor = {}) {
    const step = descriptor.step;
    if (!Number.isFinite(step) || step <= 0) return value;
    const origin = Number.isFinite(descriptor.min) ? descriptor.min : 0;
    const snapped = origin + Math.round((value - origin) / step) * step;
    const precision = precisionForStep(step);
    return Number(snapped.toFixed(precision));
}

function stepFactor({ shift = false, alt = false } = {}) {
    return shift ? 10 : alt ? 0.1 : 1;
}

/** Arrow-key stepping: ±step (Shift ×10, Alt ×0.1), snapped and clamped. */
export function stepFieldValue(value, descriptor = {}, direction = 1, modifiers = {}) {
    const base = Number.isFinite(value) ? value : 0;
    const step = Number.isFinite(descriptor.step) && descriptor.step > 0 ? descriptor.step : 1;
    const next = base + (direction < 0 ? -1 : 1) * step * stepFactor(modifiers);
    const precision = Math.max(precisionForStep(step), modifiers.alt ? precisionForStep(step) + 1 : 0);
    return clampToDescriptor(Number(next.toFixed(precision)), descriptor);
}

/** Drag scrubbing: `SCRUB_PIXELS_PER_STEP` pixels per step, modifiers as for stepping. */
export function scrubFieldValue(start, deltaPx, descriptor = {}, modifiers = {}) {
    const base = Number.isFinite(start) ? start : 0;
    const step = Number.isFinite(descriptor.step) && descriptor.step > 0 ? descriptor.step : 1;
    const steps = Math.trunc((Number(deltaPx) || 0) / SCRUB_PIXELS_PER_STEP);
    const next = base + steps * step * stepFactor(modifiers);
    const precision = precisionForStep(step) + (modifiers.alt ? 1 : 0);
    return clampToDescriptor(Number(next.toFixed(precision)), descriptor);
}

/**
 * Group descriptors by `group` in first-appearance order. Advanced fields are
 * dropped unless `advanced` is set; groups left empty are omitted.
 * @returns {Array<{ id: string, title: string, fields: object[] }>}
 */
export function groupFields(fields, { advanced = false } = {}) {
    const groups = new Map();
    for (const descriptor of fields ?? []) {
        if (descriptor.advanced && !advanced) continue;
        const title = descriptor.group || DEFAULT_GROUP;
        if (!groups.has(title)) groups.set(title, { id: `group:${title}`, title, fields: [] });
        groups.get(title).fields.push(descriptor);
    }
    return [...groups.values()];
}

export function hasAdvancedFields(fields) {
    return (fields ?? []).some((descriptor) => descriptor.advanced);
}

function valuesEqual(left, right) {
    if (left === right) return true;
    if (left === null || right === null || left === undefined || right === undefined) return false;
    if (typeof left === "object" && typeof right === "object") return JSON.stringify(left) === JSON.stringify(right);
    return false;
}

/** The value a field shows for several records: the shared value, or `mixed`. */
export function mixedValueOf(valuesList, descriptor) {
    if (!Array.isArray(valuesList) || valuesList.length === 0) return { mixed: false, value: undefined };
    const first = getFieldValue(valuesList[0], descriptor.path);
    for (const values of valuesList.slice(1)) {
        if (!valuesEqual(first, getFieldValue(values, descriptor.path))) return { mixed: true, value: undefined };
    }
    return { mixed: false, value: first };
}

/**
 * Field state for a selection. `read(record)` returns `{ fields, values }`.
 * Records of different types share no fields; same-type records show the
 * intersection of their visible fields with mixed detection.
 */
export function selectionFieldState(records, read) {
    const list = Array.isArray(records) ? records.filter(Boolean) : [];
    if (list.length === 0) return { typeId: null, mixedTypes: false, fields: [], valuesList: [], states: new Map() };
    const typeId = list[0].typeId;
    if (list.some((record) => record.typeId !== typeId)) {
        return { typeId: null, mixedTypes: true, fields: [], valuesList: [], states: new Map() };
    }
    const projections = list.map((record) => read(record) ?? { fields: [], values: null });
    const valuesList = projections.map((entry) => entry.values);
    let fields = projections[0].fields ?? [];
    for (const projection of projections.slice(1)) {
        const keys = new Set((projection.fields ?? []).map(fieldKey));
        fields = fields.filter((descriptor) => keys.has(fieldKey(descriptor)));
    }
    const states = new Map();
    for (const descriptor of fields) states.set(fieldKey(descriptor), mixedValueOf(valuesList, descriptor));
    return { typeId, mixedTypes: false, fields, valuesList, states };
}

/** Map issues to field keys; issues without a field path land under "". */
export function issuesByPath(issues) {
    const map = new Map();
    for (const issue of issues ?? []) {
        const key = Array.isArray(issue?.path) ? fieldPathKey(issue.path) : "";
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(issue);
    }
    return map;
}

/** Issues for a field, including issues raised on a parent or child path. */
export function issuesForField(index, descriptor) {
    const key = fieldKey(descriptor);
    const matches = [];
    for (const [entryKey, list] of index ?? []) {
        if (!entryKey) continue;
        if (entryKey === key || entryKey.startsWith(`${key}.`) || key.startsWith(`${entryKey}.`)) matches.push(...list);
    }
    return matches;
}

export function defaultValueFor(descriptor, defaults) {
    return isPlainObject(defaults) ? getFieldValue(defaults, descriptor.path) : undefined;
}

export function isDefaultValue(descriptor, value, defaults) {
    const fallback = defaultValueFor(descriptor, defaults);
    return fallback === undefined ? true : valuesEqual(value, fallback);
}

/** One patch entry updating a single axis of a vector field. */
export function vector3Patch(descriptor, current, axis, value) {
    const base = isPlainObject(current) ? current : { x: 0, y: 0, z: 0 };
    return { path: [...descriptor.path], value: { x: base.x ?? 0, y: base.y ?? 0, z: base.z ?? 0, [axis]: value } };
}
