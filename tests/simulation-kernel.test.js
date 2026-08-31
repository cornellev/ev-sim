import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createSimulationRuntimeContext } from "../app/simulation/kernel/SimulationRuntimeContext.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";

function scenarioRuntime() {
    return {
        active: false,
        terminal: false,
        snapshot: { active: false, step: 0, timeNs: 0, terminal: null },
        configure(resolved) {
            this.active = Boolean(resolved?.scenario?.scenario);
            this.snapshot = {
                active: this.active,
                step: 0,
                timeNs: 0,
                terminal: null,
            };
            return this.getSnapshot();
        },
        reset() {
            this.snapshot.step = 0;
            this.snapshot.timeNs = 0;
            this.snapshot.terminal = null;
        },
        setControlRuntime(runtime) {
            this.controlRuntime = runtime;
        },
        getSnapshot() {
            return structuredClone(this.snapshot);
        },
        preMotion({ step, timeNs }) {
            Object.assign(this.snapshot, { step, timeNs });
            return this.getSnapshot();
        },
        postTelemetry({ step, timeNs }) {
            Object.assign(this.snapshot, { step, timeNs });
            return this.getSnapshot();
        },
        applyExternalTopic() {
            return false;
        },
        observeAssertions() {
            return this.getSnapshot();
        },
        dispose() {},
    };
}

function createHarness() {
    const calls = [];
    const telemetry = new SignalStore({}, { sourceId: "simulation-kernel-test" });
    const vehicle = {
        telemetryId: "ego",
        position: {
            x: 0,
            y: 0,
            z: 0,
            set(x, y, z) { Object.assign(this, { x, y, z }); },
        },
        rotation: {
            x: 0,
            y: 0,
            z: 0,
            order: "XYZ",
            set(x, y, z, order) { Object.assign(this, { x, y, z, order }); },
        },
        velocity: {
            x: 0,
            y: 0,
            z: 0,
            set(x, y, z) { Object.assign(this, { x, y, z }); },
        },
        acceleration: { x: 0, y: 0, z: 0 },
        steeringAngle: 0,
        updatePosition() {},
        updateRotation() {},
    };
    const scripts = {
        signalStore: telemetry,
        setTopicScheduler(handler) { this.scheduler = handler; },
        setTopicRouter() {},
        async setManifest() {},
        async prepareResolvedScripts() {},
        applyTopicUpdate(info) { calls.push(`input:${info.name}`); },
        update() { calls.push("scripts"); },
    };
    const vehicles = {
        vehicles: [vehicle],
        async configureFromManifest() {},
        update(dt) {
            calls.push("vehicles");
            vehicle.position.x += vehicle.velocity.x * dt;
        },
    };
    const devices = {
        devices: [],
        configureFromManifest() {},
        resetSchedule() {},
        update() { calls.push("sensors"); },
        deliver() { calls.push("delivery"); },
    };
    const physics = {
        async configureRun() {},
        resetRun() {},
        beginStep() { calls.push("physics-begin"); },
        step() { calls.push("physics"); },
        syncAndPublishContacts() {
            calls.push("contacts");
            return { started: [], active: [], ended: [] };
        },
    };
    const context = createSimulationRuntimeContext({
        telemetry,
        inputs: { update: () => calls.push("inputs") },
        scripts,
        vehicles,
        devices,
        physics,
        scenarios: scenarioRuntime(),
    });
    return { calls, context, scripts, telemetry, vehicle };
}

function resolvedRun(manifest) {
    return {
        manifest,
        definitionHash: "a".repeat(64),
        resolvedHash: "b".repeat(64),
        environment: { manifest: { environmentId: manifest.environment.id } },
        bindings: { entries: [] },
        scripts: [],
        vehicles: [],
    };
}

