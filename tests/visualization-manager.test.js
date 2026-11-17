import assert from "node:assert/strict";
import test from "node:test";
import { Visualizer } from "../app/visualization/Visualizer.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";

class FakeSource {
    subscriptions = [];
    disposed = 0;
    subscribe(bindings, callback) {
        const subscription = { bindings, callback, cancelled: false };
        this.subscriptions.push(subscription);
        return () => { subscription.cancelled = true; };
    }
    emit(event) {
        for (const subscription of [...this.subscriptions]) if (!subscription.cancelled) subscription.callback(event);
    }
    dispose() { this.disposed += 1; }
}

function scheduler() {
    const requests = [];
    return {
        requests,
        requestFlush(callback) {
            const request = { callback, cancelled: false };
            requests.push(request);
            return () => { request.cancelled = true; };
        },
        run() {
            for (const request of requests.splice(0)) if (!request.cancelled) request.callback();
        },
    };
}

class FakeTool extends Visualizer {
    updates = [];
    moves = [];
    draws = { scene: [], map: [] };
    geometryBuilds = { scene: 0, map: 0 };
    visibility = [];
    clocks = [];
    resets = 0;
    disposals = 0;
    constructor(options = {}) {
        super({ requiredInputs: ["steeringRad"], optionalInputs: { wheelbase: 1.5, velocity: 0, enabled: false }, ...options });
    }
    validateInputs(inputs) {
        return Number.isFinite(inputs.steeringRad) && Number.isFinite(inputs.wheelbase) && inputs.wheelbase > 0 || "Invalid steering or wheelbase.";
    }
    validatePose(pose) { return Number.isFinite(pose.x) || "Invalid pose."; }
    onDataUpdate(inputs, changedKeys, metadata) { this.updates.push({ inputs, changedKeys, metadata }); }
    onVehicleMove(pose, metadata) { this.moves.push({ pose, metadata }); }
    onTimeAdvance(timeNs) { this.clocks.push(timeNs); }
    onVisibilityChange(target, visible) { this.visibility.push({ target, visible }); }
    draw(target, context) {
        this.draws[target].push(context);
        if (context.dirty.geometry) this.geometryBuilds[target] += 1;
        return { steeringRad: this.inputs.steeringRad, pose: this.pose, context };
    }
    display(context) { return this.draw("scene", context); }
    displayMap(context) { return this.draw("map", context); }
    reset() { this.resets += 1; super.reset(); }
    dispose() { this.disposals += 1; super.dispose(); }
}

const controls = { id: "controls", kind: "runtime", signalPath: "visualization.controls.snapshot" };
const poseBinding = { id: "ego-pose", kind: "runtime", signalPath: "vehicles.ego.pose" };
const config = { controls: { data: [controls], pose: [poseBinding], predictedPath: true } };

function fixture(tools = { controls: new FakeTool() }, bindings = config) {
    const schedule = scheduler();
    const sceneContext = { scene: { name: "scene-host" } };
    const mapContext = { scale: 2 };
    const manager = new VisualizationManager({ tools, sceneContext, mapContext, requestFlush: schedule.requestFlush });
    manager.configure(bindings);
    const source = new FakeSource();
    manager.setSource(source);
    schedule.run();
    return { manager, source, schedule, tools, tool: tools.controls, sceneContext, mapContext };
}

function data(source, inputs, revision, metadata = {}) {
    source.emit({ type: "data", bindingId: "controls", inputs, revision, metadata });
}

test("required inputs wait, zero values and optional defaults are effective, metadata remains exact", () => {
    const { manager, source, schedule, tool, sceneContext, mapContext } = fixture();
    assert.equal(manager.getSnapshot().tools.controls.status, "waiting");
    assert.equal(tool.draws.scene.length, 0);
    const metadata = { runId: "run", captureTimeNs: 0, sequenceId: "18446744073709551615", frameId: "base_link" };
    data(source, { steeringRad: 0 }, "0", metadata);
    schedule.run();
    assert.deepEqual(tool.inputs, { steeringRad: 0, wheelbase: 1.5, velocity: 0, enabled: false });
    assert.equal(manager.getSnapshot().tools.controls.status, "ready");
    assert.deepEqual(tool.updates[0].metadata, metadata);
    assert.equal(manager.getMapSnapshot().tools.controls.metadata.sequenceId, metadata.sequenceId);
    assert.equal(tool.draws.scene[0].scene, sceneContext.scene);
    assert.equal(tool.draws.map[0].scale, mapContext.scale);
    assert.equal(tool.draws.scene[0].toolId, "controls");
});

