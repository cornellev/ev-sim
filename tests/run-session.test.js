import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { RunSessionController } from "../app/simulation/RunSessionController.js";
import { RUN_STOP_TIMEOUT_MS } from "../app/simulation/AsyncCancellation.js";

function controllerFor(policy, start) {
    const controller = new RunSessionController();
    const manifest = createDefaultRunManifest({ logging: { policy, profileId: "simulation-run-full-sensors" } });
    controller.snapshot.activeRunId = "run-test";
    controller.snapshot.status = "paused";
    controller.snapshot.activeResolved = {
        version: 13,
        manifest,
        definitionHash: "definition",
        resolvedHash: "resolved",
        environment: { manifest: { environmentId: "igvc" } },
        scripts: [],
        bindings: { entries: [] },
    };
    controller.data = {
        renderer: null,
        bindings: () => ({ manifest: null, _scripts: new Map() }),
        environment: () => ({ environmentId: "igvc" }),
        simulation: () => ({ getSnapshot: () => ({ status: "paused" }) }),
        client: () => ({ catalogHash: "catalog" }),
    };
    controller.recording = { start, attachSimulation() {} };
    return controller;
}

test("engine pause leaves a prepared or stopped run unchanged and pauses a running one", () => {
    const controller = new RunSessionController();
    let emit = null;
    controller.recording = { attachSimulation() {} };
    controller.attachData({
        simulation: () => ({
            setScenarioDiagnosticsEnabled() {},
            subscribe(listener) {
                emit = listener;
                return () => {};
            },
        }),
    });
    controller.snapshot.activeRunId = "run-test";

    controller.snapshot.status = "ready";
    emit({ status: "paused", assertions: [], steps: 0, time: 0, timeNs: 0 });
    assert.equal(controller.snapshot.status, "ready");

    controller.snapshot.status = "stopped";
    emit({ status: "paused", assertions: [], steps: 0, time: 0, timeNs: 0 });
    assert.equal(controller.snapshot.status, "stopped");

    controller.snapshot.status = "running";
    emit({ status: "paused", assertions: [], steps: 1, time: 0.02, timeNs: 20_000_000 });
    assert.equal(controller.snapshot.status, "paused");
});

test("required logging rejects the run before the first step when storage cannot open", async () => {
    const controller = controllerFor("required", async () => { throw new Error("storage offline"); });
    await assert.rejects(controller._ensureRecording(), /storage offline/);
    assert.equal(controller._recordingRunId, null);
});

test("optional logging marks a run degraded while disabled logging does not open a session", async () => {
    let optionalAttempts = 0;
    const optional = controllerFor("optional", async () => { optionalAttempts += 1; throw new Error("storage offline"); });
    await optional._ensureRecording();
    assert.equal(optionalAttempts, 1);
    assert.equal(optional.snapshot.degraded, true);
    assert.equal(optional._recordingRunId, "run-test");

    let disabledAttempts = 0;
    const disabled = controllerFor("disabled", async () => { disabledAttempts += 1; });
    await disabled._ensureRecording();
    assert.equal(disabledAttempts, 0);
});

test("optional log finalization failures degrade rather than fail a completed run", async () => {
    const controller = controllerFor("optional", async () => {});
    controller._recordingRunId = "run-test";
    controller.recording = {
        session: { id: "log-pending" },
        addAttachment() {},
        async stop() { throw new Error("schema validation failed"); },
    };
    controller.data = {
        ...controller.data,
        simulation: () => ({
            steps: 10,
            timeNs: 1_000_000_000,
            assertionEngine: { finalize: () => ({ results: [] }) },
            stop() {},
        }),
    };

    const result = await controller.stop({ status: "completed" });
    assert.equal(result.completed, true);
    assert.equal(result.passed, true);
    assert.equal(result.logId, "log-pending");
    assert.equal(controller.snapshot.degraded, true);
    assert.match(controller.snapshot.error, /Optional log finalization failed/);
});

