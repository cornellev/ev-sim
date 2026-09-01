import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";
import { createDefaultExperimentSuite } from "../app/experiments/ExperimentSuite.js";
import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { verifyRoute } from "../app/scenarios/route/index.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { HeadlessExperimentService } from "../server/headless/HeadlessExperimentService.js";
import { LogService } from "../server/logging/LogService.js";
import { createHeadlessRouter } from "../server/routes/headlessRouter.js";
import { StorageService } from "../server/storage/StorageService.js";

class FakeSupervisor {
    async runManagedExperiment(request, options) {
        options.onStarted?.({ pid: 4321 });
        return {
            outputDirectory: request.outputUri,
            artifacts: [],
            experimentMetrics: { passed: 1 },
            runResult: {
                runId: "run-api",
                passed: true,
                resolvedHash: request.bundle.resolvedHash,
                simulationSemanticHash: request.bundle.simulationSemanticHash,
                episodeHash: "c".repeat(64),
                trajectoryHash: "d".repeat(64),
            },
        };
    }

    async close() {}
    async getCapabilities() {
        return { runtimeVersion: "test", platform: process.platform, architecture: process.arch };
    }
}

async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-headless-api-"));
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
    const scenario = await storage.createScenario(createDefaultScenario({
        id: "api-scenario",
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
        id: "api-manifest",
        scenario: { id: scenario.id, expectedHash: scenario.definitionHash, egoVehicleId: "igvc-car", sensorBindings: {}, parameterValues: {} },
        controls: { authority: "reference" },
        sensorRig: { sensors: [], syncGroups: [] },
        clock: { pacing: "unbounded", maxSteps: 20 },
        logging: { policy: "disabled", profileId: "simulation-run-full-sensors" },
    }));
    const suite = await storage.createExperimentSuite(createDefaultExperimentSuite({
        id: "api-suite",
        scenarioIds: [scenario.id],
        manifestIds: [manifest.id],
        seeds: [7],
        metrics: [{ id: "passed", source: { kind: "builtin", metric: "passed" } }],
    }));
    const service = new HeadlessExperimentService(storage, logs, {
        supervisor: new FakeSupervisor(),
        artifactRoot: path.join(root, "artifacts"),
    });
    await service.initialize();
    const app = express();
    app.use(express.json());
    app.use("/api/headless", createHeadlessRouter(service));
    const server = app.listen(0);
    t.after(async () => {
        await service.close();
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    });
    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    const base = `http://127.0.0.1:${port}/api/headless`;
    return { base, origin, service, suite };
}

async function json(url, options = {}) {
    const response = await fetch(url, options);
    const payload = await response.json();
    return { response, payload };
}

test("headless API exposes capabilities, preflight, enqueue, list, detail, and cancel", async (t) => {
    const { base, origin, suite } = await fixture(t);
    const caps = await json(`${base}/capabilities`);
    assert.equal(caps.response.status, 200);
    assert.equal(caps.payload.queueMode, "fifo-single-case");

    const preflight = await json(`${base}/preflight`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ suiteId: suite.id, artifactProfile: "disabled" }),
    });
    assert.equal(preflight.response.status, 200);
    assert.equal(preflight.payload.caseCount, 1);

    const enqueue = await json(`${base}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ suiteId: suite.id, resultId: "api-run", artifactProfile: "disabled" }),
    });
    assert.equal(enqueue.response.status, 200);
    assert.equal(enqueue.payload.resultId, "api-run");

    const list = await json(`${base}/runs`);
    assert.equal(list.response.status, 200);
    assert.ok(list.payload.runs.some((entry) => entry.id === "api-run"));

    const detail = await json(`${base}/runs/api-run`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.result.id, "api-run");
    assert.equal(Object.hasOwn(detail.payload.result.cases[0], "dependencyHashes"), false);

    const cancel = await json(`${base}/runs/api-run/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: "{}",
    });
    assert.equal(cancel.response.status, 200);
});

test("headless API rejects cross-origin mutation requests", async (t) => {
    const { base, suite } = await fixture(t);
    const rejected = await json(`${base}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
        body: JSON.stringify({ suiteId: suite.id, resultId: "blocked-run" }),
    });
    assert.equal(rejected.response.status, 403);
});