test("multiple bindings merge without resetting earlier inputs or optional overrides", () => {
    const tool = new FakeTool({ requiredInputs: ["steeringRad", "velocity"], optionalInputs: { wheelbase: 1.5 } });
    const velocity = { id: "velocity", kind: "runtime", signalPath: "vehicles.ego.speed" };
    const { source, schedule, manager } = fixture({ controls: tool }, { controls: { data: [controls, velocity] } });
    data(source, { steeringRad: 0, wheelbase: 2.7 }, 1);
    schedule.run();
    assert.equal(manager.getSnapshot().tools.controls.status, "waiting");
    assert.equal(tool.updates.length, 0);
    source.emit({ type: "data", bindingId: "velocity", inputs: { velocity: 0 }, revision: 1 });
    schedule.run();
    assert.equal(tool.inputs.wheelbase, 2.7);
    assert.equal(tool.inputs.velocity, 0);
    assert.equal(tool.ready, true);
    assert.equal(tool.updates.length, 1);
});

test("invalid atomic samples retain the last accepted state and only invalidate status", () => {
    const { manager, source, schedule, tool } = fixture();
    data(source, { steeringRad: 0.1, wheelbase: 2.8 }, 1);
    schedule.run();
    const previousInputs = tool.inputs;
    const previousOutput = manager.getMapSnapshot().tools.controls.output;
    const builds = { ...tool.geometryBuilds };
    for (const inputs of [{ steeringRad: NaN, wheelbase: 3 }, { steeringRad: null }, { steeringRad: 1, wheelbase: -1 }, null]) {
        assert.doesNotThrow(() => data(source, inputs, 2));
        schedule.run();
        assert.equal(tool.inputs, previousInputs);
        assert.equal(manager.getSnapshot().tools.controls.status, "error");
        assert.equal(manager.getMapSnapshot().tools.controls.output, previousOutput);
        assert.deepEqual(tool.geometryBuilds, builds);
    }
    data(source, { steeringRad: 0.1, wheelbase: 2.8 }, 1);
    schedule.run();
    assert.equal(manager.getSnapshot().tools.controls.status, "ready");
    assert.deepEqual(tool.geometryBuilds, builds);
});

test("shared subscriptions fan out once per tool and compare references or revisions without serialization", () => {
    const first = new FakeTool();
    const second = new FakeTool();
    const { source, schedule } = fixture({ controls: first, comparison: second }, {
        controls: { data: [controls] }, comparison: { data: [{ ...controls }] },
    });
    assert.deepEqual(source.subscriptions[0].bindings, [controls]);
    const cells = new Uint8Array(100000);
    cells.toJSON = () => { throw new Error("Do not serialize cells."); };
    data(source, { steeringRad: 0, cells }, 1);
    schedule.run();
    data(source, { steeringRad: 0, cells }, 1);
    schedule.run();
    assert.equal(first.updates.length, 1);
    assert.equal(second.updates.length, 1);
    data(source, { steeringRad: 0, cells }, 2);
    schedule.run();
    assert.deepEqual(first.updates[1].changedKeys, ["steeringRad", "cells"]);
    data(source, { steeringRad: 0, cells: new Uint8Array(100000) }, 2);
    schedule.run();
    assert.deepEqual(first.updates[2].changedKeys, ["cells"]);
    data(source, { steeringRad: 0, cells: first.inputs.cells });
    schedule.run();
    assert.equal(first.updates.length, 3);
});

test("bursts ingest every motion sample but coalesce presentation and placement does not rebuild geometry", () => {
    const { source, schedule, tool } = fixture();
    data(source, { steeringRad: 0 }, 1);
    for (let x = 0; x < 5; x += 1) source.emit({ type: "pose", bindingId: "ego-pose", pose: { x }, revision: x });
    assert.equal(schedule.requests.length, 1);
    assert.equal(tool.moves.length, 5);
    assert.equal(tool.draws.scene.length, 0);
    schedule.run();
    assert.equal(tool.draws.scene.length, 1);
    assert.equal(tool.draws.map.length, 1);
    assert.equal(tool.draws.scene[0].dirty.placement, true);
    const pose = { x: 8 };
    source.emit({ type: "pose", bindingId: "ego-pose", pose, revision: 8 });
    source.emit({ type: "pose", bindingId: "ego-pose", pose, revision: 8 });
    schedule.run();
    assert.equal(tool.moves.length, 6);
    assert.deepEqual(tool.geometryBuilds, { scene: 1, map: 1 });
    assert.equal(tool.draws.scene[1].dirty.geometry, false);
    assert.equal(tool.draws.scene[1].dirty.placement, true);
});

