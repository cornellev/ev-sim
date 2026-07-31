import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createExperimentBaseline } from "../app/experiments/BaselineComparison.js";
import { createExperimentResult } from "../app/experiments/ExperimentResult.js";
import { createDefaultExperimentSuite } from "../app/experiments/ExperimentSuite.js";
import {
    createDefaultScenario,
    createScenarioCatalog,
    normalizeScenarioCatalog,
} from "../app/scenarios/ScenarioDocument.js";
import { storageEvents } from "../server/mcp/events.js";
import { createStorageRouter } from "../server/routes/storageRouter.js";
import { StorageService } from "../server/storage/StorageService.js";

async function temporaryService(prefix) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    return { directory, service: new StorageService(directory) };
}

function resultDocument(id = "result-1") {
    const suite = createDefaultExperimentSuite({
        id: "suite-1",
        scenarioIds: ["scenario-1"],
        manifestIds: ["manifest-1"],
    });
    return createExperimentResult(suite, [{
        id: "case-1",
        scenarioId: "scenario-1",
        manifestId: "manifest-1",
        seed: 42,
        parameters: {},
    }], { id, createdAt: "2026-07-30T12:00:00.000Z" });
}

test("scenario folder catalog preserves order and rejects stale revisions", async () => {
    const { directory, service } = await temporaryService("cev-scenario-catalog-");
    try {
        const empty = await service.getScenarioCatalog();
        assert.equal(empty.revision, 0);
        assert.equal(empty.definitionHash.length, 64);

        const created = await service.putScenarioCatalog({
            catalog: createScenarioCatalog({
                folders: [
                    { id: "nightly", name: "Nightly" },
                    { id: "safety", name: "Safety" },
                ],
            }),
            expectedRevision: 0,
        });
        assert.equal(created.revision, 1);
        assert.deepEqual(created.folders.map((folder) => folder.id), ["nightly", "safety"]);

        // Normalization must retain storage metadata or a browser edit would
        // silently turn an optimistic write back into a last-writer-wins write.
        const normalized = normalizeScenarioCatalog(created);
        assert.equal(normalized.revision, 1);
        assert.equal(normalized.definitionHash, created.definitionHash);

        await assert.rejects(
            service.putScenarioCatalog({
                catalog: { ...created, folders: [...created.folders].reverse() },
                expectedRevision: 0,
            }),
            /revision conflict/i,
        );

        const reordered = await service.putScenarioCatalog({
            ...created,
            folders: [...created.folders].reverse(),
        });
        assert.equal(reordered.revision, 2);
        assert.deepEqual(reordered.folders.map((folder) => folder.id), ["safety", "nightly"]);

        const onDisk = JSON.parse(await fs.readFile(path.join(directory, "scenario-catalog.json"), "utf8"));
        assert.deepEqual(onDisk.folders.map((folder) => folder.id), ["safety", "nightly"]);
        assert.equal(onDisk.kind, "cev-sim.scenario-catalog");
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("concurrent scenario creates cannot overwrite an existing document", async () => {
    const { directory, service } = await temporaryService("cev-scenario-create-");
    try {
        const first = createDefaultScenario({ id: "same-id", name: "First" });
        const second = createDefaultScenario({ id: "same-id", name: "Second" });
        const outcomes = await Promise.allSettled([
            service.createScenario(first),
            service.createScenario(second),
        ]);
        assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
        assert.match(outcomes.find((entry) => entry.status === "rejected").reason.message, /already exists/i);
        assert.equal((await service.getScenario("same-id")).revision, 1);

        const duplicate = await service.duplicateScenario("same-id");
        assert.equal(duplicate.id, "same-id-copy");
        assert.equal(duplicate.name.endsWith("Copy"), true);
        assert.equal(duplicate.revision, 1);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("revisioned deletes reject stale scenario, suite, and result clients", async () => {
    const { directory, service } = await temporaryService("cev-revision-delete-");
    try {
        const scenario = await service.createScenario(createDefaultScenario({ id: "scenario-delete" }));
        const updatedScenario = await service.putScenario(scenario.id, {
            scenario: { ...scenario, description: "newer" },
            expectedRevision: scenario.revision,
        });
        await assert.rejects(service.deleteScenario(scenario.id, scenario.revision), /revision conflict/i);
        assert.equal((await service.getScenario(scenario.id)).revision, updatedScenario.revision);
        assert.equal(await service.deleteScenario(scenario.id, updatedScenario.revision), true);

        const suite = await service.createExperimentSuite(createDefaultExperimentSuite({ id: "suite-delete" }));
        await assert.rejects(service.deleteExperimentSuite(suite.id, 0), /revision conflict/i);
        assert.equal(await service.deleteExperimentSuite(suite.id, suite.revision), true);

        const result = await service.createExperimentResult(resultDocument("result-delete"));
        await assert.rejects(service.deleteExperimentResult(result.id, 0), /revision conflict/i);
        assert.equal(await service.deleteExperimentResult(result.id, result.revision), true);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("immutable baseline creation is atomic and stored result/baseline validation is exposed", async () => {
    const { directory, service } = await temporaryService("cev-baseline-atomic-");
    try {
        const result = await service.createExperimentResult(resultDocument());
        assert.equal((await service.validateExperimentResult(result.id)).ok, true);

        const baselineA = createExperimentBaseline(result, {
            id: "same-baseline",
            name: "Candidate A",
            createdAt: "2026-07-30T12:01:00.000Z",
        });
        const baselineB = createExperimentBaseline(result, {
            id: "same-baseline",
            name: "Candidate B",
            createdAt: "2026-07-30T12:02:00.000Z",
        });
        const outcomes = await Promise.allSettled([
            service.createExperimentBaseline(baselineA),
            service.createExperimentBaseline(baselineB),
        ]);
        assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
        assert.equal(outcomes.filter((entry) => entry.status === "rejected").length, 1);
        assert.match(outcomes.find((entry) => entry.status === "rejected").reason.message, /immutable/i);

        const stored = await service.getExperimentBaseline("same-baseline");
        assert.ok(["Candidate A", "Candidate B"].includes(stored.name));
        assert.equal((await service.validateExperimentBaseline(stored.id)).ok, true);

        const transient = createExperimentBaseline(result, {
            id: "create-then-delete",
            name: "Transient",
            createdAt: "2026-07-30T12:03:00.000Z",
        });
        const create = service.createExperimentBaseline(transient);
        const remove = service.deleteExperimentBaseline(transient.id);
        await Promise.all([create, remove]);
        assert.equal(await service.getExperimentBaseline(transient.id), null);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("storage router exposes authoring, result, baseline, and validation endpoints", () => {
    const router = createStorageRouter({});
    const routes = new Set(router.stack.flatMap((layer) => {
        if (!layer.route) return [];
        return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path}`);
    }));
    for (const endpoint of [
        "GET /scenario-catalog",
        "PUT /scenario-catalog",
        "POST /scenarios/:id/duplicate",
        "POST /scenarios/:id/validate",
        "POST /scenarios/:id/resolve",
        "POST /experiment-suites/:id/duplicate",
        "POST /experiment-suites/:id/validate",
        "POST /experiment-suites/:id/resolve-case",
        "POST /experiment-results/:id/validate",
        "POST /experiment-baselines/:id/validate",
    ]) {
        assert.equal(routes.has(endpoint), true, `missing ${endpoint}`);
    }
    assert.equal(routes.has("PUT /experiment-baselines/:id"), false, "baselines must not expose mutation");
});

test("successful new-domain writes publish storage events", async () => {
    const service = {
        createScenario: async () => ({ id: "scenario-1" }),
        createExperimentSuite: async () => ({ id: "suite-1" }),
        createExperimentResult: async () => ({ id: "result-1" }),
        createExperimentBaseline: async () => ({ id: "baseline-1" }),
    };
    const router = createStorageRouter(service);
    const cases = [
        ["/scenarios", "scenario", "scenario-1"],
        ["/experiment-suites", "experiment-suite", "suite-1"],
        ["/experiment-results", "experiment-result", "result-1"],
        ["/experiment-baselines", "experiment-baseline", "baseline-1"],
    ];
    for (const [routePath, domain, id] of cases) {
        const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.post);
        const eventPromise = new Promise((resolve) => storageEvents.once("change", resolve));
        let response = null;
        await layer.route.stack[0].handle(
            { body: {}, params: {}, method: "POST", originalUrl: `/api/storage${routePath}` },
            {
                json: (value) => { response = value; },
                status() { return this; },
            },
        );
        assert.equal(response.id, id);
        const event = await eventPromise;
        assert.deepEqual({ ...event, at: null }, {
            domain,
            id,
            action: "created",
            requestId: null,
            data: null,
            at: null,
        });
        assert.equal(Number.isNaN(Date.parse(event.at)), false);
    }

    service.deleteScenario = async () => false;
    const deleteLayer = router.stack.find((entry) => (
        entry.route?.path === "/scenarios/:id" && entry.route.methods.delete
    ));
    let deleteEvents = 0;
    const onDelete = () => { deleteEvents += 1; };
    storageEvents.on("change", onDelete);
    try {
        await deleteLayer.route.stack[0].handle(
            {
                body: {},
                params: { id: "missing" },
                query: {},
                method: "DELETE",
                originalUrl: "/api/storage/scenarios/missing",
            },
            { json() {}, status() { return this; } },
        );
    } finally {
        storageEvents.off("change", onDelete);
    }
    assert.equal(deleteEvents, 0, "a no-op delete must not publish a false change event");
});
