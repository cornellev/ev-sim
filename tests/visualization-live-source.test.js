import assert from "node:assert/strict";
import test from "node:test";
import { Scene, PerspectiveCamera } from "three";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { activeTopicSignalPath, candidateTopicSignalPath, oracleTopicSignalPath, referenceTopicSignalPath, vehiclesLeafPath } from "../app/scripting/runtime/SignalPaths.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { LiveVisualizationSource } from "../app/visualization/sources/LiveVisualizationSource.js";
import { createPlanViewFrameStore } from "../app/spatial/planview/frame.js";
import { Visualizer } from "../app/visualization/Visualizer.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";

const controlsPath = "visualization.controls.snapshot";
const localizationPath = "visualization.localization.status";
const posePath = vehiclesLeafPath("ego", "pose");
const controlsBinding = { id: "controls", kind: "runtime", signalPath: controlsPath };
// Direct source callers infer pose events; engine callers may omit signalPath for the default actor.
const poseBinding = { id: "ego-pose", kind: "runtime", signalPath: posePath };
const pose = (x = 0, pitch = 0) => ({ position: { x, y: 0, z: 0 }, rotation: { x: pitch, y: 0, z: 0, order: "XYZ" } });
const tick = () => Promise.resolve();

class Tool extends Visualizer {
    constructor(options = {}) {
        super({ requiredInputs: ["value"], ...options });
        this.updates = [];
        this.moves = [];
        this.clocks = [];
        this.draws = { scene: [], map: [] };
    }
    onDataUpdate(inputs, keys, metadata) { this.updates.push({ inputs, keys, metadata }); }
    onVehicleMove(value, metadata) { this.moves.push({ pose: value, metadata }); }
    onTimeAdvance(timeNs) { this.clocks.push(timeNs); }
    display(context) { this.draws.scene.push(context); return this.inputs; }
    displayMap(context) { this.draws.map.push(context); return { inputs: this.inputs, pose: this.pose }; }
}

function liveFixture(options = {}) {
    const store = new SignalStore({}, { sourceId: "live-visualization-test" });
    const source = new LiveVisualizationSource({ signalStore: store, ...options });
    const events = [];
    return { store, source, events };
}

test("configured runtime paths subscribe once, seed paused state, and preserve exact metadata", () => {
    const { store, source, events } = liveFixture({ runId: "run", getTimeNs: () => 90 });
    const nativePaths = [candidateTopicSignalPath("localization"), referenceTopicSignalPath("localization"), oracleTopicSignalPath("localization"), activeTopicSignalPath("localization")];
    const metadata = { runId: "sample-run", captureTimeNs: 0, sequenceId: "18446744073709551615", frameId: "map" };
    store.publishSignal(controlsPath, { value: { value: 0 } }, { metadata });
    const bindings = [controlsBinding, { id: "controls-copy", kind: "runtime", signalPath: controlsPath },
        { id: "status", kind: "runtime", signalPath: localizationPath },
        { id: "velocity", kind: "runtime", signalPath: vehiclesLeafPath("ego", "velocity") },
        ...nativePaths.map((signalPath, index) => ({ id: `native-${index}`, kind: "runtime", signalPath }))];
    const cancel = source.subscribe(bindings, (event) => events.push(event));
    assert.equal(store._listeners.size, 1);
    const subscription = [...store._listeners][0];
    assert.deepEqual([...subscription.paths], [...new Set(bindings.map((binding) => binding.signalPath))]);
    assert.equal(subscription.includeEvents, false);
    assert.equal(subscription.includeCatalog, false);
    assert.deepEqual(events.map((event) => event.type), ["data", "data", "clock"]);
    assert.deepEqual(events[0].metadata, metadata);
    assert.equal(events[0].inputs.value, 0);
    assert.equal(events[0].revision, store.revision(controlsPath));
    store.publishSignal(localizationPath, { status: "waiting" });
    nativePaths.forEach((path, index) => store.publishSignal(path, { value: { value: index, metadata } }));
    store.publishSignal("unrelated", { value: 9 });
    assert.equal(events.length, 3);
    source.releasePending(100);
    assert.equal(events.filter((event) => event.type === "data").length, 7);
    assert.equal(events.at(-2).metadata.sequenceId, metadata.sequenceId);
    cancel();
    assert.equal(store._listeners.size, 0);
    source.dispose();
});

