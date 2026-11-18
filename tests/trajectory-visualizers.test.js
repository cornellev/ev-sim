import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";
import { PlannedTrajectoryVisualizer } from "../app/visualization/visualizers/PlannedTrajectoryVisualizer.js";
import { TrajectoryPastVisualizer } from "../app/visualization/visualizers/TrajectoryPastVisualizer.js";
import { appendPlanTrails, clipTrail, TRAJECTORY_SAMPLE_LIMIT } from "../app/visualization/trajectoryHistory.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";
import { AutonomyOverlay, AUTONOMY_OVERLAY_LAYER } from "../app/3d/overlay/AutonomyOverlay.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { CandidateOutputRuntime } from "../app/autonomy/CandidateOutputRuntime.js";
import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import { topicFromNativeContract } from "../app/simulation/NativeTopicCatalog.js";
import { buildPlanViewFrame } from "../app/spatial/planview/frame.js";
import { listPlanLayers } from "../app/spatial/planview/registry.js";
import "../app/spatial/planview/layers/index.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

const pose = (x = 0, y = 0, yaw = 0) => ({ position: { x, y, z: 2 }, rotation: { x: 0, y: yaw, z: 0, order: "XYZ" } });
const actor = (id, x, y = 0) => ({ id, position: { x, y, z: 2 } });

