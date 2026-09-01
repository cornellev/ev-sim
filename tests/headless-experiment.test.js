import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareExperimentResultToBaseline } from "../app/experiments/BaselineComparison.js";
import { createDefaultExperimentSuite } from "../app/experiments/ExperimentSuite.js";
import { createExperimentResult, interruptActiveExperimentCases } from "../app/experiments/ExperimentResult.js";
import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { verifyRoute } from "../app/scenarios/route/index.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createRunSensor } from "../app/3d/devices/SensorTypeRegistry.js";
import { managedEpisodeIdentity } from "../server/headless/ManagedHeadlessSession.js";
import { HeadlessExperimentService } from "../server/headless/HeadlessExperimentService.js";
import { inspectReplay, readReplaySeries } from "../server/mcp/loggingTools.js";
import { LogService } from "../server/logging/LogService.js";
import { StorageService } from "../server/storage/StorageService.js";

async function fixture(t, options = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-managed-experiment-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const storage = new StorageService(path.join(root, "data"));
    const logs = new LogService(path.join(root, "logs"));
    const environment = await storage.getEnvironment("igvc");
    const edge = environment.document.roads.edges[0];
    const nodes = new Map(environment.document.roads.nodes.map((node) => [node.id, node]));
    const start = nodes.get(edge.startNodeId);
    const finish = nodes.get(edge.endNodeId);
    const verified = verifyRoute(environment, {
        id: "ego-route",
        actorId: "ego",
        initialSpeedMps: 2,
        controller: { kind: options.controllerKind || "route-follower", activation: { kind: "start" } },
        waypoints: [
            { id: "start", position: { x: start.x, y: 0, z: start.z } },
            { id: "finish", position: { x: finish.x, y: 0, z: finish.z } },
        ],
    });
    assert.equal(verified.ok, true, verified.error);
    const bounded = options.bounded !== false;
    const scenario = await storage.createScenario(createDefaultScenario({
        id: options.scenarioId || "managed-route",
        name: "Managed route",
        environment: { id: "igvc", expectedHash: null },
        routes: [{
            id: "ego-route",
            name: "Ego route",
            actorId: "ego",
            initialSpeedMps: 2,
            controller: { kind: options.controllerKind || "route-follower", activation: { kind: "start" } },
            waypoints: verified.waypoints,
            verification: verified.verification,
        }],
        triggers: bounded ? [{
            id: "finish-step",
            name: "Finish at step",
            enabled: true,
            once: true,
            condition: { kind: "step", step: options.finishStep ?? 4 },
            actions: [{ kind: "finish" }],
        }] : [],
        completion: bounded ? { conditions: [] } : {
            conditions: [{ id: "collision", name: "Collision", kind: "ego-collision" }],
        },
        expectedOutcomes: [{ id: "safe", name: "No collisions", kind: "no-collisions" }],
    }));
    const manifest = await storage.createRunManifest(createDefaultRunManifest({
        id: options.manifestId || "managed-manifest",
        name: "Managed manifest",
        seed: "7",
        scenario: {
            id: scenario.id,
            expectedHash: scenario.definitionHash,
            egoVehicleId: "igvc-car",
            sensorBindings: {},
            parameterValues: {},
        },
        controls: { authority: options.authority || "reference" },
        sensorRig: { sensors: options.sensors || [], syncGroups: [] },
        clock: {
            pacing: "unbounded",
            maxSteps: options.maxSteps === undefined ? (bounded ? 20 : null) : options.maxSteps,
        },
        logging: { policy: options.loggingPolicy || "optional", profileId: "simulation-run-full-sensors" },
    }));
    const suite = await storage.createExperimentSuite(createDefaultExperimentSuite({
        id: options.suiteId || "managed-suite",
        name: "Managed suite",
        scenarioIds: [scenario.id],
        manifestIds: [manifest.id],
        seeds: options.seeds || [7],
        metrics: [
            { id: "passed", source: { kind: "builtin", metric: "passed" } },
            { id: "duration", source: { kind: "builtin", metric: "duration" } },
            { id: "last-step", source: { kind: "signal", path: "simulation.step" }, reducer: "last" },
            { id: "trigger-count", source: { kind: "event", category: "scenario", name: "trigger-fired" }, reducer: "count" },
        ],
        execution: { failurePolicy: options.failurePolicy || "continue" },
    }));
    return { root, storage, logs, suite };
}

