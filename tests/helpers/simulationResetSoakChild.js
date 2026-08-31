import assert from "node:assert/strict";

import { SignalStore } from "../../app/scripting/runtime/SignalStore.js";
import { createDefaultRunManifest } from "../../app/simulation/RunManifest.js";
import { SimulationKernel } from "../../app/simulation/kernel/SimulationKernel.js";
import { createSimulationRuntimeContext } from "../../app/simulation/kernel/SimulationRuntimeContext.js";

if (typeof globalThis.gc !== "function") {
    throw new Error("simulationResetSoakChild requires --expose-gc");
}

function createVehicle() {
    return {
        telemetryId: "ego",
        position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ", set(x, y, z, order) { Object.assign(this, { x, y, z, order }); } },
        velocity: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        acceleration: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        steeringAngle: 0,
        update(dt) {
            this.position.x += this.velocity.x * dt;
        },
    };
}

function createHarness() {
    const telemetry = new SignalStore({}, { sourceId: "reset-soak" });
    const vehicle = createVehicle();
    const vehicles = {
        vehicles: [vehicle],
        async configureFromManifest() {},
        resetRun(initialState) {
            const entry = initialState.vehicles[0];
            vehicle.position.set(
                Number(entry.pose?.position?.x) || 0,
                Number(entry.pose?.position?.y) || 0,
                Number(entry.pose?.position?.z) || 0,
            );
            vehicle.velocity.set(
                Number(entry.linearVelocity?.x) || 0,
                Number(entry.linearVelocity?.y) || 0,
                Number(entry.linearVelocity?.z) || 0,
            );
            vehicle.acceleration.set(0, 0, 0);
            vehicle.steeringAngle = Number(entry.steeringAngle) || 0;
        },
        update(dt) { vehicle.update(dt); },
        getDeterministicState() {
            return [{
                id: vehicle.telemetryId,
                position: { x: vehicle.position.x, y: vehicle.position.y, z: vehicle.position.z },
                velocity: { x: vehicle.velocity.x, y: vehicle.velocity.y, z: vehicle.velocity.z },
                acceleration: { x: vehicle.acceleration.x, y: vehicle.acceleration.y, z: vehicle.acceleration.z },
                steeringAngle: vehicle.steeringAngle,
            }];
        },
    };
    const scripts = {
        signalStore: telemetry,
        setTopicScheduler() {},
        setTopicRouter() {},
        async setManifest() {},
        async prepareResolvedScripts() {},
        resetRun() {},
        update() {},
        getDeterministicState() { return null; },
    };
    const context = createSimulationRuntimeContext({
        telemetry,
        scripts,
        vehicles,
        devices: {
            devices: [],
            configureFromManifest() {},
            resetRun() {},
            update() {},
            deliver() {},
            getDeterministicState() { return []; },
        },
        physics: {
            async configureRun() {},
            resetRun() {},
            beginStep() {},
            step() {},
            syncAndPublishContacts() { return { started: [], active: [], ended: [] }; },
            getDeterministicState() { return null; },
        },
        inputs: { update() {} },
    });
    return { kernel: new SimulationKernel(context), telemetry, vehicles };
}

const manifest = createDefaultRunManifest({
    seed: "reset-soak",
    clock: { stepNs: 10_000_000, maxSteps: 5 },
    initialState: {
        vehicles: [{
            id: "ego",
            type: "big-car",
            pose: { position: {}, rotation: {} },
            linearVelocity: { x: 2, y: 0, z: 0 },
            steeringAngle: 0,
        }],
        signals: {},
    },
    sensorRig: { sensors: [] },
    assertions: [],
});
const resolved = {
    manifest,
    resolvedHash: "b".repeat(64),
    environment: { manifest: { environmentId: manifest.environment.id } },
    bindings: { entries: [] },
    scripts: [],
};
const { kernel, telemetry, vehicles } = createHarness();
await kernel.prepare(resolved);

let expectedTrajectoryHash = null;
const cycle = () => {
    kernel.reset();
    kernel.step(5);
    const result = kernel.finalize();
    expectedTrajectoryHash ??= result.trajectoryHash;
    assert.equal(result.trajectoryHash, expectedTrajectoryHash);
};

for (let index = 0; index < 50; index += 1) cycle();
globalThis.gc();
const baselineHeap = process.memoryUsage().heapUsed;

const cycles = 500;
for (let index = 0; index < cycles; index += 1) {
    cycle();
    if (index % 25 === 0) globalThis.gc();
}
globalThis.gc();
const finalHeap = process.memoryUsage().heapUsed;
const growthBytes = finalHeap - baselineHeap;

assert.ok(growthBytes < 16 * 1024 * 1024, `Heap grew by ${growthBytes} bytes.`);
assert.equal(kernel.inputQueue.getStats().entries, 0);
assert.equal(kernel.resetHandlers.size, 0);
assert.equal(vehicles.vehicles.length, 1);
assert.ok(telemetry.paths().length < 100);

process.stdout.write(`${JSON.stringify({
    cycles,
    baselineHeap,
    finalHeap,
    growthBytes,
    trajectoryHash: expectedTrajectoryHash,
    signalCount: telemetry.paths().length,
})}\n`);
