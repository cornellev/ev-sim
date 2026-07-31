import assert from "node:assert/strict";
import test from "node:test";

import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { TopicInputQueue } from "../app/simulation/TopicInputQueue.js";
import { PhysicsEngine, sweepAabb } from "../app/physics/PhysicsEngine.js";

function harness() {
    const calls = [];
    const vehicleConfigurations = [];
    const store = new SignalStore({}, { sourceId: "deterministic-test" });
    const vehicle = {
        telemetryId: "ego",
        position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ", set(x, y, z, order) { Object.assign(this, { x, y, z, order }); } },
        velocity: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        steeringAngle: 0,
        updatePosition() {},
        updateRotation() {},
        update(dt) { calls.push("vehicle"); this.position.x += this.velocity.x * dt; },
    };
    const runtime = {
        signalStore: store,
        manifest: { enabled: false, bindings: [] },
        setTopicScheduler(handler) { this.scheduler = handler; },
        applyTopicUpdate(info) { calls.push(`input:${info.name}`); store.publishSignal(`topics.${info.name}`, info.value); },
        update() { calls.push("script"); },
    };
    const devices = {
        configureFromManifest() {}, resetSchedule() {},
        update() { calls.push("sensor"); },
        deliver() { calls.push("delivery"); },
    };
    const physics = {
        async configureRun() {}, resetRun() {},
        step() { calls.push("physics"); },
        syncAndPublishContacts() { calls.push("contacts"); },
    };
    const vehicleDatabase = {
        vehicles: [vehicle],
        update: (dt) => vehicle.update(dt),
        async configureFromManifest(...args) { vehicleConfigurations.push(args); },
    };
    const data = {
        bindings: () => runtime,
        vehicles: () => vehicleDatabase,
        devices: () => devices,
        physics: () => physics,
        keys: () => ({ update: () => calls.push("keys") }),
        client: () => ({ get: () => null }),
        baking: () => null,
        earthTilesManager: () => null,
        skyManager: () => null,
    };
    return { engine: new SimulationEngine(data), data, store, runtime, vehicle, calls, vehicleConfigurations };
}

function resolved(manifest) {
    return {
        manifest,
        definitionHash: "a".repeat(64),
        resolvedHash: "b".repeat(64),
        environment: { manifest: { environmentId: manifest.environment.id } },
        bindings: { entries: [] },
    };
}

test("topic input queue orders declared topics before arrival sequence", () => {
    const queue = new TopicInputQueue([
        { name: "/second", direction: "input" },
        { name: "/first", direction: "input" },
    ]);
    queue.enqueue({ name: "/first", value: 1 }, 2);
    queue.enqueue({ name: "/second", value: 2 }, 2);
    queue.enqueue({ name: "/second", value: 3 }, 2);
    assert.deepEqual(queue.drain(1), []);
    assert.deepEqual(queue.drain(2).map((entry) => entry.info.value), [2, 3, 1]);
});

test("manifest clock uses exact integer nanoseconds and fixed module order", async () => {
    const { engine, calls } = harness();
    const manifest = createDefaultRunManifest({
        clock: { stepNs: 20_000_000, pacing: "unbounded", speed: 4, maxSteps: 3 },
        sensorRig: { sensors: [] },
        assertions: [],
    });
    await engine.applyRunManifest(resolved(manifest));
    engine.step(5);
    assert.equal(engine.steps, 3);
    assert.equal(engine.timeNs, 60_000_000);
    assert.equal(engine.time, 0.06);
    assert.deepEqual(engine.lastStepPhases, ["inputs", "scripts", "vehicles", "physics", "contacts", "clock", "sensors", "delivery", "assertions"]);
    assert.deepEqual(calls.slice(-7), ["keys", "script", "vehicle", "physics", "contacts", "sensor", "delivery"]);
});

test("manifest application consumes frozen environment and vehicle dependencies", async () => {
    const { engine, data, store, vehicleConfigurations } = harness();
    const applyOrder = [];
    data.environment = () => ({
        environmentId: "igvc",
        templateId: "igvc",
        name: "Current",
        roadStylePreset: "igvc",
    });
    const loader = {
        manifest: { environmentId: "igvc", templateId: "igvc", document: { marker: "current" } },
        apply(manifest) { applyOrder.push(`apply:${manifest.document.marker}`); },
    };
    engine.setEnvironmentRuntime({
        loader,
        persistence: {
            suspendAutosave() { applyOrder.push("suspend"); },
            resumeAutosave() { applyOrder.push("resume"); },
        },
    });
    const manifest = createDefaultRunManifest({ sensorRig: { sensors: [] } });
    const frozenEnvironment = {
        environmentId: "igvc",
        templateId: "igvc",
        document: { marker: "frozen" },
    };
    const run = {
        ...resolved(manifest),
        environment: { hash: "environment-hash", manifest: frozenEnvironment },
        vehicles: [{ actorId: "ego", vehicleId: "big-car", hash: "vehicle-hash", manifest: {}, assetHashes: {} }],
    };

    await engine.applyRunManifest(run);

    assert.deepEqual(applyOrder, ["suspend", "apply:frozen", "resume"]);
    assert.notEqual(loader.manifest, frozenEnvironment);
    assert.equal(loader.manifest.document.marker, "frozen");
    assert.deepEqual(vehicleConfigurations[0][2].resolvedVehicles, run.vehicles);
    assert.equal(store.read("environment.manifest").value.document.marker, "frozen");
});

