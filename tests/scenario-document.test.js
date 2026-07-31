import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    createDefaultScenario,
    createScenarioCatalog,
    normalizeScenario,
    validateScenario,
} from "../app/scenarios/ScenarioDocument.js";
import { verifyRoute } from "../app/scenarios/route/index.js";
import { createDefaultRunManifest, validateRunManifest } from "../app/simulation/RunManifest.js";
import { StorageService } from "../server/storage/StorageService.js";

async function temporaryService() {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-scenario-"));
    return { directory, service: new StorageService(directory) };
}

function validScenario(environment) {
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
    return normalizeScenario({
        ...createDefaultScenario({ id: "route-case", name: "Route case" }),
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
            conditions: [{ id: "duration", name: "Maximum duration", kind: "max-duration", durationNs: 5e9 }],
        },
        expectedOutcomes: [{ id: "safe", name: "No collisions", kind: "no-collisions" }],
        parameters: [{
            id: "ego-speed",
            name: "Ego speed",
            type: "float64",
            default: 2,
            target: { kind: "scalar-field", path: "routes.0.initialSpeedMps" },
        }],
    });
}

test("scenario documents preserve Ego invariants and require termination and verified routes", () => {
    const draft = createDefaultScenario();
    const validation = validateScenario(draft);
    assert.equal(draft.kind, "cev-sim.scenario");
    assert.equal(draft.version, 1);
    assert.equal(draft.actors[0].id, "ego");
    assert.equal(draft.actors[0].vehicleId, null);
    assert.equal(validation.ok, false);
    assert.match(validation.issues.map((issue) => issue.message).join(" "), /termination|waypoints|verified/i);

    const misplacedEgo = validateScenario({
        ...draft,
        actors: [
            { id: "actor-1", role: "actor", vehicleId: "big-car" },
            { id: "ego", role: "ego" },
        ],
    });
    assert.equal(misplacedEgo.ok, false);
    assert.match(misplacedEgo.issues.map((issue) => issue.message).join(" "), /Ego must be the first actor/i);
});

