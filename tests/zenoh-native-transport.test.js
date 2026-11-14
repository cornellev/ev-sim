import assert from "node:assert/strict";
import test from "node:test";
import { ZenohNativeTransport } from "../server/sensor-transports/ZenohNativeTransport.js";
import { ProtobufRouteRuntime } from "../app/interfaces/ProtobufRouteRuntime.js";
import { validateZenohTransportAdmission } from "../server/sensor-transports/ZenohTransportConfig.js";
import { imageRun, zenohHostConfig } from "./helpers/zenohFixtures.js";

function fakeBinding() {
    let session;
    return { get session() { return session; }, createSession(json, wake) {
        session = { config: JSON.parse(json), packets: [], incoming: [], generation: 0, state: "created", rejected: false,
            async openSession() { this.state = "open"; },
            publish(key, bytes, routeId, generation, required) { if (this.rejected) return { ok: false, accepted: false, code: "queue-full", fatal: required }; this.packets.push({ key, bytes: new Uint8Array(bytes), routeId, generation }); return { ok: true, accepted: true, fatal: false }; },
            async subscribe() { return 1; }, async unsubscribe() {}, async reset(generation) { this.generation = generation; this.incoming = []; },
            drainInbound() { return this.incoming.splice(0); },
            diagnostics() { return JSON.stringify({ available: this.state === "open", state: this.state, zenohVersion: "1.10.2", shmProviderAvailable: true, transports: [{ shm: true }] }); },
            async close() { this.state = "closed"; },
            receive(packet) { this.incoming.push(packet); wake(); },
        }; return session;
    } };
}

test("existing Protobuf route runtime uses synchronous native acceptance", async () => {
    const run = imageRun(), config = zenohHostConfig(), binding = fakeBinding();
    const admission = validateZenohTransportAdmission({ resolvedRun: run, config });
    const transport = new ZenohNativeTransport({ config, admission, nativeBinding: binding });
    await transport.openSession();
    const routes = new ProtobufRouteRuntime();
    routes.configure({ resolvedRun: run, publicationPort: (packet) => transport.publish(packet) });
    await transport.reset(routes.generation);
    const value = { data: new Uint8Array(4), width: 1, height: 1, pixelFormat: "rgba8", strideBytes: 4 };
    assert.equal(routes.publishTopic({ topicId: "image", valueContract: { id: "cev.image", version: 1 }, value }).ok, true);
    value.data.fill(255);
    assert.ok(binding.session.packets[0].bytes.length > 4);
    binding.session.rejected = true;
    assert.equal(routes.publishTopic({ topicId: "image", valueContract: { id: "cev.image", version: 1 }, value }).ok, false);
    assert.equal(transport.state, "open");
    await transport.close(); await transport.close();
});

test("required publication failure is visible once, and stale packets cannot publish", async () => {
    const binding = fakeBinding(), events = [], config = zenohHostConfig();
    const transport = new ZenohNativeTransport({ config, nativeBinding: binding, onEvent: (event) => events.push(event) });
    await transport.openSession(); await transport.reset(1);
    assert.equal(transport.publish({ key: "test/state", routeId: "state", bytes: new Uint8Array(), generation: 0 }).code, "stale-generation");
    binding.session.rejected = true;
    const result = transport.publish({ key: "test/control", routeId: "control", bytes: new Uint8Array(), generation: 1, required: true });
    assert.equal(result.fatal, true); assert.equal(events.length, 1); assert.equal(transport.diagnostics().state, "failed");
    await transport.close();
});

test("unsubscribe and reset fence callbacks, required callback failures are reported", async () => {
    const binding = fakeBinding(), config = zenohHostConfig(), received = [];
    const transport = new ZenohNativeTransport({ config, nativeBinding: binding });
    await transport.openSession();
    const id = await transport.subscribe("input", (bytes) => received.push([...bytes]), { key: "test/input" });
    binding.session.receive({ routeId: "input", bytes: new Uint8Array([1]), generation: 0 });
    await transport.unsubscribe(id);
    binding.session.receive({ routeId: "input", bytes: new Uint8Array([2]), generation: 0 });
    await transport.reset(1);
    await transport.subscribe("input", () => { throw new Error("callback failed"); }, { key: "test/input", required: true });
    binding.session.receive({ routeId: "input", bytes: new Uint8Array([3]), generation: 0 });
    assert.equal(transport.state, "open");
    binding.session.receive({ routeId: "input", bytes: new Uint8Array([4]), generation: 1 });
    assert.equal(transport.state, "failed"); assert.deepEqual(received, [[1]]);
    await transport.close();
});

test("inbound validation rejections stay application-level, async callbacks fail visibly", async () => {
    const binding = fakeBinding(), transport = new ZenohNativeTransport({ config: zenohHostConfig(), nativeBinding: binding });
    await transport.openSession();
    const id = await transport.subscribe("input", () => ({ ok: false, code: "wrong-run" }), { key: "test/input", required: true });
    binding.session.receive({ routeId: "input", bytes: new Uint8Array(), generation: 0 });
    assert.equal(transport.state, "open");
    await transport.unsubscribe(id);
    await transport.subscribe("input", () => Promise.reject(new Error("async failed")), { key: "test/input", required: true });
    binding.session.receive({ routeId: "input", bytes: new Uint8Array(), generation: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(transport.state, "failed");
    await transport.close();
});

test("late required declarations and resets cannot fail a new generation or reopen a closed session", async () => {
    const binding = fakeBinding(), transport = new ZenohNativeTransport({ config: zenohHostConfig(), nativeBinding: binding });
    await transport.openSession();
    let finishDeclaration;
    binding.session.subscribe = () => new Promise((resolve) => { finishDeclaration = resolve; });
    const declared = transport.subscribe("input", () => {}, { key: "test/input", required: true });
    await transport.reset(1);
    finishDeclaration(1);
    await assert.rejects(declared, /canceled/); assert.equal(transport.state, "open");
    let finishReset;
    binding.session.reset = () => new Promise((resolve) => { finishReset = resolve; });
    const resetting = transport.reset(2);
    await transport.close(); finishReset();
    await assert.rejects(resetting, /canceled/); assert.equal(transport.state, "closed");
});
