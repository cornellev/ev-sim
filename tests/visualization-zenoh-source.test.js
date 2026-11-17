import assert from "node:assert/strict";
import test from "node:test";
import { loadUploadedProtoFiles } from "../server/interfaces/ProtobufSourceLoader.js";
import { uploadedSource } from "./helpers/protobufFixtures.js";
import { encodeMessage, PROTOBUF_LIMITS } from "../app/interfaces/ProtobufSchema.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { LiveVisualizationSource } from "../app/visualization/sources/LiveVisualizationSource.js";
import { ZenohVisualizationSource } from "../app/visualization/sources/ZenohVisualizationSource.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";
import { Visualizer } from "../app/visualization/Visualizer.js";
import { occupancyImportStatus } from "../app/spatial/planview/occupancy/stackImport.js";

const schema = await loadUploadedProtoFiles(uploadedSource('syntax = "proto3"; package display; message Sample { double x=1; uint32 width=2; uint32 height=3; bytes cells=4; string runId=5; uint64 captureTimeNs=6; uint64 sequenceId=7; string frameId=8; uint64 source_sequence=9; string source_frame=10; }'));
// Reuse existing schema resources and the same binding object across tools. Display settings
// are code/API configuration, separate from a run's manifest and Protobuf interface.
const schemas = [{ id: "main", descriptorBase64: schema.descriptorBase64, fingerprint: schema.fingerprint }];
const binding = { id: "stack", kind: "zenoh", key: "display/stack", schemaId: "main", messageType: "display.Sample",
    project: (message) => ({ value: message.x ?? 0, width: message.width, height: message.height, cells: message.cells }) };
const poseBinding = { ...binding, id: "external-pose", key: "display/pose", eventType: "pose", project: (message) => ({ position: { x: message.x ?? 0, y: 0, z: 0 } }) };
const config = { kind: "cev-sim.zenoh-browser-host-config", version: 1, endpoint: "ws://localhost:10000" };
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
const bytes = (value) => encodeMessage(schema.root.lookupType("display.Sample"), value);

class Tool extends Visualizer {
    constructor() { super({ requiredInputs: ["value"] }); this.updates = []; this.moves = []; this.draws = []; }
    onDataUpdate(inputs, keys, metadata) { this.updates.push({ inputs, keys, metadata }); }
    onVehicleMove(pose, metadata) { this.moves.push({ pose, metadata }); }
    displayMap() { this.draws.push(this.inputs); return { inputs: this.inputs, pose: this.pose }; }
}

function fixture(options = {}) {
    const transports = [];
    const requests = [];
    const timers = new Map();
    const delays = [];
    let timerId = 0;
    const zenoh = {
        schemas: [...schemas],
        fetchImpl: async (...args) => { requests.push(args); return { ok: true, json: async () => config }; },
        transportFactory: ({ onState }) => {
            const transport = { onState, closed: 0, bound: null, connection: null,
                async connect(connection) { this.connection = connection; },
                async bindGeneration(generation) { this.bound = generation; },
                async close() { this.closed++; },
                emit(value, fields = {}) {
                    const route = this.connection.routes.find((route) => route.key === (fields.key ?? binding.key));
                    this.connection.onSample({ routeId: route.routeId, routeGeneration: this.connection.generation, bytes: value, ...fields });
                },
            };
            transports.push(transport);
            return transport;
        },
        setTimeoutImpl: (callback, delay) => { delays.push(delay); const id = ++timerId; timers.set(id, callback); return id; },
        clearTimeoutImpl: (id) => timers.delete(id),
        ...options,
    };
    const source = new ZenohVisualizationSource(zenoh);
    return { source, zenoh, transports, requests, timers, delays, events: [] };
}

test("schema validation is lazy to used bindings and display-only options cannot break engine construction", () => {
    const source = new ZenohVisualizationSource({ schemas: null });
    assert.doesNotThrow(() => source.subscribe([], () => {}));
    assert.throws(() => source.subscribe([binding], () => {}), /schemas/);
    source.dispose();
    const used = fixture({ schemas: [...schemas, { id: "unused", descriptorBase64: "broken" }] });
    assert.doesNotThrow(() => used.source.subscribe([binding], () => {}));
    used.source.dispose();
    const engine = engineFixture({ schemas: null });
    const status = engine.engine.status;
    const bindings = engine.engine.visualizationManager.bindings;
    assert.doesNotThrow(() => engine.engine.configureVisualizations({ tool: { data: [binding] } }));
    assert.equal(engine.engine.visualizationManager.bindings, bindings);
    assert.equal(engine.engine.status, status);
    engine.engine.dispose();
});

