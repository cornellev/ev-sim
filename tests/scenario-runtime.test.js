import assert from "node:assert/strict";
import test from "node:test";

import { ScenarioRuntime } from "../app/scenarios/ScenarioRuntime.js";
import { createScenarioRandom } from "../app/scenarios/ScriptContracts.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { RunSessionController } from "../app/simulation/RunSessionController.js";

function vector(x = 0, y = 0, z = 0) {
    return { x, y, z, set(a, b, c) { Object.assign(this, { x: a, y: b, z: c }); } };
}

function vehicle(id, x = 0, z = 0) {
    return {
        telemetryId: id,
        position: vector(x, 0, z),
        rotation: { ...vector(), order: "XYZ", set(a, b, c, order = "XYZ") { Object.assign(this, { x: a, y: b, z: c, order }); } },
        velocity: vector(),
        steeringAngle: 0,
        update(dt) { this.position.x += this.velocity.x * dt; },
        updatePosition() {},
        updateRotation() {},
    };
}

function route(actorId = "ego", controller = { kind: "route-follower", activation: { kind: "start" } }) {
    const polyline = [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }];
    return {
        id: `${actorId}-route`,
        actorId,
        name: `${actorId} route`,
        initialSpeedMps: 2,
        controller,
        waypoints: [
            { id: "start", position: polyline[0], kind: "start" },
            { id: "finish", position: polyline[1], kind: "finish" },
        ],
        verification: {
            polyline,
            totalLength: 10,
            sections: [{ index: 0, polyline, length: 10 }],
        },
    };
}

function scenario(overrides = {}) {
    return {
        kind: "cev-sim.scenario",
        version: 1,
        id: "scenario-test",
        actors: [{ id: "ego", role: "ego", name: "Ego" }],
        routes: [route()],
        zones: [],
        triggers: [],
        completion: { conditions: [{ id: "limit", name: "Limit", kind: "max-duration", durationNs: 10_000_000_000 }] },
        expectedOutcomes: [],
        ...overrides,
    };
}

function runtimeHarness(definition, options = {}) {
    const store = new SignalStore({}, { sourceId: "scenario-runtime-test" });
    const vehicles = options.vehicles ?? [vehicle("ego")];
    const devices = options.devices ?? [];
    const data = {
        bindings: () => ({ signalStore: store }),
        vehicles: () => ({ vehicles }),
        devices: () => ({ devices }),
    };
    const runtime = new ScenarioRuntime(data, { telemetry: store, scriptFactory: options.scriptFactory });
    runtime.configure({
        manifest: {
            seed: options.seed ?? "17",
            scenario: { sensorBindings: options.sensorBindings ?? {} },
            topics: options.topics ?? [],
        },
        scenario: { scenario: definition, parameters: { bindings: options.parameterBindings ?? [] } },
        scripts: options.scripts ?? [],
    });
    return { runtime, store, vehicles, devices };
}

test("time triggers run before motion, disturbances expire deterministically, and zones terminate after telemetry", () => {
    const definition = scenario({
        routes: [route("ego", { kind: "route-follower", activation: { kind: "flag", flag: "go" } })],
        zones: [{ id: "finish-zone", center: { x: 0, y: 0, z: 0 }, size: { x: 2, y: 2, z: 2 } }],
        triggers: [
            {
                id: "start",
                name: "Start",
                once: true,
                enabled: true,
                condition: { kind: "time", timeNs: 0 },
                actions: [
                    { kind: "set-flag", flag: "go", value: true },
                    { kind: "actor-command", actorId: "ego", speedMps: 7, steeringRad: 0.2, durationNs: 2 },
                ],
            },
            {
                id: "finish",
                name: "Finish zone entered",
                once: true,
                enabled: true,
                condition: { kind: "zone-enter", actorId: "ego", zoneId: "finish-zone" },
                actions: [{ kind: "finish" }],
            },
        ],
        expectedOutcomes: [{ id: "reached", name: "Reached", kind: "finish-zone", required: true }],
    });
    const { runtime, vehicles, store } = runtimeHarness(definition);

    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    assert.equal(store.read("scenario.flags.go").value, true);
    assert.equal(vehicles[0].velocity.x, 7);
    assert.equal(vehicles[0].steeringAngle, 0.2);

    runtime.preMotion({ step: 2, timeNs: 3, dt: 0.01 });
    assert.equal(vehicles[0].velocity.x, 2);
    const terminal = runtime.postTelemetry({ step: 2, timeNs: 3, contacts: { started: [] } }).terminal;
    assert.equal(terminal.reason, "trigger");
    assert.equal(runtime.getSnapshot().latestTrigger.id, "finish");

    const result = runtime.finalize();
    assert.equal(result.completed, true);
    assert.equal(result.passed, true);
    assert.equal(result.outcomes[0].status, "passed");
});

