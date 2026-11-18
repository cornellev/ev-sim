import assert from "node:assert/strict";
import test from "node:test";
import { RecordingController } from "../app/logging/RecordingController.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { runStopTimeout } from "../app/simulation/AsyncCancellation.js";

function recorder(transport = {}) {
    let sequence = 0;
    return new RecordingController(new SignalStore(), { transport: {
        async createSession() { const id = `session-${++sequence}`; return { id, metadata: { id } }; },
        async appendBatch() { return { bytesWritten: 12 }; },
        async finalize(id) { return { id }; },
        ...transport,
    } });
}

test("stalled uploads are aborted, retries stop, and late bytes cannot change a new session", async () => {
    let finishUpload;
    const requests = [];
    const recording = recorder({ appendBatch(id, sequence, batch, { signal }) {
        requests.push({ id, signal });
        return id === "session-1" ? new Promise((resolve) => { finishUpload = resolve; }) : Promise.resolve({ bytesWritten: 20 });
    } });
    await recording.start();
    recording._enqueueBatch({ bytes: Uint8Array.of(1) });
    await Promise.resolve();
    const abort = new AbortController();
    const pending = recording.stop({}, { signal: abort.signal });
    assert.equal(recording.stop(), pending);
    const rejected = assert.rejects(pending, { code: "RUN_STOP_TIMEOUT" });
    abort.abort(runStopTimeout("log upload"));
    await rejected;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(recording.getSnapshot().active, false);
    assert.equal(recording.getSnapshot().pendingBytes, 0);
    assert.equal(recording._flushTimer, null);
    assert.equal(recording._unsubscribe, null);
    await recording.start();
    const state = recording.getSnapshot();
    finishUpload({ bytesWritten: 9999 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(recording.getSnapshot(), state);
    await recording.stop();
});

test("an unacknowledged finalize is not retried and its late reply cannot replace the new session", async () => {
    let finishFinalize;
    let requests = 0;
    const recording = recorder({ finalize(id) {
        requests++;
        return id === "session-1" ? new Promise((resolve) => { finishFinalize = resolve; }) : Promise.resolve({ id });
    } });
    await recording.start();
    const abort = new AbortController();
    const rejected = assert.rejects(recording.stop({}, { signal: abort.signal }), { code: "RUN_STOP_TIMEOUT" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests, 1);
    abort.abort(runStopTimeout("log finalization"));
    await rejected;
    await recording.start();
    const state = recording.getSnapshot();
    finishFinalize({ id: "session-1" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(recording.getSnapshot(), state);
    assert.equal(requests, 1);
    await recording.stop();
});

test("cancelled session creation never installs late subscriptions or an encoder", async () => {
    let finishCreate;
    const recording = recorder({ createSession() { return new Promise((resolve) => { finishCreate = resolve; }); } });
    const rejected = assert.rejects(recording.start(), { code: "RUN_STOP_TIMEOUT" });
    recording.cancel(runStopTimeout("recording startup"));
    await rejected;
    finishCreate({ id: "late", metadata: { id: "late" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(recording.session, null);
    assert.equal(recording.encoder, null);
    assert.equal(recording._unsubscribe, null);
    assert.equal(recording._flushTimer, null);
});