test("read-only subscriptions fetch normalized host config and share one decode for matching consumers", async () => {
    const f = fixture();
    const first = new Tool(), second = new Tool();
    const manager = new VisualizationManager({ tools: { first, second } });
    manager.configure({ first: { data: [binding] }, second: { data: [binding] } });
    manager.setSource(f.source);
    const other = [];
    const cancel = f.source.subscribe([{ ...binding, id: "comparison" }], (event) => other.push(event));
    await settle();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0][0], "/api/zenoh/browser-config");
    assert.equal(f.requests[0][1].cache, "no-store");
    assert.equal(f.transports.length, 1);
    const transport = f.transports[0];
    assert.equal(transport.connection.config.endpoint, "ws://localhost:10000/");
    assert.deepEqual(transport.connection.routes, [{ routeId: "display-1", key: binding.key, direction: "subscribe" }]);
    assert.equal(transport.bound, transport.connection.generation);
    const type = f.source.loaded.get("main").types.get(binding.messageType).setup();
    const original = type.decode;
    let decodes = 0;
    type.decode = function (...args) { decodes++; return original.apply(this, args); };
    transport.emit(bytes({ x: 0, runId: "independent", captureTimeNs: "9007199254740993", sequenceId: "18446744073709551615", frameId: "map" }));
    await settle();
    assert.equal(decodes, 1);
    assert.equal(first.inputs.value, 0);
    assert.equal(second.inputs.value, 0);
    assert.deepEqual(first.metadata, { runId: "independent", captureTimeNs: "9007199254740993", sequenceId: "18446744073709551615", frameId: "map" });
    assert.equal(other.length, 1);
    cancel();
    assert.equal(transport.closed, 0);
    manager.dispose();
    assert.equal(transport.closed, 1);
    assert.equal(f.source.routes.size, 0);
});

test("spatial bursts retain the latest atomic sample and own projection buffers", async () => {
    const f = fixture();
    const owned = { width: 0, height: 0, cells: new Uint8Array(2) };
    f.source.subscribe([{ ...binding, project: (message) => { Object.assign(owned, { width: message.width, height: message.height }); owned.cells.set(message.cells); return owned; } }], (event) => f.events.push(event));
    await settle();
    f.transports[0].emit(bytes({ width: 2, height: 1, cells: new Uint8Array([1, 2]) }));
    f.transports[0].emit(bytes({ width: 1, height: 2, cells: new Uint8Array([3, 4]) }));
    await settle();
    assert.equal(f.events.length, 1);
    assert.deepEqual(f.events[0].inputs, { width: 1, height: 2, cells: new Uint8Array([3, 4]) });
    owned.cells.fill(9);
    assert.deepEqual(f.events[0].inputs.cells, new Uint8Array([3, 4]));
    assert.equal(f.events[0].revision, 2);
    f.source.dispose();
});

test("invalid samples in a burst retain its latest valid sample and later valid samples clear obsolete errors", async () => {
    const f = fixture();
    const tool = new Tool();
    const manager = new VisualizationManager({ tools: { tool } });
    manager.configure({ tool: { data: [{ ...binding, project: (message) => {
        if (message.x === 9) throw new Error("Bad projection.");
        return { value: message.x ?? 0 };
    } }] } }); manager.setSource(f.source); await settle();
    f.transports[0].emit(bytes({ x: 1 })); f.transports[0].emit(new Uint8Array([0xff])); await settle();
    assert.equal(tool.inputs.value, 1);
    assert.equal(tool.status, "error");
    f.transports[0].emit(bytes({ x: 2 })); f.transports[0].emit(bytes({ x: 9 })); await settle();
    assert.equal(tool.inputs.value, 2);
    assert.equal(tool.message, "Bad projection.");
    f.transports[0].emit(bytes({ x: 9 })); f.transports[0].emit(bytes({ x: 3 })); await settle();
    assert.equal(tool.inputs.value, 3);
    assert.equal(tool.status, "ready");
    manager.dispose();
});