function fakeFinalized(request, { passed = true, suffix = "a" } = {}) {
    const hash = suffix.repeat(64).slice(0, 64);
    return {
        outputDirectory: request.outputUri,
        artifacts: request.artifactPolicy?.profile === "disabled"
            ? []
            : [{ name: "run.sflog", uri: "run.sflog", mimeType: "application/x-sflog", sizeBytes: "10", sha256: hash }],
        experimentMetrics: { passed: passed ? 1 : 0, duration: 1, "last-step": 4, "trigger-count": 1 },
        runResult: {
            runId: `run-${suffix}`,
            status: passed ? "passed" : "failed",
            completed: true,
            passed,
            resolvedHash: request.bundle.resolvedHash,
            simulationSemanticHash: request.bundle.simulationSemanticHash,
            episodeHash: hash,
            trajectoryHash: hash.split("").reverse().join(""),
            terminationReason: "trigger",
            assertions: [],
            outcomes: passed ? [{ id: "safe", passed: true }] : [{ id: "safe", passed: false }],
            failureReason: passed ? null : "Semantic failure.",
            artifactWarnings: [],
        },
    };
}

class FakeSupervisor {
    constructor(handler = (request) => fakeFinalized(request)) {
        this.handler = handler;
        this.calls = 0;
        this.workers = new Set();
        this.batches = new Map();
    }

    async runManagedExperiment(request, options) {
        this.calls += 1;
        options.onStarted?.({ pid: 1000 + this.calls });
        if (options.signal?.aborted) throw new Error("cancelled");
        return this.handler(request, options, this.calls);
    }

    async close() {}
}

test("managed experiments complete without a browser, repeat hashes, and import replayable logs", async (t) => {
    const { root, storage, logs, suite } = await fixture(t);
    const service = new HeadlessExperimentService(storage, logs, {
        artifactRoot: path.join(root, "artifacts"),
    });
    try {
        const firstStart = await service.start({ suiteId: suite.id, resultId: "managed-first" });
        const secondStart = await service.start({ suiteId: suite.id, resultId: "overlapping" });
        assert.ok(secondStart.queuePosition >= 2);
        const first = await service.waitForCompletion(firstStart.resultId);
        assert.equal(first.execution.backend, "headless");
        assert.equal(first.status, "completed");
        assert.equal(first.cases[0].status, "completed");
        assert.equal(first.cases[0].passed, true);
        assert.equal(first.cases[0].metrics["last-step"], 4);
        assert.equal(first.cases[0].metrics["trigger-count"], 1);
        assert.match(first.cases[0].episodeHash, /^[0-9a-f]{64}$/);
        assert.match(first.cases[0].trajectoryHash, /^[0-9a-f]{64}$/);
        assert.ok(first.cases[0].logId);

        const metadata = await logs.getMetadata(first.cases[0].logId);
        assert.equal(metadata.runId, first.cases[0].runId);
        assert.equal(metadata.resolvedHash, first.cases[0].resolvedHash);
        const replay = await inspectReplay(logs, first.cases[0].logId, { timeUs: metadata.durationUs });
        assert.equal(replay.log.id, first.cases[0].logId);
        const series = await readReplaySeries(logs, first.cases[0].logId, {
            path: "simulation.step",
            maxSamples: 50,
        });
        assert.ok(series.samples.length > 0);

        const second = await service.waitForCompletion(secondStart.resultId);
        assert.equal(second.cases[0].episodeHash, first.cases[0].episodeHash);
        assert.equal(second.cases[0].trajectoryHash, first.cases[0].trajectoryHash);

        const baseline = await storage.createExperimentBaseline({
            resultId: first.id,
            id: "managed-baseline",
            name: "Managed baseline",
        });
        assert.equal(baseline.cases[0].episodeHash, first.cases[0].episodeHash);
        assert.equal(baseline.cases[0].trajectoryHash, first.cases[0].trajectoryHash);
        assert.equal(Object.hasOwn(baseline.cases[0], "artifacts"), false);
        const comparison = compareExperimentResultToBaseline(second, baseline);
        assert.equal(comparison.status, "unchanged");
        assert.equal(comparison.matchedCaseCount, 1);
    } finally {
        await service.close();
    }
});