test("hidden targets retain geometry work and target visibility keeps unrelated snapshots stable", () => {
    const { manager, source, schedule, tool } = fixture();
    data(source, { steeringRad: 0 }, 1);
    schedule.run();
    const mapSnapshot = manager.getMapSnapshot();
    manager.setVisible("controls", "scene", false);
    schedule.run();
    assert.equal(manager.getMapSnapshot(), mapSnapshot);
    data(source, { steeringRad: 0.3 }, 2);
    schedule.run();
    assert.equal(tool.draws.scene.length, 1);
    assert.equal(tool.draws.map.length, 2);
    assert.equal(tool.dirty.scene.geometry, true);
    assert.equal(schedule.requests.length, 0);
    manager.setVisible("controls", "scene", true);
    schedule.run();
    assert.equal(tool.draws.scene.length, 2);
    assert.equal(tool.draws.map.length, 2);
    assert.equal(tool.dirty.scene.geometry, false);
    const snapshot = manager.getSnapshot();
    manager.flush();
    assert.equal(manager.getSnapshot(), snapshot);
    assert.equal(tool.draws.scene.length, 2);
});

test("layer and predicted-path visibility changes avoid geometry work and preserve user visibility", () => {
    const { manager, source, schedule, tool } = fixture();
    data(source, { steeringRad: 0 }, 1);
    schedule.run();
    const mapSnapshot = manager.getMapSnapshot();
    manager.setLayerVisible("controls", "oracle", "scene", false);
    schedule.run();
    assert.equal(tool.draws.scene[1].layerVisibility.oracle, false);
    assert.equal(tool.draws.scene[1].dirty.geometry, false);
    assert.equal(manager.getMapSnapshot(), mapSnapshot);
    manager.setPredictedPathHidden(true);
    schedule.run();
    assert.equal(manager.getSnapshot().tools.controls.visible, false);
    assert.equal(manager.getMapSnapshot(), mapSnapshot);
    manager.setVisible("controls", "scene", false);
    manager.setPredictedPathHidden(false);
    schedule.run();
    assert.equal(manager.getSnapshot().tools.controls.visible, false);
    assert.deepEqual(tool.geometryBuilds, { scene: 1, map: 1 });
});

test("status changes publish cached snapshots without display work and subscriptions cancel", () => {
    const { manager, source, schedule, tool } = fixture();
    data(source, { steeringRad: 0 }, 1);
    schedule.run();
    let sceneNotices = 0;
    let mapNotices = 0;
    const cancelScene = manager.subscribe(() => { sceneNotices += 1; });
    const cancelMap = manager.subscribeMap(() => { mapNotices += 1; });
    const previous = manager.getSnapshot();
    source.emit({ type: "status", bindingId: "controls", status: "stale", message: "No recent sample." });
    schedule.run();
    assert.notEqual(manager.getSnapshot(), previous);
    assert.equal(sceneNotices, 1);
    assert.equal(mapNotices, 1);
    assert.equal(tool.draws.scene.length, 1);
    cancelScene(); cancelMap();
    source.emit({ type: "status", bindingId: "controls", status: "stale", message: "No recent sample." });
    schedule.run();
    assert.equal(sceneNotices, 1);
    assert.equal(mapNotices, 1);
});

test("source replacement cancels pending work and fences stale data while owning source disposal", () => {
    const { manager, source, schedule, tool } = fixture();
    data(source, { steeringRad: 1 }, 1);
    const pending = schedule.requests[0];
    const oldCallback = source.subscriptions[0].callback;
    const replacement = new FakeSource();
    manager.setSource(replacement);
    assert.equal(source.disposed, 1);
    assert.equal(source.subscriptions[0].cancelled, true);
    assert.equal(pending.cancelled, true);
    assert.equal(tool.ready, false);
    oldCallback({ type: "data", bindingId: "controls", inputs: { steeringRad: 9 }, revision: 2 });
    pending.callback();
    schedule.run();
    assert.equal(tool.draws.scene.length, 0);
    assert.equal(tool.ready, false);
    data(replacement, { steeringRad: 0 }, 1);
    schedule.run();
    assert.equal(tool.inputs.steeringRad, 0);
    assert.equal(tool.draws.scene.length, 1);
    manager.setSource(null);
    assert.equal(replacement.disposed, 1);
    assert.equal(manager.getSnapshot().tools.controls.output, undefined);
});