test("pending data retains the latest atomic sample and projection errors remain display status", () => {
    const { store, source, events } = liveFixture();
    const binding = { ...controlsBinding, project: (value) => { if (value.fail) throw new Error("Bad projection."); return value; } };
    source.subscribe([binding], (event) => events.push(event));
    store.publishSignal(controlsPath, { width: 2, height: 1, cells: [1, 2] });
    store.publishSignal(controlsPath, { width: 1, height: 2, cells: [3, 4] });
    source.releasePending(1);
    assert.deepEqual(events.find((event) => event.type === "data").inputs, { width: 1, height: 2, cells: [3, 4] });
    store.publishSignal(controlsPath, { fail: true });
    assert.doesNotThrow(() => source.releasePending(2));
    assert.equal(events.at(-2).status, "error");
    assert.equal(events.at(-2).message, "Bad projection.");
    const scalar = { id: "scalar", kind: "runtime", signalPath: "scalar", project: (value) => ({ value }) };
    store.publishSignal("scalar", 0);
    source.subscribe([scalar], (event) => events.push(event));
    assert.equal(events.at(-2).inputs.value, 0);
    source.dispose();
});

test("pose comparison uses numeric fields and owns projected transforms", () => {
    const { store, source, events } = liveFixture();
    const projected = pose();
    source.subscribe([{ ...poseBinding, project: () => projected }], (event) => events.push(event));
    for (let index = 0; index < 3; index += 1) {
        store.publishSignal(posePath, pose());
        source.releasePending(index);
    }
    assert.equal(events.filter((event) => event.type === "pose").length, 1);
    projected.position.x = 1;
    store.publishSignal(posePath, pose(1));
    source.releasePending(3);
    projected.rotation.x = 0.2;
    store.publishSignal(posePath, pose(1, 0.2));
    source.releasePending(4);
    const poses = events.filter((event) => event.type === "pose");
    assert.equal(poses.length, 3);
    assert.equal(poses[0].pose.position.x, 0);
    assert.equal(poses[1].pose.rotation.x, 0);
    assert.deepEqual(poses.map((event) => event.revision), [1, 2, 3]);
    source.dispose();
});

test("subscriptions created during a step wait for completion before reading initial values", () => {
    let inFlight = true;
    const { store, source, events } = liveFixture({ isStepInFlight: () => inFlight });
    store.publishSignal(controlsPath, { value: { value: "partial" } });
    source.subscribe([controlsBinding], (event) => events.push(event));
    assert.deepEqual(events, []);
    store.publishSignal(controlsPath, { value: { value: "complete" } });
    inFlight = false;
    source.releasePending(10);
    assert.equal(events[0].inputs.value, "complete");
    assert.equal(events[1].timeNs, 10);
    source.dispose();
});

test("failed deferred signal reads publish display errors without interrupting completion", () => {
    const { store, source, events } = liveFixture({ isStepInFlight: () => true });
    source.subscribe([controlsBinding], (event) => events.push(event));
    store.read = () => { throw new Error("Read failed."); };
    assert.doesNotThrow(() => source.releasePending(1));
    assert.equal(events[0].type, "status");
    assert.equal(events[0].message, "Read failed.");
    assert.equal(events[1].type, "clock");
    source.dispose();
});