test("headless start atomically rejects candidate and unbounded suites without creating results", async (t) => {
    const candidate = await fixture(t, { suiteId: "candidate-suite", scenarioId: "candidate-scenario", manifestId: "candidate-manifest", authority: "candidate" });
    const candidateService = new HeadlessExperimentService(candidate.storage, candidate.logs, {
        supervisor: new FakeSupervisor(),
        artifactRoot: path.join(candidate.root, "artifacts"),
    });
    await assert.rejects(
        candidateService.start({ suiteId: candidate.suite.id, resultId: "candidate-result" }),
        /reference control authority/,
    );
    assert.equal(await candidate.storage.getExperimentResult("candidate-result"), null);
    await candidateService.close();

    const unbounded = await fixture(t, { suiteId: "unbounded-suite", scenarioId: "unbounded-scenario", manifestId: "unbounded-manifest", bounded: false, maxSteps: null });
    const unboundedService = new HeadlessExperimentService(unbounded.storage, unbounded.logs, {
        supervisor: new FakeSupervisor(),
        artifactRoot: path.join(unbounded.root, "artifacts"),
    });
    await assert.rejects(
        unboundedService.start({ suiteId: unbounded.suite.id, resultId: "unbounded-result" }),
        /semantic|clock\.maxSteps/i,
    );
    assert.equal(await unbounded.storage.getExperimentResult("unbounded-result"), null);
    await unboundedService.close();
});

test("managed experiments accept persisted CPU LiDAR and continue rejecting cameras", async (t) => {
    const lidar = await fixture(t, {
        suiteId: "lidar-suite",
        scenarioId: "lidar-scenario",
        manifestId: "lidar-manifest",
        sensors: [createRunSensor("lidar3d", { id: "managed-lidar", parentId: "ego" })],
        loggingPolicy: "disabled",
    });
    const lidarValidation = await lidar.storage.validateExperimentSuite(lidar.suite.id);
    const resolved = (await lidar.storage.resolveExperimentCase(lidar.suite.id, {
        case: lidarValidation.matrix.cases[0],
    })).resolvedRun;
    assert.ok(resolved.lidarGeometry);
    assert.deepEqual(managedEpisodeIdentity(resolved).backendSelections.map((entry) => entry.kind), [1, 3]);
    const lidarService = new HeadlessExperimentService(lidar.storage, lidar.logs, {
        supervisor: new FakeSupervisor(), artifactRoot: path.join(lidar.root, "artifacts"),
    });
    const started = await lidarService.start({ suiteId: lidar.suite.id, resultId: "lidar-result", artifactProfile: "disabled" });
    assert.equal((await lidarService.waitForCompletion(started.resultId)).status, "completed");
    await lidarService.close();

    const camera = await fixture(t, {
        suiteId: "camera-suite",
        scenarioId: "camera-scenario",
        manifestId: "camera-manifest",
        sensors: [createRunSensor("camera", { id: "managed-camera", parentId: "ego" })],
    });
    const cameraService = new HeadlessExperimentService(camera.storage, camera.logs, {
        supervisor: new FakeSupervisor(), artifactRoot: path.join(camera.root, "artifacts"),
    });
    await assert.rejects(
        cameraService.start({ suiteId: camera.suite.id, resultId: "camera-result" }),
        /do not support sensor.*camera/i,
    );
    await cameraService.close();
});

test("required log import failures error a case while optional failures retain artifact warnings", async (t) => {
    for (const loggingPolicy of ["required", "optional"]) {
        const ids = `${loggingPolicy}-import`;
        const current = await fixture(t, {
            suiteId: `${ids}-suite`,
            scenarioId: `${ids}-scenario`,
            manifestId: `${ids}-manifest`,
            loggingPolicy,
        });
        const service = new HeadlessExperimentService(current.storage, current.logs, {
            supervisor: new FakeSupervisor(),
            artifactRoot: path.join(current.root, "artifacts"),
            importLog: async () => { throw new Error("catalog unavailable"); },
        });
        const started = await service.start({ suiteId: current.suite.id, resultId: `${ids}-result` });
        const result = await service.waitForCompletion(started.resultId);
        if (loggingPolicy === "required") {
            assert.equal(result.cases[0].status, "error");
        } else {
            assert.equal(result.cases[0].status, "completed");
            assert.match(result.cases[0].artifactWarnings.join(" "), /Optional SFLog import failed/);
        }
        assert.equal(result.cases[0].artifacts[0].name, "run.sflog");
        await service.close();
    }
});

