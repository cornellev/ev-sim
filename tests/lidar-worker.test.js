import assert from "node:assert/strict";
import test from "node:test";
import { BrowserCpuLidarRuntime } from "../app/3d/devices/BrowserCpuLidarRuntime.js";
import { createBoxLidarTwin, hashLidarGeometry } from "../app/simulation/lidar/LidarGeometry.js";
import { CpuLidarScene } from "../app/simulation/sensors/CpuLidarScene.js";
import { lidarCaptureDigest } from "../app/simulation/sensors/CpuLidarWorkerService.js";
import { createCpuLidarTestWorker } from "./helpers/cpuLidarWorker.js";
import { browserSimulationPerformance } from "../app/simulation/performance/BrowserSimulationPerformance.js";

function fixture() {
    const description = {
        kind: "cev-sim.lidar-geometry", version: 1,
        coordinateFrame: { units: "meters", upAxis: "+Y", forwardAxis: "+X" },
        staticPrimitives: [createBoxLidarTwin({
            id: "box", sourceId: "box", center: { x: 5, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 },
        })],
        actors: [],
    };
    const config = {
        id: "lidar", parentId: "ego", pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
        calibration: { scanLayout: {
            channels: [{ elevationDeg: 0, azimuthOffsetDeg: 0 }],
            azimuthsDeg: [0, 90, 180, 270], minRangeM: 0.2, maxRangeM: 150,
        } },
    };
    return { resolved: { lidarGeometry: { description, hash: hashLidarGeometry(description) } }, config };
}
const vehicles = [{ id: "ego", position: { x: 0, y: 0, z: 0 }, rotation: {} }];

async function prepare(t, options = {}) {
    const data = fixture();
    const worker = createCpuLidarTestWorker();
    const runtime = new BrowserCpuLidarRuntime({ workerFactory: () => worker, ...options });
    t.after(() => runtime.dispose());
    await runtime.prepare(data.resolved, [data.config]);
    assert.equal(runtime.status.implementation, "worker");
    return { ...data, worker, runtime };
}

test("actual CPU worker transfers identical raw bytes and canonical packet/observation digests", async (t) => {
    const { runtime, config, resolved } = await prepare(t);
    const scene = new CpuLidarScene(resolved.lidarGeometry);
    t.after(() => scene.dispose());
    runtime.setEpisodePrimitives([]);
    const raw = await runtime.capture(config, vehicles);
    assert.deepEqual(new Uint8Array(raw.buffer), new Uint8Array(scene.capture(config, vehicles).buffer));
    const capture = {
        messages: [{ value: { data: new Uint8Array([1, 2, 255]) } }],
        nativePackets: [{ productId: "packets", streamId: "s", offsetNs: 0, packetIndex: 1, payload: new Uint8Array([3, 4]) }],
        observation: { dtype: "float32", shape: [2], value: new Float32Array([0.2, 2]) },
    };
    const expected = structuredClone(capture);
    const digest = lidarCaptureDigest(capture);
    const pending = runtime.digestCapture(capture);
    assert.equal(capture.nativePackets[0].payload.byteLength, 0);
    const result = await pending;
    assert.equal(result.digest, digest);
    assert.deepEqual(result.capture, expected);
});

test("CPU worker bounds requests, cancels stale captures on reset, and replays", async (t) => {
    const { runtime, config, worker } = await prepare(t);
    worker.hold = true;
    const pending = runtime.capture(config, vehicles);
    await assert.rejects(runtime.capture(config, vehicles), { code: "CPU_LIDAR_CAPACITY" });
    runtime.setEpisodePrimitives([]);
    await assert.rejects(pending, { code: "CPU_LIDAR_CANCELLED" });
    worker.flush();
    const raw = await runtime.capture(config, vehicles);
    assert.equal(raw[0], 4);
    worker.hold = true;
    const disposed = runtime.capture(config, vehicles);
    runtime.dispose();
    await assert.rejects(disposed, { code: "CPU_LIDAR_CANCELLED" });
});

