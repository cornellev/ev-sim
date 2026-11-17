import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildPlanViewFrame, createPlanViewFrameStore } from "../app/spatial/planview/frame.js";
import { clearPlanWaypoints, getPlanWaypoints, setPlanWaypoints, subscribePlanWaypoints } from "../app/spatial/planview/waypoints.js";
import { Visualizer } from "../app/visualization/Visualizer.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";

const road = (z = 0) => ({ roads: { nodes: [{ id: "a", x: 0, z }, { id: "b", x: 40, z }],
    edges: [{ id: "e", startNodeId: "a", endNodeId: "b", width: 8 }] } });

function fixture({ inFlight = false, unavailable = false } = {}) {
    clearPlanWaypoints();
    const listeners = new Set(), documentListeners = new Set();
    let environment = road(), reads = 0;
    const device = { enabled: true, settings: { range: 20, theta: { range: [-45, 45] } },
        getPosition: () => vehicle.position, getRotation: () => vehicle.rotation };
    const vehicle = { telemetryId: "ego", position: { x: 1, y: 0, z: 0 }, rotation: { y: 0 }, devices: [device] };
    const simulation = {
        steps: 0, timeNs: 0, visualizationRevision: 0, _visualizationStepActive: inFlight,
        scenarioRuntime: { scenario: { id: "scenario", actors: [], routes: [] }, getSnapshot: () => ({ metrics: {} }) },
        candidateOutputRuntime: { lastPerception: { detections3d: [] } },
        controlRuntime: { getSnapshot: () => { throw new Error("Migrated controls must use the manager cache."); } },
        subscribe(listener) { listeners.add(listener); listener(this); return () => listeners.delete(listener); },
        emit(extra = {}) { for (const listener of [...listeners]) listener({ ...this, ...extra }); },
    };
    const document = { snapshot: () => environment,
        subscribe(listener) { documentListeners.add(listener); return () => documentListeners.delete(listener); } };
    const data = { simulation: () => simulation, environment: () => ({ getDocument: () => document }),
        vehicles: () => { reads++; if (unavailable) throw new Error("Display sources unavailable."); return { vehicles: [vehicle] }; } };
    const store = createPlanViewFrameStore(data);
    return { store, simulation, vehicle, device, listeners, documentListeners, reads: () => reads,
        edit(next) { environment = next; for (const listener of [...documentListeners]) listener(next); } };
}

test("mounting during a held step waits for completed state and unavailable initial sources are contained", () => {
    const f = fixture({ inFlight: true });
    const cancel = f.store.subscribe(() => {});
    assert.equal(f.reads(), 0);
    assert.equal(f.store.getSnapshot().vehicles.length, 0);
    f.vehicle.position.x = 8;
    f.simulation._visualizationStepActive = false;
    f.simulation.steps = 1; f.simulation.timeNs = 20_000_000;
    f.simulation.emit();
    assert.equal(f.store.getSnapshot().vehicles[0].position.x, 8);
    assert.equal(f.reads(), 1);
    cancel();
    const missing = fixture({ unavailable: true });
    const cancelMissing = missing.store.subscribe(() => {});
    assert.equal(missing.store.getSnapshot().vehicles.length, 0);
    assert.doesNotThrow(() => missing.simulation.emit({ steps: 1 }));
    cancelMissing();
});

test("remaining map data is cached through camera frames and refreshed only after completed state or UI changes", () => {
    const f = fixture();
    const cancel = f.store.subscribe(() => {});
    const frame = f.store.getSnapshot(), reads = f.reads();
    for (let index = 0; index < 10; index++) {
        f.simulation.emit({ frames: index, autonomyOverlay: { controls: false } });
        assert.equal(f.store.getSnapshot(), frame);
    }
    assert.equal(f.reads(), reads);
    f.simulation._visualizationStepActive = true;
    f.vehicle.position.x = 8;
    f.simulation.timeNs = 20_000_000;
    f.simulation.steps = 1;
    f.simulation.emit();
    assert.equal(f.store.getSnapshot(), frame);
    f.simulation._visualizationStepActive = false;
    f.simulation.emit();
    assert.equal(f.store.getSnapshot().vehicles[0].position.x, 8);
    assert.equal(f.reads(), reads + 1);
    f.device.enabled = false;
    f.simulation.visualizationRevision++;
    f.simulation.emit();
    assert.equal(f.store.getSnapshot().sensors.length, 0);
    cancel();
});