function fixture() {
    const past = new TrajectoryPastVisualizer();
    const planned = new PlannedTrajectoryVisualizer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    let emit;
    let requests = 0;
    const manager = new VisualizationManager({ tools: { trajectoryPast: past, plannedTrajectory: planned }, sceneContext: { scene, camera }, requestFlush: () => { requests += 1; return () => {}; } });
    manager.configure({ trajectoryPast: { data: [{ id: "actors" }], pose: [{ id: "actor-pose" }] }, plannedTrajectory: { data: [{ id: "path" }], pose: [{ id: "path-pose" }] } });
    manager.setSource({ subscribe(_bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    manager.flush();
    return { manager, past, planned, scene, camera, emit, requests: () => requests,
        actors: (actors, timeNs) => emit({ type: "data", bindingId: "actors", inputs: { actors, timeNs } }),
        clock: (timeNs) => emit({ type: "clock", timeNs }),
        path: (points, vehicleRelative = false) => emit({ type: "data", bindingId: "path", inputs: { points, vehicleRelative } }),
    };
}

function engineFixture() {
    const store = new SignalStore();
    const ego = { telemetryId: "ego", position: new THREE.Vector3(), rotation: new THREE.Euler(), velocity: new THREE.Vector3(),
        updatePosition() {}, updateRotation() {}, update() { this.position.x += 0.1; this.position.y += 0.1; } };
    const npc = { ...ego, telemetryId: "npc", position: new THREE.Vector3(5, 1, 3), update() { this.position.z += 0.1; } };
    const vehicles = { vehicles: [ego, npc], update() { this.vehicles.forEach((vehicle) => vehicle.update()); }, configureFromManifest() {} };
    const data = {
        bindings: () => ({ signalStore: store, manifest: { enabled: false, bindings: [] }, update() {} }), vehicles: () => vehicles,
        devices: () => ({ configureFromManifest() {}, resetSchedule() {}, update() {}, deliver() {} }),
        physics: () => ({ configureRun() {}, resetRun() {}, step() {}, syncAndPublishContacts() {} }), keys: () => null, client: () => null, baking: () => null,
    };
    const engine = new SimulationEngine(data, { packetRelay: null });
    data.simulation = () => engine;
    engine.setModule("assertions", false);
    engine.configure({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null });
    engine.render();
    return { engine, ego, npc, vehicles, store };
}

test("shared history samples vertical motion, keeps exact nanoseconds, and clips the selected window", () => {
    const history = new Map();
    const anchors = new Map();
    appendPlanTrails(history, [actor("ego", 0)], 0n, anchors);
    assert.equal(appendPlanTrails(history, [actor("ego", 0, 0.05)], 1n, anchors), false);
    assert.equal(appendPlanTrails(history, [actor("ego", 0, 0.06)], 2n, anchors), true);
    appendPlanTrails(history, [actor("ego", 1, 0.06)], 11_000_000_000n, anchors);
    assert.deepEqual(history.get("ego")[1], { x: 0, y: 0.06, z: 2, timeNs: 2n });
    assert.equal(clipTrail(history.get("ego"), 11_000_000_000n).length, 1);
    assert.equal(clipTrail(history.get("ego"), 11_000_000_000n, "full").length, 3);
    appendPlanTrails(history, [actor("ego", 1, 0.06)], 132_000_000_001n, anchors);
    assert.deepEqual(history.get("ego"), []);
    assert.equal(appendPlanTrails(history, [actor("ego", 1, 0.06)], 133_000_000_000n, anchors), false);
    appendPlanTrails(history, [], 133_000_000_000n, anchors);
    assert.equal(history.size, 0);
    assert.equal(anchors.size, 0);
});

test("all intermediate poses survive bursts while both visible outputs flush once", () => {
    const f = fixture();
    const displays = f.past.getTimings().display.count;
    const requests = f.requests();
    for (let index = 0; index < 30; index += 1) {
        f.actors([actor("ego", index / 10, index / 10), actor("npc", 5 + index / 10)], index * 100_000_000);
        f.clock(index * 100_000_000);
    }
    assert.equal(f.requests(), requests + 1);
    assert.equal(f.past.history.get("ego").length, 30);
    assert.equal(f.past.lines.size, 0);
    f.manager.flush();
    assert.equal(f.past.getTimings().display.count, displays + 1);
    const line = f.past.lines.get("ego");
    assert.equal(line.geometry.getAttribute("position").count, 30);
    assert.ok(Math.abs(line.geometry.getAttribute("position").getY(29) - 2.95) < 1e-6);
    assert.equal(f.past.group.position.x, 0);
    const output = f.manager.getMapSnapshot().tools.trajectoryPast.output;
    assert.equal(output.primitives[0].points[0], f.past.history.get("ego")[0]);
    assert.equal(output.primitives[0].stroke, "#f8fafc");
    const layer = listPlanLayers().find((entry) => entry.id === "trails");
    assert.equal(layer.project(buildPlanViewFrame({ visualizationMap: f.manager.getMapSnapshot() })), output.primitives);
    const intersections = [];
    line.raycast({}, intersections);
    assert.deepEqual(intersections, []);
    assert.equal(line.layers.isEnabled(AUTONOMY_OVERLAY_LAYER), true);
    f.manager.dispose();
});

test("stationary samples and clocks preserve map and geometry until visible samples expire", () => {
    const f = fixture();
    f.actors([actor("ego", 0)], 0); f.clock(0);
    f.actors([actor("ego", 1)], 1_000_000_000); f.clock(1_000_000_000); f.manager.flush();
    const snapshot = f.manager.getMapSnapshot();
    const line = f.past.lines.get("ego");
    const geometry = line.geometry;
    const version = geometry.getAttribute("position").version;
    const timings = f.past.getTimings();
    for (let index = 2; index <= 10; index += 1) {
        f.actors([actor("ego", 1)], index * 1_000_000_000); f.clock(index * 1_000_000_000); f.manager.flush();
    }
    assert.equal(f.manager.getMapSnapshot(), snapshot);
    assert.equal(f.past.getTimings().display.count, timings.display.count);
    assert.equal(geometry.getAttribute("position").version, version);
    f.clock(10_000_000_001); f.manager.flush();
    assert.equal(line.visible, false);
    assert.deepEqual(f.manager.getMapSnapshot().tools.trajectoryPast.output.primitives, []);
    f.past.setHistoryMode("full"); f.manager.flush();
    assert.equal(line.visible, true);
    f.clock(121_000_000_001); f.manager.flush();
    assert.deepEqual(f.past.history.get("ego"), []);
    assert.equal(line.visible, false);
    f.manager.dispose();
});

test("history pose events sample immediately, keep world placement, remove actors, reset, and dispose resources", () => {
    const f = fixture();
    f.emit({ type: "pose", bindingId: "actor-pose", pose: pose(0, 3), metadata: { actorId: "other", captureTimeNs: 0n } });
    f.emit({ type: "pose", bindingId: "actor-pose", pose: pose(1, 4), metadata: { actorId: "other", captureTimeNs: 1n } });
    f.clock(1n); f.manager.flush();
    assert.equal(f.past.history.get("other").length, 2);
    const line = f.past.lines.get("other");
    let geometryDisposals = 0;
    let materialDisposals = 0;
    line.geometry.addEventListener("dispose", () => { geometryDisposals++; });
    line.material.addEventListener("dispose", () => { materialDisposals++; });
    f.actors([actor("ego", 0)], 2n); f.clock(2n); f.manager.flush();
    assert.equal(f.past.history.has("other"), false);
    assert.equal(f.past.lines.has("other"), false);
    assert.equal(geometryDisposals, 1);
    assert.equal(materialDisposals, 1);
    f.manager.reset(); f.manager.flush();
    assert.equal(f.past.history.size, 0);
    assert.equal(f.past.anchors.size, 0);
    assert.equal(f.past.lines.size, 0);
    assert.deepEqual(f.manager.getMapSnapshot().tools.trajectoryPast.output.primitives, []);
    f.manager.dispose();
    assert.equal(f.past.group.parent, null);
});

test("dense external pose bursts are capped at 10,000 samples before presentation", () => {
    const f = fixture();
    for (let index = 0; index < TRAJECTORY_SAMPLE_LIMIT + 50; index += 1) {
        f.emit({ type: "pose", bindingId: "actor-pose", pose: pose(index), metadata: { captureTimeNs: BigInt(index) } });
    }
    assert.equal(f.past.history.get("ego").length, TRAJECTORY_SAMPLE_LIMIT);
    assert.equal(f.past.history.get("ego")[0].x, 50);
    assert.equal(f.past.history.get("ego").at(-1).timeNs, 10_049n);
    f.manager.flush();
    assert.equal(f.past.lines.get("ego").geometry.getAttribute("position").count, TRAJECTORY_SAMPLE_LIMIT);
    f.manager.dispose();
});

test("planned relative points follow full current pose without rebuilding buffers and world points stay fixed", () => {
    const f = fixture();
    const points = [{ x: 0, y: 1, z: 0 }, { x: 4, y: 2, z: -1 }];
    f.path(points, true);
    f.emit({ type: "pose", bindingId: "path-pose", pose: pose(5, 3, 0.4) }); f.manager.flush();
    const attribute = f.planned.line.geometry.getAttribute("position");
    const version = attribute.version;
    assert.deepEqual(f.planned.points, points);
    assert.equal(f.planned.group.position.y, 3);
    for (let index = 0; index < 20; index += 1) f.emit({ type: "pose", bindingId: "path-pose", pose: pose(index, index / 10, index / 100) });
    f.manager.flush();
    assert.equal(attribute.version, version);
    f.planned.group.updateMatrixWorld(true);
    const map = f.manager.getMapSnapshot().tools.plannedTrajectory.output.primitives[0].points;
    for (let index = 0; index < points.length; index += 1) {
        const world = new THREE.Vector3().fromBufferAttribute(attribute, index).applyMatrix4(f.planned.group.matrixWorld);
        assert.ok(world.distanceTo(new THREE.Vector3(map[index].x, map[index].y, map[index].z)) < 1e-6);
    }
    const layer = listPlanLayers().find((entry) => entry.id === "planned-trajectory");
    assert.equal(layer.project({ visualizationMap: f.manager.getMapSnapshot() }), f.planned.mapOutput.primitives);
    f.path(points, false); f.manager.flush();
    const worldOutput = f.planned.mapOutput;
    const displays = f.planned.getTimings().display.count;
    f.emit({ type: "pose", bindingId: "path-pose", pose: pose(200, 10) }); f.manager.flush();
    assert.equal(f.planned.group.position.x, 0);
    assert.equal(f.planned.mapOutput, worldOutput);
    assert.equal(f.planned.getTimings().display.count, displays);
    assert.equal(attribute.version, version);
    f.manager.dispose();
});

test("planned paths retain valid state on errors and empty samples clear both views", () => {
    const f = fixture();
    assert.equal(f.planned.ready, false);
    const points = [{ x: 0, z: 0 }, { x: 2, z: 1 }];
    f.path(points); f.manager.flush();
    const accepted = f.planned.inputs;
    f.path([{ x: NaN, z: 0 }]); f.manager.flush();
    assert.equal(f.planned.status, "error");
    assert.equal(f.planned.inputs, accepted);
    assert.equal(f.planned.line.visible, true);
    f.path([]); f.manager.flush();
    assert.equal(f.planned.line.visible, false);
    assert.equal(f.planned.line.geometry.getAttribute("position").count, 0);
    assert.deepEqual(f.planned.mapOutput.primitives, []);
    f.manager.dispose();
});

test("malformed planned poses retain accepted placement and publish errors", () => {
    const f = fixture();
    f.path([{ x: 0, z: 0 }, { x: 4, z: 0 }], true);
    const valid = pose(10, 2, 0.3);
    f.emit({ type: "pose", bindingId: "path-pose", pose: valid }); f.manager.flush();
    const output = f.planned.mapOutput;
    const positions = f.planned.line.geometry.getAttribute("position");
    const version = positions.version;
    for (const value of [
        {}, { ...valid, position: { x: NaN, y: 2, z: 0 } }, { ...valid, position: { x: 5, y: Infinity, z: 0 } },
        { ...valid, yaw: "0" }, { ...valid, rotation: { y: NaN } }, { ...valid, rotation: { x: 0, y: 0, z: 0, order: "bad" } },
    ]) {
        f.emit({ type: "pose", bindingId: "path-pose", pose: value }); f.manager.flush();
        assert.equal(f.planned.pose, valid);
        assert.equal(f.planned.group.position.x, 10);
        assert.equal(f.planned.group.position.y, 2);
        assert.equal(f.planned.mapOutput, output);
        assert.equal(positions.version, version);
        assert.equal(f.manager.getMapSnapshot().tools.plannedTrajectory.status, "error");
    }
    f.manager.dispose();
});

test("hidden history continues recording and expiring without display work", () => {
    const f = fixture();
    f.manager.setVisible("trajectoryPast", "scene", false);
    f.manager.setVisible("trajectoryPast", "map", false); f.manager.flush();
    const timings = f.past.getTimings();
    f.actors([actor("ego", 0)], 0);
    f.actors([actor("ego", 1)], 1); f.clock(1); f.manager.flush();
    assert.equal(f.past.history.get("ego").length, 2);
    assert.equal(f.past.getTimings().display.count, timings.display.count);
    f.manager.setVisible("trajectoryPast", "map", true); f.manager.flush();
    assert.equal(f.past.mapOutput.primitives.length, 1);
    f.clock(120_000_000_002); f.manager.flush();
    assert.equal(f.past.history.get("ego").length, 0);
    assert.equal(f.past.mapOutput.primitives.length, 0);
    f.manager.dispose();
});

test("replay facade owns the migrated path, preserves normalized world placement and metadata, and clears empties", () => {
    const overlay = new AutonomyOverlay();
    const tool = overlay.visualizationManager.tools.plannedTrajectory;
    const path = { status: "ok", frameId: "base_link", captureTimeNs: 0n, sequenceId: "18446744073709551615", points: [{ three: { x: 5, y: 2, z: 0 } }, { three: { x: 6, y: 3, z: 0 } }] };
    overlay.updateFromSnapshot({ path, vehiclePose: pose(20, 5) });
    assert.equal(overlay._path, tool.group);
    assert.equal(tool.group.position.x, 0);
    assert.equal(tool.points[0].x, 5);
    assert.deepEqual(tool.metadata, { frameId: "base_link", captureTimeNs: 0n, sequenceId: path.sequenceId });
    const geometry = tool.line.geometry;
    overlay.updateFromSnapshot({ path: { ...path, vehicleRelative: true }, vehiclePose: pose(30, 6) });
    assert.equal(tool.group.position.x, 30);
    assert.equal(tool.line.geometry, geometry);
    overlay.updateFromSnapshot({ path: { ...path, points: [] } });
    assert.equal(tool.line.visible, false);
    assert.deepEqual(overlay.visualizationManager.tools.trajectoryPast.history.get("ego").map((point) => point.x), [20, 30]);
    overlay.clear();
    assert.equal(tool.ready, false);
    overlay.dispose();
    assert.equal(tool.disposed, true);
});

test("engine samples every actor after each completed step, clears removed actors, and keeps canonical state unchanged", () => {
    const { engine, ego, vehicles } = engineFixture();
    const tool = engine.visualizationManager.tools.trajectoryPast;
    const displays = tool.getTimings().display.count;
    engine.step(8);
    assert.equal(tool.history.get("ego").length, 9);
    assert.equal(tool.history.get("npc").length, 9);
    assert.equal(tool.getTimings().display.count, displays + 1);
    assert.equal(tool.history.get("ego").at(-1).timeNs, engine.timeNs);
    assert.equal(tool.history.get("ego").at(-1).y, ego.position.y);
    const before = { state: engine.kernel.getCanonicalState(), hashes: [engine.simulationSemanticHash, engine.episodeHash, engine.trajectoryHash] };
    engine.render();
    assert.deepEqual(engine.kernel.getCanonicalState(), before.state);
    assert.deepEqual([engine.simulationSemanticHash, engine.episodeHash, engine.trajectoryHash], before.hashes);
    vehicles.vehicles.pop(); engine.step();
    assert.equal(tool.history.has("npc"), false);
    engine.reset();
    assert.equal(tool.history.get("ego").length, 1);
    assert.equal(tool.lines.size, 0);
    engine.dispose();
});

test("engine displays admitted native relative points using current pose without altering candidate normalization", () => {
    const { engine, ego, store } = engineFixture();
    const topics = [topicFromNativeContract("planning-path")];
    engine.topicRouter = new TopicContractRouter({ id: "run", version: 13, topics }, { telemetry: store });
    engine.candidateOutputRuntime = new CandidateOutputRuntime({ telemetry: store, manifest: { topics }, transformRuntime: {
        frames: { map: "map", baseLink: "base_link" },
        lookupTransformChain() { return { ok: true, transforms: [{ position: { x: 100, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }] }; },
    } });
    const routed = engine.topicRouter.routeInbound({ name: "planning-path", value: { points: [{ x: 0, y: 0, z: 1 }, { x: 4, y: 1, z: 2 }] }, metadata: { frameId: "base_link", captureTimeNs: 0, sequenceId: "18446744073709551615" } }, { applyTimeNs: 0 });
    engine.candidateOutputRuntime.ingestRouted(routed);
    const canonicalPath = structuredClone(engine.candidateOutputRuntime.lastPath);
    engine._updatePresentationAfterStep(0); engine.render();
    const tool = engine.visualizationManager.tools.plannedTrajectory;
    assert.equal(tool.inputs.vehicleRelative, true);
    assert.deepEqual(tool.points, [{ x: 0, y: 1, z: 0 }, { x: 4, y: 2, z: -1 }]);
    assert.equal(tool.metadata.sequenceId, "18446744073709551615");
    const attribute = tool.line.geometry.getAttribute("position");
    const version = attribute.version;
    ego.position.set(10, 3, 2);
    engine._updatePresentationAfterStep(0); engine.render();
    assert.equal(tool.group.position.x, 10);
    assert.equal(tool.group.position.y, 3);
    assert.equal(attribute.version, version);
    assert.deepEqual(engine.candidateOutputRuntime.lastPath, canonicalPath);
    engine.candidateOutputRuntime = null;
    engine._updatePresentationAfterStep(0); engine.render();
    assert.equal(tool.line.visible, false);
    engine.dispose();
});

test("independent planned and past bindings survive live facade updates", () => {
    const { engine } = engineFixture();
    let emit;
    engine.visualizationManager.setSource({ subscribe(_bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    engine.configureVisualizations({ plannedTrajectory: { data: [{ id: "independent-path", kind: "zenoh" }], pose: [{ id: "independent-pose", kind: "zenoh" }] }, trajectoryPast: { pose: [{ id: "independent-pose", kind: "zenoh" }] } });
    emit({ type: "data", bindingId: "independent-path", inputs: { points: [{ x: 0, z: 0 }, { x: 5, z: 0 }], vehicleRelative: true } });
    emit({ type: "pose", bindingId: "independent-pose", pose: pose(20, 3), metadata: { captureTimeNs: 0 } });
    emit({ type: "pose", bindingId: "independent-pose", pose: pose(21, 4), metadata: { captureTimeNs: 1 } });
    emit({ type: "clock", timeNs: 1 });
    engine._updatePresentationAfterStep(0.1); engine.render();
    assert.equal(engine.visualizationManager.tools.plannedTrajectory.group.position.x, 21);
    assert.deepEqual(engine.visualizationManager.tools.trajectoryPast.history.get("ego").map((point) => point.x), [20, 21]);
    engine.dispose();
});

test("ambiguous admitted path producers with identical sample metadata retain the latest normalized world path", () => {
    const { engine, ego, store } = engineFixture();
    const first = topicFromNativeContract("planning-path");
    const second = { ...first, id: "second-path", contractId: "second-path", name: "second-path" };
    const topics = [first, second];
    engine.topicRouter = new TopicContractRouter({ id: "run", version: 13, topics }, { telemetry: store });
    engine.candidateOutputRuntime = new CandidateOutputRuntime({ telemetry: store, manifest: { topics }, transformRuntime: {
        frames: { map: "map", baseLink: "base_link" },
        lookupTransformChain() { return { ok: true, transforms: [{ position: { x: 100, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }] }; },
    } });
    const metadata = { frameId: "base_link", captureTimeNs: 0, sequenceId: "0" };
    for (const [index, topic] of topics.entries()) {
        const routed = engine.topicRouter.routeInbound({ name: topic.id, value: { points: [{ x: index * 20, y: 0, z: 1 }, { x: index * 20 + 4, y: 1, z: 2 }] }, metadata }, { applyTimeNs: 0 });
        assert.equal(routed.ok, true);
        engine.candidateOutputRuntime.ingestRouted(routed);
    }
    assert.equal(engine.topicRouter.lastProducer.size, 2);
    const normalized = structuredClone(engine.candidateOutputRuntime.lastPath);
    ego.position.set(50, 3, 2);
    engine._updatePresentationAfterStep(0); engine.render();
    const tool = engine.visualizationManager.tools.plannedTrajectory;
    assert.equal(tool.inputs.vehicleRelative, false);
    assert.equal(tool.group.position.x, 0);
    assert.deepEqual(tool.points, normalized.points.map((point) => point.three));
    assert.equal(tool.points[0].x, 120);
    assert.deepEqual(engine.candidateOutputRuntime.lastPath, normalized);
    engine.dispose();
});
