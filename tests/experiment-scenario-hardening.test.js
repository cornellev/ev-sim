import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as THREE from "three";

import {
    createExperimentBaseline,
} from "../app/experiments/BaselineComparison.js";
import {
    normalizeExperimentResult,
} from "../app/experiments/ExperimentResult.js";
import {
    createDefaultExperimentSuite,
} from "../app/experiments/ExperimentSuite.js";
import {
    createDefaultScenario,
} from "../app/scenarios/ScenarioDocument.js";
import {
    SCENARIO_DIAGNOSTIC_LAYER,
    ScenarioDiagnostics,
} from "../app/scenarios/ScenarioDiagnostics.js";
import { verifyRoute } from "../app/scenarios/route/index.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { StorageService } from "../server/storage/StorageService.js";

function layer(layerId) {
    const layers = new THREE.Layers();
    layers.set(layerId);
    return layers;
}

function routeScenario(environment, {
    id = "vertical-route",
    expectedEnvironmentHash = null,
    edge = null,
} = {}) {
    const document = environment.document ?? environment;
    const nodes = new Map(document.roads.nodes.map((node) => [node.id, node]));
    const selectedEdge = edge ?? document.roads.edges.find((candidate) => {
        const start = nodes.get(candidate.startNodeId);
        const finish = nodes.get(candidate.endNodeId);
        return start && finish && Math.abs(finish.z - start.z) > 1e-6;
    });
    assert.ok(selectedEdge, "the environment should expose a road with a nonzero Z tangent");
    const start = nodes.get(selectedEdge.startNodeId);
    const finish = nodes.get(selectedEdge.endNodeId);
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
    assert.equal(verified.ok, true, verified.error);
    return createDefaultScenario({
        id,
        name: id,
        environment: {
            id: document.environmentId,
            expectedHash: expectedEnvironmentHash,
        },
        routes: [{
            id: "ego-route",
            name: "Ego route",
            actorId: "ego",
            initialSpeedMps: 2,
            controller: { kind: "route-follower", activation: { kind: "start" } },
            waypoints: verified.waypoints,
            verification: verified.verification,
        }],
        completion: {
            conditions: [{
                id: "time-limit",
                name: "Time limit",
                kind: "max-duration",
                durationNs: 5_000_000_000,
            }],
        },
    });
}

async function temporaryService(prefix) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    return { directory, service: new StorageService(directory) };
}

test("scenario diagnostics use an operator-only, non-colliding render layer", () => {
    const scene = new THREE.Scene();
    const operatorCamera = new THREE.PerspectiveCamera();
    const sensorCamera = new THREE.PerspectiveCamera();
    const diagnostics = new ScenarioDiagnostics();

    diagnostics.attach(scene, operatorCamera);
    diagnostics.setEnabled(true);
    diagnostics.configure({
        actors: [{ id: "ego", name: "Ego" }],
        routes: [{
            id: "ego-route",
            actorId: "ego",
            waypoints: [{ position: { x: 0, y: 0, z: 0 } }],
            verification: {
                polyline: [
                    { x: 0, y: 0, z: 0 },
                    { x: 4, y: 0, z: 2 },
                ],
            },
        }],
        zones: [{
            id: "finish-zone",
            center: { x: 4, y: 1, z: 2 },
            size: { x: 2, y: 2, z: 2 },
        }],
        triggers: [{
            id: "finish-trigger",
            condition: { kind: "zone-enter", zoneId: "finish-zone" },
        }],
    });

    const diagnosticLayer = layer(SCENARIO_DIAGNOSTIC_LAYER);
    const defaultLayer = layer(0);
    assert.equal(diagnostics.group.parent, scene);
    assert.equal(diagnostics.group.visible, true);
    assert.equal(diagnostics.group.userData.nonColliding, true);
    assert.equal(diagnostics.group.layers.test(diagnosticLayer), true);
    assert.equal(diagnostics.group.layers.test(defaultLayer), false);
    assert.equal(operatorCamera.layers.test(diagnosticLayer), true);
    assert.equal(sensorCamera.layers.test(diagnosticLayer), false);

    const renderables = [];
    diagnostics.group.traverse((object) => {
        if (object.isLine || object.isLineSegments || object.isSprite) renderables.push(object);
    });
    assert.ok(renderables.length >= 2);
    for (const object of renderables) {
        assert.equal(object.userData.scenarioDiagnostic, true);
        assert.equal(object.layers.test(diagnosticLayer), true);
        assert.equal(object.layers.test(defaultLayer), false);
    }

    const egoLabel = diagnostics.roleObjects.get("ego");
    assert.ok(egoLabel);
    assert.equal(egoLabel.layers.test(diagnosticLayer), true);
    assert.deepEqual([egoLabel.position.x, egoLabel.position.y, egoLabel.position.z], [0, 1.8, 0]);
    diagnostics.update({
        latestTrigger: { id: "finish-trigger" },
        actorPoses: { ego: { x: 4, y: 0.5, z: 2 } },
    });
    assert.equal(diagnostics.zoneObjects.get("finish-zone").material.color.getHex(), 0xffb454);
    assert.deepEqual([egoLabel.position.x, egoLabel.position.y, egoLabel.position.z], [4, 2.3, 2]);
    diagnostics.dispose();
    assert.equal(diagnostics.group.parent, null);
});