test("fail-fast cancels pending cases while continue executes the full sequential queue", async (t) => {
    for (const policy of ["fail-fast", "continue"]) {
        const current = await fixture(t, {
            suiteId: `${policy}-suite`,
            scenarioId: `${policy}-scenario`,
            manifestId: `${policy}-manifest`,
            seeds: [1, 2],
            failurePolicy: policy,
            loggingPolicy: "disabled",
        });
        const supervisor = new FakeSupervisor((request, _options, call) => fakeFinalized(request, { passed: false, suffix: String(call) }));
        const service = new HeadlessExperimentService(current.storage, current.logs, {
            supervisor,
            artifactRoot: path.join(current.root, "artifacts"),
        });
        const started = await service.start({ suiteId: current.suite.id, resultId: `${policy}-result`, artifactProfile: "disabled" });
        const result = await service.waitForCompletion(started.resultId);
        assert.equal(result.cases[0].status, "failed");
        assert.equal(supervisor.calls, policy === "fail-fast" ? 1 : 2);
        assert.equal(result.cases[1].status, policy === "fail-fast" ? "cancelled" : "failed");
        await service.close();
    }
});

test("managed queues stop on optimistic result revision conflicts without overwriting external changes", async (t) => {
    const current = await fixture(t, { loggingPolicy: "disabled" });
    let release;
    let announce;
    const entered = new Promise((resolve) => { announce = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    const supervisor = new FakeSupervisor(async (request) => {
        announce();
        await blocked;
        return fakeFinalized(request);
    });
    const service = new HeadlessExperimentService(current.storage, current.logs, {
        supervisor,
        artifactRoot: path.join(current.root, "artifacts"),
    });
    const started = await service.start({
        suiteId: current.suite.id,
        resultId: "revision-conflict",
        artifactProfile: "disabled",
    });
    const completion = service.waitForCompletion(started.resultId);
    await entered;
    const externallyRead = await current.storage.getExperimentResult(started.resultId);
    const paused = interruptActiveExperimentCases(externallyRead, new Date().toISOString());
    paused.status = "paused";
    await current.storage.putExperimentResult(started.resultId, {
        expectedRevision: externallyRead.revision,
        result: paused,
    });
    release();
    await completion;
    const preserved = await current.storage.getExperimentResult(started.resultId);
    assert.equal(preserved.status, "paused");
    assert.equal(service.active, null);
    assert.equal(supervisor.calls, 1);
    await service.close();
});

test("cancellation exits workers and startup reconciliation touches only headless-owned results", async (t) => {
    const current = await fixture(t, { bounded: false, maxSteps: 1_000_000, loggingPolicy: "disabled" });
    const service = new HeadlessExperimentService(current.storage, current.logs, {
        artifactRoot: path.join(current.root, "artifacts"),
    });
    const started = await service.start({ suiteId: current.suite.id, resultId: "cancelled-result", artifactProfile: "disabled" });
    const cancelled = await service.cancel(started.resultId);
    assert.equal(cancelled.status, "cancelled");
    assert.ok(cancelled.cases.every((entry) => entry.status === "cancelled"));
    assert.equal(service.supervisor.workers.size, 0);
    assert.equal(service.supervisor.batches.size, 0);
    const stagingNames = [];
    async function collect(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
            if (entry.isDirectory()) {
                stagingNames.push(entry.name);
                await collect(path.join(directory, entry.name));
            }
        }
    }
    await collect(path.join(current.root, "artifacts"));
    assert.equal(stagingNames.some((name) => name.startsWith(".") && name.includes(".tmp-")), false);
    await service.close();

    const headless = createExperimentResult(current.suite, [{
        id: "headless-case",
        scenarioId: current.suite.scenarioIds[0],
        manifestId: current.suite.manifestIds[0],
        seed: 7,
        parameters: {},
        status: "running",
    }], {
        id: "stale-headless",
        status: "running",
        execution: { backend: "headless", jobId: "old-job" },
    });
    const browser = createExperimentResult(current.suite, [{
        id: "browser-case",
        scenarioId: current.suite.scenarioIds[0],
        manifestId: current.suite.manifestIds[0],
        seed: 7,
        parameters: {},
        status: "running",
    }], {
        id: "stale-browser",
        status: "running",
        execution: { backend: "browser", jobId: null },
    });
    await current.storage.createExperimentResult(headless);
    await current.storage.createExperimentResult(browser);
    const restarted = new HeadlessExperimentService(current.storage, current.logs, {
        supervisor: new FakeSupervisor(),
        artifactRoot: path.join(current.root, "restart-artifacts"),
    });
    await restarted.initialize();
    assert.equal((await current.storage.getExperimentResult("stale-headless")).status, "interrupted");
    assert.equal((await current.storage.getExperimentResult("stale-browser")).status, "running");
    await restarted.close();
});
