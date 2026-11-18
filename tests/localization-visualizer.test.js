import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";
import { LocalizationVisualizer, localizationSnapshotInputs } from "../app/visualization/visualizers/LocalizationVisualizer.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";
import { AutonomyOverlay, AUTONOMY_OVERLAY_LAYER } from "../app/3d/overlay/AutonomyOverlay.js";
import { eulerToQuaternion } from "../app/autonomy/CoordinateFrames.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { buildPlanViewFrame } from "../app/spatial/planview/frame.js";
import { listPlanLayers } from "../app/spatial/planview/registry.js";
import "../app/spatial/planview/layers/index.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

const position = (x = 0, y = 0, z = 0) => ({ x, y, z });
const sample = (x = 0) => ({ position: position(x, 0.4, -2), covarianceEllipse: { sigmaX: 0.2, sigmaY: 0.4 }, truthPosition: position(x + 1, 0.8, -3), error: { positionM: 1 } });

function fixture(options = {}) {
    const tool = new LocalizationVisualizer(options);
    let emit;
    let requests = 0;
    const scene = new THREE.Scene();
    const manager = new VisualizationManager({ tools: { localization: tool }, sceneContext: { scene, camera: new THREE.PerspectiveCamera() }, requestFlush: () => { requests += 1; return () => {}; } });
    manager.configure({ localization: { data: [{ id: "estimate" }] } });
    manager.setSource({ subscribe(_bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    manager.flush();
    return { tool, manager, scene, emit, requests: () => requests, data: (inputs, metadata = {}) => emit({ type: "data", bindingId: "estimate", inputs, metadata }) };
}

function engineFixture() {
    const store = new SignalStore();
    const vehicle = { telemetryId: "ego", position: new THREE.Vector3(50, 0, 0), rotation: new THREE.Euler(), velocity: new THREE.Vector3(), updatePosition() {}, updateRotation() {}, update() {} };
    const vehicles = { vehicles: [vehicle], update() {}, configureFromManifest() {} };
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
    return { engine, vehicle, store, tool: engine.visualizationManager.tools.localization };
}

test("localization requires a position, accepts zero, defaults orientation, and omits unavailable products", () => {
    const f = fixture();
    assert.equal(f.manager.getSnapshot().tools.localization.status, "waiting");
    assert.equal(f.tool.markers.children.length, 0);
    f.data({ position: position() }); f.manager.flush();
    assert.deepEqual(f.tool.inputs.orientation, { x: 0, y: 0, z: 0, w: 1 });
    assert.equal(f.tool.ghost.position.y, 0.35);
    assert.equal(f.tool.ellipse, null);
    assert.equal(f.tool.errorLine, null);
    assert.equal(f.manager.getMapSnapshot().tools.localization.output.primitives.length, 1);
    f.manager.dispose();
});

test("malformed samples retain accepted localization and render error status without changing geometry", () => {
    const f = fixture();
    f.data({ ...sample(), active: true }); f.manager.flush();
    const accepted = f.tool.inputs;
    const ellipseVersion = f.tool.ellipse.geometry.getAttribute("position").version;
    const errorVersion = f.tool.errorLine.geometry.getAttribute("position").version;
    for (const invalid of [{ position: position(NaN) }, { orientation: { w: 0 } }, { orientation: { x: Infinity } }, { covarianceEllipse: { sigmaX: -1, sigmaY: 2 } }, { truthPosition: position(Infinity) }, { ageNs: -1 }]) {
        f.data(invalid); f.manager.flush();
        assert.equal(f.tool.inputs, accepted);
        assert.equal(f.manager.getSnapshot().tools.localization.status, "error");
        assert.equal(f.tool.ghost.material.color.getHex(), 0xfb7185);
        assert.match(f.tool.badge.userData.badgeLabel, /^error /);
        assert.equal(f.tool.ellipse.geometry.getAttribute("position").version, ellipseVersion);
        assert.equal(f.tool.errorLine.geometry.getAttribute("position").version, errorVersion);
    }
    f.manager.dispose();
});

test("status-only events redraw colors and badges while covariance and error buffers stay intact", () => {
    const f = fixture();
    f.data({ ...sample(), ageNs: 12_000_000 }); f.manager.flush();
    const ellipse = f.tool.ellipse.geometry.getAttribute("position");
    const error = f.tool.errorLine.geometry.getAttribute("position");
    const versions = [ellipse.version, error.version];
    const covariance = f.manager.getMapSnapshot().tools.localization.output.primitives[2].points;
    for (const [status, color] of [["stale", 0xf59e0b], ["missing-frame", 0xfb7185], ["error", 0xfb7185]]) {
        f.emit({ type: "status", bindingId: "estimate", status, message: "display failure" }); f.manager.flush();
        assert.equal(f.tool.ghost.material.color.getHex(), color);
        assert.equal(f.tool.badge.userData.badgeLabel, `${status} 12ms`);
        assert.deepEqual([ellipse.version, error.version], versions);
        const output = f.manager.getMapSnapshot().tools.localization.output;
        assert.equal(output.primitives[2].points, covariance);
        assert.equal(output.primitives.at(-1).text, f.tool.badge.userData.badgeLabel);
    }
    f.manager.dispose();
});

test("estimate transforms and covariance/error geometry update independently and bursts coalesce", () => {
    const f = fixture();
    f.data(sample()); f.manager.flush();
    const ellipse = f.tool.ellipse.geometry.getAttribute("position");
    const error = f.tool.errorLine.geometry.getAttribute("position");
    const versions = [ellipse.version, error.version];
    const requests = f.requests();
    for (let index = 1; index <= 10; index += 1) f.data({ ...sample(index), orientation: eulerToQuaternion({ y: index / 10 }) });
    assert.equal(f.requests(), requests + 1);
    f.manager.flush();
    assert.equal(f.tool.ghost.position.x, 10);
    assert.equal(f.tool.errorLine.position.x, 10);
    assert.deepEqual([ellipse.version, error.version], versions);
    f.data({ covarianceEllipse: { sigmaX: 0.5, sigmaY: 0.4 } }); f.manager.flush();
    assert.equal(ellipse.version, versions[0] + 1);
    assert.equal(error.version, versions[1]);
    f.data({ truthPosition: position(12, 0.8, -3) }); f.manager.flush();
    assert.equal(ellipse.version, versions[0] + 1);
    assert.equal(error.version, versions[1] + 1);
    f.data({ covarianceEllipse: null, truthPosition: null, error: null }); f.manager.flush();
    assert.equal(f.tool.ellipse.visible, false);
    assert.equal(f.tool.errorLine.visible, false);
    f.manager.dispose();
});

test("owned appearance becomes available once, follows estimates, and preserves fallback and visibility", () => {
    let ready = false;
    let calls = 0;
    const f = fixture({ createAppearanceClone() { calls += 1; return ready ? new THREE.Group() : null; } });
    f.data(sample()); f.manager.flush();
    assert.equal(f.tool.clone, null);
    assert.equal(f.tool.ghost.visible, true);
    ready = true;
    f.data({ ...sample(1), orientation: eulerToQuaternion({ y: 0.5 }) }); f.manager.flush();
    const clone = f.tool.clone;
    assert.equal(calls, 2);
    assert.equal(clone.parent, f.tool.group);
    assert.equal(clone.position.x, 1);
    assert.ok(Math.abs(clone.rotation.y - 0.5) < 1e-9);
    assert.equal(f.tool.ghost.visible, false);
    f.data(sample(2)); f.manager.flush();
    assert.equal(f.tool.clone, clone);
    assert.equal(calls, 2);
    f.manager.setLayerVisible("localization", "estimateClone", "scene", false); f.manager.flush();
    assert.equal(clone.visible, false);
    assert.equal(f.tool.ghost.visible, true);
    f.manager.setLayerVisible("localization", "estimateClone", "scene", true); f.manager.flush();
    assert.equal(clone.visible, true);
    f.manager.setVisible("localization", "scene", false); f.manager.flush();
    assert.equal(clone.visible, false);
    assert.equal(f.manager.getMapSnapshot().tools.localization.visible, true);
    f.manager.setVisible("localization", "scene", true); f.manager.flush();
    assert.equal(clone.visible, true);
    f.data({ active: false }); f.manager.flush();
    assert.equal(f.tool.group.visible, false);
    assert.equal(clone.visible, false);
    assert.deepEqual(f.manager.getMapSnapshot().tools.localization.output.primitives, []);
    f.data({ ...sample(), active: true }); f.manager.flush();
    assert.equal(f.tool.clone, clone);
    assert.equal(clone.position.x, 0);
    f.manager.reset();
    assert.equal(f.tool.clone, null);
    assert.equal(clone.parent, null);
    f.manager.dispose();
});

test("appearance factory failures show an error fallback and do not escape presentation", () => {
    const f = fixture({ createAppearanceClone() { throw new Error("appearance unavailable"); } });
    f.data(sample());
    assert.doesNotThrow(() => f.manager.flush());
    assert.equal(f.tool.clone, null);
    assert.equal(f.tool.ghost.visible, true);
    assert.equal(f.tool.ghost.material.color.getHex(), 0xfb7185);
    assert.equal(f.manager.getSnapshot().tools.localization.message, "appearance unavailable");
    f.manager.dispose();
});

test("independent internal quaternions preserve all axes while native snapshots project REP103 at the boundary", () => {
    const f = fixture({ createAppearanceClone: () => new THREE.Group() });
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.4, -0.3));
    f.data({ position: position(), orientation: { x: expected.x, y: expected.y, z: expected.z, w: expected.w } },
        { frameId: "external-scene", sequenceId: "18446744073709551615" });
    f.manager.flush();
    assert.ok(f.tool.clone.quaternion.angleTo(expected) < 1e-7);
    assert.equal(f.manager.getMapSnapshot().tools.localization.metadata.frameId, "external-scene");
    const nativeOrientation = eulerToQuaternion({ z: 0.5 });
    const metadata = {};
    const projected = localizationSnapshotInputs({ estimate: { position: { x: 1, y: 2, z: 3 },
        orientation: nativeOrientation, frameId: "map", sequenceId: "18446744073709551615" } }, metadata);
    assert.deepEqual(projected.position, position(1, 3, -2));
    assert.ok(Math.abs(projected.orientation.y - 0.5) < 1e-9);
    assert.equal(projected.orientation.z, 0);
    f.data(projected, metadata); f.manager.flush();
    assert.ok(Math.abs(f.tool.clone.rotation.y - 0.5) < 1e-9);
    assert.equal(metadata.frameId, "map");
    assert.equal(metadata.sequenceId, "18446744073709551615");
    assert.equal(nativeOrientation.y, 0);
    f.manager.dispose();
});

test("disposing ManifestVehicle appearance leaves source geometry and materials intact", async () => {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const { ManifestVehicle } = await import("../app/3d/vehicles/ManifestVehicle.js");
    const vehicle = new ManifestVehicle(new VehicleDatabase({ devices: () => ({ addDevice() {} }), bindings: () => null, scene: null }), createDefaultVehicleManifest({ id: "localization-source", sensors: [], lidarZone: { vertices: [], triangles: [] } }), new THREE.Vector3(), new THREE.Euler(), { skipManifestDevices: true });
    await vehicle.addToScene({ add() {} });
    let sourceDisposals = 0;
    vehicle.sceneObject.traverse((node) => {
        node.geometry?.addEventListener("dispose", () => { sourceDisposals += 1; });
        node.material?.addEventListener("dispose", () => { sourceDisposals += 1; });
    });
    const f = fixture({ createAppearanceClone: () => vehicle.cloneVisualBody() });
    f.data(sample()); f.manager.flush();
    const clone = f.tool.clone;
    let ownedDisposals = 0;
    clone.traverse((node) => {
        node.geometry?.addEventListener("dispose", () => { ownedDisposals += 1; });
        assert.equal(node.layers.isEnabled(AUTONOMY_OVERLAY_LAYER), true);
        assert.deepEqual(node.raycast({}, []), undefined);
    });
    f.manager.dispose();
    assert.ok(ownedDisposals > 0);
    assert.equal(sourceDisposals, 0);
    assert.equal(clone.parent, null);
    vehicle.dispose();
});

test("replay localization preserves capture zero and exact sequence metadata and uses capture-time truth", () => {
    const overlay = new AutonomyOverlay();
    const localization = { estimate: { position: { x: 2, y: -3, z: 0.4 }, captureTimeNs: 0, sequenceId: "18446744073709551615", frameId: "map", metadata: { calibrationId: "pinned" } }, truth: { threePosition: position(1, 0.4, 3) }, error: { positionM: 1 }, status: "missing-frame", ageNs: 15_000_000, runId: "replay" };
    overlay.updateFromSnapshot({ localization, vehiclePose: { position: position(100) } });
    const tool = overlay.visualizationManager.tools.localization;
    const entry = overlay.visualizationManager.getMapSnapshot().tools.localization;
    assert.deepEqual(tool.inputs.position, position(2, 0.4, 3));
    assert.deepEqual(entry.metadata, { calibrationId: "pinned", runId: "replay", captureTimeNs: 0, sequenceId: "18446744073709551615", frameId: "map" });
    assert.equal(entry.output.primitives[0].points[0].x, 1);
    assert.equal(tool.badge.userData.badgeLabel, "missing-frame 15ms");
    const layer = listPlanLayers().find((entry) => entry.id === "localization");
    assert.equal(layer.project(buildPlanViewFrame({ visualizationMap: overlay.visualizationManager.getMapSnapshot() })), entry.output.primitives);
    overlay.updateFromSnapshot({});
    assert.equal(tool.group.visible, false);
    assert.deepEqual(overlay.visualizationManager.getMapSnapshot().tools.localization.output.primitives, []);
    overlay.dispose();
});

test("engine localization listens after completed state and keeps captured truth, metadata, and canonical state", () => {
    const f = engineFixture();
    const canonical = f.engine.kernel.getCanonicalState();
    const localization = { estimate: { threePosition: position(2), captureTimeNs: 0, sequenceId: "9007199254740993", frameId: "map" }, truth: { threePosition: position(1) }, error: { positionM: 1 }, status: "ok", ageNs: 0 };
    f.engine.candidateOutputRuntime = { lastLocalization: localization };
    f.store.publishSignal("visualization.localization.status", { status: "ok", captureTimeNs: 0 });
    f.engine.render();
    assert.equal(f.tool.ready, false);
    f.engine._updatePresentationAfterStep(0); f.engine.render();
    assert.equal(f.tool.inputs.truthPosition.x, 1);
    assert.equal(f.tool.ghost.position.x, 2);
    const metadata = f.engine.visualizationManager.getMapSnapshot().tools.localization.metadata;
    assert.equal(metadata.captureTimeNs, 0);
    assert.equal(metadata.sequenceId, "9007199254740993");
    assert.equal(metadata.frameId, "map");
    assert.deepEqual(f.engine.kernel.getCanonicalState(), canonical);
    f.engine.dispose();
});

test("shared live facade never overwrites independently bound localization or forces a flush", () => {
    const f = engineFixture();
    let emit;
    f.engine.visualizationManager.setSource({ subscribe(_bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    f.engine.configureVisualizations({ localization: { data: [{ id: "independent", kind: "zenoh" }] } });
    emit({ type: "data", bindingId: "independent", inputs: sample(7) });
    f.engine._updatePresentationAfterStep(0.1);
    assert.equal(f.tool.getTimings().display.count, 0);
    f.engine.autonomyOverlay.updateFromRuntime({ lastLocalization: { estimate: { threePosition: position(100) } } });
    assert.equal(f.tool.inputs.position.x, 7);
    f.engine.render();
    assert.equal(f.tool.ghost.position.x, 7);
    f.engine.dispose();
});

test("explicit shared snapshots delegate to all migrated tools without flushing the live manager", () => {
    const f = engineFixture();
    f.engine.autonomyOverlay.updateFromSnapshot({
        localization: { estimate: { threePosition: position(8) } },
        controls: { applied: { steeringRad: 0.3 } },
        path: { status: "ok", points: [position(), position(4)] },
        vehiclePose: { position: position(20) },
    });
    assert.equal(f.tool.inputs.position.x, 8);
    assert.equal(f.engine.visualizationManager.tools.ackermann.inputs.steeringRad, 0.3);
    assert.equal(f.engine.visualizationManager.tools.plannedTrajectory.points[1].x, 4);
    assert.equal(f.tool.getTimings().display.count, 0);
    f.engine.render();
    assert.equal(f.tool.ghost.position.x, 8);
    f.engine.dispose();
});

test("unchanged runtime layer settings preserve explicit manager localization visibility", () => {
    const f = engineFixture();
    f.engine.visualizationManager.setLayerVisible("localization", "ekf", "scene", false);
    f.engine.visualizationManager.setLayerVisible("localization", "estimateClone", "scene", false);
    f.engine.autonomyOverlay.updateFromRuntime({ lastLocalization: {} }, { ekf: true, estimateClone: true });
    assert.equal(f.tool.layerVisibility.scene.ekf, false);
    assert.equal(f.tool.layerVisibility.scene.estimateClone, false);
    f.engine.autonomyOverlay.setLayers({ ekf: false });
    f.engine.autonomyOverlay.setLayers({ ekf: true });
    assert.equal(f.tool.layerVisibility.scene.ekf, true);
    f.engine.dispose();
});

test("snapshot projections omit unknown positions and clear unavailable covariance and truth atomically", () => {
    assert.equal(localizationSnapshotInputs({ estimate: {} }).position, null);
    const projected = localizationSnapshotInputs({ estimate: { threePosition: position() } });
    assert.equal(projected.covarianceEllipse, null);
    assert.equal(projected.truthPosition, null);
    assert.equal(projected.error, null);
});

test("varying localization age badges retain only the current owned texture", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    const context = { clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {} };
    Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => context }) } });
    const f = fixture();
    let disposals = 0;
    try {
        for (let index = 0; index < 20; index += 1) {
            f.data({ ...sample(), status: "stale", ageNs: index * 1_000_000 }); f.manager.flush();
            const texture = f.tool.badge.children[0].material.map;
            texture.addEventListener("dispose", () => { disposals += 1; });
            assert.equal(disposals, index);
            assert.equal(f.tool.markers.children.filter((node) => node === f.tool.badge).length, 1);
        }
        f.manager.dispose();
        assert.equal(disposals, 20);
    } finally {
        if (previous) Object.defineProperty(globalThis, "document", previous);
        else delete globalThis.document;
    }
});