test("flag-started script controllers stop while false and seeded runners reconstruct on reset", () => {
    const samples = [];
    const gains = [];
    const scriptFactory = (_artifact, options) => ({
        run(inputs) {
            const sample = options.runtimeContext.random();
            samples.push(sample);
            gains.push(inputs.gain);
            return { commandedSpeed: sample * inputs.gain, commandedSteering: 0.1 };
        },
    });
    const definition = scenario({
        routes: [route("ego", {
            kind: "script-with-route",
            activation: { kind: "flag", flag: "enabled" },
            scriptId: "controller",
            inputs: [{ source: "route", input: "route" }],
            outputs: [
                { output: "commandedSpeed", target: "speed" },
                { output: "commandedSteering", target: "steering" },
            ],
        })],
    });
    const { runtime, vehicles, store } = runtimeHarness(definition, {
        scriptFactory,
        scripts: [{ scriptId: "controller", artifact: { id: "controller" } }],
        parameterBindings: [{
            id: "gain",
            type: "float64",
            value: 5,
            target: { kind: "script-input", scriptId: "controller", input: "gain" },
        }],
    });

    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    assert.equal(samples.length, 0);
    assert.equal(vehicles[0].velocity.x, 0);
    runtime.setFlag("enabled", true);
    runtime.preMotion({ step: 2, timeNs: 2, dt: 0.01 });
    const first = vehicles[0].velocity.x;
    assert.ok(first > 0);
    runtime.setFlag("enabled", false);
    runtime.preMotion({ step: 3, timeNs: 3, dt: 0.01 });
    assert.equal(vehicles[0].velocity.x, 0);

    runtime.reset();
    runtime.setFlag("enabled", true);
    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    assert.equal(vehicles[0].velocity.x, first);
    assert.equal(samples[0], samples[1]);
    assert.deepEqual(gains, [5, 5]);
    runtime.reset();
    assert.equal(store.read("scenario.flags.enabled").exists, false);

    const streamA = createScenarioRandom("seed", "a");
    const streamB = createScenarioRandom("seed", "b");
    assert.notEqual(streamA(), streamB());
});

test("completion predicates honor cadence and end-only outcomes execute exactly once", () => {
    let finishCalls = 0;
    let outcomeCalls = 0;
    const scriptFactory = (artifact) => ({
        run() {
            if (artifact.id === "finish") {
                finishCalls += 1;
                return { finished: true };
            }
            outcomeCalls += 1;
            return { passed: true };
        },
    });
    const definition = scenario({
        completion: {
            conditions: [{
                id: "script-finish",
                name: "Script finish",
                kind: "script",
                scriptId: "finish",
                cadence: { kind: "every-n-steps", everyN: 2 },
                onError: "fail",
            }],
        },
        expectedOutcomes: [{ id: "script-outcome", name: "Script outcome", kind: "script", scriptId: "outcome", required: true }],
    });
    const { runtime } = runtimeHarness(definition, {
        scriptFactory,
        scripts: [
            { scriptId: "finish", artifact: { id: "finish" } },
            { scriptId: "outcome", artifact: { id: "outcome" } },
        ],
    });

    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    runtime.postTelemetry({ step: 1, timeNs: 1 });
    assert.equal(finishCalls, 0);
    assert.equal(outcomeCalls, 0);
    assert.equal(runtime.getSnapshot().outcomes[0].status, "pending");

    runtime.preMotion({ step: 2, timeNs: 2, dt: 0.01 });
    runtime.postTelemetry({ step: 2, timeNs: 2 });
    assert.equal(finishCalls, 1);
    assert.equal(runtime.getSnapshot().terminal.reason, "finish-predicate");
    const first = runtime.finalize();
    const second = runtime.finalize();
    assert.equal(outcomeCalls, 1);
    assert.deepEqual(first, second);
    assert.equal(first.passed, true);
});

