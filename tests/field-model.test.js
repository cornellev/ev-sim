import assert from "node:assert/strict";
import test from "node:test";

import { field } from "../app/3d/editor/objects/ObjectOptions.js";
import {
    SCRUB_PIXELS_PER_STEP,
    clampToDescriptor,
    defaultValueFor,
    fieldKey,
    formatFieldNumber,
    groupFields,
    hasAdvancedFields,
    isDefaultValue,
    issuesByPath,
    issuesForField,
    mixedValueOf,
    parseNumberDraft,
    precisionForStep,
    scrubFieldValue,
    selectionFieldState,
    snapToStep,
    stepFieldValue,
    vector3Patch,
} from "../app/3d/editor/presentation/fieldModel.js";

const WIDTH = field({ path: ["width"], label: "Width", control: "number", units: "m", min: 0.5, step: 0.1, group: "Cross-section" });
const LANES = field({ path: ["laneCount"], label: "Lanes", control: "number", min: 1, max: 8, step: 1, group: "Cross-section" });
const TWO_WAY = field({ path: ["bidirectional"], label: "Two-way", control: "toggle", group: "Direction" });
const DIRECTION = field({ path: ["direction"], label: "One-way direction", control: "number", min: -1, max: 1, step: 2, group: "Direction", advanced: true });
const TIME = field({ path: ["takram", "timeOfDay"], label: "Time of day", control: "number", units: "h", min: 0, max: 23.99, step: 0.1 });
const POSITION = field({ path: ["position"], label: "Position", control: "vector3", units: "m" });

test("ED-03 numbers format with the precision their step implies and parse tolerant input", () => {
    assert.equal(precisionForStep(1), 0);
    assert.equal(precisionForStep(0.5), 1);
    assert.equal(precisionForStep(0.05), 2);
    assert.equal(precisionForStep(0.001), 3);
    assert.equal(precisionForStep(undefined), 2);
    assert.equal(formatFieldNumber(7, WIDTH), "7.0");
    assert.equal(formatFieldNumber(2, LANES), "2");
    assert.equal(formatFieldNumber(14.4, TIME), "14.4");
    assert.equal(formatFieldNumber(1.5, POSITION), "1.5", "unknown step trims trailing zeros");
    assert.equal(formatFieldNumber(2, POSITION), "2");
    assert.equal(formatFieldNumber(Number.NaN, WIDTH), "");

    assert.deepEqual(parseNumberDraft(" 7.5 m ", WIDTH), { ok: true, value: 7.5 });
    assert.deepEqual(parseNumberDraft("7,25", WIDTH), { ok: true, value: 7.25 });
    assert.deepEqual(parseNumberDraft("-1", DIRECTION), { ok: true, value: -1 });
    assert.deepEqual(parseNumberDraft("1e2", WIDTH), { ok: true, value: 100 });
    assert.equal(parseNumberDraft("", WIDTH).ok, false);
    assert.equal(parseNumberDraft("abc", WIDTH).ok, false);
    assert.equal(parseNumberDraft("7 mm", WIDTH).ok, false, "a foreign suffix is not silently dropped");
    assert.deepEqual(parseNumberDraft("0.1", WIDTH), { ok: true, value: 0.1 }, "parsing never clamps; validation reports the range");
});

test("ED-03 stepping, scrubbing, snapping, and clamping follow the descriptor", () => {
    assert.equal(stepFieldValue(7, WIDTH, 1), 7.1);
    assert.equal(stepFieldValue(7, WIDTH, -1, { shift: true }), 6);
    assert.equal(stepFieldValue(7, WIDTH, 1, { alt: true }), 7.01);
    assert.equal(stepFieldValue(0.5, WIDTH, -1), 0.5, "clamped at min");
    assert.equal(stepFieldValue(8, LANES, 1), 8, "clamped at max");
    assert.equal(stepFieldValue(undefined, LANES, 1), 1);
    assert.equal(stepFieldValue(1, POSITION, 1), 2, "no step means 1");

    assert.equal(scrubFieldValue(7, SCRUB_PIXELS_PER_STEP * 3, WIDTH), 7.3);
    assert.equal(scrubFieldValue(7, -SCRUB_PIXELS_PER_STEP * 2, WIDTH, { shift: true }), 5);
    assert.equal(scrubFieldValue(7, SCRUB_PIXELS_PER_STEP - 1, WIDTH), 7, "sub-step drags do nothing");
    assert.equal(scrubFieldValue(2, SCRUB_PIXELS_PER_STEP * 100, LANES), 8);

    assert.equal(snapToStep(7.26, WIDTH), 7.3);
    assert.equal(snapToStep(0.34, DIRECTION), 1, "steps anchor at min");
    assert.equal(snapToStep(3.3, POSITION), 3.3, "no step means no snapping");
    assert.equal(clampToDescriptor(99, LANES), 8);
    assert.equal(clampToDescriptor(-5, WIDTH), 0.5);
});