test("cancel, reset, and disposal fence queued callbacks and release subscriptions", async () => {
    const { store, source } = liveFixture();
    const tool = new Tool();
    const manager = new VisualizationManager({ tools: { tool } });
    manager.configure({ tool: { data: [controlsBinding] } });
    manager.setSource(source);
    const oldListener = [...store._listeners][0].listener;
    store.publishSignal(controlsPath, { value: { value: 1 } });
    store.resetRunState({ preservePaths: [] });
    manager.reset();
    oldListener({ kind: "update", path: controlsPath, entry: { value: { value: 9 } } });
    source.releasePending(1);
    await tick();
    assert.equal(tool.updates.length, 0);
    assert.equal(store._listeners.size, 1);
    manager.setSource(null);
    assert.equal(store._listeners.size, 0);
    oldListener({ kind: "update", path: controlsPath, entry: { value: { value: 10 } } });
    source.releasePending(2);
    assert.equal(tool.updates.length, 0);
    source.dispose(); manager.dispose();
});

test("invalid bindings retain working subscriptions and throwing listeners cannot escape release", () => {
    const { source, store } = liveFixture();
    source.subscribe([controlsBinding], () => { throw new Error("Listener failed."); });
    for (const binding of [{ ...controlsBinding, signalPath: "" }, { ...controlsBinding, project: "value" }, { ...controlsBinding, kind: "zenoh" }, { ...controlsBinding, eventType: "invalid" }]) {
        assert.throws(() => source.subscribe([binding], () => {}), /Runtime visualization bindings|Zenoh visualization bindings/);
        assert.equal(store._listeners.size, 1);
    }
    store.publishSignal(controlsPath, { value: { value: 1 } });
    assert.doesNotThrow(() => source.releasePending(1));
    source.dispose();
});

test("failed document subscription rolls back a pending reconfiguration", () => {
    const { source, store } = liveFixture({ subscribeRuntimeChanges() { throw new Error("Document subscription failed."); } });
    const tool = new Tool({ requiredInputs: [] });
    const manager = new VisualizationManager({ tools: { tool } });
    manager.configure({ tool: {} });
    manager.setSource(source);
    manager.configure({ tool: { data: [controlsBinding] } });
    assert.equal(tool.message, "Document subscription failed.");
    assert.equal(manager.bindings.length, 0);
    assert.equal(source.subscriptions.size, 1);
    assert.equal(store._listeners.size, 0);
    source.subscribeRuntimeChanges = () => () => {};
    manager.configure({ tool: { data: [controlsBinding] } });
    assert.equal(source.subscriptions.size, 1);
    assert.equal(store._listeners.size, 1);
    manager.dispose();
    assert.equal(source.subscriptions.size, 0);
    assert.equal(store._listeners.size, 0);
});

