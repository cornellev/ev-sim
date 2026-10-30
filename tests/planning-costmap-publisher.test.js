import assert from "node:assert/strict";
import test from "node:test";

import {
    PlanningCostmapPublisher,
    createPlanningCostmapPublisher,
    encodePlanningCostmap,
} from "../app/simulation/PlanningCostmapPublisher.js";
import { OracleOccupancyGrid } from "../app/simulation/occupancy/OracleOccupancyGrid.js";
import { createSimulationRuntimeContext } from "../app/simulation/kernel/SimulationRuntimeContext.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";

function world() {
    return { drivableSurfaces: [{ footprint: [[0, 0], [4, 0], [4, 4], [0, 4]] }] };
}

function run(id = "oct-31-testing") {
    return {
        manifest: createDefaultRunManifest({
            id,
            clock: { stepNs: 20_000_000, maxSteps: null, modules: { sensors: false } },
            sensorRig: { sensors: [] },
            assertions: [],
        }),
        world: { description: world() },
        vehicles: [{ actorId: "other", manifest: { boundingBox: { size: { x: 1, z: 1 } } } }],
        environment: { manifest: { environmentId: "test" } },
        bindings: { entries: [] },
        scripts: [],
    };
}

function harness(publish = () => Promise.resolve()) {
    const published = [];
    const client = {
        open: true,
        isOpen() { return this.open; },
        publish(...args) { published.push(args); return publish(...args); },
    };
    const vehicles = [{ id: "ego", position: { x: 2, z: 2 } }];
    const context = {
        topics: { client: () => client },
        rendering: { target: () => "browser" },
        episodeOverlay: { toObstacles: () => [] },
    };
    const grid = new OracleOccupancyGrid(world(), { cells: 4, resolutionM: 1 });
    const publisher = new PlanningCostmapPublisher(run(), context, grid);
    return { publisher, context, client, vehicles, grid, published };
}

test("costmap rows reflect world Z into REP-103 Y, preserving cell centers", () => {
    const payload = JSON.parse(encodePlanningCostmap({
        cells: Uint8Array.from([0, 1, 0, 1, 0, 1]),
        originX: -0.1, originZ: -0.25, resolutionM: 0.05,
    }, 2, 3));
    assert.deepEqual([...Buffer.from(payload.cells, "base64")], [255, 0, 255, 0, 255, 0]);
    assert.equal(payload.origin_x, -0.1);
    assert.equal(payload.origin_y, 0.15);
    assert.equal(payload.resolution, 0.05);
    assert.equal(payload.rows, 2);
    assert.equal(payload.cols, 3);
    assert.ok(Math.abs(payload.origin_y + 0.025 - -(-0.25 + 1.5 * 0.05)) < 1e-12);
});

test("export includes other actors and overlay obstacles but leaves ego clear", async () => {
    const h = harness();
    h.vehicles.push({ id: "other", position: { x: 1.5, z: 1.5 } });
    h.context.episodeOverlay.toObstacles = () => [{ footprint: [[3, 3], [4, 3], [4, 4], [3, 4]] }];
    h.publisher.publish(20_000_000, h.vehicles);
    await h.publisher.pending;
    const [topic, type, json] = h.published[0];
    const payload = JSON.parse(json);
    const cells = Buffer.from(payload.cells, "base64");
    assert.equal(topic, "/planning/costmap");
    assert.equal(type, "std_msgs/String");
    assert.equal(cells[2 * 4 + 1], 255, "other actor is blocked");
    assert.equal(cells[3], 255, "overlay obstacle is blocked");
    assert.equal(cells[1 * 4 + 2], 0, "ego is not stamped");
});

test("throttle uses simulation nanoseconds and resets without publishing at reset", async () => {
    const h = harness();
    h.publisher.publish(20_000_000, h.vehicles);
    await h.publisher.pending;
    h.publisher.publish(519_999_999, h.vehicles);
    assert.equal(h.published.length, 1);
    h.publisher.publish(520_000_000, h.vehicles);
    await h.publisher.pending;
    assert.equal(h.published.length, 2);
    h.publisher.reset();
    assert.equal(h.published.length, 2);
    h.publisher.publish(20_000_000, h.vehicles);
    await h.publisher.pending;
    assert.equal(h.published.length, 3);
    h.publisher.dispose();
    h.publisher.publish(1_000_000_000, h.vehicles);
    assert.equal(h.publisher.grid, null);
    assert.equal(h.published.length, 3);
});

test("closed sockets and pending sends skip sampling; backpressure drops the frame", async (t) => {
    let reject;
    const h = harness(() => new Promise((_, fail) => { reject = fail; }));
    const sample = t.mock.method(h.grid, "sample");
    const warnings = t.mock.method(console, "warn", () => {});
    h.client.open = false;
    h.publisher.publish(20_000_000, h.vehicles);
    assert.equal(sample.mock.callCount(), 0);
    h.client.open = true;
    h.publisher.publish(20_000_000, h.vehicles);
    h.publisher.publish(1_000_000_000, h.vehicles);
    assert.equal(sample.mock.callCount(), 1);
    reject(Object.assign(new Error("congested"), { code: "websocket-backpressure" }));
    await h.publisher.pending;
    assert.equal(warnings.mock.callCount(), 0);
    h.client.publish = () => { throw new Error("encoding failed"); };
    h.publisher.publish(1_000_000_000, h.vehicles);
    assert.equal(warnings.mock.callCount(), 1);
});

test("only the named browser run creates an exporter", () => {
    const context = { rendering: { target: () => "browser" } };
    assert.equal(createPlanningCostmapPublisher(run("other"), context), null);
    assert.equal(createPlanningCostmapPublisher(run(), { rendering: { target: () => "headless" } }), null);
    const publisher = createPlanningCostmapPublisher(run(), context);
    assert.ok(publisher instanceof PlanningCostmapPublisher);
    assert.equal(publisher.grid.cells, 1000);
    publisher.dispose();
});

test("kernel exports after motion, resets its throttle, and disposes the exporter", async () => {
    const published = [];
    const vehicle = {
        telemetryId: "ego", position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
        acceleration: { x: 0, y: 0, z: 0 }, steeringAngle: 0,
    };
    const context = createSimulationRuntimeContext({
        renderTarget: "browser",
        topicClient: () => ({ isOpen: () => true, publish: (...args) => { published.push(args); } }),
        inputs: { update() {} },
        scripts: {
            setTopicScheduler() {}, setTopicRouter() {}, async setManifest() {},
            async prepareResolvedScripts() {}, applyTopicUpdate() {}, update() {},
        },
        vehicles: {
            vehicles: [vehicle], async configureFromManifest() {},
            update() { vehicle.position.x = 3; },
        },
        devices: { devices: [], configureFromManifest() {}, resetSchedule() {}, update() {}, deliver() {} },
        physics: { async configureRun() {}, resetRun() {}, beginStep() {}, step() {} },
        scenarios: { configure() {}, reset() {}, setControlRuntime() {}, getSnapshot() { return null; } },
    });
    const kernel = new SimulationKernel(context);
    await kernel.configureRun(run());
    const publisher = kernel.planningCostmapPublisher;
    assert.equal(published.length, 0);
    kernel.step(1);
    await publisher.pending;
    assert.equal(published.length, 1);
    const payload = JSON.parse(published[0][2]);
    assert.equal(payload.origin_x, -22, "window follows the post-motion x=3 position");
    kernel.reset();
    kernel.step(1);
    await publisher.pending;
    assert.equal(published.length, 2);
    kernel.dispose();
    assert.equal(kernel.planningCostmapPublisher, null);
    assert.equal(publisher.grid, null);
});
