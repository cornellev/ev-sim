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
    assert.equal(supervisor.calls, 1);
    release();
    await service.waitForCompletion("queue-first");
    await service.waitForCompletion("queue-second");
    assert.equal(supervisor.calls, 2);
    await service.close();
});

test("headless queue persists immutable bundle sidecars at admission", async (t) => {
    const { storage, logs, suite } = await fixture(t);
    const service = new HeadlessExperimentService(storage, logs, {
        supervisor: new FakeSupervisor(),
        artifactRoot: path.join(storage.dataDir, "artifacts"),
    });
    const enqueued = await service.enqueue({ suiteId: suite.id, resultId: "immutable-run", artifactProfile: "disabled" });
    const sidecars = await storage.readHeadlessRunBundles(enqueued.resultId);
    assert.ok(sidecars);
    assert.equal(sidecars.bundles.length, 1);
    const originalHash = sidecars.bundles[0].resolvedHash;
    await storage.putExperimentSuite(suite.id, {
        expectedRevision: (await storage.getExperimentSuite(suite.id)).revision,
        suite: { ...(await storage.getExperimentSuite(suite.id)), name: "Edited after enqueue" },
    });
    const reread = await storage.readHeadlessRunBundles(enqueued.resultId);
    assert.equal(reread.bundles[0].resolvedHash, originalHash);
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