test("run recording options include immutable manifest attachment and provenance", async () => {
    let options;
    const controller = controllerFor("required", async (value) => { options = value; });
    await controller._ensureRecording();
    assert.equal(options.runId, "run-test");
    assert.equal(options.resolvedHash, "resolved");
    assert.equal(options.timeBase, "simulation");
    assert.equal(options.provenance.orchestratorCatalogHash, undefined);
    assert.equal(options.haltSimulationOnError, true);
    assert.ok(options.attachments.some((attachment) => attachment.name === "run-manifest.json"));

    let optionalOptions;
    const optional = controllerFor("optional", async (value) => { optionalOptions = value; });
    await optional._ensureRecording();
    assert.equal(optionalOptions.haltSimulationOnError, false);
});

test("prepare waits for a switched environment to mount and apply the resolved run", async () => {
    const controller = new RunSessionController();
    const applied = [];
    const makeData = (environmentId) => {
        const simulation = {
            subscribe(listener) { listener({ status: "paused", assertions: [] }); return () => {}; },
            async applyRunManifest(value) { applied.push(value.resolvedHash); },
        };
        return {
            environment: () => ({ environmentId }),
            simulation: () => simulation,
            client: () => ({ preflight: async () => ({ ok: true, issues: [] }) }),
        };
    };
    const detach = controller.attachData(makeData("yard"));
    let requestedEnvironment = null;
    controller.setEnvironmentHandler((environmentId) => { requestedEnvironment = environmentId; });
    const manifest = createDefaultRunManifest({ environment: { id: "igvc" }, logging: { policy: "disabled" } });
    const resolved = {
        version: 13,
        manifest,
        resolvedHash: "resolved-environment-switch",
        environment: { manifest: { environmentId: "igvc" } },
        scripts: [],
        bindings: { entries: [] },
    };
    let settled = false;
    const readiness = controller.prepare(resolved, { autoplay: false }).then((value) => {
        settled = true;
        return value;
    });

    await Promise.resolve();
    assert.equal(requestedEnvironment, "igvc");
    assert.equal(settled, false);
    assert.deepEqual(applied, []);

    detach();
    controller.attachData(makeData("igvc"));
    const snapshot = await readiness;
    assert.equal(snapshot.status, "ready");
    assert.deepEqual(applied, ["resolved-environment-switch"]);
    assert.equal(controller.getSnapshot().activeResolved.resolvedHash, "resolved-environment-switch");
});

test("prepare forwards episode stop phase to the simulation", async () => {
    const controller = new RunSessionController();
    const applied = [];
    controller.recording = { attachSimulation() {} };
    const simulation = {
        subscribe(listener) { listener({ status: "paused", assertions: [] }); return () => {}; },
        async applyRunManifest(_value, options) { applied.push(options?.episodePhase ?? "start"); },
    };
    controller.attachData({
        environment: () => ({ environmentId: "igvc" }),
        simulation: () => simulation,
        client: () => ({ preflight: async () => ({ ok: true, issues: [] }) }),
    });
    const manifest = createDefaultRunManifest({ environment: { id: "igvc" }, logging: { policy: "disabled" } });
    const resolved = {
        version: 13,
        manifest,
        resolvedHash: "resolved-stop-phase",
        environment: { manifest: { environmentId: "igvc" } },
        scripts: [],
        bindings: { entries: [] },
    };
    await controller.prepare(resolved, { episodePhase: "stop" });
    assert.deepEqual(applied, ["stop"]);
});

test("reset-status stop skips post-run dispatch so re-prepare can scatter once", async () => {
    const controller = controllerFor("disabled", async () => {});
    const stops = [];
    controller.data = {
        ...controller.data,
        simulation: () => ({
            steps: 0,
            timeNs: 0,
            assertionEngine: { finalize: () => ({ results: [] }) },
            stop(options) { stops.push(options); },
        }),
    };
    await controller.stop({ status: "reset" });
    assert.equal(stops.length, 1);
    assert.equal(stops[0].reset, false);
    assert.equal(stops[0].dispatchEpisode, false);
});