test("paused waypoint edits notify immediately, clear on a time reset, and unsubscribe without a polling loop", () => {
    const f = fixture();
    let notices = 0;
    const cancel = f.store.subscribe(() => { notices++; });
    setPlanWaypoints([{ x: 2, z: 3 }]);
    assert.deepEqual(f.store.getSnapshot().waypoints, [{ x: 2, z: 3 }]);
    clearPlanWaypoints();
    assert.deepEqual(f.store.getSnapshot().waypoints, []);
    const emptyNotices = notices;
    clearPlanWaypoints();
    assert.equal(notices, emptyNotices);
    f.simulation.timeNs = 20_000_000; f.simulation.steps = 1; f.simulation.emit();
    setPlanWaypoints([{ x: 4, z: 5 }]);
    f.simulation.timeNs = 0; f.simulation.steps = 0; f.simulation.emit();
    assert.deepEqual(getPlanWaypoints(), []);
    assert.deepEqual(f.store.getSnapshot().waypoints, []);
    cancel();
    const reads = f.reads();
    setPlanWaypoints([{ x: 9, z: 1 }]);
    f.simulation.emit();
    assert.equal(f.reads(), reads);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.documentListeners.size, 0);
    clearPlanWaypoints();
});

test("document edits copy projected poses and rebuild roads with unchanged ids; late notifications are fenced", async () => {
    const f = fixture();
    const cancel = f.store.subscribe(() => {});
    const reads = f.reads();
    const frame = f.store.getSnapshot();
    f.edit(road(5));
    f.edit(road(7));
    f.vehicle.position.x = 12;
    f.vehicle.position.z = 7;
    assert.equal(f.store.getSnapshot(), frame);
    await Promise.resolve();
    assert.equal(f.reads(), reads + 1);
    assert.equal(f.store.getSnapshot().vehicles[0].position.x, 12);
    assert.ok(f.store.getSnapshot().lane.points.every((point) => point.z > 4));
    const late = [...f.listeners][0];
    f.edit(road(10));
    cancel();
    const closed = f.store.getSnapshot();
    late({ steps: 20, timeNs: 400_000_000 });
    await Promise.resolve();
    assert.equal(f.store.getSnapshot(), closed);
    assert.equal(f.reads(), reads + 1);
});

test("independent paused manager updates do not resample remaining map data", () => {
    const f = fixture();
    const cancel = f.store.subscribe(() => {});
    const tool = new Visualizer({ requiredInputs: ["value"] });
    tool.displayMap = () => tool.inputs;
    const manager = new VisualizationManager({ tools: { tool } });
    manager.configure({ tool: { data: [{ id: "independent" }] } });
    let emit, notices = 0;
    manager.setSource({ subscribe(_bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    const cancelMap = manager.subscribeMap(() => { notices++; });
    const frame = f.store.getSnapshot(), reads = f.reads();
    emit({ type: "data", bindingId: "independent", inputs: { value: 42 }, revision: "18446744073709551615" });
    manager.flush();
    assert.equal(manager.getMapSnapshot().tools.tool.output.value, 42);
    assert.equal(notices, 1);
    assert.equal(f.store.getSnapshot(), frame);
    assert.equal(f.reads(), reads);
    cancelMap(); cancel(); manager.dispose();
});

test("the frame adapter reads only supplied waypoints and waypoint subscribers cannot interrupt delivery", () => {
    setPlanWaypoints([{ x: 9, z: 8 }]);
    assert.deepEqual(buildPlanViewFrame().waypoints, []);
    const cancel = subscribePlanWaypoints(() => { throw new Error("Bad map subscriber."); });
    assert.doesNotThrow(() => setPlanWaypoints([{ x: 1, z: 2 }]));
    assert.doesNotThrow(() => clearPlanWaypoints());
    cancel();
});

test("map hooks and menus use subscriptions and wire cached tool visibility", async () => {
    const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const [hook, view, layers, menu, hierarchy] = await Promise.all([
        read("app/spatial/planview/usePlanViewFrame.js"), read("app/spatial/planview/PlanView.js"),
        read("app/spatial/planview/PlanViewLayers.js"), read("app/3d/overlay/SimulationMenu.js"), read("app/3d/overlay/VehicleOverlay.js"),
    ]);
    assert.equal((hook.match(/useSyncExternalStore\(/g) ?? []).length, 2);
    assert.match(hook, /subscribeMap/);
    assert.doesNotMatch(hook + view + layers, /requestAnimationFrame|cancelAnimationFrame|setInterval|frameKey|\.sample\(/);
    assert.match(view, /"planned-trajectory": "plannedTrajectory"/);
    assert.match(view, /manager\.setVisible\(toolId, "map"/);
    assert.match(view, /manager\.setLayerVisible\("occupancy", layer\.channel, "map"/);
    assert.match(view, /if \(visible\) manager\.setVisible\("occupancy", "map", true\)/);
    assert.match(layers, /\[cells, width, height, rgba, revision, encoding, palette\]/);
    for (const key of ["oracleOccupancy", "lidarOccupancy", "stackOccupancy", "pastTrajectories"]) {
        assert.match(menu, new RegExp(`setAutonomyOverlayEnabled\\?\\.\\(\\{ ${key}: value \\}\\)`));
    }
    assert.equal((hierarchy.match(/notifyVisualizationChange\?\.\(\)/g) ?? []).length, 3);
});