test("projected views backed by shared memory are copied into ordinary owned buffers", { skip: typeof SharedArrayBuffer === "undefined" }, async () => {
    const f = fixture();
    const cells = new Uint8Array(new SharedArrayBuffer(2));
    cells.set([1, 2]);
    f.source.subscribe([{ ...binding, project: () => ({ cells }) }], (event) => f.events.push(event));
    await settle(); f.transports[0].emit(bytes({ x: 1 })); await settle();
    cells.fill(9);
    assert.deepEqual(f.events[0].inputs.cells, new Uint8Array([1, 2]));
    assert.ok(f.events[0].inputs.cells.buffer instanceof ArrayBuffer);
    f.source.dispose();
});

test("sample metadata retains zero and exact sequences without frame conversion or simulator run substitution", async () => {
    const f = fixture();
    f.source.subscribe([poseBinding], (event) => f.events.push(event));
    await settle();
    const metadata = { runId: "external", captureTimeNs: 0, sequenceId: "18446744073709551615", frameId: "base_link" };
    f.transports[0].emit(bytes({ x: 3, runId: "wire" }), { key: poseBinding.key, metadata });
    await settle();
    assert.deepEqual(f.events[0].metadata, metadata);
    assert.deepEqual(f.events[0].pose, { position: { x: 3, y: 0, z: 0 } });
    f.source.dispose();
});

test("code-owned projections can select exact metadata from an external schema", async () => {
    const f = fixture();
    f.source.subscribe([{ ...binding, project: (message, metadata) => {
        metadata.sequenceId = message.source_sequence;
        metadata.frameId = message.source_frame;
        return { value: message.x ?? 0 };
    } }], (event) => f.events.push(event));
    await settle();
    f.transports[0].emit(bytes({ x: 1, source_sequence: "18446744073709551615", source_frame: "map" }));
    await settle();
    assert.deepEqual(f.events[0].metadata, { sequenceId: "18446744073709551615", frameId: "map" });
    f.source.dispose();
});

test("invalid binding, schema, descriptor and type admission retains working bindings", async () => {
    const f = fixture();
    const tool = new Tool();
    const manager = new VisualizationManager({ tools: { tool } });
    manager.configure({ tool: { data: [binding] } }); manager.setSource(f.source);
    await settle();
    const previous = manager.bindings;
    assert.throws(() => manager.configure({ tool: { data: [{ ...binding, id: undefined }] } }), /nonempty string id/);
    for (const patch of [{ schemaId: undefined }, { key: "display/*" }, { key: "display/{run_id}" }, { key: "display/../stack" },
        { key: "x".repeat(1025) }, { schemaId: "absent" }, { messageType: "display.Absent" }, { messageType: "display.__proto__" }, { project: "mapping" }, { eventType: "clock" }]) {
        manager.configure({ tool: { data: [{ ...binding, ...patch }] } });
        assert.equal(manager.bindings, previous);
        assert.equal(f.source.routes.size, 1);
        assert.equal(f.transports.length, 1);
    }
    for (const patch of [{ descriptorBase64: "broken" }, { descriptorBase64: "AA==" }, { fingerprint: "0".repeat(64) },
        { descriptorBase64: "A".repeat(Math.ceil(PROTOBUF_LIMITS.descriptorBytes / 3) * 4 + 4) }]) {
        f.source.schemas = [{ ...schemas[0], ...patch }];
        manager.configure({ tool: { data: [binding] } });
        assert.equal(manager.bindings, previous);
        assert.equal(f.transports[0].closed, 0);
    }
    f.source.schemas = schemas;
    f.transports[0].emit(bytes({ x: 2 })); await settle();
    assert.equal(tool.inputs.value, 2);
    assert.equal(tool.status, "ready");
    manager.dispose();
});

test("malformed messages and projection failures preserve last valid display state", async () => {
    const f = fixture();
    const tool = new Tool();
    let projected = null;
    const manager = new VisualizationManager({ tools: { tool } });
    manager.configure({ tool: { data: [{ ...binding, project: (message) => {
        if (projected instanceof Error) throw projected;
        return projected ?? { value: message.x ?? 0 };
    } }] } }); manager.setSource(f.source);
    await settle();
    f.transports[0].emit(bytes({ x: 1 })); await settle();
    for (const invalid of [new Error("Projection failed."), 1, { value: NaN }, { value: new Float32Array([Infinity]) }, { value: () => 1 }, new Date(), { value: new Array(2) }]) {
        projected = invalid;
        f.transports[0].emit(bytes({ x: 2 })); await settle();
        assert.equal(tool.inputs.value, 1);
        assert.equal(tool.status, "error");
    }
    projected = null;
    f.transports[0].emit(new Uint8Array([0xff])); await settle();
    assert.equal(tool.inputs.value, 1);
    assert.equal(tool.status, "error");
    f.transports[0].emit(new Uint8Array(PROTOBUF_LIMITS.payloadBytes + 1)); await settle();
    assert.match(tool.message, /bounded bytes/);
    assert.equal(tool.inputs.value, 1);
    f.transports[0].emit(bytes({ x: 3 })); await settle();
    assert.equal(tool.inputs.value, 3);
    manager.dispose();
});