test("scenario diagnostics preference is reapplied when a new simulation attaches", () => {
    const controller = new RunSessionController();
    controller.recording = { attachSimulation() {} };
    const firstValues = [];
    const secondValues = [];
    const dataFor = (values) => ({
        simulation: () => ({
            setScenarioDiagnosticsEnabled(value) { values.push(value); },
            subscribe() { return () => {}; },
        }),
    });

    controller.attachData(dataFor(firstValues));
    assert.deepEqual(firstValues, [false]);
    assert.equal(controller.setScenarioDiagnosticsEnabled(true), true);
    assert.deepEqual(firstValues, [false, true]);

    controller.attachData(dataFor(secondValues));
    assert.deepEqual(secondValues, [true]);
    controller.setScenarioDiagnosticsEnabled(false);
    assert.deepEqual(secondValues, [true, false]);
});

test("transient logging override skips recording and speed override applies immediately", async () => {
    let startCount = 0;
    const speeds = [];
    const controller = controllerFor("required", async () => { startCount += 1; });
    controller.data = {
        ...controller.data,
        simulation: () => ({
            getSnapshot: () => ({ status: "paused" }),
            setSpeed(value) { speeds.push(value); },
            play() {},
        }),
    };

    controller.setLoggingPolicyOverride("disabled");
    controller.setSpeedOverride(4);
    await controller.play();
    assert.equal(startCount, 0);
    assert.equal(controller._recordingRunId, "run-test");
    assert.ok(speeds.includes(4));

    controller.clear();
    assert.equal(controller._loggingPolicyOverride, null);
    assert.equal(controller._speedOverride, null);
});

test("stopping a superseded run skips finalize when the kernel was not prepared", async () => {
    const controller = controllerFor("disabled", async () => {});
    controller.snapshot.status = "running";
    let finalized = false;
    controller.data = {
        ...controller.data,
        simulation: () => ({
            resolvedRun: null,
            lifecycleState: "idle",
            steps: 0,
            timeNs: 0,
            finalize() {
                finalized = true;
                throw new Error("Cannot finalize before preparing a managed run.");
            },
            stop() {},
        }),
    };

    const result = await controller.stop({ status: "superseded" });
    assert.equal(finalized, false);
    assert.equal(result.status, "superseded");
    assert.equal(controller.snapshot.status, "superseded");
});

test("external-topic realtime cases force 1x regardless of speed override", () => {
    const speeds = [];
    const controller = controllerFor("disabled", async () => {});
    controller.data = {
        ...controller.data,
        simulation: () => ({
            getSnapshot: () => ({ status: "paused" }),
            setSpeed(value) { speeds.push(value); },
        }),
    };
    controller.snapshot.activeResolved = {
        ...controller.snapshot.activeResolved,
        manifest: {
            ...controller.snapshot.activeResolved.manifest,
            clock: { pacing: "realtime", speed: 1 },
            logging: { policy: "disabled", profileId: "simulation-run-full-sensors" },
        },
        scenario: {
            scenario: {
                routes: [{ controller: { kind: "external-topic", topicId: "/controls/command" } }],
            },
        },
    };
    controller.setSpeedOverride(4);
    speeds.length = 0;
    controller.applyRuntimeOverrides();
    assert.deepEqual(speeds, [1]);
});