test("run state reset clears signal values, histories, events, and pending transactions", () => {
    const store = new SignalStore({}, { sourceId: "isolation" });
    store.publishSignal("environment.manifest", { id: "map" });
    store.publishSignal("scenario.flags.old", true, { timeUs: 10 });
    store.record("vehicles.ego.speed", 3, { timeUs: 10 });
    store.emitTelemetryEvent({ category: "scenario", name: "old-event" });
    store.write("scenario.pending", 1);

    store.resetRunState();
    assert.equal(store.read("environment.manifest").exists, true);
    assert.equal(store.read("scenario.flags.old").exists, false);
    assert.deepEqual(store.history("vehicles.ego.speed"), []);
    assert.deepEqual(store.events(), []);
    assert.deepEqual(store.pendingSnapshot(), {});
});

test("sensor disturbances override and restore enabled and deterministic dropout state", () => {
    const sensor = {
        telemetryId: "front-lidar",
        enabled: true,
        config: { noise: { dropoutProbability: 0.1 } },
        setEnabled(value) { this.enabled = Boolean(value); },
    };
    const definition = scenario({
        sensorAliases: [{ id: "lidar", type: "lidar3d" }],
        triggers: [{
            id: "dropout",
            name: "Temporary dropout",
            once: true,
            enabled: true,
            condition: { kind: "time", timeNs: 0 },
            actions: [{
                kind: "sensor-state",
                sensorAlias: "lidar",
                enabled: false,
                dropoutProbability: 0.75,
                durationNs: 2,
            }],
        }],
    });
    const { runtime } = runtimeHarness(definition, {
        devices: [sensor],
        sensorBindings: { lidar: "front-lidar" },
    });
    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    assert.equal(sensor.enabled, false);
    assert.equal(sensor.config.noise.dropoutProbability, 0.75);
    runtime.preMotion({ step: 2, timeNs: 3, dt: 0.01 });
    assert.equal(sensor.enabled, true);
    assert.equal(sensor.config.noise.dropoutProbability, 0.1);

    runtime.reset();
    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    runtime.reset();
    assert.equal(sensor.enabled, true);
    assert.equal(sensor.config.noise.dropoutProbability, 0.1);
});

test("inactive flag-started External ROS controllers consume commands and hold the actor stopped", () => {
    const definition = scenario({
        routes: [route("ego", {
            kind: "external-ros",
            activation: { kind: "flag", flag: "external-enabled" },
            topicId: "ego-command",
        })],
    });
    const { runtime, vehicles } = runtimeHarness(definition, {
        topics: [{ id: "ego-command", name: "/ackdrive", direction: "input" }],
    });

    assert.equal(runtime.applyExternalTopic({
        name: "/ackdrive",
        value: { speedMps: 5, steeringRad: 0.2 },
    }), true);
    assert.equal(vehicles[0].velocity.x, 0);
    assert.equal(vehicles[0].steeringAngle, 0);

    runtime.setFlag("external-enabled", true);
    runtime.applyExternalTopic({
        name: "/ackdrive",
        value: { speedMps: 5, steeringRad: 0.2 },
    });
    assert.equal(vehicles[0].velocity.x, 5);
    assert.equal(vehicles[0].steeringAngle, -0.2);

    runtime.setFlag("external-enabled", false);
    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    assert.equal(vehicles[0].velocity.x, 0);
    assert.equal(vehicles[0].steeringAngle, 0);
    runtime.applyExternalTopic({
        name: "/ackdrive",
        value: { speedMps: 9, steeringRad: -0.4 },
    });
    assert.equal(vehicles[0].velocity.x, 0);
    assert.equal(vehicles[0].steeringAngle, 0);
});

test("actor-command expiry restores the latest External ROS command deterministically", () => {
    const definition = scenario({
        routes: [route("ego", {
            kind: "external-ros",
            activation: { kind: "start" },
            topicId: "ego-command",
        })],
        triggers: [{
            id: "temporary-override",
            name: "Temporary override",
            once: true,
            enabled: true,
            condition: { kind: "time", timeNs: 0 },
            actions: [{
                kind: "actor-command",
                actorId: "ego",
                speedMps: 7,
                steeringRad: 0.25,
                durationNs: 2,
            }],
        }],
    });
    const { runtime, vehicles } = runtimeHarness(definition, {
        topics: [{ id: "ego-command", name: "/ackdrive", direction: "input" }],
    });

    runtime.applyExternalTopic({
        name: "/ackdrive",
        value: { speedMps: 3, steeringRad: 0.1 },
    });
    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    assert.equal(vehicles[0].velocity.x, 7);
    assert.equal(vehicles[0].steeringAngle, 0.25);

    runtime.applyExternalTopic({
        name: "/ackdrive",
        value: { speedMps: 4, steeringRad: 0.15 },
    });
    assert.equal(vehicles[0].velocity.x, 7);
    assert.equal(vehicles[0].steeringAngle, 0.25);
    runtime.preMotion({ step: 2, timeNs: 2, dt: 0.01 });
    assert.equal(vehicles[0].velocity.x, 7);

    runtime.preMotion({ step: 3, timeNs: 3, dt: 0.01 });
    assert.equal(vehicles[0].velocity.x, 4);
    assert.equal(vehicles[0].steeringAngle, -0.15);

    runtime.reset();
    runtime.preMotion({ step: 1, timeNs: 1, dt: 0.01 });
    runtime.preMotion({ step: 2, timeNs: 2, dt: 0.01 });
    runtime.preMotion({ step: 3, timeNs: 3, dt: 0.01 });
    assert.equal(vehicles[0].velocity.x, 0);
    assert.equal(vehicles[0].steeringAngle, 0);
});

