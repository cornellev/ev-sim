import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { OccupancyVisualizer, OCCUPANCY_CHANNELS } from "../app/visualization/visualizers/OccupancyVisualizer.js";
import { VisualizationManager } from "../app/visualization/VisualizationManager.js";
import { LiveVisualizationSource } from "../app/visualization/sources/LiveVisualizationSource.js";
import { PlanOccupancySampler } from "../app/spatial/planview/occupancy/oracleSample.js";
import { PlanLidarSampler } from "../app/spatial/planview/occupancy/lidarSample.js";
import { occupancyScreenRect, paintOccupancyCanvas, paintOccupancyRgba } from "../app/spatial/planview/occupancy/paint.js";
import { worldToScreen } from "../app/3d/editor/map/mapCoords.js";
import { AutonomyOverlay } from "../app/3d/overlay/AutonomyOverlay.js";

const grid = (values = [0, 1, 2, 0], extra = {}) => ({ cells: Uint8Array.from(values), width: 2, height: 2, ...extra });
const pose = { position: { x: 3, y: 4, z: -2 }, rotation: { x: 0.2, y: 0.6, z: -0.1, order: "XYZ" } };

function fixture() {
    const tool = new OccupancyVisualizer();
    const scene = new THREE.Scene();
    const manager = new VisualizationManager({ tools: { occupancy: tool }, sceneContext: { scene } });
    manager.configure({ occupancy: { data: [{ id: "grid" }], pose: [{ id: "pose" }] } });
    let emit;
    manager.setSource({ subscribe(_bindings, callback) { emit = callback; return () => {}; }, dispose() {} });
    const send = (inputs, revision) => emit({ type: "data", bindingId: "grid", inputs, revision });
    return { tool, manager, scene, send, emit };
}

test("channels accept atomic dimensions, defaults, and owned buffers; invalid grids retain accepted state", () => {
    const { tool, manager, send } = fixture();
    const sample = grid();
    send({ oracle: sample });
    sample.cells.fill(0);
    manager.flush();
    const accepted = manager.getMapSnapshot().tools.occupancy.output.grids.oracle;
    assert.deepEqual([...accepted.cells], [0, 1, 2, 0]);
    assert.equal(accepted.resolutionM, 0.05);
    assert.equal(accepted.encoding, "cost");
    assert.deepEqual(accepted.corners[0], { x: 0, y: 0, z: 0 });
    for (const invalid of [grid([1]), grid(undefined, { width: 0 }), grid(undefined, { height: 1.5 }), grid(undefined, { resolutionM: 0 }), grid(undefined, { originX: NaN }), grid(undefined, { encoding: "unknown" }), { width: 2, height: 2 }]) {
        send({ oracle: invalid }); manager.flush();
        assert.equal(tool.status, "error");
        assert.equal(manager.getMapSnapshot().tools.occupancy.output.grids.oracle, accepted);
    }
    send({ oracle: grid(), lidar: grid(undefined, { encoding: "ternary" }), stack: grid() });
    manager.flush();
    assert.equal(tool.status, "ready");
    assert.deepEqual(Object.keys(tool.mapOutput.grids), OCCUPANCY_CHANNELS);
    assert.notDeepEqual(tool.channels.get("oracle").rgba, tool.channels.get("lidar").rgba);
    manager.dispose();
});

test("both views share one color conversion and persistent resources; unchanged and pose-only data cause no upload or repaint", () => {
    const { tool, manager, send, emit } = fixture();
    const sample = grid(undefined, { vehicleRelative: true, resolutionM: 0.5 });
    send({ stack: sample }, 1); manager.flush();
    const channel = tool.channels.get("stack");
    const texture = channel.texture;
    const plane = channel.plane;
    const geometry = plane.geometry;
    const rgba = channel.rgba;
    const version = texture.version;
    const map = channel.map;
    assert.equal(texture.image.data, map.rgba);
    assert.deepEqual(map.rgba, paintOccupancyRgba(map.cells, 2, 2, "cost"));
    let paints = 0;
    const canvas = { width: 0, height: 0, getContext: () => ({ createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }), putImageData: () => { paints += 1; } }) };
    paintOccupancyCanvas(canvas, map);
    send({ stack: sample }, 1); manager.flush();
    assert.equal(channel.map, map);
    paintOccupancyCanvas(canvas, channel.map);
    emit({ type: "pose", bindingId: "pose", pose, revision: 1 }); manager.flush();
    paintOccupancyCanvas(canvas, channel.map);
    assert.equal(paints, 1);
    assert.equal(texture.version, version);
    assert.equal(channel.rgba, rgba);
    assert.equal(channel.texture, texture);
    assert.equal(channel.plane.geometry, geometry);
    send({ stack: grid([1, 0, 0, 1], { vehicleRelative: true }) }, 2); manager.flush();
    assert.equal(channel.texture, texture);
    assert.equal(texture.version, version + 1);
    paintOccupancyCanvas(canvas, channel.map);
    assert.equal(paints, 2);
    manager.dispose();
});