test("experiment result normalization preserves structured trigger, terminal, and outcome details", () => {
    const source = {
        kind: "cev-sim.experiment-result",
        version: 1,
        id: "structured-result",
        suiteId: "suite-a",
        status: "completed",
        finishedAt: "2026-07-30T12:00:01.000Z",
        cases: [{
            id: "case-a",
            scenarioId: "route-a",
            manifestId: "controller-a",
            seed: 7,
            parameters: { gain: 0.5 },
            status: "failed",
            completed: true,
            passed: false,
            startedAt: "2026-07-30T12:00:00.000Z",
            finishedAt: "2026-07-30T12:00:01.000Z",
            latestTrigger: {
                id: "minimum-gap",
                name: "Minimum gap",
                firedAt: { step: 42, timeNs: 700_000_000 },
                actions: [{ kind: "finish" }],
            },
            terminalEvent: {
                reason: "trigger",
                trigger: { id: "minimum-gap" },
                contact: { actors: ["ego", "pedestrian"] },
            },
            assertions: [{
                id: "minimum-clearance",
                name: "Minimum clearance",
                status: "failed",
                severity: "error",
                message: "Expected clearance above 1m.",
            }],
            outcomes: [{
                id: "no-collision",
                name: "No collision",
                status: "failed",
                passed: false,
                message: "A collision was observed.",
                detail: {
                    collisionCount: 1,
                    firstCollision: { step: 42, actors: ["ego", "pedestrian"] },
                },
            }],
        }],
    };

    const result = normalizeExperimentResult(source);
    const entry = result.cases[0];
    assert.deepEqual(entry.latestTrigger, source.cases[0].latestTrigger);
    assert.deepEqual(entry.terminalEvent, source.cases[0].terminalEvent);
    assert.deepEqual(entry.assertions, source.cases[0].assertions);
    assert.deepEqual(entry.outcomes[0].detail, source.cases[0].outcomes[0].detail);
    assert.equal(entry.outcomes[0].message, "A collision was observed.");

    source.cases[0].latestTrigger.firedAt.step = 999;
    source.cases[0].terminalEvent.contact.actors.push("other");
    source.cases[0].assertions[0].message = "mutated";
    source.cases[0].outcomes[0].detail.collisionCount = 99;
    assert.equal(entry.latestTrigger.firedAt.step, 42);
    assert.deepEqual(entry.terminalEvent.contact.actors, ["ego", "pedestrian"]);
    assert.equal(entry.assertions[0].message, "Expected clearance above 1m.");
    assert.equal(entry.outcomes[0].detail.collisionCount, 1);

    const roundTripped = normalizeExperimentResult(JSON.parse(JSON.stringify(result)));
    assert.deepEqual(roundTripped.cases[0].latestTrigger, entry.latestTrigger);
    assert.deepEqual(roundTripped.cases[0].terminalEvent, entry.terminalEvent);
    assert.deepEqual(roundTripped.cases[0].assertions, entry.assertions);
    assert.deepEqual(roundTripped.cases[0].outcomes[0].detail, entry.outcomes[0].detail);
});