test("CPU worker failure after preparation fails the run without switching inline", async (t) => {
    const { runtime, config, worker } = await prepare(t);
    worker.hold = true;
    const pending = runtime.capture(config, vehicles);
    worker.fail();
    await assert.rejects(pending, { code: "CPU_LIDAR_WORKER_FAILED", infrastructureFailure: true });
    assert.equal(runtime.inline, null);
    await assert.rejects(runtime.capture(config, vehicles), { code: "CPU_LIDAR_WORKER_FAILED" });
});

test("rapid resets cannot accumulate physical worker capture jobs", async (t) => {
    const { runtime, config, worker } = await prepare(t);
    let posted = 0;
    const post = worker.postMessage.bind(worker);
    worker.postMessage = (message, transfers) => { posted += 1; post(message, transfers); };
    worker.hold = true;
    for (let reset = 0; reset < 10; reset += 1) {
        const pending = runtime.capture(config, vehicles);
        runtime.setEpisodePrimitives([]);
        await assert.rejects(pending, { code: "CPU_LIDAR_CANCELLED" });
    }
    assert.equal(posted, 1);
    const latest = runtime.capture(config, vehicles);
    worker.flush();
    assert.equal((await latest)[0], 4);
    assert.equal(posted, 2);
});

test("reset during digest rejects the old output and accepts the next generation", async (t) => {
    const { runtime, config, worker } = await prepare(t);
    await runtime.capture(config, vehicles);
    worker.hold = true;
    const pending = runtime.digestCapture({ messages: [], nativePackets: [], observation: null });
    runtime.setEpisodePrimitives([]);
    await assert.rejects(pending, { code: "CPU_LIDAR_CANCELLED" });
    worker.flush();
    await runtime.capture(config, vehicles);
    const result = await runtime.digestCapture({ messages: [], nativePackets: [], observation: null });
    assert.equal(typeof result.digest, "string");
});

test("performance counters distinguish completed empty captures and seeded drops from missed work", () => {
    browserSimulationPerformance.start();
    const health = { captureAttempts: 13, capturedFrames: 10, deliveredFrames: 10 };
    browserSimulationPerformance.recordSensorState("sensor", health, undefined, 1, 13);
    const report = browserSimulationPerformance.stop();
    assert.equal(report.sensors.completed, 13);
    assert.equal(report.sensors.intentionalDrops, 1);
    assert.equal(report.sensors.skipped, 0);
    assert.equal(report.gates.scheduledSensors, true);
    browserSimulationPerformance.start();
    browserSimulationPerformance.recordSensorState("sensor", health, undefined, 1, 12);
    assert.equal(browserSimulationPerformance.stop().gates.scheduledSensors, false);
    browserSimulationPerformance.start({ warmupMs: 10 });
    const start = browserSimulationPerformance.startedAt;
    browserSimulationPerformance.recordSensorState("sensor", {
        captureAttempts: 1, capturedFrames: 1, deliveredFrames: 0,
    }, start + 9, 0, 1);
    browserSimulationPerformance.recordSensorState("sensor", {
        captureAttempts: 1, capturedFrames: 1, deliveredFrames: 1,
    }, start + 11, 0, 1);
    assert.equal(browserSimulationPerformance.stop().gates.scheduledSensors, true);
});

test("CPU worker timeout fails closed and preparation unavailability has an exact inline fallback", async (t) => {
    const { runtime, config, worker } = await prepare(t);
    runtime.requestTimeoutMs = 15;
    worker.hold = true;
    await assert.rejects(runtime.capture(config, vehicles), { code: "CPU_LIDAR_TIMEOUT" });
    const { resolved } = fixture();
    const fallback = new BrowserCpuLidarRuntime({ workerFactory: () => null });
    t.after(() => fallback.dispose());
    await fallback.prepare(resolved, [config]);
    assert.equal(fallback.requiresAsyncCapture, false);
    assert.equal(fallback.status.implementation, "inline");
    assert.ok(fallback.status.fallbackReason);
    assert.equal(fallback.capture(config, vehicles)[0], 4);
    const tampered = structuredClone(resolved);
    tampered.lidarGeometry.description.staticPrimitives[0].center.x = 10;
    const invalid = new BrowserCpuLidarRuntime({ workerFactory: () => null });
    await assert.rejects(invalid.prepare(tampered, [config]), /hash mismatch/);
});
