import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ZenohBrowserTransport } from "../app/client/ZenohBrowserTransport.js";
import { createZenohBrowserWorkerRuntime } from "../app/client/ZenohBrowserWorkerRuntime.js";
import { normalizeZenohBrowserConfig, ZENOH_BROWSER_LIMITS } from "../app/client/ZenohBrowserConfig.js";
import { readZenohBrowserConfig } from "../server/interfaces/ZenohBrowserConfig.js";

const config = { kind: "cev-sim.zenoh-browser-host-config", version: 1, endpoint: "ws://localhost:10000", maxOutboundEntries: 2, maxOutboundBytes: 1024 };
const routes = [{ routeId: "out", direction: "publish", key: "sim/a/out" }, { routeId: "in", direction: "subscribe", key: "sim/a/in" }];
const tick = () => new Promise((resolve) => setImmediate(resolve));
function workerFixture({ holdPublication = false, failDeclaration = false, earlySample = false, manualBoot = false } = {}) {
    const callbacks = [], publications = [], pending = [], workers = [];
    const sdk = { Config: class {}, SampleKind: { PUT: "put" }, Encoding: { APPLICATION_PROTOBUF: "protobuf" }, Session: {
        async open() { return {
            async declarePublisher(key) {
                if (failDeclaration) throw new Error("declaration denied");
                return { async put(bytes) { publications.push({ key, bytes: [...bytes] }); if (holdPublication) await new Promise((resolve) => pending.push(resolve)); }, async undeclare() {} };
            },
            async declareSubscriber(key, { handler }) { const binding = { key, handler, undeclared: false }; callbacks.push(binding);
                if (earlySample) handler({ kind: () => "put", payload: () => ({ len: () => 1, toBytes: () => new Uint8Array([42]) }) });
                return { async undeclare() { binding.undeclared = true; } }; },
            async info() {}, async close() {},
        }; },
    } };
    const workerFactory = () => {
        const worker = { terminated: false, messages: [], ready() { this.onmessage({ data: { type: "worker-ready" } }); }, terminate() { this.terminated = true; }, postMessage(message, transfer) {
            this.messages.push(message.type);
            const owned = structuredClone(message, { transfer: transfer ?? [] });
            queueMicrotask(() => { if (!worker.terminated) runtime.handle(owned); });
        } };
        const runtime = createZenohBrowserWorkerRuntime({ sdk, postMessage(message, transfer) {
            const owned = structuredClone(message, { transfer });
            queueMicrotask(() => { if (!worker.terminated) worker.onmessage({ data: owned }); });
        } });
        if (!manualBoot) queueMicrotask(() => { if (!worker.terminated) worker.ready(); });
        workers.push(worker); return worker;
    };
    return { callbacks, publications, pending, workers, workerFactory };
}

test("browser transport waits for bundled worker imports before sending open", async (t) => {
    const fixture = workerFixture({ manualBoot: true });
    const transport = new ZenohBrowserTransport({ workerFactory: fixture.workerFactory, limits });
    t.after(() => transport.close());
    const connecting = transport.connect({ config, routes });
    await tick();
    assert.deepEqual(fixture.workers[0].messages, []);
    fixture.workers[0].ready();
    await connecting;
    assert.equal(fixture.workers[0].messages[0], "open");
    assert.equal(transport.state, "ready");
});
const limits = { ...ZENOH_BROWSER_LIMITS, heartbeatIntervalMs: 100000, closeTimeoutMs: 30, connectTimeoutMs: 100, sendTimeoutMs: 100 };

test("host configuration is explicit and rejects credentials, unknown fields and invalid limits", () => {
    assert.equal(normalizeZenohBrowserConfig(config).endpoint, "ws://localhost:10000/");
    for (const patch of [{ endpoint: "http://localhost" }, { endpoint: "ws://user:secret@localhost" }, { endpoint: "ws://localhost?token=secret" }, { maxOutboundBytes: -1 }, { guessed: true }]) {
        assert.throws(() => normalizeZenohBrowserConfig({ ...config, ...patch }), { code: "ZENOH_CONFIG_INVALID" });
    }
});

test("host configuration is optional, bounded and decoded as strict UTF-8", async (t) => {
    assert.equal(await readZenohBrowserConfig({}), null);
    const directory = await mkdtemp(path.join(os.tmpdir(), "cev-browser-config-")); t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, "host.json"); const env = { CEV_SIM_ZENOH_BROWSER_CONFIG: file };
    await writeFile(file, JSON.stringify(config)); assert.equal((await readZenohBrowserConfig(env)).maxOutboundEntries, 2);
    await writeFile(file, new Uint8Array(16385)); await assert.rejects(readZenohBrowserConfig(env), /bounded regular file/);
    await writeFile(file, new Uint8Array([255])); await assert.rejects(readZenohBrowserConfig(env));
});

test("stop during connection prevents the old worker from becoming ready", async () => {
    const fixture = workerFixture(); const transport = new ZenohBrowserTransport({ workerFactory: fixture.workerFactory, limits });
    const connecting = transport.connect({ config, routes }); const closed = transport.close();
    await assert.rejects(connecting, /superseded/); await closed;
    assert.equal(transport.worker, null); assert.equal(transport.state, "closed");
});