function engineFixture({ id = "ego", tools = { tool: new Tool() } } = {}) {
    const store = new SignalStore({}, { sourceId: "engine-live-visualization-test" });
    const vehicle = {
        telemetryId: id,
        position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ", set(x, y, z) { Object.assign(this, { x, y, z }); } },
        velocity: { x: 1, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        steeringAngle: 0,
        updatePosition() {}, updateRotation() {},
        update(dt) { this.position.x += this.velocity.x * dt; },
    };
    const vehicles = { vehicles: [vehicle], update(dt) { this.vehicles.forEach((vehicle) => vehicle.update(dt)); }, async configureFromManifest() {} };
    const runtime = {
        signalStore: store, manifest: { enabled: false, bindings: [] },
        update() { store.publishSignal("test.value", { value: { value: vehicle.position.x } }); },
    };
    const devices = { configureFromManifest() {}, resetSchedule() {}, update() {}, deliver() {} };
    const physics = { async configureRun() {}, resetRun() {}, step() {}, syncAndPublishContacts() {} };
    const data = { bindings: () => runtime, vehicles: () => vehicles, devices: () => devices, physics: () => physics,
        keys: () => null, client: () => null, baking: () => null, skyManager: () => null, earthTilesManager: () => null };
    const engine = new SimulationEngine(data, { visualizationTools: tools, packetRelay: null });
    engine.setModule("assertions", false);
    return { engine, store, vehicle, vehicles, devices, tools, data };
}

function resolved(target = "ego") {
    const manifest = createDefaultRunManifest({ version: 13, controls: { targetVehicleId: target }, sensorRig: { sensors: [] }, assertions: [],
        initialState: { vehicles: [{ id: target, type: "igvc-ego", pose: pose(), velocity: { x: 1, y: 0, z: 0 } }] } });
    return { manifest, definitionHash: "a".repeat(64), resolvedHash: "b".repeat(64),
        environment: { manifest: { environmentId: manifest.environment.id } }, bindings: { entries: [] } };
}

const runtimeBinding = { id: "value", kind: "runtime", signalPath: "test.value" };
const engineBindings = { tool: { data: [runtimeBinding], pose: [{ id: "default-pose", kind: "runtime" }] } };

test("engine seeds playground pose, attaches scene context, and flushes map without a renderer", async () => {
    const { engine, store, vehicle, tools: { tool } } = engineFixture({ id: "vehicle-1" });
    store.publishSignal("test.value", { value: { value: 0 } });
    vehicle.position.x = 8;
    engine.configureVisualizations(engineBindings);
    assert.equal(tool.moves[0].pose.position.x, 8);
    await tick();
    assert.equal(tool.draws.map.length, 1);
    assert.equal(engine.visualizationManager.getMapSnapshot().tools.tool.output.inputs.value, 0);
    const scene = { add(object) { object.parent = this; }, remove(object) { object.parent = null; } };
    const camera = { position: { x: 0, y: 0, z: 0 } };
    engine.configure({ scene, camera, renderer: null });
    await tick();
    assert.equal(tool.draws.scene.at(-1).scene, scene);
    assert.equal(tool.draws.scene.at(-1).camera, camera);
    engine.dispose();
    assert.equal(store._listeners.size, 0);
});

test("id-only playground vehicles receive default poses and explicit actor bindings remain separate", () => {
    const first = new Tool({ requiredInputs: [] });
    const second = new Tool({ requiredInputs: [] });
    const { engine, vehicle, vehicles } = engineFixture({ tools: { first, second } });
    vehicle.id = "ego";
    delete vehicle.telemetryId;
    vehicles.vehicles.push({ ...vehicle, id: "actor", position: { x: 5, y: 0, z: 0 } });
    engine.configureVisualizations({
        first: { pose: [{ id: "default", kind: "runtime" }] },
        second: { pose: [{ id: "actor", kind: "runtime", vehicleId: "actor" }] },
    });
    assert.equal(first.pose.position.x, 0);
    assert.equal(second.pose.position.x, 5);
    engine.dispose();
});

test("local events arrive after complete phases and every changed pose survives a multi-step burst", async () => {
    const { engine, vehicle, tools: { tool } } = engineFixture();
    await engine.applyRunManifest(resolved());
    engine.setModule("controls", false);
    vehicle.velocity.x = 1;
    engine.configureVisualizations(engineBindings);
    const observations = [];
    tool.onDataUpdate = (inputs) => observations.push({ inputs, phases: [...engine.lastStepPhases], hash: engine.trajectoryHash });
    const initialHash = engine.trajectoryHash;
    const initialMoves = tool.moves.length;
    engine.step(3);
    assert.equal(observations.length, 3);
    assert.ok(observations.every((entry) => entry.phases.at(-1) === "assertions" && entry.hash !== initialHash));
    assert.equal(tool.moves.length, initialMoves + 3);
    assert.equal(tool.draws.map.length, 1);
    const before = tool.moves.length;
    vehicle.velocity.x = 0;
    engine.step(2);
    assert.equal(tool.moves.length, before);
    engine.dispose();
});

test("async sensor advancement holds local notifications until capture and delivery finish", async () => {
    const { engine, devices, store, tools: { tool } } = engineFixture();
    engine.configureVisualizations(engineBindings);
    devices.requiresAsyncCapture = true;
    let release;
    devices.updateAsync = () => new Promise((resolve) => { release = resolve; });
    devices.deliver = () => store.publishSignal("test.value", { value: { value: "delivered" } });
    const stepped = engine.step();
    await tick();
    assert.equal(tool.updates.length, 0);
    assert.ok(engine.lastStepPhases.includes("sensors"));
    release();
    await stepped;
    assert.equal(tool.updates.length, 1);
    assert.equal(tool.updates[0].inputs.value, "delivered");
    assert.equal(engine.lastStepPhases.at(-1), "assertions");
    engine.dispose();
});

test("reset during async capture discards its late signals before seeding the replacement source", async () => {
    const { engine, devices, store, tools: { tool } } = engineFixture();
    engine.configureVisualizations(engineBindings);
    devices.requiresAsyncCapture = true;
    let release;
    devices.updateAsync = () => new Promise((resolve) => { release = resolve; });
    devices.deliver = () => store.publishSignal("test.value", { value: { value: "old capture" } });
    const step = engine.step();
    await tick();
    const source = engine.liveVisualizationSource;
    engine.reset();
    assert.equal(source.disposed, true);
    assert.equal(engine.liveVisualizationSource, null);
    release();
    await step;
    await engine.whenIdle();
    await tick();
    assert.equal(tool.updates.length, 0);
    assert.equal(tool.ready, false);
    assert.equal(store._listeners.size, 1);
    devices.updateAsync = () => Promise.resolve();
    devices.deliver = () => store.publishSignal("test.value", { value: { value: "new capture" } });
    await engine.step();
    assert.equal(tool.inputs.value, "new capture");
    assert.equal(tool.updates.length, 1);
    engine.dispose();
});

test("a mounted map receives reset completion after a cancelled held capture without another step", async () => {
    const { engine, data, devices, vehicle } = engineFixture();
    data.simulation = () => engine;
    engine.step(2);
    const frame = createPlanViewFrameStore(data);
    const cancel = frame.subscribe(() => {});
    assert.ok(frame.getSnapshot().timeNs > 0);
    devices.requiresAsyncCapture = true;
    let release;
    devices.updateAsync = () => new Promise((resolve) => { release = resolve; });
    const step = engine.step();
    await tick();
    engine.reset();
    assert.ok(frame.getSnapshot().timeNs > 0);
    release();
    await step;
    await engine.whenIdle(); await tick();
    assert.equal(engine.steps, 0);
    assert.equal(frame.getSnapshot().timeNs, 0);
    assert.equal(frame.getSnapshot().vehicles[0].position.x, vehicle.position.x);
    cancel(); engine.dispose();
});

test("reconfiguration after interrupted reset cannot seed paths without fresh completed-step samples", async () => {
    const { engine, devices, store, tools: { tool } } = engineFixture();
    const binding = { id: "late", kind: "runtime", signalPath: "late.value" };
    const bindings = { tool: { data: [binding] } };
    engine.configureVisualizations(bindings);
    devices.requiresAsyncCapture = true;
    let release;
    devices.updateAsync = () => new Promise((resolve) => { release = resolve; });
    devices.deliver = () => store.publishSignal("late.value", { value: { value: "cancelled capture" } });
    const step = engine.step();
    await tick();
    engine.reset();
    release(); await step;
    await engine.whenIdle(); await tick();
    devices.updateAsync = () => Promise.resolve();
    devices.deliver = () => {};
    await engine.step();
    engine.configureVisualizations(bindings);
    assert.equal(tool.updates.length, 0);
    assert.equal(tool.ready, false);
    devices.deliver = () => store.publishSignal("late.value", { value: { value: "fresh capture" } }, { metadata: { captureTimeNs: 0 } });
    await engine.step();
    assert.equal(tool.inputs.value, "fresh capture");
    assert.equal(tool.metadata.captureTimeNs, 0);
    engine.configureVisualizations(bindings);
    assert.equal(tool.ready, true);
    assert.equal(tool.inputs.value, "fresh capture");
    engine.configureVisualizations({});
    assert.equal(engine.liveVisualizationSource.latest.size, 0);
    engine.dispose();
});

test("replacement fences old callbacks before preparing and binds the new manifest target", async () => {
    const { engine, store, vehicles, tools: { tool } } = engineFixture();
    engine.configureVisualizations(engineBindings);
    engine.step();
    const oldSource = engine.liveVisualizationSource;
    const oldCallback = [...store._listeners][0].listener;
    const before = tool.updates.length;
    let releasePrepare;
    let notifyStarted;
    const started = new Promise((resolve) => { notifyStarted = resolve; });
    vehicles.configureFromManifest = () => new Promise((resolve) => { releasePrepare = resolve; notifyStarted(); });
    const preparing = engine.applyRunManifest(resolved("actor"));
    await tick(); await tick();
    assert.equal(oldSource.disposed, true);
    assert.equal(tool.ready, false);
    await started;
    vehicles.vehicles.push({ ...vehicles.vehicles[0], telemetryId: "actor", position: { x: 12, y: 0, z: 0, set() {} }, velocity: { x: 0, y: 0, z: 0, set() {} } });
    oldCallback({ kind: "update", path: "test.value", entry: { value: { value: 99 } } });
    oldSource.releasePending(100);
    assert.equal(tool.updates.length, before);
    releasePrepare(); await preparing;
    assert.equal(engine.visualizationManager.bindings.find((binding) => binding.id === "default-pose").signalPath, vehiclesLeafPath("actor", "pose"));
    assert.equal(tool.pose.position.x, 12);
    engine.dispose();
});

test("reset, stop, and clear discard old local samples and release prior source lifetimes", async () => {
    const { engine, store, tools: { tool } } = engineFixture();
    await engine.applyRunManifest(resolved());
    engine.configureVisualizations(engineBindings);
    for (const action of [() => engine.reset(), () => engine.stop(), () => engine.clearRun()]) {
        const source = engine.liveVisualizationSource;
        const callback = [...store._listeners][0].listener;
        store.publishSignal("test.value", { value: { value: 99 } });
        const oldFlush = engine._visualizationFlush;
        action();
        const count = tool.updates.length;
        callback({ kind: "update", path: "test.value", entry: { value: { value: 100 } } });
        source.releasePending(100);
        oldFlush?.();
        await tick();
        assert.equal(tool.updates.length, count);
        assert.equal(source.disposed, true);
        assert.equal(store._listeners.size, 1);
        assert.notEqual(tool.inputs.value, 99);
    }
    assert.equal(tool.poseMetadata.runId, undefined);
    engine.dispose();
    assert.equal(store._listeners.size, 0);
});

test("pause preserves a pending dirty flush through renderer leases and independent paused events", async () => {
    const { engine, store, tools: { tool } } = engineFixture();
    let blocked = true;
    let available;
    const runtime = { implementation: "inline", get presentationBlocked() { return blocked; },
        subscribePresentationAvailability(callback) { available = callback; return () => {}; }, dispose() {} };
    engine._bindRenderRuntime(runtime);
    store.publishSignal("test.value", { value: { value: 1 } });
    engine.configureVisualizations(engineBindings);
    await tick();
    assert.equal(tool.draws.map.length, 0);
    engine.pause();
    blocked = false;
    available(true);
    await tick();
    assert.equal(tool.draws.map.length, 1);
    let emit;
    engine.visualizationManager.setSource({ subscribe(bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    emit({ type: "data", bindingId: "value", inputs: { value: 2 }, revision: 2 });
    await tick();
    assert.equal(engine.status, "paused");
    assert.equal(tool.draws.map.at(-1).dirty.geometry, true);
    assert.equal(engine.visualizationManager.getMapSnapshot().tools.tool.output.inputs.value, 2);
    engine.dispose();
});

test("display bindings leave canonical state and run identities equal", async () => {
    const first = engineFixture();
    const second = engineFixture();
    await first.engine.applyRunManifest(resolved());
    await second.engine.applyRunManifest(resolved());
    second.engine.configureVisualizations(engineBindings);
    second.engine.visualizationManager.setVisible("tool", "scene", false);
    first.engine.step(3); second.engine.step(3);
    assert.deepEqual(second.engine.kernel.getCanonicalState(), first.engine.kernel.getCanonicalState());
    assert.equal(second.engine.resolvedRun.resolvedHash, first.engine.resolvedRun.resolvedHash);
    assert.equal(second.engine.simulationSemanticHash, first.engine.simulationSemanticHash);
    assert.equal(second.engine.episodeHash, first.engine.episodeHash);
    assert.equal(second.engine.trajectoryHash, first.engine.trajectoryHash);
    first.engine.dispose(); second.engine.dispose();
});

test("synthetic fallback data and poses update after every completed playground step", () => {
    const { engine, vehicle } = engineFixture();
    engine.configureVisualizations({ trajectoryPast: { data: [{ id: "actors", kind: "runtime", signalPath: "visualization.trajectoryPast.actors" }] } });
    vehicle.velocity.x = 6;
    engine.step(8);
    const samples = engine.visualizationManager.tools.trajectoryPast.history.get("ego");
    assert.ok(samples.length > 1);
    assert.equal(samples.at(-1).x, vehicle.position.x);
    assert.equal(samples.at(-1).timeNs, engine.timeNs);
    engine.dispose();
});

test("local projections wait for completed release before reading runtime snapshots", () => {
    const { store, source, events } = liveFixture();
    let snapshot = { value: "captured" };
    let projections = 0;
    source.subscribe([{ ...controlsBinding, project: () => { projections += 1; return snapshot; } }], (event) => events.push(event));
    store.publishSignal(controlsPath, { status: "ok" });
    assert.equal(projections, 0);
    snapshot = { value: "later" };
    source.releasePending(1);
    assert.equal(events.find((event) => event.type === "data").inputs.value, "later");
    assert.equal(projections, 1);
    source.dispose();
});

test("metadata failures remain deferred display errors and never escape local publication", () => {
    let publish;
    const events = [];
    const source = new LiveVisualizationSource({ signalStore: {
        subscribeSignals(_options, callback) { publish = callback; return () => {}; },
        read() { return { exists: false }; }, revision() { return 1; },
    } });
    source.subscribe([controlsBinding], (event) => events.push(event));
    const entry = { value: { value: 1 }, get metadata() { throw new Error("Metadata failed."); } };
    assert.doesNotThrow(() => publish({ kind: "update", path: controlsPath, entry }));
    assert.doesNotThrow(() => source.releasePending(1));
    assert.equal(events.find((event) => event.type === "status").message, "Metadata failed.");
    source.dispose();
});

test("paused document changes capture poses after projection and queued old notifications are fenced", async () => {
    let changed, poseValue = pose(), canceled = 0;
    const events = [];
    const source = new LiveVisualizationSource({ getPose: () => poseValue,
        subscribeRuntimeChanges: (callback) => { changed = callback; return () => { canceled += 1; }; } });
    const cancel = source.subscribe([poseBinding], (event) => events.push(event));
    changed();
    poseValue = pose(5);
    await tick();
    assert.equal(events.filter((event) => event.type === "pose").at(-1).pose.position.x, 5);
    changed(); cancel();
    const count = events.length;
    await tick();
    assert.equal(events.length, count);
    assert.equal(canceled, 1);
    source.dispose();
});

test("scene menu visibility and map choices survive implicit configure/reset/run rebinds", async () => {
    const { engine } = engineFixture();
    engine.setAutonomyOverlayEnabled({ controls: false, candidate: false, ekf: false, estimateClone: false,
        oracleOccupancy: true, lidarOccupancy: false, stackOccupancy: false, pastTrajectories: false });
    const manager = engine.visualizationManager;
    for (const id of ["ackermann", "plannedTrajectory", "trajectoryPast", "localization"]) manager.setVisible(id, "map", false);
    const check = () => {
        for (const id of ["ackermann", "plannedTrajectory", "trajectoryPast"]) assert.equal(manager.entries.get(id).visible.scene, false);
        for (const id of ["ackermann", "plannedTrajectory", "trajectoryPast", "localization"]) assert.equal(manager.entries.get(id).visible.map, false);
        assert.equal(manager.entries.get("occupancy").visible.scene, true);
        assert.deepEqual(manager.tools.occupancy.layerVisibility.scene, { oracle: true, lidar: false, stack: false });
        assert.equal(manager.tools.localization.layerVisibility.scene.ekf, false);
        assert.equal(manager.tools.localization.layerVisibility.scene.estimateClone, false);
        assert.equal(engine.getSnapshot().autonomyOverlay.oracleOccupancy, true);
        assert.equal(engine.getSnapshot().autonomyOverlay.pastTrajectories, false);
    };
    engine.configure({ scene: new Scene(), camera: new PerspectiveCamera(), renderer: null }); check();
    engine.reset(); check();
    engine.stop(); check();
    await engine.applyRunManifest(resolved()); check();
    engine.step(); check();
    engine.clearRun(); check();
    engine.dispose();
});

test("perspective hiding does not overwrite requested visibility and explicit configuration still wins", () => {
    const { engine } = engineFixture();
    const manager = engine.visualizationManager;
    manager.setVisible("ackermann", "map", false);
    manager.setPredictedPathHidden(true);
    engine.configure({ scene: new Scene(), camera: new PerspectiveCamera(), renderer: null });
    assert.equal(manager.entries.get("ackermann").visible.scene, true);
    assert.equal(manager.tools.ackermann.visible.scene, false);
    assert.equal(engine.getSnapshot().autonomyOverlay.controls, true);
    manager.setPredictedPathHidden(false);
    assert.equal(manager.tools.ackermann.visible.scene, true);
    engine.configureVisualizations({ ...engine._visualizationBindings, ackermann: {
        ...engine._visualizationBindings.ackermann, visible: { scene: false, map: true },
    } });
    assert.equal(manager.entries.get("ackermann").visible.scene, false);
    assert.equal(manager.entries.get("ackermann").visible.map, true);
    assert.equal(engine.getSnapshot().autonomyOverlay.controls, false);
    manager.setVisible("localization", "scene", false);
    assert.equal(engine.getSnapshot().autonomyOverlay.ekf, false);
    engine.setAutonomyOverlayEnabled({ ekf: true });
    assert.equal(manager.entries.get("localization").visible.scene, true);
    assert.equal(engine.getSnapshot().autonomyOverlay.ekf, true);
    engine.step();
    assert.equal(manager.entries.get("ackermann").visible.scene, false);
    engine.dispose();
});

test("paused device edits refresh map wedges and poses without a simulation step", () => {
    const { engine, data, vehicle } = engineFixture();
    const device = { enabled: true, settings: { range: 10, theta: { range: [-45, 45] } },
        getPosition: () => vehicle.position, getRotation: () => vehicle.rotation };
    vehicle.devices = [device];
    data.simulation = () => engine;
    const frame = createPlanViewFrameStore(data);
    const cancel = frame.subscribe(() => {});
    assert.equal(frame.getSnapshot().sensors.length, 1);
    const previous = frame.getSnapshot();
    engine._emitFrame();
    assert.equal(frame.getSnapshot(), previous);
    device.enabled = false;
    vehicle.position.x = 9;
    engine.notifyVisualizationChange();
    assert.equal(frame.getSnapshot().sensors.length, 0);
    assert.equal(frame.getSnapshot().vehicles[0].position.x, 9);
    assert.equal(engine.steps, 0);
    assert.equal(engine.visualizationManager.tools.ackermann.pose.position.x, 9);
    cancel(); engine.dispose();
});