test("resolved scenario vehicle yaw maps local +X onto a route with nonzero Z", async () => {
    const { directory, service } = await temporaryService("cev-heading-hardening-");
    try {
        const environment = await service.getEnvironment("igvc");
        const scenario = await service.createScenario(routeScenario(environment));
        await service.createRunManifest(createDefaultRunManifest({
            id: "vertical-controller",
            scenario: {
                id: scenario.id,
                egoVehicleId: "big-car",
                sensorBindings: {},
                parameterValues: {},
            },
            sensorRig: { rootFrameId: "base_link", sensors: [] },
            topics: [],
        }));

        const resolved = await service.resolveRunManifest("vertical-controller");
        const polyline = resolved.scenario.scenario.routes[0].verification.polyline;
        const dx = polyline[1].x - polyline[0].x;
        const dz = polyline[1].z - polyline[0].z;
        assert.ok(Math.abs(dz) > 1e-6);
        const length = Math.hypot(dx, dz);
        const vehicle = resolved.manifest.initialState.vehicles.find((entry) => entry.id === "ego");
        const egoDependency = resolved.vehicles.find((entry) => entry.actorId === "ego");
        const yaw = vehicle.pose.rotation.y;

        assert.ok(Math.abs(Math.cos(yaw) - dx / length) < 1e-9);
        assert.ok(Math.abs(-Math.sin(yaw) - dz / length) < 1e-9);
        assert.equal(vehicle.linearVelocity.x, 2);
        assert.equal(vehicle.linearVelocity.z, 0);
        assert.match(egoDependency.assetHashes["/shell/shell.gltf"], /^[a-f0-9]{64}$/);
        assert.match(egoDependency.assetHashes["/shell/buffer.bin"], /^[a-f0-9]{64}$/);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("stored baselines snapshot every case dependency in provenance", async () => {
    const { directory, service } = await temporaryService("cev-baseline-hardening-");
    try {
        const dependencyHashes = {
            scenario: "scenario-v1",
            environment: "environment-v1",
            scripts: { controller: "controller-v1" },
            vehicles: { "big-car": "vehicle-v1" },
        };
        const result = await service.createExperimentResult({
            kind: "cev-sim.experiment-result",
            version: 1,
            id: "dependency-result",
            suiteId: "suite-a",
            status: "completed",
            createdAt: "2026-07-30T12:00:00.000Z",
            finishedAt: "2026-07-30T12:00:01.000Z",
            metricDefinitions: [],
            cases: [{
                id: "case-a",
                scenarioId: "route-a",
                manifestId: "controller-a",
                seed: 7,
                parameters: { gain: 0.5 },
                status: "completed",
                completed: true,
                passed: true,
                metrics: { passed: 1 },
                dependencyHashes,
                resolvedHash: "resolved-v1",
                startedAt: "2026-07-30T12:00:00.000Z",
                finishedAt: "2026-07-30T12:00:01.000Z",
            }],
        });
        const baseline = await service.createExperimentBaseline({
            resultId: result.id,
            id: "dependency-baseline",
            name: "Dependency Baseline",
            createdAt: "2026-07-30T12:01:00.000Z",
            provenance: {
                appVersion: "1.0.0",
                gitCommit: "abc123",
                dependencies: { runtime: { three: "0.182.0" } },
            },
        });
        const caseKey = baseline.cases[0].key;

        assert.deepEqual(baseline.provenance.dependencies.runtime, { three: "0.182.0" });
        assert.deepEqual(baseline.provenance.dependencies.cases[caseKey], {
            resolvedHash: "resolved-v1",
            dependencyHashes,
        });

        dependencyHashes.scripts.controller = "mutated-source";
        assert.equal(
            baseline.provenance.dependencies.cases[caseKey].dependencyHashes.scripts.controller,
            "controller-v1",
        );
        assert.equal(Object.isFrozen(createExperimentBaseline(result, {
            id: "in-memory-baseline",
            createdAt: "2026-07-30T12:02:00.000Z",
        })), true);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("server suite validation isolates dependency-incompatible cells without blocking valid case resolution", async () => {
    const { directory, service } = await temporaryService("cev-suite-hardening-");
    try {
        const environment = await service.getEnvironment("igvc");
        const compatibleScenario = await service.createScenario(routeScenario(environment, {
            id: "compatible-route",
        }));
        await service.createScenario(routeScenario(environment, {
            id: "stale-route",
            expectedEnvironmentHash: "stale-environment-hash",
        }));
        await service.createRunManifest(createDefaultRunManifest({
            id: "controller-a",
            sensorRig: { rootFrameId: "base_link", sensors: [] },
            topics: [],
        }));
        await service.createExperimentSuite(createDefaultExperimentSuite({
            id: "dependency-suite",
            scenarioIds: ["compatible-route", "stale-route"],
            manifestIds: ["controller-a"],
            seeds: [17],
            metrics: [],
        }));

        const validation = await service.validateExperimentSuite("dependency-suite");
        assert.equal(validation.ok, true);
        assert.deepEqual(validation.matrix.cases.map((entry) => entry.scenarioId), ["compatible-route"]);
        assert.equal(validation.matrix.incompatible.length, 1);
        assert.equal(validation.matrix.incompatible[0].scenarioId, "stale-route");
        assert.match(validation.matrix.incompatible[0].reason, /environment.*changed/i);

        const resolved = await service.resolveExperimentCase("dependency-suite", {
            caseId: validation.matrix.cases[0].id,
        });
        assert.equal(resolved.case.scenarioId, compatibleScenario.id);
        assert.equal(resolved.resolvedRun.scenario.scenario.id, compatibleScenario.id);
        assert.equal(resolved.resolvedHash, resolved.resolvedRun.resolvedHash);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
