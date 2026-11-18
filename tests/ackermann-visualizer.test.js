import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";
import { AckermannVisualizer, controlsSnapshotInputs } from "../app/visualization/visualizers/AckermannVisualizer.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";
import { AutonomyOverlay, AUTONOMY_OVERLAY_LAYER } from "../app/3d/overlay/AutonomyOverlay.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { buildPlanViewFrame, planViewSourcesFromData } from "../app/spatial/planview/frame.js";
import { listPlanLayers } from "../app/spatial/planview/registry.js";
import "../app/spatial/planview/layers/controls.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

const pose = (x = 0, yaw = 0) => ({ position: { x, y: 2, z: 3 }, rotation: { x: 0, y: yaw, z: 0, order: "XYZ" } });
const tick = () => Promise.resolve();

function fixture() {
    const tool = new AckermannVisualizer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    let emit;
    let requests = 0;
    const manager = new VisualizationManager({ tools: { ackermann: tool }, sceneContext: { scene, camera }, requestFlush: () => { requests += 1; return () => {}; } });
    manager.configure({ ackermann: { data: [{ id: "controls" }], pose: [{ id: "pose" }], predictedPath: true } });
    manager.setSource({ subscribe(_bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    manager.flush();
    return { tool, manager, scene, camera, requests: () => requests,
        data: (inputs, revision) => emit({ type: "data", bindingId: "controls", inputs, revision }),
        move: (value, revision) => emit({ type: "pose", bindingId: "pose", pose: value, revision }),
    };
}

function engineFixture({ wheelbase = 3.2 } = {}) {
    const store = new SignalStore({}, { sourceId: "ackermann-test" });
    const vehicle = {
        telemetryId: "ego",
        manifest: { kinematics: wheelbase == null ? {} : { wheelbase } },
        position: new THREE.Vector3(), rotation: new THREE.Euler(), velocity: new THREE.Vector3(1, 0, 0),
        steeringAngle: 0.1, displaySteeringAngle: 0.2, controlsEnabled: true,
        updatePosition() {}, updateRotation() {},
        update(dt) { this.position.x += dt; },
    };
    const vehicles = { vehicles: [vehicle], update(dt) { vehicle.update(dt); }, configureFromManifest() {} };
    const bindings = { signalStore: store, manifest: { enabled: false, bindings: [] }, update() {} };
    const data = {
        bindings: () => bindings, vehicles: () => vehicles,
        devices: () => ({ configureFromManifest() {}, resetSchedule() {}, update() {}, deliver() {} }),
        physics: () => ({ configureRun() {}, resetRun() {}, step() {}, syncAndPublishContacts() {} }),
        keys: () => null, client: () => null, baking: () => null,
    };
    const engine = new SimulationEngine(data, { packetRelay: null });
    data.simulation = () => engine;
    engine.setModule("assertions", false);
    const beforePresentation = { state: engine.kernel.getCanonicalState(), hashes: [engine.simulationSemanticHash, engine.episodeHash, engine.trajectoryHash] };
    engine.configure({ scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: null });
    engine.render();
    return { engine, data, vehicle, store, beforePresentation, tool: engine.visualizationManager.tools.ackermann };
}

test("Ackermann waits for steering, accepts zero, and retains valid data on malformed samples", () => {
    const { manager, tool, data } = fixture();
    assert.equal(tool.ready, false);
    data({ velocity: 0 }); manager.flush();
    assert.equal(manager.getSnapshot().tools.ackermann.status, "waiting");
    assert.equal(tool.meshes[0], null);
    data({ steeringRad: 0 }); manager.flush();
    assert.equal(tool.ready, true);
    assert.equal(tool.inputs.wheelbase, 1.5);
    assert.ok(Math.abs(tool.arcs[0].points.at(-1).x - 7) < 1e-10);
    assert.equal(tool.arcs[0].points.at(-1).z, 0);
    const valid = tool.inputs;
    for (const inputs of [{ steeringRad: NaN }, { wheelbase: 0 }, { achievedSteeringRad: Infinity }, { flags: { timedOut: "yes" } }, { velocity: Infinity }]) {
        data(inputs); manager.flush();
        assert.equal(tool.inputs, valid);
        assert.equal(manager.getMapSnapshot().tools.ackermann.status, "error");
    }
    manager.dispose();
});

test("scene and map share positive-left centerlines, actual wheelbase, colors, and full pose placement", () => {
    const { manager, tool, camera, data, move } = fixture();
    data({ steeringRad: 0.2, achievedSteeringRad: 0.1, wheelbase: 3.4 });
    const vehiclePose = pose(5, 0.4);
    vehiclePose.rotation.z = 0.15;
    move(vehiclePose); manager.flush();
    assert.equal(tool.arcs[0].points.length, 21);
    assert.equal(tool.arcs[0].wheelbase, 3.4);
    assert.ok(tool.arcs[0].points.at(-1).z < 0);
    const map = manager.getMapSnapshot().tools.ackermann.output.primitives;
    assert.deepEqual(map.map((entry) => entry.stroke), ["#a78bfa", "#22d3ee"]);
    assert.equal(tool.meshes[0].material.color.getHex(), 0xa78bfa);
    assert.equal(tool.meshes[1].material.color.getHex(), 0x22d3ee);
    tool.group.updateMatrixWorld(true);
    for (let index = 0; index < 21; index += 1) {
        const attr = tool.meshes[0].geometry.getAttribute("position");
        const center = new THREE.Vector3().fromBufferAttribute(attr, index * 2).add(new THREE.Vector3().fromBufferAttribute(attr, index * 2 + 1)).multiplyScalar(0.5).applyMatrix4(tool.group.matrixWorld);
        assert.ok(Math.abs(center.x - map[0].points[index].x) < 1e-6);
        assert.ok(Math.abs(center.z - map[0].points[index].z) < 1e-6);
    }
    assert.equal(camera.layers.isEnabled(AUTONOMY_OVERLAY_LAYER), true);
    for (const mesh of tool.meshes) {
        assert.equal(mesh.layers.isEnabled(AUTONOMY_OVERLAY_LAYER), true);
        assert.equal(mesh.layers.isEnabled(0), false);
        const intersections = [];
        mesh.raycast({}, intersections);
        assert.deepEqual(intersections, []);
    }
    manager.dispose();
});

test("pose-only and badge-only updates never rebuild either ribbon", () => {
    const { manager, tool, data, move } = fixture();
    data({ steeringRad: 0.2, achievedSteeringRad: 0.1 }); manager.flush();
    const arcs = [...tool.arcs];
    const versions = tool.meshes.map((mesh) => mesh.geometry.getAttribute("position").version);
    for (let index = 1; index <= 40; index += 1) move(pose(index, index / 100), index);
    manager.flush();
    assert.deepEqual(tool.arcs, arcs);
    assert.deepEqual(tool.meshes.map((mesh) => mesh.geometry.getAttribute("position").version), versions);
    data({ flags: { timedOut: true, saturated: true, fallbackActive: true, rateLimited: true }, velocity: 0 }); manager.flush();
    assert.equal(tool.badge.userData.badgeLabel, "TIMEOUT · SAT · FALLBACK · RATE");
    assert.equal(tool.badge.userData.badgeColor, 0xfb7185);
    assert.equal(manager.getMapSnapshot().tools.ackermann.output.primitives.at(-1).text, tool.badge.userData.badgeLabel);
    assert.deepEqual(tool.meshes.map((mesh) => mesh.geometry.getAttribute("position").version), versions);
    const badge = tool.badge;
    data({ flags: { timedOut: true, saturated: true, fallbackActive: true, rateLimited: true } }); manager.flush();
    assert.equal(tool.badge, badge);
    data({ flags: { saturated: true } }); manager.flush();
    assert.equal(tool.badge.userData.badgeColor, 0xf59e0b);
    data({ flags: {} }); manager.flush();
    assert.equal(tool.badge.visible, false);
    data({ commanded: false, achievedSteeringRad: null }); manager.flush();
    assert.equal(tool.meshes.some((mesh) => mesh?.visible), false);
    data({ commanded: true, achievedSteeringRad: 0.1 }); manager.flush();
    assert.deepEqual(tool.meshes.map((mesh) => mesh.geometry.getAttribute("position").version), versions);
    data({ achievedSteeringRad: 0.3 }); manager.flush();
    assert.equal(tool.meshes[0].geometry.getAttribute("position").version, versions[0]);
    assert.equal(tool.meshes[1].geometry.getAttribute("position").version, versions[1] + 1);
    data({ wheelbase: 4 }); manager.flush();
    assert.equal(tool.meshes[0].geometry.getAttribute("position").version, versions[0] + 1);
    assert.equal(tool.meshes[1].geometry.getAttribute("position").version, versions[1] + 2);
    manager.dispose();
});

test("bursts build only the latest geometry once and cache both map getter and layer output", () => {
    const { manager, tool, data, move, requests } = fixture();
    const initialRequests = requests();
    for (let index = 0; index < 100; index += 1) {
        data({ steeringRad: index / 1000, wheelbase: 2.5 }, index);
        move(pose(index), index);
    }
    assert.equal(requests(), initialRequests + 1);
    assert.equal(tool.meshes[0], null);
    assert.equal(tool.arcs[0], null);
    manager.flush();
    assert.equal(tool.getTimings().display.count, 1);
    assert.equal(tool.getTimings().displayMap.count, 1);
    assert.equal(tool.meshes[0].geometry.getAttribute("position").version, 1);
    assert.equal(tool.arcs[0].steeringRad, 0.099);
    const snapshot = manager.getMapSnapshot();
    const frame = buildPlanViewFrame({ visualizationMap: snapshot, controlsById: { ego: { applied: { steeringRad: -1 } } } });
    assert.equal(frame.visualizationMap, snapshot);
    const layer = listPlanLayers().find((layer) => layer.id === "controls");
    assert.equal(layer.project(frame), snapshot.tools.ackermann.output.primitives);
    assert.equal(layer.project(frame), layer.project(frame));
    manager.flush();
    assert.equal(manager.getMapSnapshot(), snapshot);
    manager.dispose();
});

test("perspective hiding affects scene only and does not override independent map visibility", () => {
    const { manager, tool, data } = fixture();
    data({ steeringRad: 0.2 }); manager.flush();
    const map = manager.getMapSnapshot();
    manager.setPredictedPathHidden(true); manager.flush();
    assert.equal(tool.group.visible, false);
    assert.equal(tool.meshes[0].visible, false);
    assert.equal(manager.getMapSnapshot(), map);
    manager.setVisible("ackermann", "map", false); manager.flush();
    assert.deepEqual(listPlanLayers().find((layer) => layer.id === "controls").project({ visualizationMap: manager.getMapSnapshot() }), []);
    manager.setPredictedPathHidden(false); manager.flush();
    assert.equal(tool.group.visible, true);
    assert.equal(manager.getMapSnapshot().tools.ackermann.visible, false);
    manager.setVisible("ackermann", "scene", false);
    manager.setPredictedPathHidden(true); manager.setPredictedPathHidden(false); manager.flush();
    assert.equal(tool.group.visible, false);
    manager.dispose();
});

test("standalone replay controls delegate to one tool with immediate display, clearing, and stable buffers", () => {
    const overlay = new AutonomyOverlay();
    const tool = overlay.visualizationManager.tools.ackermann;
    const snapshot = { applied: { steeringRad: 0.2 }, achieved: { steeringRad: 0.1 }, wheelbase: 4, flags: { fallbackActive: true } };
    overlay.updateFromSnapshot({ controls: snapshot, vehiclePose: pose(1) });
    assert.equal(overlay._controls, tool.group);
    assert.equal(tool.meshes.filter(Boolean).length, 2);
    assert.equal(tool.inputs.wheelbase, 4);
    const geometry = tool.meshes[0].geometry;
    const version = geometry.getAttribute("position").version;
    overlay.updateFromSnapshot({ controls: snapshot, vehiclePose: pose(8) });
    assert.equal(tool.group.position.x, 8);
    assert.equal(tool.meshes[0].geometry, geometry);
    assert.equal(geometry.getAttribute("position").version, version);
    overlay.updateFromSnapshot({});
    assert.equal(tool.meshes.some((mesh) => mesh?.visible), false);
    overlay.updateFromSnapshot({ controls: snapshot });
    overlay.updateFromSnapshot({ controls: { applied: null, achieved: null } });
    assert.equal(tool.meshes.some((mesh) => mesh?.visible), false);
    overlay.clear();
    assert.equal(tool.ready, false);
    overlay.updateFromRuntime({}, null, { controlRuntime: { getSnapshot: () => snapshot }, vehiclePose: pose(2) });
    assert.equal(tool.group.position.x, 2);
    assert.equal(tool.meshes[0].geometry, geometry);
    overlay.dispose();
    assert.equal(tool.disposed, true);
});

test("replay snapshots preserve available control and pose metadata independently", () => {
    const overlay = new AutonomyOverlay();
    const sequenceId = "18446744073709551615";
    const controls = { applied: { steeringRad: 0 }, runId: "controls-run", captureTimeNs: 0, sequenceId, frameId: "controls-frame", metadata: { note: "controls" } };
    const vehiclePose = { ...pose(), metadata: { runId: "pose-run", captureTimeNs: 4, sequenceId: 0, frameId: "pose-frame", note: "pose" } };
    overlay.updateFromSnapshot({ controls, vehiclePose });
    const entry = overlay.visualizationManager.getMapSnapshot().tools.ackermann;
    assert.deepEqual(entry.metadata, { note: "controls", runId: "controls-run", captureTimeNs: 0, sequenceId, frameId: "controls-frame" });
    assert.deepEqual(entry.poseMetadata, vehiclePose.metadata);
    overlay.updateFromSnapshot({ controls: { applied: { steeringRad: 0 }, sequence: 0 } });
    const next = overlay.visualizationManager.getMapSnapshot().tools.ackermann;
    assert.deepEqual(next.metadata, { sequenceId: 0 });
    assert.deepEqual(next.poseMetadata, {});
    overlay.dispose();
});

test("engine default controls use real playground wheelbase and shared facade coalesces step bursts", () => {
    const { engine, data, vehicle, tool, beforePresentation } = engineFixture();
    assert.equal(engine.steps, 0);
    assert.equal(engine.timeNs, 0);
    assert.deepEqual(engine.kernel.getCanonicalState(), beforePresentation.state);
    assert.deepEqual([engine.simulationSemanticHash, engine.episodeHash, engine.trajectoryHash], beforePresentation.hashes);
    assert.equal(tool.inputs.wheelbase, 3.2);
    assert.equal(tool.inputs.steeringRad, 0.2);
    assert.equal(tool.inputs.achievedSteeringRad, 0.1);
    assert.equal(engine.autonomyOverlay.visualizationManager, engine.visualizationManager);
    assert.equal(engine.autonomyOverlay._controls, tool.group);
    assert.equal(planViewSourcesFromData(data).visualizationMap, engine.visualizationManager.getMapSnapshot());
    const firstVersion = tool.meshes[0].geometry.getAttribute("position").version;
    const displays = tool.getTimings().display.count;
    vehicle.update = function update(dt) { this.position.x += dt; this.displaySteeringAngle += 0.01; };
    engine.step(8);
    assert.equal(tool.getTimings().display.count, displays + 1);
    assert.equal(tool.meshes[0].geometry.getAttribute("position").version, firstVersion + 1);
    assert.ok(Math.abs(tool.inputs.steeringRad - 0.28) < 1e-10);
    assert.equal(tool.group.position.x, vehicle.position.x);
    vehicle.controlsEnabled = false;
    engine.step();
    assert.equal(tool.meshes.some((mesh) => mesh?.visible), false);
    engine.configureVisualizations({ ackermann: { ...engine._visualizationBindings.ackermann, visible: { scene: false, map: true } } });
    vehicle.controlsEnabled = true;
    engine.step();
    assert.equal(tool.group.visible, false);
    assert.equal(engine.visualizationManager.getMapSnapshot().tools.ackermann.visible, true);
    engine.setAutonomyOverlayEnabled({ controls: true });
    assert.equal(tool.group.visible, true);
    engine.dispose();
});

test("playground wheelbase fallback is 1.5 only when unavailable", () => {
    const { engine, tool } = engineFixture({ wheelbase: null });
    assert.equal(tool.inputs.wheelbase, 1.5);
    engine.dispose();
});

test("resolved controls supply the target vehicle wheelbase without estimating from body dimensions", async () => {
    const { engine, tool } = engineFixture();
    const manifest = createDefaultRunManifest({ version: 13, sensorRig: { sensors: [] }, assertions: [] });
    await engine.applyRunManifest({ manifest, definitionHash: "a".repeat(64), resolvedHash: "b".repeat(64),
        environment: { manifest: { environmentId: manifest.environment.id } }, bindings: { entries: [] },
        vehicles: [{ actorId: "ego", manifest: { kinematics: { wheelbase: 4.25 } } }],
    });
    const initialState = engine.kernel.getCanonicalState();
    const hashes = [engine.simulationSemanticHash, engine.episodeHash, engine.trajectoryHash];
    engine._bindLiveVisualizationSource();
    engine.render();
    assert.equal(engine.steps, 0);
    assert.equal(tool.inputs.wheelbase, 4.25);
    assert.deepEqual(engine.kernel.getCanonicalState(), initialState);
    assert.deepEqual([engine.simulationSemanticHash, engine.episodeHash, engine.trajectoryHash], hashes);
    engine.step();
    assert.equal(tool.inputs.wheelbase, 4.25);
    engine.dispose();
});

test("an explicit independent binding is never overwritten by the engine's runtime facade", () => {
    const { engine, tool } = engineFixture();
    let emit;
    engine.visualizationManager.setSource({ subscribe(_bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    engine.configureVisualizations({ ackermann: { data: [{ id: "independent", kind: "zenoh" }], pose: [{ id: "external-pose", kind: "zenoh" }], predictedPath: true } });
    emit({ type: "data", bindingId: "independent", inputs: { steeringRad: -0.3, wheelbase: 5 } });
    emit({ type: "pose", bindingId: "external-pose", pose: pose(20) });
    engine.controlRuntime = { getSnapshot() { throw new Error("The live facade must not read controls for an independent display."); } };
    engine._updatePresentationAfterStep(0.1);
    engine.render();
    assert.equal(tool.inputs.steeringRad, -0.3);
    assert.equal(tool.inputs.wheelbase, 5);
    assert.equal(tool.group.position.x, 20);
    assert.equal(tool.getTimings().display.count, 2);
    engine.controlRuntime = null;
    engine.dispose();
});

test("ego presentation never creates or updates a vehicle-owned ribbon", async () => {
    await import("../app/3d/data/VehicleDatabase.js");
    const { attachEgoPresentation, updateEgoPresentation } = await import("../app/3d/vehicles/EgoPresentation.js");
    const vehicle = { sceneObject: new THREE.Group(), position: new THREE.Vector3(), rotation: new THREE.Euler() };
    attachEgoPresentation(vehicle);
    assert.equal(vehicle.path, undefined);
    assert.equal(vehicle.renderPath, undefined);
    assert.equal(vehicle.sceneObject.children.length, 0);
    updateEgoPresentation(vehicle, 0.1);
    vehicle.disableControls();
    assert.equal(vehicle.sceneObject.children.length, 0);
});

test("reset reuses ribbons and disposal releases each owned geometry and material once", async () => {
    const { manager, tool, data } = fixture();
    data({ steeringRad: 0.2, achievedSteeringRad: 0.1 }); manager.flush();
    const meshes = [...tool.meshes];
    const disposed = [0, 0];
    const materials = [0, 0];
    meshes.forEach((mesh, index) => {
        mesh.geometry.addEventListener("dispose", () => { disposed[index] += 1; });
        mesh.material.addEventListener("dispose", () => { materials[index] += 1; });
    });
    manager.reset();
    assert.equal(tool.group.visible, false);
    assert.equal(tool.ready, false);
    data({ steeringRad: 0, achievedSteeringRad: 0 }); manager.flush();
    assert.deepEqual(tool.meshes, meshes);
    manager.dispose(); manager.dispose();
    await tick();
    assert.deepEqual(disposed, [1, 1]);
    assert.deepEqual(materials, [1, 1]);
    assert.equal(tool.group.parent, null);
});