test("projection size, depth, schema count and distinct-route limits use existing bounds", async () => {
    const f = fixture();
    assert.throws(() => f.source.subscribe(Array.from({ length: 65 }, (_, index) => ({ ...binding, id: `binding-${index}`, key: `display/${index}` })), () => {}), /64/);
    assert.equal(f.source.routes.size, 0);
    f.source.schemas = Array.from({ length: 17 }, (_, index) => ({ ...schemas[0], id: index ? `schema-${index}` : "main" }));
    assert.throws(() => f.source.subscribe([binding], () => {}), /16/);
    f.source.schemas = schemas;
    let projected = { value: new Uint8Array(PROTOBUF_LIMITS.payloadBytes + 1) };
    f.source.subscribe([{ ...binding, project: () => projected }], (event) => f.events.push(event));
    await settle();
    f.transports[0].emit(bytes({ x: 1 })); await settle();
    assert.match(f.events.at(-1).message, /too large/);
    projected = { value: 1 };
    for (let index = 0; index < PROTOBUF_LIMITS.depth + 1; index++) projected = { nested: projected };
    f.transports[0].emit(bytes({ x: 1 })); await settle();
    assert.match(f.events.at(-1).message, /too complex/);
    f.source.dispose();
});

test("invalid fetched host configuration never opens a transport or schedules reconnect", async () => {
    for (const response of [{ ok: false, value: { error: "Host unavailable." } }, { ok: true, value: null },
        { ok: true, value: { ...config, endpoint: "http://localhost" } }, { ok: true, value: { ...config, unknown: true } }]) {
        const f = fixture({ fetchImpl: async () => ({ ok: response.ok, json: async () => response.value }) });
        f.source.subscribe([binding], (event) => f.events.push(event)); await settle();
        assert.equal(f.events.at(-1).status, "error");
        assert.equal(f.transports.length, 0);
        assert.equal(f.timers.size, 0);
        f.source.dispose();
    }
});

test("reconnect uses bounded delays and fences old samples, timers, and cancellation", async () => {
    const f = fixture();
    const factory = f.source.transportFactory;
    let fail = true;
    f.source.transportFactory = (options) => {
        const transport = factory(options);
        transport.connect = async function (connection) { this.connection = connection; if (fail) throw new Error("Display connection failed."); };
        return transport;
    };
    const cancel = f.source.subscribe([binding], (event) => f.events.push(event));
    await settle();
    for (let index = 0; index < 5; index++) {
        const [id, retry] = [...f.timers][0]; f.timers.delete(id); retry(); await settle();
    }
    assert.deepEqual(f.delays, [500, 1000, 2000, 4000, 5000, 5000]);
    assert.ok(f.transports.every((transport) => transport.closed === 1));
    fail = false;
    const [id, retry] = [...f.timers][0]; f.timers.delete(id); retry(); await settle();
    const current = f.transports.at(-1);
    f.transports[0].emit(bytes({ x: 9 }));
    current.emit(bytes({ x: 1 })); await settle();
    assert.equal(f.events.filter((event) => event.type === "data").length, 1);
    current.onState({ state: "reconnecting", lastError: "Display lost." });
    assert.equal(f.delays.at(-1), 500);
    const lateRetry = [...f.timers.values()][0];
    cancel(); assert.equal(f.timers.size, 0);
    const count = f.transports.length;
    lateRetry(); current.emit(bytes({ x: 9 })); await settle();
    assert.equal(f.transports.length, count);
    assert.equal(f.events.filter((event) => event.type === "data").length, 1);
    f.source.dispose();
});

