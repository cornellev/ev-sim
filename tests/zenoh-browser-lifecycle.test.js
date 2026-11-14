import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ClientManager } from "../app/3d/managers/ClientManager.js";
import { RunSessionController } from "../app/simulation/RunSessionController.js";
import { ProtobufRouteRuntime } from "../app/interfaces/ProtobufRouteRuntime.js";
const bundle = JSON.parse(await readFile(new URL("./fixtures/protobuf/run-controls.v13.json", import.meta.url)));
const config = { kind: "cev-sim.zenoh-browser-host-config", version: 1, endpoint: "ws://localhost:10000" };

test("native startup bypasses legacy discovery, admits required subscriptions, and fails on missing host config", async () => {
    let connections = 0;
    const transport = { async connect() { connections++; }, async close() {}, async bindGeneration() {}, stageGeneration() {} };
    const manager = new ClientManager({}, { transportFactory: () => transport, fetchImpl: async () => ({ ok: true, json: async () => config }) });
    manager._loadLegacy = () => { throw new Error("Legacy codecs must not load"); };
    assert.equal((await manager.preflight(bundle.resolved, { runId: "run-a" })).ok, true); assert.equal(connections, 1);
    assert.equal(manager._nativeRun.runId, "run-a");
    const unresolved = structuredClone(bundle.resolved); unresolved.protobufInterface.document.routes = unresolved.protobufInterface.document.routes.filter((route) => route.direction !== "subscribe");
    const absent = await manager.preflight(unresolved, { runId: "run-b" }); assert.equal(absent.ok, false); assert.equal(connections, 1);
    let cleared = 0;
    await manager.activateRoutes({ runId: "run-a", generation: 1, invalidateBindings() { cleared++; } });
    await manager.closeRun(); assert.equal(cleared, 1);
    manager.fetchImpl = async () => ({ ok: true, json: async () => null });
    assert.equal((await manager.preflight(bundle.resolved, { runId: "run-c" })).ok, false);
});

function recoveryFixture() {
    const controller = new RunSessionController();
    let emit; let reconnects = 0; let plays = 0; let invalidations = 0;
    const simulation = { steps: 4, timeNs: 80, pause() {}, async whenIdle() {}, play() { plays++; }, subscribe() { return () => {}; },
        protobufRoutes: { invalidateBindings() { invalidations++; return 2; } } };
    const client = { subscribeTransport(listener) { emit = listener; listener({ state: "ready" }); return () => {}; },
        stageGeneration() {}, async reconnect() { reconnects++; return { state: "ready" }; }, async closeRun() {} };
    controller.recording = { attachSimulation() {} }; controller.attachData({ simulation: () => simulation, client: () => client });
    controller.snapshot.activeRunId = "frozen-run"; controller.snapshot.activeResolved = { manifest: { logging: { policy: "disabled" } } }; controller.snapshot.status = "running";
    controller._ensureRecording = async () => {};
    return { controller, emit: (state) => emit({ state }), counts: () => ({ reconnects, plays, invalidations }) };
}
test("loss pauses, invalidates once, and resumes the same frozen run", async () => {
    const fixture = recoveryFixture(); fixture.emit("reconnecting");
    assert.equal(fixture.controller.snapshot.status, "paused"); await fixture.controller._recoveryPromise;
    assert.equal(fixture.controller.snapshot.status, "running"); assert.equal(fixture.controller.snapshot.activeRunId, "frozen-run");
    assert.deepEqual(fixture.counts(), { reconnects: 1, plays: 1, invalidations: 1 });
});
test("explicit pause cancels automatic resume and stop cancels a pending retry", async () => {
    const fixture = recoveryFixture(); fixture.emit("reconnecting"); fixture.controller.pause(); await fixture.controller._recoveryPromise;
    assert.equal(fixture.controller.snapshot.status, "paused"); assert.equal(fixture.counts().plays, 0);
    fixture.emit("reconnecting"); fixture.controller._cancelRecovery(); await fixture.controller._recoveryPromise;
    assert.equal(fixture.counts().reconnects, 1);
});

test("reconnection clears inputs but keeps once bootstrap lifetime; reset re-arms it", () => {
    const runtime = new ProtobufRouteRuntime(); const packets = [];
    runtime.configure({ resolvedRun: bundle.resolved, runId: "frozen-run", publicationPort: (packet) => { packets.push(packet); return { ok: true }; } });
    runtime.deliver({ step: 0, timeNs: 0 }); const once = packets.length; assert.ok(once > 0);
    runtime.invalidateBindings(); runtime.deliver({ step: 1, timeNs: 1 }); assert.equal(packets.length, once);
    runtime.reset(); runtime.deliver({ step: 0, timeNs: 0 }); assert.equal(packets.length, once * 2);
});
