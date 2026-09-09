import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultExperimentSuite } from "../app/experiments/ExperimentSuite.js";
import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { verifyRoute } from "../app/scenarios/route/index.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { HeadlessExperimentService } from "../server/headless/HeadlessExperimentService.js";
import { LogService } from "../server/logging/LogService.js";
import { StorageService } from "../server/storage/StorageService.js";

class FakeSupervisor {
    constructor(handler = async (request) => ({
        outputDirectory: request.outputUri,
        artifacts: [],
        experimentMetrics: { passed: 1 },
        runResult: {
            runId: "run-a",
            passed: true,
            resolvedHash: request.bundle.resolvedHash,
            simulationSemanticHash: request.bundle.simulationSemanticHash,
            episodeHash: "a".repeat(64),
            trajectoryHash: "b".repeat(64),
        },
    })) {
        this.handler = handler;
        this.calls = 0;
    }

    async runManagedExperiment(request, options) {
        if (options.signal?.aborted) throw new Error("cancelled");
        this.calls += 1;
        options.onStarted?.({ pid: 1000 + this.calls });
        const result = await this.handler(request, options, this.calls);
        if (options.signal?.aborted) throw new Error("cancelled");
        return result;
    }

    async close() {}
    async getCapabilities() {
        return { runtimeVersion: "test", platform: process.platform, architecture: process.arch };
    }
}

async function waitForGateOrAbort(gate, signal) {
    if (signal?.aborted) throw new Error("cancelled");
    await new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error("cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(gate).then(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }).catch(reject);
    });
}

async function waitFor(predicate, { timeoutMs = 2_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for managed queue state.");
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-headless-queue-"));
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
        controller: { kind: "route-follower", activation: { kind: "start" } },
        waypoints: [
            { id: "start", position: { x: start.x, y: 0, z: start.z } },
            { id: "finish", position: { x: finish.x, y: 0, z: finish.z } },
        ],
    });
    assert.equal(verified.ok, true);
    const scenario = await storage.createScenario(createDefaultScenario({
        id: "queue-scenario",
        name: "Queue scenario",
        environment: { id: "igvc", expectedHash: null },
        routes: [{
            id: "ego-route",
            actorId: "ego",
            initialSpeedMps: 2,
            controller: { kind: "route-follower", activation: { kind: "start" } },
            waypoints: verified.waypoints,
            verification: verified.verification,
        }],
        triggers: [{ id: "finish-step", enabled: true, once: true, condition: { kind: "step", step: 4 }, actions: [{ kind: "finish" }] }],
        completion: { conditions: [] },
        expectedOutcomes: [{ id: "safe", kind: "no-collisions" }],
    }));
    const manifest = await storage.createRunManifest(createDefaultRunManifest({
        id: "queue-manifest",
        name: "Queue manifest",
        seed: "7",
        scenario: { id: scenario.id, expectedHash: scenario.definitionHash, egoVehicleId: "igvc-car", sensorBindings: {}, parameterValues: {} },
        controls: { authority: "reference" },
        sensorRig: { sensors: [], syncGroups: [] },
        clock: { pacing: "unbounded", maxSteps: 20 },
        logging: { policy: "disabled", profileId: "simulation-run-full-sensors" },
    }));
    const suite = await storage.createExperimentSuite(createDefaultExperimentSuite({
        id: "queue-suite",
        name: "Queue suite",
        scenarioIds: [scenario.id],
        manifestIds: [manifest.id],
        seeds: [7],
        metrics: [{ id: "passed", source: { kind: "builtin", metric: "passed" } }],
    }));
    return { root, storage, logs, suite };
}

test("headless queue preserves FIFO order and executes one worker at a time", async (t) => {
    const { storage, logs, suite } = await fixture(t);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const supervisor = new FakeSupervisor(async (request, options) => {
        await waitForGateOrAbort(gate, options.signal);
        return {
            outputDirectory: request.outputUri,
            artifacts: [],
            experimentMetrics: { passed: 1 },
            runResult: {
                runId: "run-a",
                passed: true,
                resolvedHash: request.bundle.resolvedHash,
                simulationSemanticHash: request.bundle.simulationSemanticHash,
                episodeHash: "a".repeat(64),
                trajectoryHash: "b".repeat(64),
            },
        };
    });
    const service = new HeadlessExperimentService(storage, logs, {
        supervisor,
        artifactRoot: path.join(storage.dataDir, "artifacts"),
    });
    const first = await service.enqueue({ suiteId: suite.id, resultId: "queue-first" });
    const second = await service.enqueue({ suiteId: suite.id, resultId: "queue-second" });
    assert.equal(first.queuePosition, 1);
    assert.equal(second.queuePosition, 2);
    await waitFor(() => supervisor.calls === 1);
    assert.equal(supervisor.calls, 1);
    release();
    await service.waitForCompletion("queue-first");
    await service.waitForCompletion("queue-second");
    assert.equal(supervisor.calls, 2);
    await service.close();
});

