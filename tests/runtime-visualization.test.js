import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { AutonomyOverlay } from "../app/3d/overlay/AutonomyOverlay.js";
import { cachedStatusBadge, disposeObject } from "../app/3d/overlay/overlayObjects.js";
import { CameraRenderProducts } from "../app/3d/perception/CameraRenderProducts.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";
import { LiveVisualizationSource } from "../app/visualization/sources/LiveVisualizationSource.js";
import { AckermannVisualizer } from "../app/visualization/visualizers/AckermannVisualizer.js";
import { PlannedTrajectoryVisualizer } from "../app/visualization/visualizers/PlannedTrajectoryVisualizer.js";
import { TrajectoryPastVisualizer } from "../app/visualization/visualizers/TrajectoryPastVisualizer.js";
import { LocalizationVisualizer } from "../app/visualization/visualizers/LocalizationVisualizer.js";
import { OccupancyVisualizer } from "../app/visualization/visualizers/OccupancyVisualizer.js";

function fixture() {
    const tools = { ackermann: new AckermannVisualizer(), plannedTrajectory: new PlannedTrajectoryVisualizer(),
        trajectoryPast: new TrajectoryPastVisualizer(), localization: new LocalizationVisualizer(), occupancy: new OccupancyVisualizer() };
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    const manager = new VisualizationManager({ tools, sceneContext: { scene, camera } });
    const binding = { id: "display", kind: "runtime", signalPath: "test.display" };
    const pose = { id: "pose", kind: "runtime", signalPath: "vehicles.ego.pose" };
    const bindings = Object.fromEntries(Object.keys(tools).map((id) => [id, { data: [binding], pose: [pose] }]));
    manager.configure(bindings);
    const store = new SignalStore();
    const createSource = () => new LiveVisualizationSource({ signalStore: store });
    manager.setSource(createSource());
    const sample = (x = 0) => ({ steeringRad: 0.2, achievedSteeringRad: 0.1, wheelbase: 2.2,
        points: [{ x: 0, y: 0, z: 0 }, { x: 3, y: 0.2, z: 1 }], vehicleRelative: true,
        position: { x, y: 0, z: 0 }, covarianceEllipse: { sigmaX: 1, sigmaY: 0.5 },
        actors: [{ id: "ego", position: { x, y: 0, z: 0 } }], timeNs: 0,
        stack: { width: 2, height: 1, cells: new Uint8Array([0, 255]), vehicleRelative: true } });
    const publish = (x = 0) => {
        store.publishSignal(binding.signalPath, sample(x));
        store.publishSignal(pose.signalPath, { position: { x, y: 0, z: 0 }, yaw: 0 });
        manager.source.releasePending(0); manager.flush();
    };
    return { tools, scene, camera, manager, store, bindings, createSource, publish };
}

