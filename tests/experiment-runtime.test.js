import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    ExperimentRunController,
    interruptStaleExperimentResults,
} from "../app/experiments/ExperimentRunController.js";
import { createDefaultExperimentSuite } from "../app/experiments/ExperimentSuite.js";
import { createExperimentResult } from "../app/experiments/ExperimentResult.js";
import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { StorageService } from "../server/storage/StorageService.js";

function experimentSuite(overrides = {}) {
    return createDefaultExperimentSuite({
        id: "nightly",
        name: "Nightly",
        scenarioIds: ["route-a"],
        manifestIds: ["controller-a"],
        seeds: [7],
        metrics: [{ id: "passed", source: { kind: "builtin", metric: "passed" } }],
        ...overrides,
    });
}

function pendingCase(overrides = {}) {
    return {
        id: "case-a",
        scenarioId: "route-a",
        manifestId: "controller-a",
        seed: 7,
        parameters: {},
        ...overrides,
    };
}

test("experiment storage persists readable suites/results/baselines with revisions and immutable snapshots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-experiment-storage-"));
    const service = new StorageService(dir);
    try {
        const created = await service.createExperimentSuite(experimentSuite());
        assert.equal(created.revision, 1);
        assert.equal(created.definitionHash.length, 64);
        assert.equal((await service.listExperimentSuites())[0].id, "nightly");

        const updated = await service.putExperimentSuite("nightly", {
            suite: { ...created, description: "Regression gate" },
            expectedRevision: 1,
        });
        assert.equal(updated.revision, 2);
        await assert.rejects(
            service.putExperimentSuite("nightly", { suite: created, expectedRevision: 1 }),
            /revision conflict/,
        );
        const duplicate = await service.duplicateExperimentSuite("nightly", { id: "nightly-copy" });
        assert.equal(duplicate.id, "nightly-copy");

        const resultDocument = createExperimentResult(updated, [pendingCase()], {
            id: "nightly-result",
            createdAt: "2026-07-30T10:00:00.000Z",
        });
        const result = await service.createExperimentResult(resultDocument);
        assert.equal(result.revision, 1);
        const completed = await service.putExperimentResult(result.id, {
            expectedRevision: 1,
            result: {
                ...result,
                status: "completed",
                finishedAt: "2026-07-30T10:00:01.000Z",
                cases: result.cases.map((entry) => ({
                    ...entry,
                    status: "completed",
                    completed: true,
                    passed: true,
                    metrics: { passed: 1 },
                    startedAt: "2026-07-30T10:00:00.000Z",
                    finishedAt: "2026-07-30T10:00:01.000Z",
                })),
            },
        });
        assert.equal(completed.revision, 2);

        const baseline = await service.createExperimentBaseline({
            resultId: completed.id,
            id: "known-good",
            name: "Known Good",
            provenance: { appVersion: "1.0.0", gitCommit: "abc123" },
        });
        assert.equal(baseline.cases[0].metrics.passed, 1);
        assert.equal(baseline.provenance.gitCommit, "abc123");
        await assert.rejects(
            service.createExperimentBaseline({
                resultId: completed.id,
                id: "known-good",
                name: "Replacement",
            }),
            /immutable/,
        );
        assert.deepEqual((await service.listExperimentBaselines("nightly")).map((entry) => entry.id), ["known-good"]);

        const suiteOnDisk = JSON.parse(await fs.readFile(path.join(dir, "experiment-suites", "nightly.json"), "utf8"));
        const resultOnDisk = JSON.parse(await fs.readFile(path.join(dir, "experiment-results", "nightly-result.json"), "utf8"));
        const baselineOnDisk = JSON.parse(await fs.readFile(path.join(dir, "experiment-baselines", "known-good.json"), "utf8"));
        assert.equal(suiteOnDisk.kind, "cev-sim.experiment-suite");
        assert.equal(resultOnDisk.kind, "cev-sim.experiment-result");
        assert.equal(baselineOnDisk.kind, "cev-sim.experiment-baseline");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("experiment case resolution accepts only expanded cases and splits declared scenario and manifest parameters", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-experiment-resolve-"));
    const service = new StorageService(dir);
    try {
        await service.createScenario(createDefaultScenario({
            id: "route-a",
            parameters: [{
                id: "speed",
                type: "float64",
                default: 2,
                target: { kind: "scalar-field", path: "routes.0.initialSpeedMps" },
            }],
        }));
        await service.createRunManifest(createDefaultRunManifest({
            id: "controller-a",
            parameters: [{
                id: "gain",
                type: "float64",
                default: 0.5,
                target: { kind: "scalar-field", path: "clock.speed" },
            }],
        }));
        await service.createExperimentSuite(experimentSuite({
            sweeps: [
                { parameterId: "speed", values: [3] },
                { parameterId: "gain", values: [0.75] },
            ],
        }));

        let captured = null;
        service.resolveRunManifest = async (manifestId, options) => {
            captured = { manifestId, options };
            return {
                resolvedHash: "resolved-hash",
                dependencyHashes: { scenario: "scenario-hash", manifest: "manifest-hash" },
                manifest: { clock: { pacing: "unbounded" } },
                scenario: { scenario: { routes: [] } },
            };
        };
        const resolved = await service.resolveExperimentCase("nightly", {
            scenarioId: "route-a",
            manifestId: "controller-a",
            seed: 7,
            parameters: { speed: 3, gain: 0.75 },
        });
        assert.equal(resolved.case.parameters.speed, 3);
        assert.deepEqual(captured, {
            manifestId: "controller-a",
            options: {
                scenarioId: "route-a",
                seed: 7,
                scenarioParameterValues: { speed: 3 },
                manifestParameterValues: { gain: 0.75 },
                egoVehicleId: undefined,
                sensorBindings: undefined,
            },
        });
        await assert.rejects(
            service.resolveExperimentCase("nightly", {
                scenarioId: "route-a",
                manifestId: "controller-a",
                seed: 999,
                parameters: { speed: 3, gain: 0.75 },
            }),
            /not part of the suite/,
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

class FakeTelemetry {
    subscribeSignals(_options, listener) {
        this.listener = listener;
        return () => { if (this.listener === listener) this.listener = null; };
    }

    signal(path, value) {
        this.values ??= new Map();
        this.values.set(path, value);
        this.listener?.({ kind: "update", path, entry: { value } });
    }

    event(event) {
        this.eventValues ??= [];
        this.eventValues.push(structuredClone(event));
        this.listener?.({ kind: "event", event });
    }

    read(path) {
        return this.values?.has(path) ? { value: this.values.get(path) } : null;
    }

    events() {
        return structuredClone(this.eventValues || []);
    }
}

class FakeRunSession {
    constructor(telemetry, terminalResults) {
        this.telemetry = telemetry;
        this.terminalResults = [...terminalResults];
        this.listeners = new Set();
        this.snapshot = { status: "idle", runResult: null };
        this.activeCount = 0;
        this.maximumActive = 0;
        this.prepared = [];
        this.speedOverride = null;
        this.loggingOverride = null;
        this.appliedOverrides = 0;
        this.liveSpeeds = [];
    }

    getSnapshot() {
        return structuredClone(this.snapshot);
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    setSpeedOverride(speed = null) {
        this.speedOverride = speed;
        this.liveSpeeds.push(speed);
        return this.speedOverride;
    }

    setLoggingPolicyOverride(policy = null) {
        this.loggingOverride = policy;
        return this.loggingOverride;
    }

    applyRuntimeOverrides() {
        this.appliedOverrides += 1;
    }

    async prepare(resolved, { autoplay }) {
        assert.equal(autoplay, false);
        this.prepared.push(resolved.resolvedHash);
        this.activeCount += 1;
        this.maximumActive = Math.max(this.maximumActive, this.activeCount);
        this._emit({ status: "ready", activeResolved: resolved, runResult: null });
    }

    pause() {
        this._emit({ status: "paused" });
    }

    async play() {
        this._emit({ status: "running" });
        await Promise.resolve();
        this.telemetry.signal("vehicle.speed", this.prepared.length * 2);
        const terminal = this.terminalResults.shift();
        this.activeCount -= 1;
        const resolved = this.snapshot.activeResolved;
        this._emit({
            status: terminal.status,
            activeResolved: resolved,
            runResult: { ...terminal, resolvedHash: resolved.resolvedHash },
        });
    }

    async stop({ status }) {
        const result = { status, completed: false, passed: false, resolvedHash: this.snapshot.activeResolved?.resolvedHash };
        this._emit({ status, runResult: result });
        return result;
    }

    _emit(patch) {
        this.snapshot = { ...this.snapshot, ...patch };
        for (const listener of this.listeners) listener(this.getSnapshot());
    }
}

test("ExperimentRunController rejects cross-suite result loading and resume", async () => {
    const telemetry = new FakeTelemetry();
    const runSession = new FakeRunSession(telemetry, []);
    const controller = new ExperimentRunController({ telemetry, runSession });
    const owner = experimentSuite({ id: "owner-suite" });
    const foreign = experimentSuite({ id: "foreign-suite" });
    const result = createExperimentResult(owner, [pendingCase()], {
        id: "owner-result",
        status: "interrupted",
    });

    await assert.rejects(
        controller.load(result, { suite: foreign, persist: false }),
        /belongs to suite "owner-suite", not "foreign-suite"/,
    );

    await controller.load(result, { suite: owner, persist: false });
    await assert.rejects(
        controller.resume({ suite: foreign }),
        /belongs to suite "owner-suite", not "foreign-suite"/,
    );
    controller.destroy();
});

test("ExperimentRunController executes sequentially, streams metrics, persists every case, and honors fail-fast", async () => {
    const telemetry = new FakeTelemetry();
    const runSession = new FakeRunSession(telemetry, [
        { status: "completed", completed: true, passed: true, logId: "log-a" },
        { status: "assertion-failed", completed: true, passed: false, failureReason: "assertion failed" },
    ]);
    const suite = experimentSuite({
        seeds: [1, 2, 3],
        execution: { failurePolicy: "fail-fast" },
        metrics: [
            { id: "passed", source: { kind: "builtin", metric: "passed" } },
            { id: "last-speed", source: { kind: "signal", path: "vehicle.speed" }, reducer: "last" },
        ],
    });
    const cases = [1, 2, 3].map((seed, index) => pendingCase({ id: `case-${index + 1}`, seed }));
    let revision = 0;
    let saveCount = 0;
    let storedResult = null;
    const controller = new ExperimentRunController({
        telemetry,
        runSession,
        now: (() => {
            let tick = 0;
            return () => new Date(Date.UTC(2026, 6, 30, 10, 0, tick++)).getTime();
        })(),
        createResult: async (result) => ({ ...result, revision: ++revision }),
        saveResult: async (_id, result, expectedRevision) => {
            assert.equal(expectedRevision, revision);
            saveCount += 1;
            storedResult = structuredClone(result);
            return { ...result, revision: ++revision };
        },
        resolveCase: async (_suiteId, { case: entry }) => ({
            resolvedHash: `hash-${entry.seed}`,
            dependencyHashes: { scenario: "scenario-hash", manifest: `manifest-${entry.seed}` },
            resolvedRun: { resolvedHash: `hash-${entry.seed}`, manifest: { id: entry.manifestId } },
        }),
    });

    await controller.start({ suite, cases });
    const finalSnapshot = await controller.waitForCompletion();
    assert.equal(finalSnapshot.status, "completed");
    assert.deepEqual(finalSnapshot.result.execution, { backend: "browser", jobId: null });
    assert.deepEqual(finalSnapshot.result.cases.map((entry) => entry.status), ["completed", "failed", "cancelled"]);
    assert.deepEqual(runSession.prepared, ["hash-1", "hash-2"]);
    assert.equal(runSession.maximumActive, 1);
    assert.equal(finalSnapshot.result.cases[0].metrics.passed, 1);
    assert.equal(finalSnapshot.result.cases[0].metrics["last-speed"], 2);
    assert.equal(finalSnapshot.result.cases[0].logId, "log-a");
    assert.equal(finalSnapshot.result.cases[1].metrics.passed, 0);
    assert.match(finalSnapshot.result.cases[2].failureReason, /fail-fast/);
    assert.ok(saveCount >= 6, "queue state and every terminal case are persisted");
    assert.equal(storedResult.status, "completed");
    controller.destroy();
});

test("ExperimentRunController preserves terminal failure and interruption categories", async () => {
    const telemetry = new FakeTelemetry();
    const runSession = new FakeRunSession(telemetry, [
        { status: "interrupted", completed: false, passed: false },
        { status: "stopped", completed: false, passed: false },
        { status: "cancelled", completed: false, passed: false },
        { status: "error", completed: false, passed: false },
        { status: "failed", completed: true, passed: false },
    ]);
    const suite = experimentSuite({
        seeds: [1, 2, 3, 4, 5],
        execution: { failurePolicy: "continue" },
    });
    const cases = suite.seeds.map((seed, index) => pendingCase({ id: `terminal-${index + 1}`, seed }));
    let revision = 0;
    const controller = new ExperimentRunController({
        telemetry,
        runSession,
        createResult: async (result) => ({ ...result, revision: ++revision }),
        saveResult: async (_id, result) => ({ ...result, revision: ++revision }),
        resolveCase: async (_suiteId, { case: entry }) => ({
            resolvedHash: `terminal-hash-${entry.seed}`,
            dependencyHashes: {},
            resolvedRun: { resolvedHash: `terminal-hash-${entry.seed}`, manifest: { id: entry.manifestId } },
        }),
    });

    await controller.start({ suite, cases });
    await controller.waitForCompletion();
    const results = controller.getSnapshot().result.cases;
    assert.deepEqual(results.map((entry) => entry.status), [
        "interrupted",
        "interrupted",
        "cancelled",
        "error",
        "failed",
    ]);
    assert.deepEqual(results.map((entry) => entry.completed), [false, false, false, false, true]);
    assert.deepEqual(results.map((entry) => entry.terminationReason), [
        "interrupted",
        "stopped",
        "cancelled",
        "error",
        "failed",
    ]);
    controller.destroy();
});

test("ExperimentRunController seeds reducers with deterministic t=0 signals and events", async () => {
    const telemetry = new FakeTelemetry();
    telemetry.signal("vehicle.initial-speed", 4.5);
    telemetry.event({ category: "scenario", name: "configured", severity: "info" });
    const runSession = new FakeRunSession(telemetry, [
        { status: "completed", completed: true, passed: true },
    ]);
    const suite = experimentSuite({
        metrics: [
            { id: "initial-speed", source: { kind: "signal", path: "vehicle.initial-speed" }, reducer: "first" },
            { id: "configured-events", source: { kind: "event", category: "scenario", name: "configured" }, reducer: "count" },
        ],
    });
    let revision = 0;
    const controller = new ExperimentRunController({
        telemetry,
        runSession,
        createResult: async (result) => ({ ...result, revision: ++revision }),
        saveResult: async (_id, result) => ({ ...result, revision: ++revision }),
        resolveCase: async () => ({
            resolvedHash: "t0-hash",
            dependencyHashes: {},
            resolvedRun: { resolvedHash: "t0-hash", manifest: { id: "controller-a" } },
        }),
    });

    await controller.start({ suite, cases: [pendingCase()] });
    const finalSnapshot = await controller.waitForCompletion();
    assert.equal(finalSnapshot.result.cases[0].metrics["initial-speed"], 4.5);
    assert.equal(finalSnapshot.result.cases[0].metrics["configured-events"], 1);
    controller.destroy();
});

test("scenario built-in metrics persist from run summaries and stay unavailable when absent", async () => {
    const telemetry = new FakeTelemetry();
    const runSession = new FakeRunSession(telemetry, [
        {
            status: "completed",
            completed: true,
            passed: true,
            metrics: {
                passed: 1,
                "route-progress": 12.5,
                "route-progress-ratio": 0.625,
                "off-road": 0,
                "wrong-way": 0,
                "kinematic-infeasibility": 0,
                acceleration: 3.1,
                jerk: 1.2,
                "log-divergence": 0.4,
                failure: 0,
            },
        },
        {
            status: "completed",
            completed: true,
            passed: true,
            metrics: { passed: 1 },
        },
    ]);
    const suite = experimentSuite({
        seeds: [1, 2],
        metrics: [
            { id: "passed", source: { kind: "builtin", metric: "passed" } },
            { id: "route-progress", source: { kind: "builtin", metric: "route-progress" } },
            { id: "failure", source: { kind: "builtin", metric: "failure" } },
            { id: "log-divergence", source: { kind: "builtin", metric: "log-divergence" } },
        ],
    });
    const controller = new ExperimentRunController({
        telemetry,
        runSession,
        createResult: async (result) => ({ ...result, revision: 1 }),
        saveResult: async (_id, result) => ({ ...result, revision: 2 }),
        resolveCase: async () => ({
            resolvedHash: "scenario-metric-hash",
            dependencyHashes: {},
            resolvedRun: { resolvedHash: "scenario-metric-hash", manifest: { id: "controller-a" } },
        }),
    });

    await controller.start({
        suite,
        cases: [
            pendingCase({ id: "with-metrics", seed: 1 }),
            pendingCase({ id: "without-metrics", seed: 2 }),
        ],
    });
    const finalSnapshot = await controller.waitForCompletion();
    assert.equal(finalSnapshot.result.cases[0].metrics["route-progress"], 12.5);
    assert.equal(finalSnapshot.result.cases[0].metrics.failure, 0);
    assert.equal(finalSnapshot.result.cases[0].metrics["log-divergence"], 0.4);
    assert.equal(finalSnapshot.result.cases[1].metrics["route-progress"], null);
    assert.equal(finalSnapshot.result.cases[1].metrics.failure, null);
    assert.equal(finalSnapshot.result.cases[1].metrics["log-divergence"], null);
    controller.destroy();
});

test("ExperimentRunController marks stale running cases interrupted and resumes pending work", async () => {
    const telemetry = new FakeTelemetry();
    const runSession = new FakeRunSession(telemetry, [
        { status: "completed", completed: true, passed: true },
    ]);
    const suite = experimentSuite();
    const stale = createExperimentResult(suite, [], {
        id: "stale-result",
        status: "running",
        cases: [
            { ...pendingCase({ id: "interrupted", seed: 1 }), status: "running", startedAt: "2026-07-30T09:00:00.000Z" },
            { ...pendingCase({ id: "pending", seed: 2 }), status: "pending" },
        ],
    });
    let revision = 4;
    const savedStatuses = [];
    const controller = new ExperimentRunController({
        telemetry,
        runSession,
        resolveCase: async (_suiteId, { case: entry }) => ({
            resolvedHash: `hash-${entry.seed}`,
            dependencyHashes: {},
            resolvedRun: { resolvedHash: `hash-${entry.seed}`, manifest: { id: entry.manifestId } },
        }),
        saveResult: async (_id, result, expectedRevision) => {
            assert.equal(expectedRevision, revision);
            savedStatuses.push({ result: result.status, cases: result.cases.map((entry) => entry.status) });
            return { ...result, revision: ++revision };
        },
    });

    await controller.load({ ...stale, revision }, { suite });
    assert.deepEqual(controller.getSnapshot().result.cases.map((entry) => entry.status), ["interrupted", "pending"]);
    await controller.resume({ suite });
    await controller.waitForCompletion();
    assert.deepEqual(controller.getSnapshot().result.cases.map((entry) => entry.status), ["interrupted", "completed"]);
    assert.ok(savedStatuses.some((entry) => entry.result === "interrupted"));
    controller.destroy();
});

test("reload audit interrupts stale active results across every suite", async () => {
    const makeStale = (id, suiteId, status) => ({
        ...createExperimentResult(experimentSuite({ id: suiteId }), [], {
            id,
            status,
            cases: [
                {
                    ...pendingCase({ id: `${id}-active` }),
                    status: "running",
                    startedAt: "2026-07-30T09:00:00.000Z",
                },
                { ...pendingCase({ id: `${id}-pending`, seed: 8 }), status: "pending" },
            ],
        }),
        revision: 3,
    });
    const stored = new Map([
        ["suite-a-active", makeStale("suite-a-active", "suite-a", "running")],
        ["suite-b-active", makeStale("suite-b-active", "suite-b", "paused")],
        ["suite-c-complete", {
            ...createExperimentResult(experimentSuite({ id: "suite-c" }), [], {
                id: "suite-c-complete",
                status: "completed",
                cases: [],
            }),
            revision: 2,
        }],
    ]);
    const saves = [];

    const updated = await interruptStaleExperimentResults([
        { id: "suite-a-active", suiteId: "suite-a", status: "running" },
        { id: "suite-b-active", suiteId: "suite-b", status: "paused" },
        { id: "suite-c-complete", suiteId: "suite-c", status: "completed" },
    ], {
        now: () => new Date("2026-07-30T10:00:00.000Z"),
        getResult: async (id) => stored.get(id),
        saveResult: async (id, result, expectedRevision) => {
            assert.equal(expectedRevision, 3);
            saves.push(id);
            return { ...result, revision: expectedRevision + 1 };
        },
    });

    assert.deepEqual(saves, ["suite-a-active", "suite-b-active"]);
    assert.deepEqual(updated.map((entry) => entry.status), ["interrupted", "interrupted"]);
    for (const result of updated) {
        assert.deepEqual(result.cases.map((entry) => entry.status), ["interrupted", "pending"]);
        assert.equal(result.finishedAt, "2026-07-30T10:00:00.000Z");
    }
});

test("ExperimentRunController applies transient speed and disable-logging overrides without mutating the suite", async () => {
    const telemetry = new FakeTelemetry();
    const runSession = new FakeRunSession(telemetry, [
        { status: "completed", completed: true, passed: true, logId: null },
    ]);
    const suite = experimentSuite({ seeds: [1] });
    const cases = [pendingCase({ id: "case-speed", seed: 1 })];
    let revision = 0;
    const controller = new ExperimentRunController({
        telemetry,
        runSession,
        createResult: async (result) => ({ ...result, revision: ++revision }),
        saveResult: async (_id, result) => ({ ...result, revision: ++revision }),
        resolveCase: async (_suiteId, { case: entry }) => ({
            resolvedHash: `hash-${entry.seed}`,
            dependencyHashes: {},
            resolvedRun: { resolvedHash: `hash-${entry.seed}`, manifest: { id: entry.manifestId } },
        }),
    });

    await controller.start({
        suite,
        cases,
        resultId: "corridor-acceptance-01",
        runSpeed: 2,
        disableLogging: true,
    });
    assert.equal(controller.getSnapshot().result.id, "corridor-acceptance-01");
    assert.equal(controller.getSnapshot().runSpeed, 2);
    assert.equal(controller.getSnapshot().disableLogging, true);
    assert.equal(runSession.speedOverride, 2);
    assert.equal(runSession.loggingOverride, "disabled");
    controller.setRunSpeed(4);
    assert.equal(runSession.speedOverride, 4);
    assert.equal(controller.getSnapshot().runSpeed, 4);
    await controller.waitForCompletion();
    assert.ok(runSession.appliedOverrides >= 1);
    assert.equal(runSession.loggingOverride, null);
    assert.equal(suite.execution?.logging, undefined);
    controller.destroy();
});