test("headless queue persists immutable bundle sidecars at admission", async (t) => {
    const { storage, logs, suite } = await fixture(t);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const service = new HeadlessExperimentService(storage, logs, {
        supervisor: new FakeSupervisor(async (request, options) => {
            await waitForGateOrAbort(gate, options.signal);
            return {
                outputDirectory: request.outputUri,
                artifacts: [],
                experimentMetrics: { passed: 1 },
                runResult: {
                    runId: "immutable-run",
                    passed: true,
                    resolvedHash: request.bundle.resolvedHash,
                    simulationSemanticHash: request.bundle.simulationSemanticHash,
                    episodeHash: "a".repeat(64),
                    trajectoryHash: "b".repeat(64),
                },
            };
        }),
        artifactRoot: path.join(storage.dataDir, "artifacts"),
    });
    const enqueued = await service.enqueue({ suiteId: suite.id, resultId: "immutable-run", artifactProfile: "disabled" });
    const sidecars = await storage.readHeadlessRunBundles(enqueued.resultId);
    assert.ok(sidecars);
    assert.equal(sidecars.manifest.version, 2);
    assert.equal(sidecars.bundles.length, 1);
    assert.equal(sidecars.bundleRecords[0].bundleBytesHash, sidecars.manifest.cases[0].bundleBytesHash);
    const originalHash = sidecars.bundles[0].resolvedHash;
    const sidecarPath = path.join(
        storage.dataDir,
        "headless-run-bundles",
        enqueued.resultId,
        "case-0000.bundle.json",
    );
    const originalBytes = await fs.readFile(sidecarPath);
    await fs.writeFile(sidecarPath, Buffer.concat([originalBytes, Buffer.from(" ")]));
    await assert.rejects(() => storage.readHeadlessRunBundles(enqueued.resultId), /byte digest/);
    await fs.writeFile(sidecarPath, originalBytes);
    await storage.putExperimentSuite(suite.id, {
        expectedRevision: (await storage.getExperimentSuite(suite.id)).revision,
        suite: { ...(await storage.getExperimentSuite(suite.id)), name: "Edited after enqueue" },
    });
    const reread = await storage.readHeadlessRunBundles(enqueued.resultId);
    assert.equal(reread.bundles[0].resolvedHash, originalHash);
    release();
    await service.waitForCompletion(enqueued.resultId);
    await service.close();
});

test("pending queue cancellation removes work without launching a worker", async (t) => {
    const { storage, logs, suite } = await fixture(t);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const supervisor = new FakeSupervisor(async (request, options) => {
        await waitForGateOrAbort(gate, options.signal);
        return {
            outputDirectory: request.outputUri,
            artifacts: [],
            experimentMetrics: { passed: 1 },
            runResult: {
                runId: "run-a",
                passed: true,
                resolvedHash: request.bundle.resolvedHash,
                simulationSemanticHash: request.bundle.simulationSemanticHash,
                episodeHash: "a".repeat(64),
                trajectoryHash: "b".repeat(64),
            },
        };
    });
    const service = new HeadlessExperimentService(storage, logs, {
        supervisor,
        artifactRoot: path.join(storage.dataDir, "artifacts"),
    });
    await service.enqueue({ suiteId: suite.id, resultId: "active-run" });
    const pending = await service.enqueue({ suiteId: suite.id, resultId: "pending-run" });
    const cancelled = await service.cancel(pending.resultId);
    assert.equal(cancelled.status, "cancelled");
    release();
    await service.waitForCompletion("active-run");
    assert.equal(supervisor.calls, 1);
    await service.close();
});

test("service shutdown interrupts only the uncertain case and recovery resumes frozen pending work", async (t) => {
    const { storage, logs, suite } = await fixture(t);
    const never = new Promise(() => {});
    const firstSupervisor = new FakeSupervisor(async (_request, options) => {
        await waitForGateOrAbort(never, options.signal);
        throw new Error("unreachable");
    });
    const firstService = new HeadlessExperimentService(storage, logs, {
        supervisor: firstSupervisor,
        artifactRoot: path.join(storage.dataDir, "shutdown-artifacts"),
    });
    await firstService.enqueue({ suiteId: suite.id, resultId: "shutdown-running", artifactProfile: "disabled" });
    await firstService.enqueue({ suiteId: suite.id, resultId: "shutdown-pending", artifactProfile: "disabled" });
    await waitFor(() => firstSupervisor.calls === 1);
    const frozen = await storage.readHeadlessRunBundles("shutdown-pending");
    const frozenHash = frozen.bundles[0].resolvedHash;
    const currentSuite = await storage.getExperimentSuite(suite.id);
    await storage.putExperimentSuite(suite.id, {
        expectedRevision: currentSuite.revision,
        suite: { ...currentSuite, name: "Edited while pending" },
    });
    await firstService.close();

    assert.equal((await storage.getExperimentResult("shutdown-running")).status, "interrupted");
    assert.equal((await storage.getExperimentResult("shutdown-pending")).status, "pending");
    assert.deepEqual(
        (await storage.getHeadlessExperimentQueue()).entries.map((entry) => entry.resultId),
        ["shutdown-pending"],
    );

    let resumedHash = null;
    const restarted = new HeadlessExperimentService(storage, logs, {
        supervisor: new FakeSupervisor(async (request) => {
            resumedHash = request.bundle.resolvedHash;
            return {
                outputDirectory: request.outputUri,
                artifacts: [],
                experimentMetrics: { passed: 1 },
                runResult: {
                    runId: "recovered",
                    passed: true,
                    resolvedHash: request.bundle.resolvedHash,
                    simulationSemanticHash: request.bundle.simulationSemanticHash,
                    episodeHash: "a".repeat(64),
                    trajectoryHash: "b".repeat(64),
                },
            };
        }),
        artifactRoot: path.join(storage.dataDir, "recovery-artifacts"),
    });
    await restarted.initialize();
    const recovered = await restarted.waitForCompletion("shutdown-pending");
    assert.equal(recovered.status, "completed");
    assert.equal(resumedHash, frozenHash);
    await restarted.close();
});