test("cancellation aborts pending configuration fetch and closes owned resources immediately", async () => {
    let finishFetch;
    let signal;
    const f = fixture({ fetchImpl: (_url, options) => { signal = options.signal; return new Promise((resolve) => { finishFetch = resolve; }); } });
    const cancel = f.source.subscribe([binding], (event) => f.events.push(event));
    assert.equal(typeof cancel, "function");
    cancel();
    assert.equal(signal.aborted, true);
    finishFetch({ ok: true, json: async () => config }); await settle();
    assert.equal(f.transports.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.source.routes.size, 0);
    f.source.dispose();
});

test("reset, reconfiguration, and source replacement cannot replay pending or cached messages", async () => {
    const f = fixture();
    const tool = new Tool();
    const manager = new VisualizationManager({ tools: { tool } });
    manager.configure({ tool: { data: [binding] } }); manager.setSource(f.source); await settle();
    f.transports[0].emit(bytes({ x: 9 })); manager.reset(); await settle();
    assert.equal(tool.updates.length, 0);
    assert.equal(tool.ready, false);
    f.transports[0].emit(bytes({ x: 9 })); f.transports.at(-1).emit(bytes({ x: 1 })); await settle();
    assert.equal(tool.inputs.value, 1);
    manager.configure({}); manager.configure({ tool: { data: [binding] } }); await settle();
    assert.equal(tool.ready, false);
    const old = f.transports.at(-1);
    old.emit(bytes({ x: 9 }));
    const replacement = fixture();
    manager.setSource(replacement.source); await settle();
    assert.equal(f.source.disposed, true);
    assert.equal(tool.ready, false);
    old.emit(bytes({ x: 10 })); replacement.transports[0].emit(bytes({ x: 2 })); await settle();
    assert.equal(tool.inputs.value, 2);
    manager.dispose();
});

test("live source combines completed-step runtime values with immediate independent samples", async () => {
    const f = fixture();
    const store = new SignalStore({});
    const source = new LiveVisualizationSource({ signalStore: store, zenoh: f.zenoh });
    source.subscribe([{ id: "local", kind: "runtime", signalPath: "local" }, binding], (event) => f.events.push(event));
    await settle();
    store.publishSignal("local", { value: { value: 7 } });
    f.transports[0].emit(bytes({ x: 3 })); await settle();
    assert.equal(f.events.filter((event) => event.type === "data").length, 1);
    assert.equal(f.events.at(-1).inputs.value, 3);
    source.releasePending(1);
    assert.equal(f.events.at(-2).bindingId, "local");
    assert.equal(f.events.at(-2).inputs.value, 7);
    source.dispose();
    assert.equal(f.transports[0].closed, 1);
    assert.equal(store._listeners.size, 0);
    f.source.dispose();
});

function engineFixture(zenoh) {
    const store = new SignalStore({});
    const tool = new Tool();
    const vehicle = { telemetryId: "ego", position: { x: 0, y: 0, z: 0, set() {} }, rotation: { x: 0, y: 0, z: 0, set() {} }, velocity: { x: 0, y: 0, z: 0, set() {} }, update() {} };
    const vehicles = { vehicles: [vehicle], update() {}, async configureFromManifest() {} };
    const bindings = { signalStore: store, manifest: { enabled: false, bindings: [] }, update() {} };
    const devices = { configureFromManifest() {}, resetSchedule() {}, update() {}, deliver() {} };
    const physics = { async configureRun() {}, resetRun() {}, step() {}, syncAndPublishContacts() {} };
    const data = { bindings: () => bindings, vehicles: () => vehicles, devices: () => devices, physics: () => physics,
        client: () => { throw new Error("Visualization must not use the managed connection."); }, keys: () => null, baking: () => null, skyManager: () => null, earthTilesManager: () => null };
    const engine = new SimulationEngine(data, { visualizationTools: { tool }, visualizationZenoh: zenoh, packetRelay: null });
    engine.setModule("assertions", false);
    return { engine, store, tool };
}