test("stop pauses immediately and waits for sensor work and logging before acknowledgement", async () => {
    const controller = controllerFor("required", async () => {});
    const calls = [];
    let finishCapture;
    let finishLog;
    const capture = new Promise((resolve) => { finishCapture = resolve; });
    const log = new Promise((resolve) => { finishLog = resolve; });
    const simulation = {
        resolvedRun: controller.snapshot.activeResolved,
        steps: 1,
        timeNs: 20_000_000,
        pause() { calls.push("pause"); },
        whenIdle() { return capture; },
        finalize() { calls.push("finalize"); return { assertions: [] }; },
        stop() { calls.push("stop"); },
    };
    controller.data.simulation = () => simulation;
    controller._recordingRunId = "run-test";
    controller.recording = {
        session: { id: "log-1" },
        addAttachment() {},
        async stop() { calls.push("log"); return log; },
    };
    const flags = [];
    controller.subscribe((snapshot) => flags.push(snapshot.transitioning));
    const pending = controller.stop();
    assert.equal(flags.at(-1), true);
    assert.deepEqual(calls, ["pause"]);
    assert.equal(controller.stop(), pending, "concurrent stops share finalization");
    assert.equal(controller.getSnapshot().transitioning, true);
    await Promise.resolve();
    assert.deepEqual(calls, ["pause"]);
    simulation.steps = 2;
    simulation.timeNs = 40_000_000;
    finishCapture();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["pause", "finalize", "log"]);
    assert.equal(controller.getSnapshot().transitioning, true);
    finishLog({ id: "log-1" });
    const result = await pending;
    assert.equal(result.timeNs, 40_000_000);
    assert.equal(result.logId, "log-1");
    assert.equal(controller.getSnapshot().transitioning, false);
    assert.equal(flags.at(-1), false);
    assert.deepEqual(calls, ["pause", "finalize", "log", "stop"]);
    assert.equal(await controller.stop(), result, "repeated stop returns the existing result");
    assert.equal(calls.filter((call) => call === "finalize").length, 1);
});

test("reset accepts the server-resolved snapshot and creates a fresh ready run", async () => {
    const controller = controllerFor("disabled", async () => {});
    controller.recording = { attachSimulation() {} };
    const applied = [];
    const simulation = {
        steps: 9,
        timeNs: 180_000_000,
        pause() {},
        stop() {},
        async whenIdle() {},
        assertionEngine: { finalize: () => ({ results: [] }) },
        async applyRunManifest(resolved, options) {
            applied.push([resolved, options]);
            this.steps = 0;
            this.timeNs = 0;
        },
    };
    controller.data.simulation = () => simulation;
    const manifest = createDefaultRunManifest({ id: "fresh", logging: { policy: "disabled" } });
    const resolved = { ...controller.snapshot.activeResolved, manifest, resolvedHash: "server-frozen" };
    const snapshot = await controller.reset(resolved, { manifestRevision: 7 });
    assert.equal(snapshot.status, "ready");
    assert.notEqual(snapshot.activeRunId, "run-test");
    assert.equal(snapshot.activeResolved, resolved);
    assert.equal(snapshot.manifestRevision, 7);
    assert.equal(simulation.timeNs, 0);
    assert.deepEqual(applied, [[resolved, { episodePhase: "stop", runId: snapshot.activeRunId }]]);
});

test("a timed-out preparation cannot launch later when preflight eventually finishes", async (t) => {
    const controller = controllerFor("disabled", async () => {});
    controller.snapshot.activeRunId = null;
    controller.snapshot.status = "idle";
    let timeout;
    let finishPreflight;
    let applied = false;
    t.mock.method(globalThis, "setTimeout", (callback) => { timeout = callback; return 0; });
    controller.data.client = () => ({ preflight: () => new Promise((resolve) => { finishPreflight = resolve; }) });
    controller.data.simulation = () => ({ async applyRunManifest() { applied = true; } });
    const readiness = controller.prepare(controller.snapshot.activeResolved, { autoplay: true });
    timeout();
    await assert.rejects(readiness, /Timed out/);
    finishPreflight({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(applied, false);
    assert.equal(controller.getSnapshot().status, "error");
});

function stoppingController(policy = "disabled") {
    const controller = controllerFor(policy, async () => {});
    const calls = [];
    const simulation = {
        status: "playing", lifecycleState: "prepared", resolvedRun: controller.snapshot.activeResolved,
        steps: 3, timeNs: 60_000_000, trajectoryHash: "last-completed-step",
        assertionEngine: { snapshot: () => [] },
        pause() { this.status = "paused"; calls.push("pause"); },
        play() { this.status = "playing"; calls.push("play"); },
        async whenIdle() {},
        finalize() { this.lifecycleState = "finalized"; calls.push("finalize"); return { assertions: [] }; },
        stop(options) { this.status = "stopped"; calls.push(["stop", options]); },
        async applyRunManifest() { this.status = "paused"; this.lifecycleState = "prepared"; this.steps = 0; },
        cancelPendingAdvance(error) { calls.push(error.code); },
    };
    controller.data.simulation = () => simulation;
    controller.recording = { attachSimulation() {}, cancel() {} };
    return { controller, simulation, calls };
}

function stopDeadline(t) {
    const original = globalThis.setTimeout;
    const deadlines = [];
    t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
        if (ms !== RUN_STOP_TIMEOUT_MS) return original(callback, ms, ...args);
        deadlines.push(callback);
        return 0;
    });
    return deadlines;
}