test("SimulationKernel imports and steps without browser or graphics globals", async () => {
    const names = [
        "window",
        "document",
        "navigator",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "WebGLRenderingContext",
        "WebGL2RenderingContext",
    ];
    const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    try {
        for (const name of names) {
            Object.defineProperty(globalThis, name, {
                configurable: true,
                value: undefined,
                writable: true,
            });
        }

        const { SimulationKernel } = await import("../app/simulation/kernel/SimulationKernel.js");
        const target = createHarness();
        const manifest = createDefaultRunManifest({
            clock: {
                stepNs: 20_000_000,
                pacing: "unbounded",
                maxSteps: 2,
                modules: { physics: true },
            },
            sensorRig: { sensors: [] },
            assertions: [],
        });
        const kernel = new SimulationKernel(target.context);
        await kernel.configureRun(resolvedRun(manifest));

        target.scripts.scheduler({
            name: "/controls/command",
            typeStr: "sensor_fusion_msgs/StampedAckermannDrive",
            value: {
                header: { stamp: { sec: 0, nanosec: 0 }, frame_id: "base_link" },
                sequence: 1,
                mode: "velocity",
                deadline_ns: 0,
                steering_angle: 0,
                steering_angle_velocity: 0,
                speed: 1,
                acceleration: 0,
                jerk: 0,
            },
        });
        kernel.step(1);

        assert.equal(kernel.steps, 1);
        assert.equal(kernel.timeNs, 20_000_000);
        assert.equal(kernel.time, 0.02);
        assert.deepEqual(kernel.lastStepPhases, [
            "inputs",
            "scripts",
            "controls",
            "vehicles",
            "physics",
            "controls-achieved",
            "contacts",
            "clock",
            "transforms",
            "sensors",
            "delivery",
            "candidate-viz",
            "assertions",
        ]);
        assert.deepEqual(target.calls, [
            "inputs",
            "input:/controls/command",
            "scripts",
            "physics-begin",
            "vehicles",
            "physics",
            "contacts",
            "sensors",
            "delivery",
        ]);
        assert.equal(Object.hasOwn(kernel.getSnapshot(), "frames"), false);
    } finally {
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});

test("kernel snapshots are defensive, structured-cloneable state values", async () => {
    const { SimulationKernel } = await import("../app/simulation/kernel/SimulationKernel.js");
    const target = createHarness();
    const manifest = createDefaultRunManifest({
        clock: { stepNs: 10_000_000, maxSteps: 1 },
        sensorRig: { sensors: [] },
        assertions: [],
    });
    const kernel = new SimulationKernel(target.context);
    await kernel.configureRun(resolvedRun(manifest));
    kernel.step();

    const snapshot = kernel.getSnapshot();
    const cloned = structuredClone(snapshot);
    assert.deepEqual(cloned, snapshot);
    snapshot.modules.physics = !kernel.modules.physics;
    snapshot.assertions.push({ id: "mutated" });
    assert.notEqual(snapshot.modules.physics, kernel.modules.physics);
    assert.equal(kernel.assertionEngine.snapshot().length, 0);
});

test("managed kernel lifecycle finalizes idempotently and requires reset before more steps", async () => {
    const { SimulationKernel } = await import("../app/simulation/kernel/SimulationKernel.js");
    const target = createHarness();
    const manifest = createDefaultRunManifest({
        seed: "lifecycle-seed",
        clock: { stepNs: 10_000_000, maxSteps: 3 },
        sensorRig: { sensors: [] },
        assertions: [],
    });
    const kernel = new SimulationKernel(target.context);
    await kernel.prepare(resolvedRun(manifest));
    assert.equal(kernel.lifecycleState, "prepared");
    const initialEpisodeHash = kernel.episodeHash;
    const initialTrajectoryHash = kernel.trajectoryHash;

    kernel.step();
    assert.equal(kernel.lifecycleState, "stepping");
    assert.notEqual(kernel.trajectoryHash, initialTrajectoryHash);

    const first = kernel.finalize({ status: "completed" });
    const second = kernel.finalize({ status: "ignored" });
    assert.deepEqual(second, first);
    assert.equal(kernel.lifecycleState, "finalized");
    assert.throws(() => kernel.step(), /finalized episode/);
    assert.throws(() => kernel.play(), /finalized episode/);

    kernel.reset({ resetSeed: "next-seed" });
    assert.equal(kernel.lifecycleState, "prepared");
    assert.equal(kernel.steps, 0);
    assert.notEqual(kernel.episodeHash, initialEpisodeHash);
    kernel.step();

    kernel.dispose();
    kernel.dispose();
    assert.equal(kernel.lifecycleState, "disposed");
    assert.throws(() => kernel.step(), /disposed simulation kernel/);
});

test("same episode reset reconstructs production trajectory hash", async () => {
    const { SimulationKernel } = await import("../app/simulation/kernel/SimulationKernel.js");
    const target = createHarness();
    const manifest = createDefaultRunManifest({
        seed: "repeat-seed",
        clock: { stepNs: 10_000_000, maxSteps: 2 },
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
    const kernel = new SimulationKernel(target.context);
    await kernel.prepare(resolvedRun(manifest));
    kernel.step(2);
    const first = kernel.trajectoryHash;

    kernel.reset();
    kernel.step(2);
    assert.equal(kernel.trajectoryHash, first);
});

test("runtime facade disposes prepared components in reverse dependency order", async () => {
    const [{ SimulationKernel }, { createSimulationRuntimeContext }, { SignalStore }] = await Promise.all([
        import("../app/simulation/kernel/SimulationKernel.js"),
        import("../app/simulation/kernel/SimulationRuntimeContext.js"),
        import("../app/scripting/runtime/SignalStore.js"),
    ]);
    const calls = [];
    const scripts = {
        signalStore: new SignalStore({}, { sourceId: "lifecycle-order" }),
        setTopicScheduler() {},
        setTopicRouter() {},
        async setManifest() {},
        async prepareResolvedScripts() {},
        resetRun() { calls.push("scripts-reset"); },
        finalizeRun() { calls.push("scripts-finalize"); },
        disposeRun() { calls.push("scripts-dispose"); },
        update() {},
    };
    const manager = (name) => ({
        vehicles: [],
        devices: [],
        async configureFromManifest() { calls.push(`${name}-prepare`); },
        async configureRun() { calls.push(`${name}-prepare`); },
        resetRun() { calls.push(`${name}-reset`); },
        finalizeRun() { calls.push(`${name}-finalize`); },
        disposeRun() { calls.push(`${name}-dispose`); },
        update() {},
        deliver() {},
        beginStep() {},
        step() {},
        syncAndPublishContacts() { return { started: [], active: [], ended: [] }; },
    });
    const scenarioRuntime = {
        active: false,
        configure() {},
        reset() { calls.push("scenario-reset"); },
        finalize() { calls.push("scenario-finalize"); return null; },
        dispose() { calls.push("scenario-dispose"); },
        getSnapshot() { return null; },
    };
    const context = createSimulationRuntimeContext({
        telemetry: scripts.signalStore,
        scripts,
        scenarios: scenarioRuntime,
        vehicles: manager("vehicles"),
        devices: manager("devices"),
        physics: manager("physics"),
        inputs: {
            update() {},
            resetRun() { calls.push("inputs-reset"); },
            finalizeRun() { calls.push("inputs-finalize"); },
            disposeRun() { calls.push("inputs-dispose"); },
        },
        applyEnvironment() { calls.push("environment-prepare"); },
        resetEnvironment() { calls.push("environment-reset"); },
        finalizeEnvironment() { calls.push("environment-finalize"); },
        disposeEnvironment() { calls.push("environment-dispose"); },
    });
    const kernel = new SimulationKernel(context);
    await kernel.prepare(resolvedRun(createDefaultRunManifest({
        sensorRig: { sensors: [] },
        assertions: [],
    })));
    kernel.finalize();
    kernel.dispose();

    assert.deepEqual(calls.slice(-7), [
        "scenario-dispose",
        "physics-dispose",
        "devices-dispose",
        "vehicles-dispose",
        "scripts-dispose",
        "inputs-dispose",
        "environment-dispose",
    ]);
});