test("scene and map corners match yaw, elevation, relative pose, and the grid-minimum pivot", () => {
    const { tool, manager, send, emit } = fixture();
    send({ stack: grid(undefined, { resolutionM: 0.5, originX: 2, originY: 1.5, originZ: -3, yawRad: 0.4, vehicleRelative: true }) });
    emit({ type: "pose", bindingId: "pose", pose }); manager.flush();
    const channel = tool.channels.get("stack");
    const positions = channel.plane.geometry.attributes.position;
    for (let index = 0; index < positions.count; index += 1) {
        const world = new THREE.Vector3().fromBufferAttribute(positions, index).applyMatrix4(channel.plane.matrix);
        assert.deepEqual(channel.map.corners[index], { x: world.x, y: world.y, z: world.z });
    }
    const viewport = { centerX: 0, centerZ: 0, zoom: 1 };
    const size = { width: 200, height: 100 };
    const rect = occupancyScreenRect(channel.map, viewport, size);
    const [a, b, c, d, e, f] = rect.transform.slice(7, -1).split(" ").map(Number);
    for (const [index, x, y] of [[0, 0, 0], [1, rect.width, 0], [2, 0, rect.height], [3, rect.width, rect.height]]) {
        const expected = worldToScreen(channel.map.corners[index], viewport, size);
        assert.ok(Math.abs(a * x + c * y + e - expected.x) < 1e-9);
        assert.ok(Math.abs(b * x + d * y + f - expected.y) < 1e-9);
    }
    assert.ok(channel.map.originY > 0);
    manager.dispose();
});

test("comparison visibility is independent; reset and dispose retain or release resources correctly", () => {
    const { tool, manager, send, scene } = fixture();
    send(Object.fromEntries(OCCUPANCY_CHANNELS.map((id) => [id, grid()]))); manager.flush();
    manager.setLayerVisible("occupancy", "oracle", "scene", false);
    manager.setLayerVisible("occupancy", "lidar", "map", false); manager.flush();
    assert.equal(tool.channels.get("oracle").plane.visible, false);
    assert.equal(tool.channels.get("lidar").plane.visible, true);
    assert.ok(tool.mapOutput.grids.oracle);
    assert.equal(tool.mapOutput.grids.lidar, undefined);
    const texture = tool.channels.get("stack").texture;
    let disposals = 0;
    texture.addEventListener("dispose", () => { disposals += 1; });
    manager.reset(); manager.flush();
    assert.deepEqual(tool.mapOutput.grids, {});
    assert.equal(tool.channels.get("stack").plane.visible, false);
    send({ stack: grid() }); manager.flush();
    assert.equal(tool.channels.get("stack").texture, texture);
    manager.dispose();
    assert.equal(disposals, 1);
    assert.equal(scene.children.length, 0);
});