test("ED-03 fields group in first-appearance order and hide advanced descriptors by default", () => {
    const fields = [WIDTH, LANES, TWO_WAY, DIRECTION, field({ path: ["note"], label: "Note", control: "text" })];
    const groups = groupFields(fields);
    assert.deepEqual(groups.map((group) => [group.title, group.fields.map(fieldKey)]), [
        ["Cross-section", ["width", "laneCount"]],
        ["Direction", ["bidirectional"]],
        ["General", ["note"]],
    ]);
    const withAdvanced = groupFields(fields, { advanced: true });
    assert.deepEqual(withAdvanced[1].fields.map(fieldKey), ["bidirectional", "direction"]);
    assert.equal(hasAdvancedFields(fields), true);
    assert.equal(hasAdvancedFields([WIDTH]), false);
    assert.deepEqual(groupFields([DIRECTION]), [], "groups left empty are omitted");
});

test("ED-03 multi-selection field state shares fields of one type and detects mixed values", () => {
    const records = [{ id: "a", typeId: "road" }, { id: "b", typeId: "road" }];
    const read = (record) => ({
        fields: record.id === "a" ? [WIDTH, LANES, TWO_WAY] : [WIDTH, LANES],
        values: record.id === "a" ? { width: 7, laneCount: 2, bidirectional: true } : { width: 7, laneCount: 4 },
    });
    const state = selectionFieldState(records, read);
    assert.equal(state.typeId, "road");
    assert.equal(state.mixedTypes, false);
    assert.deepEqual(state.fields.map(fieldKey), ["width", "laneCount"], "only fields every record shows");
    assert.deepEqual(state.states.get("width"), { mixed: false, value: 7 });
    assert.deepEqual(state.states.get("laneCount"), { mixed: true, value: undefined });

    const mixed = selectionFieldState([{ id: "a", typeId: "road" }, { id: "c", typeId: "building" }], read);
    assert.equal(mixed.mixedTypes, true);
    assert.deepEqual(mixed.fields, []);
    assert.deepEqual(selectionFieldState([], read).fields, []);

    assert.deepEqual(mixedValueOf([{ takram: { timeOfDay: 6 } }, { takram: { timeOfDay: 6 } }], TIME), { mixed: false, value: 6 });
    assert.deepEqual(mixedValueOf([{ position: { x: 1, y: 0, z: 2 } }, { position: { x: 1, y: 0, z: 2 } }], POSITION), { mixed: false, value: { x: 1, y: 0, z: 2 } });
    assert.equal(mixedValueOf([{ position: { x: 1, y: 0, z: 2 } }, { position: { x: 1, y: 0, z: 3 } }], POSITION).mixed, true);
    assert.deepEqual(mixedValueOf([], POSITION), { mixed: false, value: undefined });
});

test("ED-03 issues map back to their fields, including nested and parent paths", () => {
    const issues = [
        { path: ["laneCount"], code: "option.range", message: "Lanes must be at most 8.", severity: "error" },
        { path: ["takram", "timeOfDay"], code: "option.range", message: "Time of day must be at most 23.99.", severity: "error" },
        { path: ["bounds"], code: "option.range", message: "Tile bounds require north > south.", severity: "error" },
        { path: ["command"], code: "command.object.locked", message: "Locked.", severity: "error" },
        { code: "x", message: "No path.", severity: "error" },
    ];
    const index = issuesByPath(issues);
    assert.deepEqual([...index.keys()], ["laneCount", "takram.timeOfDay", "bounds", "command", ""]);
    assert.equal(issuesForField(index, LANES)[0].message, "Lanes must be at most 8.");
    assert.equal(issuesForField(index, TIME).length, 1);
    assert.equal(issuesForField(index, field({ path: ["bounds", "north"], label: "North", control: "number" })).length, 1, "a parent-path issue reaches its child fields");
    assert.equal(issuesForField(index, WIDTH).length, 0);
    assert.equal(index.get("").length, 1);
});

test("ED-03 defaults, reset detection, and vector patches", () => {
    const defaults = { width: 7, laneCount: 2, position: { x: 0, y: 0, z: 0 } };
    assert.equal(defaultValueFor(WIDTH, defaults), 7);
    assert.equal(defaultValueFor(TIME, defaults), undefined);
    assert.equal(isDefaultValue(WIDTH, 7, defaults), true);
    assert.equal(isDefaultValue(WIDTH, 9, defaults), false);
    assert.equal(isDefaultValue(POSITION, { x: 0, y: 0, z: 0 }, defaults), true);
    assert.equal(isDefaultValue(TIME, 6, defaults), true, "fields without a default never offer reset");
    assert.deepEqual(vector3Patch(POSITION, { x: 1, y: 2, z: 3 }, "z", 9), { path: ["position"], value: { x: 1, y: 2, z: 9 } });
    assert.deepEqual(vector3Patch(POSITION, null, "x", 4), { path: ["position"], value: { x: 4, y: 0, z: 0 } });
});
