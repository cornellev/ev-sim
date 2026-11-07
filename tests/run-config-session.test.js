import assert from "node:assert/strict";
import test from "node:test";

import {
    EMBEDDED_BINDINGS_BUFFER_ID,
    OTHER_JSON_BUFFER_MESSAGE,
    RAW_MANIFEST_BUFFER_ID,
    advancedEditorA11yProps,
    applyReadyBuffers,
    createLaunchGate,
    jsonBufferGate,
    jsonBufferMessage,
    planReadyFlush,
    runConfigHasUnsavedWork,
    stageJsonBuffer,
    validationSuccessVisible,
    writeJsonBuffer,
} from "../app/config/runConfigSession.js";

const fieldPatch = { kind: "embedded-bindings" };

test("invalid JSON blocks the session and a ready entry waits", () => {
    const invalid = stageJsonBuffer({}, RAW_MANIFEST_BUFFER_ID, {
        label: "Manifest JSON",
        text: "{",
        error: "Unexpected end of JSON input",
    });
    assert.equal(invalid.flush, false);
    assert.equal(jsonBufferGate(invalid.buffers).blocked, true);
    assert.deepEqual(jsonBufferGate(invalid.buffers).invalidIds, [RAW_MANIFEST_BUFFER_ID]);
    assert.deepEqual(planReadyFlush(invalid.buffers), []);

    const waiting = stageJsonBuffer(invalid.buffers, EMBEDDED_BINDINGS_BUFFER_ID, {
        label: "Embedded portable bindings",
        text: "[1]",
        parsed: [1],
        patch: fieldPatch,
    });
    assert.equal(waiting.flush, false);
    assert.equal(waiting.buffers[EMBEDDED_BINDINGS_BUFFER_ID].ready, true);
    assert.equal(waiting.buffers[EMBEDDED_BINDINGS_BUFFER_ID].error, OTHER_JSON_BUFFER_MESSAGE);
    assert.equal(waiting.buffers[EMBEDDED_BINDINGS_BUFFER_ID].parsed[0], 1);
    assert.deepEqual(planReadyFlush(waiting.buffers), []);
    assert.match(jsonBufferMessage(waiting.buffers), /Manifest JSON/);
    assert.match(jsonBufferMessage(waiting.buffers), /Embedded portable bindings/);
});

test("discard of the last invalid entry flushes field patches onto the raw document", () => {
    const draft = { name: "current", embedded: [0] };
    let buffers = stageJsonBuffer({}, "sensor.lidar.calibration.scanLayout", {
        label: "Scan layout",
        text: "{",
        error: "Unexpected end of JSON input",
    }).buffers;
    buffers = stageJsonBuffer(buffers, EMBEDDED_BINDINGS_BUFFER_ID, {
        label: "Embedded portable bindings",
        text: "[9]",
        parsed: [9],
        patch: fieldPatch,
    }).buffers;
    buffers = stageJsonBuffer(buffers, RAW_MANIFEST_BUFFER_ID, {
        label: "Manifest JSON",
        text: "{\"name\":\"from-raw\"}",
        parsed: { name: "from-raw", embedded: [] },
        patch: { kind: "raw" },
    }).buffers;
    assert.equal(jsonBufferGate(buffers).blocked, true);
    assert.deepEqual(planReadyFlush(buffers), []);

    const discarded = writeJsonBuffer(buffers, "sensor.lidar.calibration.scanLayout", null);
    assert.equal(discarded["sensor.lidar.calibration.scanLayout"], undefined);
    assert.equal(discarded[EMBEDDED_BINDINGS_BUFFER_ID].parsed[0], 9);
    assert.deepEqual(planReadyFlush(discarded), [RAW_MANIFEST_BUFFER_ID, EMBEDDED_BINDINGS_BUFFER_ID]);

    const flushed = applyReadyBuffers(draft, discarded, (current, entry, id) => {
        if (id === RAW_MANIFEST_BUFFER_ID) return entry.parsed;
        return { ...current, embedded: entry.parsed };
    });
    assert.deepEqual(flushed.appliedIds, [RAW_MANIFEST_BUFFER_ID, EMBEDDED_BINDINGS_BUFFER_ID]);
    assert.equal(flushed.draft.name, "from-raw");
    assert.deepEqual(flushed.draft.embedded, [9]);
    assert.deepEqual(flushed.buffers, {});
});

test("discard removes one buffer and leaves the draft fields alone", () => {
    const buffers = {
        [RAW_MANIFEST_BUFFER_ID]: {
            label: "Manifest JSON",
            text: "{",
            error: "bad",
            ready: false,
            patch: null,
        },
        [EMBEDDED_BINDINGS_BUFFER_ID]: {
            label: "Embedded portable bindings",
            text: "[1]",
            error: "",
            ready: true,
            parsed: [1],
            patch: fieldPatch,
        },
    };
    const discarded = writeJsonBuffer(buffers, EMBEDDED_BINDINGS_BUFFER_ID, null);
    assert.equal(discarded[EMBEDDED_BINDINGS_BUFFER_ID], undefined);
    assert.equal(discarded[RAW_MANIFEST_BUFFER_ID].text, "{");
    assert.deepEqual(planReadyFlush(discarded), []);
});

test("a clean draft with a pending buffer is still unsaved work", () => {
    const buffers = writeJsonBuffer({}, RAW_MANIFEST_BUFFER_ID, {
        label: "Manifest JSON",
        text: "{",
        error: "bad",
        ready: false,
    });
    assert.equal(runConfigHasUnsavedWork({ dirty: false, buffers }), true);
    assert.equal(runConfigHasUnsavedWork({ dirty: false, buffers: {} }), false);
    assert.equal(runConfigHasUnsavedWork({ dirty: true, buffers: {} }), true);
});

test("launch gate ignores a second enter until leave", () => {
    const gate = createLaunchGate();
    assert.equal(gate.enter(), true);
    assert.equal(gate.enter(), false);
    gate.leave();
    assert.equal(gate.enter(), true);
});

test("validation success stays hidden while a run is preparing or failed", () => {
    assert.equal(validationSuccessVisible({ ok: true, error: null, runStatus: "ready" }), true);
    assert.equal(validationSuccessVisible({ ok: true, error: null, runStatus: "preparing" }), false);
    assert.equal(validationSuccessVisible({ ok: true, error: null, runStatus: "error" }), false);
    assert.equal(validationSuccessVisible({ ok: true, error: "preparation failed", runStatus: "ready" }), false);
    assert.equal(validationSuccessVisible({ ok: true, error: null, runStatus: "ready", busy: true }), false);
    assert.equal(validationSuccessVisible({ ok: false, error: null, runStatus: "ready" }), false);
});

test("advanced editor visibility props stay empty until the editor is hidden", () => {
    assert.deepEqual(advancedEditorA11yProps(false), {});
    assert.deepEqual(advancedEditorA11yProps(true), {
        hidden: true,
        inert: true,
        "aria-hidden": true,
    });
});

test("writing the same JSON buffer keeps the map identity", () => {
    const first = writeJsonBuffer({}, RAW_MANIFEST_BUFFER_ID, {
        label: "Manifest JSON",
        text: "{",
        error: "bad",
        ready: false,
    });
    const second = writeJsonBuffer(first, RAW_MANIFEST_BUFFER_ID, {
        label: "Manifest JSON",
        text: "{",
        error: "bad",
        ready: false,
    });
    assert.equal(second, first);
});