test("ended runs ignore Pause and lease loss, reject playback, and repair a stale paused clock", async () => {
    const { controller, simulation, calls } = stoppingController();
    controller._beginControlOwnership({ leaseId: "lease", status: "active", mode: "autonomous", remainingMs: 750, target: { vehicleId: "ego" } });
    const guard = controller.ownershipGuard;
    const result = await controller.stop();
    assert.equal(guard.lease, null);
    const count = calls.length;
    await controller.pause();
    guard.onLoss({ reason: "lease-expired" });
    assert.equal(calls.length, count);
    assert.equal(controller.getSnapshot().status, "stopped");
    await assert.rejects(controller.play(), { code: "RUN_TERMINAL" });
    await assert.rejects(controller.step(), { code: "RUN_TERMINAL" });
    simulation.pause();
    assert.equal(await controller.stop(), result);
    assert.equal(simulation.status, "stopped");
    assert.equal(calls.filter((call) => call === "finalize").length, 1);
    assert.deepEqual(calls.at(-1), ["stop", { reset: false, dispatchEpisode: false }]);
});

test("required logging failures stop the engine, retain evidence and failure, and allow reset", async () => {
    const { controller, simulation } = stoppingController("required");
    const error = new Error("storage offline");
    controller._recordingRunId = "run-test";
    controller.recording = { session: { id: "failed-log" }, addAttachment() {}, attachSimulation() {}, async stop() { throw error; }, cancel() {} };
    await assert.rejects(controller.stop(), (failure) => failure === error);
    assert.equal(simulation.status, "stopped");
    assert.equal(controller.getSnapshot().transitioning, false);
    assert.equal(controller.getSnapshot().runResult.logId, "failed-log");
    assert.equal(controller.getSnapshot().runResult.passed, false);
    await controller.pause();
    await assert.rejects(controller.stop(), (failure) => failure === error);
    const fresh = await controller.reset(controller.snapshot.activeResolved);
    assert.equal(fresh.status, "ready");
    assert.notEqual(fresh.activeRunId, "run-test");
});

test("a stalled sensor drain shares one deadline, stops, and retains the incomplete-step evidence", async (t) => {
    const deadlines = stopDeadline(t);
    const { controller, simulation, calls } = stoppingController();
    simulation.whenIdle = () => new Promise(() => {});
    const pending = controller.stop();
    const rejected = assert.rejects(pending, (error) => error.code === "RUN_STOP_TIMEOUT" && /sensor work/.test(error.message));
    assert.equal(controller.stop(), pending);
    await Promise.resolve();
    assert.equal(deadlines.length, 1);
    await assert.rejects(controller.play(), { code: "BUSY" });
    await assert.rejects(controller.step(), { code: "BUSY" });
    deadlines[0]();
    await rejected;
    assert.equal(simulation.status, "stopped");
    assert.equal(controller.getSnapshot().transitioning, false);
    assert.equal(controller.getSnapshot().runResult.completed, false);
    assert.equal(controller.getSnapshot().runResult.trajectoryHash, "last-completed-step");
    assert.equal(controller.getSnapshot().runResult.terminationReason, "shutdown-timeout");
    assert.ok(calls.includes("RUN_STOP_TIMEOUT"));
    assert.ok(!calls.includes("finalize"));
});