test("scenario-rejected Ego commands never fall through to the legacy direct /ackdrive path", () => {
    const ego = vehicle("ego");
    ego.velocity.x = 1.5;
    ego.steeringAngle = 0.05;
    const bindings = { applyTopicUpdate() {} };
    const data = {
        bindings: () => bindings,
        vehicles: () => ({ vehicles: [ego] }),
    };
    const engine = new SimulationEngine(data);
    engine.resolvedRun = { manifest: { id: "scenario-run" } };
    engine.scenarioRuntime.active = true;
    engine.scenarioRuntime.applyExternalTopic = () => false;
    engine.inputQueue.enqueue({
        name: "/ackdrive",
        value: { speed: 20, steering_angle: 30 },
    }, 1);

    engine._applyQueuedInputs(1);
    assert.equal(ego.velocity.x, 1.5);
    assert.equal(ego.steeringAngle, 0.05);

    engine.scenarioRuntime.active = false;
    engine.inputQueue.enqueue({
        name: "/ackdrive",
        value: { speed: 20, steering_angle: 30 },
    }, 2);
    engine._applyQueuedInputs(2);
    assert.equal(ego.velocity.x, 20 * 0.44704);
    assert.equal(ego.steeringAngle, -30 * Math.PI / 180);
});

test("SimulationEngine exposes the two scenario phases only for scenario runs", async () => {
    const store = new SignalStore({}, { sourceId: "scenario-engine" });
    const ego = vehicle("ego");
    const runtime = {
        signalStore: store,
        setTopicScheduler() {},
        async setManifest() {},
        async prepareResolvedScripts() {},
        update() {},
        applyTopicUpdate() {},
    };
    const data = {
        bindings: () => runtime,
        vehicles: () => ({ vehicles: [ego], async configureFromManifest() {}, update: (dt) => ego.update(dt) }),
        devices: () => ({ devices: [], configureFromManifest() {}, resetSchedule() {}, update() {}, deliver() {} }),
        physics: () => ({ async configureRun() {}, resetRun() {}, beginStep() {}, step() {}, syncAndPublishContacts: () => ({ started: [] }) }),
        keys: () => ({ update() {} }),
        client: () => ({ get: () => null }),
        baking: () => null,
        earthTilesManager: () => null,
        skyManager: () => null,
    };
    const engine = new SimulationEngine(data);
    const manifest = createDefaultRunManifest({
        scenario: { id: "scenario-test", egoVehicleId: "big-car" },
        sensorRig: { sensors: [] },
        assertions: [],
    });
    await engine.applyRunManifest({
        manifest,
        definitionHash: "definition",
        resolvedHash: "resolved",
        environment: { manifest: { environmentId: "igvc" } },
        bindings: { entries: [] },
        scripts: [],
        scenario: { scenario: scenario({ completion: { conditions: [] } }), parameters: { bindings: [] } },
    });
    engine.step();
    assert.deepEqual(engine.lastStepPhases, [
        "inputs",
        "scripts",
        "scenario-before-motion",
        "vehicles",
        "physics",
        "contacts",
        "clock",
        "transforms",
        "sensors",
        "delivery",
        "candidate-viz",
        "scenario-after-telemetry",
        "assertions",
    ]);
});