test("scenario storage supports drafts, optimistic revisions, folders, validation, and resolution", async () => {
    const { directory, service } = await temporaryService();
    try {
        const environment = await service.getEnvironment("igvc");
        assert.ok(environment.document.roads.edges.length > 0);
        const scenario = validScenario(environment);
        assert.equal(validateScenario(scenario).ok, true);

        const stored = await service.createScenario(scenario);
        assert.equal(stored.revision, 1);
        assert.equal(stored.definitionHash.length, 64);
        assert.deepEqual((await service.listScenarios()).map((entry) => entry.id), ["route-case"]);

        const catalog = await service.putScenarioCatalog(createScenarioCatalog({
            folders: [{ id: "regression", name: "Regression" }],
        }));
        assert.deepEqual(catalog.folders, [{ id: "regression", name: "Regression" }]);

        const resolved = await service.resolveScenario("route-case", { parameterValues: { "ego-speed": 3.5 } });
        assert.equal(resolved.scenario.routes[0].initialSpeedMps, 3.5);
        assert.equal(resolved.parameters.values["ego-speed"], 3.5);
        assert.equal(resolved.dependencyHashes.roadNetwork, scenario.routes[0].verification.environmentHash);

        const updated = await service.putScenario("route-case", {
            scenario: { ...stored, description: "Updated" },
            expectedRevision: 1,
        });
        assert.equal(updated.revision, 2);
        await assert.rejects(
            service.putScenario("route-case", { scenario: stored, expectedRevision: 1 }),
            /revision conflict/,
        );
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("route verification endpoint produces the same canonical proof consumed by resolution", async () => {
    const { directory, service } = await temporaryService();
    try {
        const environment = await service.getEnvironment("igvc");
        const scenario = validScenario(environment);
        const authored = structuredClone(scenario);
        const edge = environment.document.roads.edges[0];
        const nodes = new Map(environment.document.roads.nodes.map((node) => [node.id, node]));
        const start = nodes.get(edge.startNodeId);
        const end = nodes.get(edge.endNodeId);
        const pointAt = (fraction) => ({
            x: start.x + ((end.x - start.x) * fraction),
            y: 0,
            z: start.z + ((end.z - start.z) * fraction),
        });
        authored.routes[0].waypoints = [
            { id: "start", position: pointAt(0.25) },
            { id: "finish", position: pointAt(0.75) },
        ];
        authored.routes[0].verification = null;
        const verified = await service.verifyScenarioRoute(authored.id, {
            scenario: authored,
            routeId: authored.routes[0].id,
        });
        assert.equal(verified.ok, true);
        authored.routes[0].waypoints = verified.waypoints;
        authored.routes[0].verification = verified.verification;

        const validation = await service.validateScenario(authored.id, { scenario: authored });
        assert.equal(validation.ok, true, validation.issues.map((issue) => issue.message).join(" "));
        const resolved = await service.resolveScenario(authored.id, { scenario: authored });
        assert.equal(resolved.dependencyHashes.roadNetwork, verified.verification.environmentHash);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("run resolution freezes a transient scenario, concrete Ego vehicle, and parameter vector", async () => {
    const { directory, service } = await temporaryService();
    try {
        const scenario = await service.createScenario(validScenario(await service.getEnvironment("igvc")));
        const manifest = createDefaultRunManifest({
            id: "scenario-run",
            name: "Scenario run",
            scenario: {
                id: scenario.id,
                expectedHash: scenario.definitionHash,
                egoVehicleId: "big-car",
                sensorBindings: {},
                parameterValues: { "ego-speed": 4 },
            },
        });
        await service.createRunManifest(manifest);
        const resolved = await service.resolveRunManifest("scenario-run");
        assert.equal(resolved.scenario.scenario.id, scenario.id);
        assert.equal(resolved.manifest.environment.id, scenario.environment.id);
        assert.equal(resolved.manifest.initialState.vehicles[0].id, "ego");
        assert.equal(resolved.manifest.initialState.vehicles[0].type, "big-car");
        assert.equal(resolved.scenario.scenario.routes[0].initialSpeedMps, 4);
        assert.ok(resolved.dependencyHashes.scenario);
        assert.ok(resolved.dependencyHashes.vehicles["big-car"]);

        const transient = await service.resolveRunManifest("scenario-run", {
            scenarioId: scenario.id,
            egoVehicleId: "igvc-car",
            scenarioParameterValues: { "ego-speed": 1.25 },
            seed: "case-7",
        });
        assert.equal(transient.manifest.seed, "case-7");
        assert.equal(transient.manifest.initialState.vehicles[0].type, "igvc-car");
        assert.equal(transient.scenario.scenario.routes[0].initialSpeedMps, 1.25);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("route verification rejects empty, stale, and forged canonical proofs", async () => {
    const { directory, service } = await temporaryService();
    try {
        const environment = await service.getEnvironment("igvc");
        const canonical = validScenario(environment);

        const emptyProof = structuredClone(canonical);
        emptyProof.routes[0].verification = {};
        const emptyValidation = validateScenario(emptyProof);
        assert.equal(emptyValidation.ok, false);
        assert.match(emptyValidation.issues.map((issue) => issue.message).join(" "), /directed-a-star|environment hash|sections|polyline/i);
        await assert.rejects(
            service.resolveScenario(emptyProof.id, { scenario: emptyProof }),
            /verification|verified/i,
        );

        const changedWaypoint = structuredClone(canonical);
        changedWaypoint.routes[0].waypoints[1].position.x += 0.5;
        const changedValidation = validateScenario(changedWaypoint);
        assert.equal(changedValidation.ok, false);
        assert.match(changedValidation.issues.map((issue) => issue.message).join(" "), /current waypoints/i);

        const forgedGeometry = structuredClone(canonical);
        forgedGeometry.routes[0].verification.polyline[0].x += 0.25;
        assert.equal(validateScenario(forgedGeometry).ok, true, "finite forged geometry needs the environment to disprove it");
        const dependencyValidation = await service.validateScenario(forgedGeometry.id, { scenario: forgedGeometry });
        assert.equal(dependencyValidation.ok, false);
        assert.match(dependencyValidation.issues.map((issue) => issue.message).join(" "), /canonical directed A\*|re-verified/i);
        await assert.rejects(
            service.resolveScenario(forgedGeometry.id, { scenario: forgedGeometry }),
            /canonical directed A\*|re-verified/i,
        );

        const forgedTraversal = structuredClone(canonical);
        forgedTraversal.routes[0].verification.edgeTraversal[0].edgeId = "forged-edge";
        await assert.rejects(
            service.resolveScenario(forgedTraversal.id, { scenario: forgedTraversal }),
            /canonical directed A\*|re-verified/i,
        );
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("scalar parameters can only bind compatible approved leaves", async () => {
    const { directory, service } = await temporaryService();
    try {
        const environment = await service.getEnvironment("igvc");
        const scenario = validScenario(environment);

        for (const parameter of [
            {
                id: "controller-kind",
                type: "string",
                default: "external-ros",
                target: { kind: "scalar-field", path: "routes.0.controller.kind" },
            },
            {
                id: "route-array",
                type: "string",
                default: "bad",
                target: { kind: "scalar-field", path: "routes.0.waypoints" },
            },
            {
                id: "wrong-type",
                type: "boolean",
                default: true,
                target: { kind: "scalar-field", path: "routes.0.initialSpeedMps" },
            },
            {
                id: "wrong-numeric-type",
                type: "int32",
                default: 2,
                target: { kind: "scalar-field", path: "routes.0.initialSpeedMps" },
            },
        ]) {
            const validation = validateScenario({ ...scenario, parameters: [parameter] });
            assert.equal(validation.ok, false);
            assert.match(validation.issues.map((issue) => issue.message).join(" "), /approved|compatible|scalar leaf/i);
        }

        const scenarioWithZone = {
            ...scenario,
            zones: [{ id: "sweep-zone", center: { x: 0, y: 1, z: 0 }, size: { x: 5, y: 2, z: 5 } }],
            parameters: [{
                id: "zone-width",
                type: "float64",
                default: -4,
                target: { kind: "scalar-field", path: "zones.0.size.x" },
            }],
        };
        assert.equal(validateScenario(scenarioWithZone).ok, true);
        await assert.rejects(
            service.resolveScenario(scenarioWithZone.id, { scenario: scenarioWithZone }),
            /rejected or changed by scenario validation/i,
        );

        for (const parameter of [
            {
                id: "clock-mode",
                type: "string",
                default: "unbounded",
                target: { kind: "scalar-field", path: "clock.pacing" },
            },
            {
                id: "vehicles-object",
                type: "string",
                default: "bad",
                target: { kind: "scalar-field", path: "initialState.vehicles" },
            },
            {
                id: "wrong-clock-type",
                type: "boolean",
                default: true,
                target: { kind: "scalar-field", path: "clock.speed" },
            },
        ]) {
            const validation = validateRunManifest(createDefaultRunManifest({ parameters: [parameter] }));
            assert.equal(validation.ok, false);
            assert.match(validation.issues.map((issue) => issue.message).join(" "), /approved|compatible|scalar leaf/i);
        }

        const invalidSpeed = createDefaultRunManifest({
            id: "invalid-speed-parameter",
            parameters: [{
                id: "speed",
                type: "float64",
                default: -1,
                target: { kind: "scalar-field", path: "clock.speed" },
            }],
        });
        assert.equal(validateRunManifest(invalidSpeed).ok, true);
        await assert.rejects(
            service.resolveRunManifest(invalidSpeed.id, { manifest: invalidSpeed }),
            /rejected or changed by run manifest validation/i,
        );
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