for (const policy of ["optional", "required"]) {
    test(`${policy} stalled log finalization uses the remaining shutdown budget`, async (t) => {
        const deadlines = stopDeadline(t);
        const { controller, simulation } = stoppingController(policy);
        let finishCapture;
        let finishLog;
        simulation.whenIdle = () => new Promise((resolve) => { finishCapture = resolve; });
        controller._recordingRunId = "run-test";
        controller.recording = { session: { id: "partial-log" }, addAttachment() {}, stop() { return new Promise((resolve) => { finishLog = resolve; }); }, cancel() {} };
        const pending = controller.stop({ status: "completed" });
        const settled = policy === "required" ? assert.rejects(pending, { code: "RUN_STOP_TIMEOUT" }) : pending;
        await Promise.resolve();
        finishCapture();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(deadlines.length, 1, "logging must not restart the timeout");
        deadlines[0]();
        await settled;
        const snapshot = controller.getSnapshot();
        assert.equal(simulation.status, "stopped");
        assert.equal(snapshot.transitioning, false);
        assert.equal(snapshot.runResult.logId, "partial-log");
        assert.equal(snapshot.status, policy === "required" ? "error" : "completed");
        assert.equal(snapshot.degraded, policy === "optional");
        finishLog({ id: "late-log" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(controller.getSnapshot(), snapshot);
    });
}

test("a stalled transport close stops the engine and reports its shutdown stage", async (t) => {
    const deadlines = stopDeadline(t);
    const { controller, simulation } = stoppingController();
    controller.data.client = () => ({ closeRun: () => new Promise(() => {}) });
    const rejected = assert.rejects(controller.stop(), (error) => error.code === "RUN_STOP_TIMEOUT" && /transport/.test(error.message));
    await new Promise((resolve) => setImmediate(resolve));
    deadlines[0]();
    await rejected;
    assert.equal(simulation.status, "stopped");
});

test("a stalled Pause acknowledgement ends the run instead of keeping the browser API busy forever", async (t) => {
    const deadlines = stopDeadline(t);
    const { controller, simulation } = stoppingController();
    simulation.whenIdle = () => new Promise(() => {});
    const rejected = assert.rejects(controller.pause(), { code: "RUN_STOP_TIMEOUT" });
    deadlines[0]();
    await rejected;
    assert.equal(simulation.status, "stopped");
    assert.equal(controller.getSnapshot().transitioning, false);
    assert.equal(controller.getSnapshot().status, "error");
});

test("delayed recording startup cannot resume a stopped or replacement run", async (t) => {
    const deadlines = stopDeadline(t);
    const { controller, simulation, calls } = stoppingController("required");
    let finishStart;
    controller.recording = { start: () => new Promise((resolve) => { finishStart = resolve; }), cancel() {} };
    const playRejected = assert.rejects(controller.play(), { code: "RUN_SUPERSEDED" });
    const stopRejected = assert.rejects(controller.stop(), { code: "RUN_STOP_TIMEOUT" });
    await new Promise((resolve) => setImmediate(resolve));
    deadlines[0]();
    await stopRejected;
    finishStart({ id: "late-session" });
    await playRejected;
    assert.equal(simulation.status, "stopped");
    assert.ok(!calls.includes("play"));
});

test("clearing during shutdown fences the old completion without skipping its physical stop", async (t) => {
    const deadlines = stopDeadline(t);
    const { controller, simulation } = stoppingController();
    simulation.whenIdle = () => new Promise(() => {});
    const rejected = assert.rejects(controller.stop(), /cleared/);
    await Promise.resolve();
    controller.clear();
    await rejected;
    assert.equal(simulation.status, "stopped");
    assert.equal(controller.getSnapshot().status, "idle");
    assert.equal(controller.getSnapshot().runResult, null);
    assert.equal(deadlines.length, 1);
});