test("reset fences callbacks, clears accepted state, and resubscribes without disposing the source", () => {
    const { manager, source, schedule, tool } = fixture();
    data(source, { steeringRad: 1 }, 1);
    const old = source.subscriptions[0];
    const pending = schedule.requests[0];
    manager.reset();
    assert.equal(old.cancelled, true);
    assert.equal(pending.cancelled, true);
    assert.equal(source.disposed, 0);
    assert.equal(source.subscriptions.length, 2);
    old.callback({ type: "data", bindingId: "controls", inputs: { steeringRad: 9 }, revision: 2 });
    pending.callback();
    schedule.run();
    assert.equal(tool.ready, false);
    data(source, { steeringRad: 0 }, 1);
    schedule.run();
    assert.equal(tool.inputs.steeringRad, 0);
    const active = source.subscriptions[1];
    source.emit({ type: "reset" });
    assert.equal(active.cancelled, true);
    assert.equal(tool.ready, false);
    assert.equal(manager.getMapSnapshot().tools.controls.output, undefined);
});

test("removing configured tools hides/resets them and removes routing and both cached outputs", () => {
    const first = new FakeTool();
    const second = new FakeTool();
    const { manager, source, schedule } = fixture({ controls: first, comparison: second }, {
        controls: { data: [controls] }, comparison: { data: [controls] },
    });
    data(source, { steeringRad: 0 }, 1);
    schedule.run();
    const old = source.subscriptions[0];
    manager.configure({ comparison: { data: [controls] } });
    assert.equal(old.cancelled, true);
    assert.equal(first.ready, false);
    assert.deepEqual(first.visible, { scene: false, map: false });
    assert.deepEqual(Object.keys(manager.getSnapshot().tools), ["comparison"]);
    data(source, { steeringRad: 1 }, 2);
    schedule.run();
    assert.equal(first.updates.length, 1);
    assert.equal(second.updates.length, 2);
    manager.configure({});
    assert.deepEqual(manager.getSnapshot(), { tools: {} });
    assert.deepEqual(manager.getMapSnapshot(), { tools: {} });
    assert.deepEqual(second.visible, { scene: false, map: false });
});

test("invalid configuration or failed replacement subscription retains working bindings", () => {
    const { manager, source, schedule, tool } = fixture();
    const subscription = source.subscriptions[0];
    assert.throws(() => manager.configure({ controls: { data: [controls, { ...controls, signalPath: "other" }] } }), /Conflicting binding/);
    assert.throws(() => manager.configure({ missing: { data: [controls] } }), /Unknown/);
    assert.equal(subscription.cancelled, false);
    const subscribe = source.subscribe;
    source.subscribe = () => { throw new Error("Subscription failed."); };
    assert.doesNotThrow(() => manager.configure({}));
    source.subscribe = subscribe;
    assert.equal(subscription.cancelled, false);
    assert.ok(manager.entries.has("controls"));
    const replacement = new FakeSource();
    replacement.subscribe = () => { throw new Error("Offline."); };
    manager.setSource(replacement);
    assert.equal(replacement.disposed, 1);
    assert.equal(manager.source, source);
    assert.equal(subscription.cancelled, false);
    data(source, { steeringRad: 0 }, 1);
    schedule.run();
    assert.equal(tool.ready, true);
});