test("run finalization records scenario semantics and finalized log id", async () => {
    const controller = new RunSessionController();
    controller.snapshot.activeRunId = "run-1";
    controller.snapshot.activeResolved = {
        manifest: { id: "manifest-1" },
        resolvedHash: "hash",
        scenario: { scenario: { id: "scenario-1" } },
    };
    controller._recordingRunId = "run-1";
    controller.recording = {
        session: { id: "log-pending" },
        addAttachment() {},
        async stop() { return { id: "log-final" }; },
    };
    const simulation = {
        steps: 4,
        timeNs: 2_000_000_000,
        assertionEngine: { finalize: () => ({ results: [] }) },
        scenarioRuntime: {
            observeAssertions() {},
            finalize: () => ({
                completed: true,
                passed: true,
                status: "completed",
                terminationReason: "trigger",
                latestTrigger: { id: "finish" },
                outcomes: [{ id: "safe", status: "passed" }],
                metrics: { duration: 2 },
                terminalEvent: { reason: "trigger" },
            }),
        },
        stop() {},
    };
    controller.data = { simulation: () => simulation };

    const result = await controller.stop({ status: "completed" });
    assert.equal(result.completed, true);
    assert.equal(result.passed, true);
    assert.equal(result.terminationReason, "trigger");
    assert.equal(result.logId, "log-final");
});

test("scenario metrics publish deterministically, finalize idempotently, and resolve ego collisions by actor id", () => {
    const environment = {
        environmentId: "metrics-corridor",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0 },
                { id: "b", x: 40, y: 0, z: 0 },
            ],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", width: 8, bidirectional: true },
            ],
        },
    };
    const ego = vehicle("hero-1", 0, 0);
    ego.collisionDimensions = { x: 4, y: 1.5, z: 2 };
    const definition = scenario({
        actors: [{ id: "hero-1", role: "ego", name: "Hero" }],
        routes: [route("hero-1")],
        completion: { conditions: [{ id: "limit", name: "Limit", kind: "max-duration", durationNs: 10_000_000_000 }] },
    });
    const store = new SignalStore({}, { sourceId: "scenario-metrics-runtime" });
    const data = {
        bindings: () => ({ signalStore: store }),
        vehicles: () => ({ vehicles: [ego] }),
        devices: () => ({ devices: [] }),
        environment: () => ({
            environmentId: "metrics-corridor",
            toManifest: () => environment,
            getDocument: () => environment,
        }),
    };
    const runtime = new ScenarioRuntime(data, { telemetry: store });
    runtime.configure({
        manifest: {
            seed: "17",
            initialState: {
                vehicles: [{
                    id: "hero-1",
                    type: "scenario-car",
                    keyframes: [
                        { t: 0, x: 0, y: 0 },
                        { t: 1, x: 10, y: 0 },
                    ],
                }],
            },
            topics: [],
        },
        environment: { manifest: environment },
        scenario: { scenario: definition, parameters: { bindings: [] } },
        scripts: [],
    });

    runtime.preMotion({ step: 1, timeNs: 0, dt: 0.1 });
    runtime.postTelemetry({ step: 1, timeNs: 0, dt: 0.1, contacts: { started: [] } });
    ego.position.x = 5;
    runtime.preMotion({ step: 2, timeNs: 100_000_000, dt: 0.1 });
    runtime.postTelemetry({
        step: 2,
        timeNs: 100_000_000,
        dt: 0.1,
        contacts: { started: ["hero-1|barrel-1"] },
    });

    assert.equal(runtime.getSnapshot().egoCollisionCount, 1);
    assert.equal(store.read("scenario.metrics.route-progress").value, 5);
    assert.equal(store.read("scenario.metrics.failure").value, 1);
    assert.ok(Number.isFinite(store.read("scenario.metrics.log-divergence").value));

    const first = runtime.finalize();
    const second = runtime.finalize();
    assert.deepEqual(first.metrics, second.metrics);
    assert.equal(first.passed, first.completed && first.metrics["expected-outcome-failures"] === 0);
    assert.equal(first.metrics.failure, 1);
    assert.equal(first.metrics["route-progress"], 5);
    // failure is metric-only and does not force passed=false by itself when outcomes/assertions are clean
    // (this scenario has empty expected outcomes and no assertions).
});

test("scenario metrics stay unavailable when road and keyframe prerequisites are missing", () => {
    const { runtime, store } = runtimeHarness(scenario({
        routes: [],
        completion: { conditions: [] },
    }));
    runtime.preMotion({ step: 1, timeNs: 0, dt: 0.1 });
    runtime.postTelemetry({ step: 1, timeNs: 0, dt: 0.1, contacts: { started: [] } });
    assert.equal(store.read("scenario.metrics.off-road").value, null);
    assert.equal(store.read("scenario.metrics.wrong-way").value, null);
    assert.equal(store.read("scenario.metrics.log-divergence").value, null);
    const result = runtime.finalize();
    assert.equal(result.metrics["off-road"], null);
    assert.equal(result.metrics.failure, null);
});