test("bounded FIFO includes detached in-flight bytes, owns payloads, and publishes one at a time", async (t) => {
    const fixture = workerFixture({ holdPublication: true });
    const transport = new ZenohBrowserTransport({ workerFactory: fixture.workerFactory, limits }); t.after(() => transport.close());
    await transport.connect({ config, routes, generation: 1 }); await transport.bindGeneration(1);
    const bytes = new Uint8Array([1, 2]);
    assert.equal(transport.publish({ routeId: "out", key: "sim/a/out", generation: 1, bytes }).ok, true);
    bytes.fill(9);
    assert.equal(transport.publish({ routeId: "out", key: "sim/a/out", generation: 1, bytes: new Uint8Array([3]) }).ok, true);
    assert.equal(transport.publish({ routeId: "out", key: "sim/a/out", generation: 1, bytes }).code, "queue-full");
    await tick(); assert.deepEqual(fixture.publications, [{ key: "sim/a/out", bytes: [1, 2] }]);
    assert.equal(transport.getSnapshot().diagnostics.queuedBytes, 3);
    fixture.pending.shift()(); await tick(); assert.equal(fixture.publications.length, 2);
    fixture.pending.shift()(); await tick(); assert.equal(transport.getSnapshot().diagnostics.queuedBytes, 0);
});

test("bind, unsubscribe, loss and reconnect fence old samples and clear queued publications", async (t) => {
    const fixture = workerFixture(); const received = [];
    const transport = new ZenohBrowserTransport({ workerFactory: fixture.workerFactory, limits }); t.after(() => transport.close());
    const sample = (byte) => ({ kind: () => "put", payload: () => ({ len: () => 1, toBytes: () => new Uint8Array([byte]) }) });
    await transport.connect({ config, routes, generation: 1, onSample: (message) => received.push([...message.bytes]) });
    await transport.bindGeneration(1);
    const old = fixture.callbacks.at(-1);
    old.handler(sample(1)); await tick(); assert.deepEqual(received, [[1]]);
    transport.stageGeneration(2); old.handler(sample(2)); await tick();
    assert.equal(transport.publish({ routeId: "out", key: "sim/a/out", bytes: new Uint8Array([8]), generation: 2 }).ok, true);
    await transport.bindGeneration(2); old.handler(sample(3)); fixture.callbacks.at(-1).handler(sample(4)); await tick();
    assert.deepEqual(received, [[1], [4]]);
    await transport.unsubscribe("in"); fixture.callbacks.at(-1).handler(sample(5)); await tick();
    fixture.workers.at(-1).onerror({ message: "router lost" });
    assert.equal(transport.state, "reconnecting"); assert.equal(transport.getSnapshot().diagnostics.queuedEntries, 0);
    await transport.connect({ config, routes, generation: 3, onSample: (message) => received.push([...message.bytes]) }); await transport.bindGeneration(3);
    old.handler(sample(6)); fixture.callbacks.at(-1).handler(sample(7)); await tick(); assert.deepEqual(received, [[1], [4], [7]]);
});

test("dynamic subscriptions receive samples arriving during declaration and require explicit replacement", async (t) => {
    const fixture = workerFixture({ earlySample: true }); const received = [];
    const transport = new ZenohBrowserTransport({ workerFactory: fixture.workerFactory, limits }); t.after(() => transport.close());
    await transport.connect({ config }); await transport.bindGeneration(0);
    await transport.subscribe("in", "sim/a/in", (sample) => received.push([...sample.bytes]));
    assert.deepEqual(received, [[42]]);
    await assert.rejects(transport.subscribe("in", "sim/b/in", () => {}), /Unsubscribe/);
    await transport.unsubscribe("in");
    await transport.subscribe("in", "sim/b/in", (sample) => received.push([...sample.bytes]));
    assert.deepEqual(received, [[42], [42]]);
});

test("failed declaration and stalled send fail visibly and terminate their workers", async () => {
    const broken = workerFixture({ failDeclaration: true }); const transport = new ZenohBrowserTransport({ workerFactory: broken.workerFactory, limits });
    await assert.rejects(transport.connect({ config, routes }), /declaration denied/);
    assert.equal(broken.workers[0].terminated, true); await transport.close();
    const stalled = workerFixture({ holdPublication: true }); const sending = new ZenohBrowserTransport({ workerFactory: stalled.workerFactory, limits: { ...limits, sendTimeoutMs: 10 } });
    await sending.connect({ config, routes }); await sending.bindGeneration(0);
    sending.publish({ routeId: "out", key: "sim/a/out", generation: 0, bytes: new Uint8Array([1]) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sending.state, "reconnecting"); assert.match(sending.lastError, /publish timed out/); assert.equal(stalled.workers[0].terminated, true); await sending.close();
});

test("worker limits unacknowledged inbound handoffs before copying more payloads", async () => {
    let handler; const messages = [];
    const sdk = { Config: class {}, SampleKind: { PUT: 1 }, Session: { async open() { return { async declareSubscriber(_key, options) { handler = options.handler; return { async undeclare() {} }; }, async close() {} }; } } };
    const runtime = createZenohBrowserWorkerRuntime({ sdk, postMessage: (message) => messages.push(message) });
    await runtime.handle({ type: "open", requestId: 1, connectionGeneration: 1, routeGeneration: 1, routes: [routes[1]] });
    for (let index = 0; index < 17; index++) handler({ kind: () => 1, payload: () => ({ len: () => 1, toBytes: () => new Uint8Array([index]) }) });
    assert.equal(runtime.getInboundStats().entries, 16); assert.equal(messages.at(-1).code, "inbound-handoff-full");
    runtime.handle({ type: "sample-ack", sampleId: 1, connectionGeneration: 1 }); assert.equal(runtime.getInboundStats().entries, 15);
    await runtime.handle({ type: "close", requestId: 2, connectionGeneration: 1 }); assert.equal(runtime.getInboundStats().bytes, 0);
});