test("source, tool, status-handler and subscriber failures cannot escape presentation into stepping", () => {
    const broken = new FakeTool();
    const good = new FakeTool();
    const { manager, source, schedule } = fixture({ controls: broken, comparison: good }, {
        controls: { data: [controls], pose: [poseBinding] }, comparison: { data: [controls] },
    });
    broken.onDataUpdate = () => { throw new Error("Ingestion failed."); };
    assert.doesNotThrow(() => data(source, { steeringRad: 0 }, 1));
    schedule.run();
    assert.equal(manager.getSnapshot().tools.controls.status, "error");
    assert.equal(good.draws.scene.length, 1);
    broken.onDataUpdate = FakeTool.prototype.onDataUpdate;
    data(source, { steeringRad: 0 }, 1);
    schedule.run();
    broken.display = () => { throw new Error("Scene failed."); };
    manager.subscribe(() => { throw new Error("Subscriber failed."); });
    data(source, { steeringRad: 1 }, 2);
    assert.doesNotThrow(() => schedule.run());
    assert.equal(manager.getSnapshot().tools.controls.message, "Scene failed.");
    assert.equal(good.draws.scene.length, 2);
    const previousPose = broken.pose;
    assert.doesNotThrow(() => source.emit({ type: "pose", bindingId: "ego-pose", pose: { x: NaN }, revision: 1 }));
    schedule.run();
    assert.equal(broken.pose, previousPose);
    broken.setStatus = () => { throw new Error("Status hook failed."); };
    assert.doesNotThrow(() => source.emit({ type: "status", bindingId: "controls", status: "stale" }));
    schedule.run();
    assert.equal(manager.getSnapshot().tools.controls.message, "Status hook failed.");
    broken.reset = () => { throw new Error("Reset failed."); };
    source.subscribe = () => { throw new Error("Source failed."); };
    assert.doesNotThrow(() => manager.reset());
    assert.equal(manager.getSnapshot().tools.controls.status, "error");
});

test("clock-only tools are ready and ingest clock events without unnecessary drawing", () => {
    const tool = new FakeTool({ requiredInputs: [] });
    const { source, schedule, manager } = fixture({ controls: tool }, { controls: {} });
    assert.equal(tool.ready, true);
    const count = tool.draws.scene.length;
    source.emit({ type: "clock", timeNs: 1000000000 });
    source.emit({ type: "clock", timeNs: 2000000000n });
    schedule.run();
    assert.deepEqual(tool.clocks, [1000000000, 2000000000n]);
    assert.equal(tool.draws.scene.length, count);
    source.emit({ type: "clock", timeNs: -1 });
    schedule.run();
    assert.equal(manager.getSnapshot().tools.controls.status, "error");
});

test("timing counters use the injected clock and include failed hooks without exposing mutable records", () => {
    let now = 0;
    const tool = new FakeTool({ now: () => now });
    tool.onDataUpdate = () => { now += 3; };
    tool.onVehicleMove = () => { now += 2; };
    tool.display = () => { now += 5; };
    tool.displayMap = () => { now += 7; };
    const { source, schedule } = fixture({ controls: tool });
    data(source, { steeringRad: 0 }, 1);
    source.emit({ type: "pose", bindingId: "ego-pose", pose: { x: 0 } });
    schedule.run();
    data(source, { steeringRad: 1 }, 2);
    schedule.run();
    assert.deepEqual(tool.getTimings(), {
        onDataUpdate: { count: 2, lastMs: 3, totalMs: 6, maxMs: 3 },
        onVehicleMove: { count: 1, lastMs: 2, totalMs: 2, maxMs: 2 },
        display: { count: 2, lastMs: 5, totalMs: 10, maxMs: 5 },
        displayMap: { count: 2, lastMs: 7, totalMs: 14, maxMs: 7 },
    });
    const copy = tool.getTimings();
    copy.display.count = -1;
    assert.equal(tool.getTimings().display.count, 2);
    tool.onDataUpdate = () => { now += 11; throw new Error("Timed failure."); };
    data(source, { steeringRad: 2 }, 3);
    schedule.run();
    assert.deepEqual(tool.getTimings().onDataUpdate, { count: 3, lastMs: 11, totalMs: 17, maxMs: 11 });
});

test("dispose cancels subscriptions and queued work, releases owned tools once, and fences all callbacks", () => {
    const { manager, source, schedule, tool } = fixture();
    data(source, { steeringRad: 0 }, 1);
    const pending = schedule.requests[0];
    const callback = source.subscriptions[0].callback;
    manager.dispose();
    manager.dispose();
    assert.equal(pending.cancelled, true);
    assert.equal(source.disposed, 1);
    assert.equal(source.subscriptions[0].cancelled, true);
    assert.equal(tool.disposals, 1);
    callback({ type: "data", bindingId: "controls", inputs: { steeringRad: 9 }, revision: 2 });
    pending.callback();
    manager.reset();
    manager.flush();
    schedule.run();
    assert.equal(tool.draws.scene.length, 0);
    assert.deepEqual(manager.getSnapshot(), { tools: {} });
    assert.deepEqual(manager.getMapSnapshot(), { tools: {} });
});