test("independent data and pose redraw a paused engine with managed Protobuf disabled and retain run identity", async () => {
    const f = fixture();
    const { engine, store, tool } = engineFixture(f.zenoh);
    const manifest = createDefaultRunManifest({ version: 13, sensorRig: { sensors: [] }, assertions: [] });
    assert.equal(manifest.protobuf.mode, "disabled");
    await engine.applyRunManifest({ manifest, definitionHash: "a".repeat(64), resolvedHash: "b".repeat(64), environment: { manifest: { environmentId: manifest.environment.id } }, bindings: { entries: [] } });
    engine.pause();
    const identity = { semantic: engine.simulationSemanticHash, episode: engine.episodeHash, state: engine.kernel.getCanonicalState() };
    engine.configureVisualizations({ tool: { data: [binding], pose: [poseBinding] } }); await settle();
    assert.equal(engine.visualizationManager.bindings.find((entry) => entry.id === poseBinding.id).signalPath, undefined);
    assert.equal(store._listeners.size, 0);
    const metadata = { runId: "independent", captureTimeNs: 0, sequenceId: "18446744073709551615", frameId: "map" };
    f.transports.at(-1).emit(bytes({ x: 4 }), { metadata });
    f.transports.at(-1).emit(bytes({ x: 8 }), { key: poseBinding.key, metadata }); await settle();
    assert.equal(engine.status, "paused");
    assert.equal(engine.visualizationManager.getMapSnapshot().tools.tool.output.inputs.value, 4);
    assert.equal(tool.pose.position.x, 8);
    assert.equal(tool.metadata.runId, "independent");
    assert.deepEqual(engine.kernel.getCanonicalState(), identity.state);
    assert.equal(engine.simulationSemanticHash, identity.semantic);
    assert.equal(engine.episodeHash, identity.episode);
    engine.pause = () => { throw new Error("Display loss must not pause a managed run."); };
    f.transports.at(-1).onState({ state: "reconnecting", lastError: "Display lost." }); await settle();
    assert.equal(tool.status, "error");
    engine.dispose();
    assert.equal(f.timers.size, 0);
    f.source.dispose();
});

test("independent occupancy updates both paused views without a declared simulation input", async () => {
    const f = fixture();
    const { engine } = engineFixture(f.zenoh);
    engine.pause();
    const state = engine.kernel.getCanonicalState();
    assert.equal(occupancyImportStatus(engine.resolvedRun).configured, false);
    const independent = { ...binding, project: (message) => ({ stack: { cells: message.cells, width: message.width, height: message.height, vehicleRelative: true } }) };
    engine.configureVisualizations({ occupancy: { data: [independent], pose: [poseBinding] } });
    await settle();
    const metadata = { runId: "external", captureTimeNs: 0, sequenceId: "18446744073709551615", frameId: "base_link" };
    f.transports.at(-1).emit(bytes({ width: 2, height: 1, cells: new Uint8Array([0, 1]) }), { metadata });
    f.transports.at(-1).emit(bytes({ x: 8 }), { key: poseBinding.key, metadata });
    await settle();
    const tool = engine.visualizationManager.tools.occupancy;
    const channel = tool.channels.get("stack");
    const map = engine.visualizationManager.getMapSnapshot().tools.occupancy.output.grids.stack;
    assert.equal(map.originX, 8);
    assert.equal(map.rgba, channel.texture.image.data);
    assert.deepEqual([...map.cells], [0, 1]);
    assert.deepEqual(tool.metadata, metadata);
    assert.equal(engine.status, "paused");
    assert.deepEqual(engine.kernel.getCanonicalState(), state);
    f.transports.at(-1).emit(bytes({ width: 2, height: 1, cells: new Uint8Array([1]) }));
    await settle();
    assert.equal(tool.status, "error");
    assert.equal(channel.map, map);
    engine.dispose(); f.source.dispose();
});

test("engine reset, stop, and clear recreate owned Zenoh lifetimes without stale samples", async () => {
    const f = fixture();
    const { engine, tool } = engineFixture(f.zenoh);
    engine.configureVisualizations({ tool: { data: [binding] } }); await settle();
    for (const action of [() => engine.reset(), () => engine.stop(), () => engine.clearRun()]) {
        const oldSource = engine.liveVisualizationSource.zenohSource;
        const oldTransport = f.transports.at(-1);
        oldTransport.emit(bytes({ x: 9 }));
        action(); await settle();
        assert.equal(oldSource.disposed, true);
        assert.equal(oldTransport.closed, 1);
        assert.equal(tool.ready, false);
        oldTransport.emit(bytes({ x: 10 })); f.transports.at(-1).emit(bytes({ x: 1 })); await settle();
        assert.equal(tool.inputs.value, 1);
        assert.equal(f.transports.at(-1).closed, 0);
    }
    engine.dispose();
    assert.ok(f.transports.every((transport) => transport.closed === 1));
    f.source.dispose();
});