test("live source owns shared samplers, completed-step samples, imported diagnostics, and world-change cancellation", async () => {
    let inFlight = true, worldChanged, canceled = 0;
    const vehicle = { telemetryId: "ego", position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, devices: [{
        buff: new Float32Array([1, 0, 5, 0]), buffGeneration: 1,
        config: { calibration: { azimuth: { startDeg: 0, endDeg: 1, stepDeg: 1 }, elevation: { startDeg: 0, endDeg: 1, stepDeg: 1 } }, pose: { position: { x: 0, y: 0, z: 0.5 }, rotation: { x: 0, y: 0, z: 0 } } },
    }] };
    const sources = { ego: vehicle.position, vehicles: [vehicle], description: { bounds: { min: { x: -2, z: -2 }, max: { x: 2, z: 2 } }, drivableSurfaces: [], obstacles: [] }, obstacles: [], runtime: {}, resolvedRun: { manifest: { topics: [] } } };
    const source = new LiveVisualizationSource({ isStepInFlight: () => inFlight, getOccupancySources: () => sources,
        subscribeRuntimeChanges: (callback) => { worldChanged = callback; return () => { canceled += 1; }; } });
    source.occupancySamplers.oracle = new PlanOccupancySampler({ cells: 40 });
    source.occupancySamplers.lidar = new PlanLidarSampler({ cells: 40 });
    const events = [];
    source.subscribe(OCCUPANCY_CHANNELS.map((id) => ({ id, kind: "runtime", signalPath: `visualization.occupancy.${id}` })), (event) => events.push(event));
    assert.deepEqual(events, []);
    inFlight = false; source.releasePending(1);
    const first = events.find((event) => event.bindingId === "oracle").inputs.oracle;
    const saved = first.cells.slice();
    assert.match(events.find((event) => event.bindingId === "stack").inputs.stackMessage, /not configured/);
    const oracle = source.occupancySamples.get("oracle").inputs;
    const lidar = source.occupancySamples.get("lidar").inputs;
    source.releasePending(2);
    assert.equal(source.occupancySamples.get("oracle").inputs, oracle);
    assert.equal(source.occupancySamples.get("lidar").inputs, lidar);
    sources.ego = null;
    source.releasePending(2);
    assert.equal(source.occupancySamples.get("oracle").inputs.oracle, null);
    assert.equal(source.occupancySamples.get("lidar").inputs.lidar, null);
    sources.ego = vehicle.position;
    source.releasePending(2);
    assert.ok(source.occupancySamples.get("oracle").inputs.oracle);
    assert.ok(source.occupancySamples.get("lidar").inputs.lidar);
    const devices = vehicle.devices;
    vehicle.devices = [];
    source.releasePending(2);
    assert.equal(source.occupancySamples.get("lidar").inputs.lidar, null);
    vehicle.devices = devices;
    source.releasePending(2);
    assert.ok(source.occupancySamples.get("lidar").inputs.lidar);
    sources.obstacles.push({ id: "episode-box", footprint: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }] });
    source.releasePending(3);
    assert.notEqual(source.occupancySamples.get("oracle").inputs, oracle);
    assert.deepEqual(first.cells, saved);
    vehicle.devices[0].config.calibration.azimuth.startDeg = 1;
    source.releasePending(4);
    assert.notEqual(source.occupancySamples.get("lidar").inputs, lidar);
    sources.description = { ...sources.description };
    worldChanged();
    await Promise.resolve();
    assert.notEqual(source.occupancySamples.get("oracle").inputs.oracle, first);
    const count = events.length;
    source.dispose(); worldChanged(); source.releasePending(5);
    await Promise.resolve();
    assert.equal(events.length, count);
    assert.equal(canceled, 1);
});

test("admitted stack producer metadata preserves exact sequence identity and excludes ambiguous or mismatched producers", () => {
    const sample = grid(undefined, { status: "ok", captureTimeNs: 0, frameId: "map" });
    const metadata = { runId: "imported-run", captureTimeNs: 0, frameId: "map", sequenceId: "18446744073709551615" };
    const envelope = { topicId: "import", valueContract: { id: "cev.occupancy" }, value: { data: sample.cells }, metadata };
    const sources = { runtime: { lastOccupancy: sample }, topicRouter: { lastProducer: new Map([["import", envelope]]) },
        resolvedRun: { manifest: { topics: [{ id: "import", direction: "input", valueContract: { id: "cev.occupancy" } }] },
            protobufInterface: { document: { routes: [{ direction: "subscribe", target: { topicId: "import" } }] } } } };
    const events = [];
    const source = new LiveVisualizationSource({ runId: "fallback-run", getOccupancySources: () => sources });
    source.subscribe([{ id: "stack", kind: "runtime", signalPath: "visualization.occupancy.stack" }], (event) => events.push(event));
    const accepted = events.find((event) => event.type === "data");
    assert.deepEqual(accepted.metadata, metadata);
    assert.deepEqual(accepted.inputs.stack.metadata, metadata);
    assert.equal(sample.sequenceId, undefined);
    sources.runtime.lastOccupancy = { ...sample };
    sources.topicRouter.lastProducer.set("ambiguous", envelope);
    source.releasePending(1);
    assert.equal(events.filter((event) => event.type === "data").at(-1).metadata.sequenceId, undefined);
    sources.topicRouter.lastProducer.delete("ambiguous");
    sources.runtime.lastOccupancy = { ...sample, captureTimeNs: 1 };
    source.releasePending(2);
    assert.equal(events.filter((event) => event.type === "data").at(-1).metadata.sequenceId, undefined);
    source.dispose();
});

test("an explicit independent stack sample bypasses simulation admission and shared runtime facade; replay is immediate", () => {
    const { tool, manager, send } = fixture();
    const sample = grid(undefined, { frameId: "external-map" });
    send({ stack: sample }); manager.flush();
    const overlay = new AutonomyOverlay({ visualizationManager: manager });
    const accepted = tool.channels.get("stack").grid;
    overlay.updateFromRuntime({ lastOccupancy: grid([1, 1, 1, 1]), lastLocalization: {} });
    assert.equal(tool.channels.get("stack").grid, accepted);
    overlay.updateFromSnapshot({ occupancy: grid([1, 0, 1, 0]) }); manager.flush();
    assert.deepEqual([...tool.channels.get("stack").grid.cells], [1, 0, 1, 0]);
    overlay.dispose(); manager.dispose();
    const replay = new AutonomyOverlay();
    replay.updateFromSnapshot({ occupancy: sample });
    assert.equal(replay.visualizationManager.tools.occupancy.channels.get("stack").plane.visible, true);
    replay.dispose();
});
