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