test("workspace deactivation pauses without resetting and returning stays paused", () => {
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let nextFrame = 1;
    const cancelled = [];
    globalThis.requestAnimationFrame = () => nextFrame++;
    globalThis.cancelAnimationFrame = (id) => cancelled.push(id);
    try {
        const { engine, store } = harness();
        engine.time = 4;
        engine.timeNs = 4_000_000_000;
        engine.steps = 240;
        engine.play();
        assert.equal(engine.status, "playing");
        assert.equal(engine.looping, true);

        engine.setWorkspaceActive(false);
        assert.equal(engine.status, "paused");
        assert.equal(engine.looping, false);
        assert.equal(engine.time, 4);
        assert.equal(engine.steps, 240);
        assert.equal(store.getTimeUs(), 4_000_000);
        assert.ok(cancelled.length > 0);

        engine.setWorkspaceActive(true);
        assert.equal(engine.status, "paused");
        assert.equal(engine.looping, true);
        assert.equal(engine.time, 4);
        assert.equal(engine.steps, 240);
        assert.equal(store.getTimeUs(), 4_000_000);
    } finally {
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
});

test("hidden experiment diagnostics preserve authoritative playback", () => {
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    const previousCancelAnimationFrame = globalThis.cancelAnimationFrame;
    let nextFrame = 1;
    const cancelled = [];
    globalThis.requestAnimationFrame = () => nextFrame++;
    globalThis.cancelAnimationFrame = (id) => cancelled.push(id);
    try {
        const { engine } = harness();
        engine.play();
        const activeFrame = engine.rafId;

        engine.setWorkspaceActive(false, { preservePlayback: true });

        assert.equal(engine.viewportActive, false);
        assert.equal(engine.status, "playing");
        assert.equal(engine.looping, true);
        assert.equal(engine.rafId, activeFrame);
        assert.deepEqual(cancelled, []);
    } finally {
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
        globalThis.cancelAnimationFrame = previousCancelAnimationFrame;
    }
});

test("queued ackdrive is applied only at a step boundary", async () => {
    const { engine, runtime, vehicle, store } = harness();
    const manifest = createDefaultRunManifest({ sensorRig: { sensors: [] } });
    await engine.applyRunManifest(resolved(manifest));
    runtime.scheduler({ name: "/ackdrive", value: { speed: 10, steering_angle: 5 } });
    assert.equal(vehicle.velocity.x, 0);
    engine.step();
    assert.ok(Math.abs(vehicle.velocity.x - 4.4704) < 1e-12);
    const applied = store.events().find((event) => event.name === "input-applied");
    assert.equal(applied.name, "input-applied");
    assert.equal(applied.payload.step, 1);
});

test("signal assertions stop a run deterministically", async () => {
    const { engine } = harness();
    const manifest = createDefaultRunManifest({
        sensorRig: { sensors: [] },
        assertions: [{
            id: "must-be-fast",
            source: "signal",
            path: "simulation.time",
            operator: "gte",
            expected: 10,
            mode: "always",
            window: { startStep: 1, endStep: 2 },
            severity: "error",
            onFailure: "stop",
        }],
    });
    await engine.applyRunManifest(resolved(manifest));
    engine.play = () => {};
    engine.step();
    assert.equal(engine.status, "paused");
    assert.equal(engine.assertionEngine.snapshot()[0].status, "failed");
});

test("swept colliders clamp at first impact and publish ordered contact transitions", async () => {
    assert.equal(sweepAabb(
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 0, z: 0 },
        { x: 0.5, y: 0.5, z: 0.5 },
        { min: { x: 1.5, y: -0.5, z: -0.5 }, max: { x: 2.5, y: 0.5, z: 0.5 } },
    ), 1 / 3);

    class Body {
        setNextKinematicTranslation(position) { this.position = { ...position }; }
    }
    class World {
        createRigidBody() { return new Body(); }
        createCollider() {}
        step() {}
        free() {}
    }
    const descriptor = () => ({ setTranslation() { return this; } });
    const fakeRapier = {
        World,
        RigidBodyDesc: { fixed: descriptor, kinematicPositionBased: descriptor },
        ColliderDesc: { cuboid: () => ({}) },
    };
    const events = [];
    const vehicle = {
        telemetryId: "ego",
        dimensions: { x: 1, y: 1, z: 1 },
        position: { x: 0, y: 0, z: 0 },
        updatePosition(position) { Object.assign(this.position, position); },
    };
    const data = {
        objects: () => ({ boxes: () => [{ position: { x: 2, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }] }),
        vehicles: () => ({ vehicles: [vehicle] }),
        bindings: () => ({ signalStore: { emitTelemetryEvent: (event) => events.push(event) } }),
    };
    const physics = new PhysicsEngine(data, { loadPhysics: async () => fakeRapier });
    await physics.configureRun();
    physics.beginStep();
    vehicle.position.x = 3;
    physics.step(1 / 60);
    const first = physics.syncAndPublishContacts({ step: 1, timeNs: 16_666_667 });
    assert.ok(vehicle.position.x < 1.000001);
    assert.deepEqual(first.started, ["ego|environment-00001"]);

    physics.beginStep();
    vehicle.position.x = 0;
    physics.step(1 / 60);
    const second = physics.syncAndPublishContacts({ step: 2, timeNs: 33_333_334 });
    assert.deepEqual(second.ended, ["ego|environment-00001"]);
    assert.deepEqual(events.map((event) => event.name), ["contact-start", "contact-end"]);
});

test("manual, realtime, and unbounded pacing produce the same fixed-step state", async () => {
    const manifest = createDefaultRunManifest({
        clock: { stepNs: 20_000_000, pacing: "realtime", speed: 1, maxSteps: 5 },
        initialState: { vehicles: [{ id: "ego", type: "big-car", pose: { position: {}, rotation: {} }, linearVelocity: { x: 3, y: 0, z: 0 }, steeringAngle: 0 }], signals: {} },
        sensorRig: { sensors: [] },
    });
    const manual = harness();
    await manual.engine.applyRunManifest(resolved(manifest));
    manual.engine.step(5);

    const realtime = harness();
    await realtime.engine.applyRunManifest(resolved(manifest));
    realtime.engine._advanceSimulation(0.1);

    const unbounded = harness();
    await unbounded.engine.applyRunManifest(resolved({ ...manifest, clock: { ...manifest.clock, pacing: "unbounded" } }));
    unbounded.engine._advanceSimulation(0);

    const state = ({ engine, vehicle }) => ({ steps: engine.steps, timeNs: engine.timeNs, x: vehicle.position.x });
    assert.deepEqual(state(manual), state(realtime));
    assert.deepEqual(state(manual), state(unbounded));
    assert.deepEqual(state(manual), { steps: 5, timeNs: 100_000_000, x: 0.3 });
});

test("vehicle sweeps prevent fast vehicles from tunneling through each other", async () => {
    class Body { setNextKinematicTranslation(position) { this.position = position; } }
    class World { createRigidBody() { return new Body(); } createCollider() {} step() {} free() {} }
    const descriptor = () => ({ setTranslation() { return this; } });
    const fakeRapier = { World, RigidBodyDesc: { fixed: descriptor, kinematicPositionBased: descriptor }, ColliderDesc: { cuboid: () => ({}) } };
    const makeVehicle = (id, x) => ({ telemetryId: id, dimensions: { x: 1, y: 1, z: 1 }, position: { x, y: 0, z: 0 }, updatePosition(position) { Object.assign(this.position, position); } });
    const left = makeVehicle("a", 0);
    const right = makeVehicle("b", 4);
    const data = {
        objects: () => ({ boxes: () => [] }),
        vehicles: () => ({ vehicles: [right, left] }),
        bindings: () => ({ signalStore: { emitTelemetryEvent() {} } }),
    };
    const physics = new PhysicsEngine(data, { loadPhysics: async () => fakeRapier });
    await physics.configureRun();
    physics.beginStep();
    left.position.x = 3;
    right.position.x = 1;
    physics.step(1 / 60);
    const contacts = physics.syncAndPublishContacts({ step: 1, timeNs: 16_666_667 });
    assert.deepEqual(contacts.started, ["a|b"]);
    assert.ok(left.position.x <= right.position.x);
    assert.ok(right.position.x - left.position.x >= 0.999999);
});

test("reset and replaying the same steps reconstructs the same vehicle state", async () => {
    const target = harness();
    const manifest = createDefaultRunManifest({
        initialState: { vehicles: [{ id: "ego", type: "big-car", pose: { position: {}, rotation: {} }, linearVelocity: { x: 2, y: 0, z: 0 }, steeringAngle: 0 }], signals: {} },
        sensorRig: { sensors: [] },
    });
    await target.engine.applyRunManifest(resolved(manifest));
    target.engine.step(12);
    const first = { x: target.vehicle.position.x, step: target.engine.steps, timeNs: target.engine.timeNs };
    target.engine.reset();
    target.engine.step(12);
    assert.deepEqual({ x: target.vehicle.position.x, step: target.engine.steps, timeNs: target.engine.timeNs }, first);
});