test("base and routing manager import and run with browser/graphics globals forbidden", async () => {
    for (const file of ["Visualizer.js", "VisualizationManager.js"]) {
        const source = await readFile(new URL(`../app/visualization/${file}`, import.meta.url), "utf8");
        assert.doesNotMatch(source, /from ["'](?:react|three|.*Zenoh)|\b(?:window|document|navigator|requestAnimationFrame|WebGLRenderingContext)\b/);
    }
    execFileSync(process.execPath, ["--experimental-default-type=module", "--input-type=module", "-e", `
        for (const name of ["window", "document", "navigator", "requestAnimationFrame", "WebGLRenderingContext"])
            Object.defineProperty(globalThis, name, { get() { throw new Error(name + " accessed"); }, configurable: true });
        const { Visualizer } = await import("./app/visualization/Visualizer.js");
        const { VisualizationManager } = await import("./app/visualization/VisualizationManager.js");
        const tool = new Visualizer({ requiredInputs: ["value"] });
        const manager = new VisualizationManager({ tools: { tool } });
        manager.configure({ tool: { data: [{ id: "input" }] } });
        manager.setSource({ subscribe(_bindings, emit) { emit({ type: "data", bindingId: "input", inputs: { value: 0 } }); return () => {}; }, dispose() {} });
        manager.flush();
        if (!tool.ready || tool.inputs.value !== 0) throw new Error("Missing input");
        manager.dispose();
    `], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
});

test("all five tools retain bounded resources through configure/reset/source replacement and release them on dispose", () => {
    const f = fixture();
    const observed = new Set(), live = new Set();
    const observe = () => {
        for (const tool of Object.values(f.tools)) tool.group.traverse((object) => {
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const resource of [object.geometry, ...materials.flatMap((material) => [material, material?.map])]) {
                if (!resource || observed.has(resource)) continue;
                observed.add(resource); live.add(resource);
                resource.addEventListener("dispose", () => live.delete(resource));
            }
        });
    };
    for (let cycle = 0; cycle < 40; cycle++) {
        f.manager.configure(f.bindings);
        f.publish(); f.publish(1); observe();
        assert.equal(f.store._listeners.size, 1);
        assert.equal(f.manager.source.subscriptions.size, 1);
        assert.equal(f.tools.trajectoryPast.history.size, 1);
        assert.ok(f.tools.trajectoryPast.history.get("ego").length <= 3);
        assert.equal(f.tools.trajectoryPast.lines.size, 1);
        assert.equal(f.tools.occupancy.channels.size, 3);
        assert.ok(live.size <= 16, `live resources: ${live.size}`);
        assert.ok(Object.values(f.manager.getMapSnapshot().tools).every((entry) => entry.ready));
        const old = f.manager.source;
        f.manager.reset();
        f.manager.setSource(f.createSource());
        assert.equal(old.disposed, true);
        assert.equal(old.subscriptions.size, 0);
        assert.equal(old.latest.size, 0);
    }
    f.manager.dispose();
    assert.equal(live.size, 0);
    assert.equal(f.store._listeners.size, 0);
    assert.equal(f.scene.children.length, 0);
    assert.equal(f.tools.occupancy.channels.size, 0);
    assert.equal(f.tools.trajectoryPast.history.size, 0);
    assert.deepEqual(f.tools.plannedTrajectory.points, []);
    assert.equal(f.tools.plannedTrajectory.line, null);
    for (const id of ["ackermann", "plannedTrajectory", "localization"]) {
        assert.deepEqual(f.tools[id].mapOutput, { primitives: [] });
        assert.equal(f.tools[id].group.children.length, 0);
    }
});

test("operator visuals disable collision and picking and stay excluded in actual camera capture passes", () => {
    const f = fixture(); f.publish(); f.publish(1);
    const renderables = [];
    for (const tool of Object.values(f.tools)) {
        assert.equal(tool.group.userData.nonColliding, true);
        tool.group.traverse((object) => {
            assert.equal(object.layers.mask, 2 ** 31);
            assert.equal(object.userData.autonomyOverlay, true);
            const hits = [];
            object.raycast(new THREE.Raycaster(), hits);
            assert.deepEqual(hits, []);
            if (object.isMesh || object.isLine || object.isSprite) renderables.push(object);
        });
    }
    const surface = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    f.scene.add(surface);
    // Enable operator layer deliberately: sensor exclusion must also work through capture filtering.
    f.camera.layers.enable(31);
    let draws = 0;
    const renderer = { getRenderTarget: () => null, setRenderTarget() {}, getClearAlpha: () => 1,
        getClearColor: (color) => color.set(0), setClearColor() {}, readRenderTargetPixels(_target, _x, _y, _w, _h, pixels) { pixels.fill(0); },
        render(scene) {
            draws++;
            const visible = []; scene.traverseVisible((object) => visible.push(object));
            assert.ok(visible.includes(surface));
            assert.ok(renderables.every((object) => !visible.includes(object)));
        } };
    const products = new CameraRenderProducts({ renderer, scene: f.scene, camera: f.camera, width: 2, height: 1 });
    for (const mode of ["rgb", "depth", "semantic", "instance"]) products._render({ mode });
    assert.equal(draws, 4);
    assert.ok(renderables.every((object) => object.visible));
    products.dispose(); f.manager.dispose(); disposeObject(surface);
});

test("the replay facade delegates explicit snapshots while live updates preserve independent tools", () => {
    const f = fixture(); f.publish(3);
    const overlay = new AutonomyOverlay({ visualizationManager: f.manager });
    const previous = Object.fromEntries(Object.entries(f.tools).map(([id, tool]) => [id, tool.inputs]));
    overlay.updateFromRuntime({ lastLocalization: { estimate: { threePosition: { x: 100, y: 0, z: 0 } } },
        lastPath: { status: "ok", points: [{ x: 100, z: 100 }] }, lastOccupancy: { status: "ok" } });
    for (const [id, tool] of Object.entries(f.tools)) assert.equal(tool.inputs, previous[id]);
    overlay.updateFromSnapshot({ controls: { applied: { steeringRad: 0.4 } },
        path: { status: "ok", points: [{ x: 4, y: 0, z: 0 }, { x: 5, y: 0, z: 0 }] },
        localization: { estimate: { threePosition: { x: 4, y: 0, z: 0 } } },
        occupancy: { width: 1, height: 1, cells: [128] }, vehiclePose: { position: { x: 4, y: 0, z: 0 }, yaw: 0 } });
    f.manager.flush();
    assert.equal(f.tools.ackermann.inputs.steeringRad, 0.4);
    assert.equal(f.tools.plannedTrajectory.points[0].x, 4);
    assert.equal(f.tools.localization.inputs.position.x, 4);
    assert.equal(f.tools.occupancy.channels.get("stack").grid.cells[0], 128);
    overlay.dispose(); f.manager.dispose();
});

test("arbitrary status labels retain at most 64 cache textures without disposing displayed clones", () => {
    const originalDocument = globalThis.document, originalClone = THREE.SpriteMaterial.prototype.clone;
    const templates = new Set(), disposed = new Set();
    THREE.SpriteMaterial.prototype.clone = function () {
        templates.add(this);
        this.addEventListener("dispose", () => disposed.add(this));
        return originalClone.call(this);
    };
    globalThis.document = { createElement: () => ({ getContext: () => ({ clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {} }) }) };
    const badges = [];
    try {
        for (let index = 0; index < 160; index++) badges.push(cachedStatusBadge(`status:${index}`, 0xff0000));
        assert.equal(templates.size - disposed.size, 64);
        assert.equal(disposed.size, 96);
        let cloneDisposed = false;
        const firstTexture = badges[0].children[0].material.map;
        firstTexture.addEventListener("dispose", () => { cloneDisposed = true; });
        cachedStatusBadge("status:159", 0xff0000).traverse(disposeObject);
        assert.equal(cloneDisposed, false);
        badges[0].traverse(disposeObject);
        assert.equal(cloneDisposed, true);
    } finally {
        badges.slice(1).forEach((badge) => badge.traverse(disposeObject));
        THREE.SpriteMaterial.prototype.clone = originalClone;
        if (originalDocument === undefined) delete globalThis.document;
        else globalThis.document = originalDocument;
    }
});
