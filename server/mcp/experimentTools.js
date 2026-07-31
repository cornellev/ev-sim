import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { compareExperimentToBaseline } from "../../app/experiments/BaselineComparison.js";
import { storageEvents } from "./events.js";
import { fail, ok } from "./toolResult.js";

const JsonObjectSchema = z.record(z.string(), z.any());

function publish(domain, id, action, data = null) {
    return storageEvents.publish({ domain, id, action, data });
}

function browserCommand(action, id, data = {}) {
    const command = publish("experiment-run", id, action, data);
    return { command, browserRequiredForControl: true };
}

function resultSummary(result) {
    const cases = result?.cases ?? [];
    return {
        id: result?.id ?? null,
        suiteId: result?.suiteId ?? null,
        status: result?.status ?? "unknown",
        revision: result?.revision ?? null,
        progress: {
            completed: cases.filter((entry) => ["completed", "failed", "error", "cancelled", "interrupted"].includes(entry.status)).length,
            total: cases.length,
            current: cases.find((entry) => entry.status === "running") ?? null,
        },
        summary: result?.summary ?? null,
        startedAt: result?.startedAt ?? null,
        finishedAt: result?.finishedAt ?? null,
    };
}

/**
 * Register experiment suite planning, evidence, baseline comparison, and
 * browser-authoritative sequential execution controls.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("../storage/StorageService.js").StorageService} storage
 */
export function registerExperimentTools(server, storage) {
    server.registerTool("experiment_suite_list", {
        title: "List experiment suites",
        description: "List deterministic experiment suites with selected scenarios, manifests, revisions, and hashes.",
        inputSchema: {},
    }, async () => {
        try { return ok({ ok: true, suites: await storage.listExperimentSuites() }); }
        catch (error) { return fail(error); }
    });

    server.registerTool("experiment_suite_get", {
        title: "Get experiment suite",
        description: "Get a complete cev-sim.experiment-suite authoring document.",
        inputSchema: { suiteId: z.string().min(1) },
    }, async ({ suiteId }) => {
        try {
            const suite = await storage.getExperimentSuite(suiteId);
            if (!suite) return fail(`Experiment suite "${suiteId}" does not exist.`);
            return ok({ ok: true, suite });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_suite_create", {
        title: "Create experiment suite",
        description: "Create a versioned suite selecting scenarios, run manifests, seeds, sweeps, metrics, exclusions, and execution policy.",
        inputSchema: { suite: JsonObjectSchema },
    }, async ({ suite }) => {
        try {
            const created = await storage.createExperimentSuite(suite);
            publish("experiment-suite", created.id, "created", { revision: created.revision });
            return ok({ ok: true, suite: created });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_suite_update", {
        title: "Update experiment suite",
        description: "Replace an experiment suite using its expected optimistic revision.",
        inputSchema: {
            suiteId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
            suite: JsonObjectSchema,
        },
    }, async ({ suiteId, expectedRevision, suite }) => {
        try {
            const updated = await storage.putExperimentSuite(suiteId, { suite, expectedRevision });
            publish("experiment-suite", suiteId, "updated", { revision: updated.revision });
            return ok({ ok: true, suite: updated });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_suite_duplicate", {
        title: "Duplicate experiment suite",
        description: "Copy a saved suite to a new stable id.",
        inputSchema: {
            suiteId: z.string().min(1),
            newSuiteId: z.string().min(1),
            name: z.string().min(1).optional(),
        },
    }, async ({ suiteId, newSuiteId, name }) => {
        try {
            const created = await storage.duplicateExperimentSuite(suiteId, { id: newSuiteId, name });
            publish("experiment-suite", created.id, "created", { sourceId: suiteId, revision: created.revision });
            return ok({ ok: true, suite: created });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_suite_delete", {
        title: "Delete experiment suite",
        description: "Delete a saved suite using an optional optimistic revision guard. Results and baselines remain independent evidence.",
        inputSchema: {
            suiteId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative().optional(),
        },
    }, async ({ suiteId, expectedRevision }) => {
        try {
            if (!await storage.getExperimentSuite(suiteId)) return fail(`Experiment suite "${suiteId}" does not exist.`);
            await storage.deleteExperimentSuite(suiteId, expectedRevision);
            publish("experiment-suite", suiteId, "deleted");
            return ok({ ok: true, deleted: suiteId });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_suite_validate", {
        title: "Validate and expand experiment suite",
        description: "Validate a saved or draft suite and return its deterministic case matrix, exclusions, incompatibilities, and issues.",
        inputSchema: {
            suiteId: z.string().min(1),
            suite: JsonObjectSchema.optional(),
        },
    }, async ({ suiteId, suite }) => {
        try {
            const validation = await storage.validateExperimentSuite(suiteId, suite ? { suite } : null);
            return validation.ok
                ? ok({ ok: true, ...validation })
                : fail("Experiment suite validation found issues.", validation);
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_case_resolve", {
        title: "Resolve experiment case",
        description: "Resolve one case from the suite's current deterministic expansion into a frozen run and dependency hashes.",
        inputSchema: {
            suiteId: z.string().min(1),
            caseId: z.string().min(1).optional(),
            scenarioId: z.string().min(1).optional(),
            manifestId: z.string().min(1).optional(),
            seed: z.union([z.string(), z.number()]).optional(),
            parameters: JsonObjectSchema.optional(),
            egoVehicleId: z.string().min(1).optional(),
            sensorBindings: JsonObjectSchema.optional(),
        },
    }, async ({ suiteId, ...requestedCase }) => {
        try {
            const resolution = await storage.resolveExperimentCase(suiteId, requestedCase);
            return ok({ ok: true, resolution });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_result_list", {
        title: "List experiment results",
        description: "List persisted experiment queue results and terminal summaries.",
        inputSchema: { suiteId: z.string().min(1).optional() },
    }, async ({ suiteId }) => {
        try {
            const results = (await storage.listExperimentResults()).filter((entry) => !suiteId || entry.suiteId === suiteId);
            return ok({ ok: true, results });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_result_get", {
        title: "Get experiment result",
        description: "Get complete per-case outcomes, metrics, dependency hashes, failure reasons, and log ids.",
        inputSchema: { resultId: z.string().min(1) },
    }, async ({ resultId }) => {
        try {
            const result = await storage.getExperimentResult(resultId);
            if (!result) return fail(`Experiment result "${resultId}" does not exist.`);
            return ok({ ok: true, result });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_result_create", {
        title: "Create experiment result",
        description: "Create a result document directly, or initialize a pending queue from a suite id.",
        inputSchema: {
            result: JsonObjectSchema.optional(),
            suiteId: z.string().min(1).optional(),
            id: z.string().min(1).optional(),
        },
    }, async ({ result, suiteId, id }) => {
        try {
            if (!result && !suiteId) return fail("Provide either result or suiteId.");
            const created = await storage.createExperimentResult(result ? { result } : { suiteId, id });
            publish("experiment-result", created.id, "created", { revision: created.revision });
            return ok({ ok: true, result: created });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_result_update", {
        title: "Update experiment result",
        description: "Replace a mutable in-progress or terminal result using its expected optimistic revision.",
        inputSchema: {
            resultId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
            result: JsonObjectSchema,
        },
    }, async ({ resultId, expectedRevision, result }) => {
        try {
            const updated = await storage.putExperimentResult(resultId, { result, expectedRevision });
            publish("experiment-result", resultId, "updated", { revision: updated.revision });
            return ok({ ok: true, result: updated });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_result_validate", {
        title: "Validate experiment result",
        description: "Validate a saved result or an unsaved draft result document.",
        inputSchema: {
            resultId: z.string().min(1),
            result: JsonObjectSchema.optional(),
        },
    }, async ({ resultId, result }) => {
        try {
            const validation = await storage.validateExperimentResult(resultId, result ? { result } : null);
            return validation.ok
                ? ok({ ok: true, ...validation })
                : fail("Experiment result validation found issues.", validation);
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_result_delete", {
        title: "Delete experiment result",
        description: "Delete a persisted result using an optional optimistic revision guard.",
        inputSchema: {
            resultId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative().optional(),
        },
    }, async ({ resultId, expectedRevision }) => {
        try {
            if (!await storage.getExperimentResult(resultId)) return fail(`Experiment result "${resultId}" does not exist.`);
            await storage.deleteExperimentResult(resultId, expectedRevision);
            publish("experiment-result", resultId, "deleted");
            return ok({ ok: true, deleted: resultId });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_baseline_list", {
        title: "List experiment baselines",
        description: "List immutable named baselines, optionally for one suite.",
        inputSchema: { suiteId: z.string().min(1).optional() },
    }, async ({ suiteId }) => {
        try { return ok({ ok: true, baselines: await storage.listExperimentBaselines(suiteId ?? null) }); }
        catch (error) { return fail(error); }
    });

    server.registerTool("experiment_baseline_get", {
        title: "Get experiment baseline",
        description: "Get immutable copied case values and provenance independent of retained logs.",
        inputSchema: { baselineId: z.string().min(1) },
    }, async ({ baselineId }) => {
        try {
            const baseline = await storage.getExperimentBaseline(baselineId);
            if (!baseline) return fail(`Experiment baseline "${baselineId}" does not exist.`);
            return ok({ ok: true, baseline });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_baseline_create", {
        title: "Create immutable experiment baseline",
        description: "Snapshot a persisted result into a named immutable baseline with app, git, and dependency provenance.",
        inputSchema: {
            resultId: z.string().min(1),
            id: z.string().min(1).optional(),
            name: z.string().min(1),
            description: z.string().optional(),
            provenance: JsonObjectSchema.optional(),
        },
    }, async ({ resultId, id, name, description, provenance }) => {
        try {
            const baseline = await storage.createExperimentBaseline({ resultId, id, name, description, provenance });
            publish("experiment-baseline", baseline.id, "created", { sourceResultId: resultId });
            return ok({ ok: true, baseline });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_baseline_validate", {
        title: "Validate experiment baseline",
        description: "Validate a saved immutable baseline or an unsaved draft.",
        inputSchema: {
            baselineId: z.string().min(1),
            baseline: JsonObjectSchema.optional(),
        },
    }, async ({ baselineId, baseline }) => {
        try {
            const validation = await storage.validateExperimentBaseline(baselineId, baseline ? { baseline } : null);
            return validation.ok
                ? ok({ ok: true, ...validation })
                : fail("Experiment baseline validation found issues.", validation);
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_baseline_delete", {
        title: "Delete experiment baseline",
        description: "Delete an immutable baseline document. Baselines cannot be edited in place.",
        inputSchema: { baselineId: z.string().min(1) },
    }, async ({ baselineId }) => {
        try {
            if (!await storage.getExperimentBaseline(baselineId)) return fail(`Experiment baseline "${baselineId}" does not exist.`);
            await storage.deleteExperimentBaseline(baselineId);
            publish("experiment-baseline", baselineId, "deleted");
            return ok({ ok: true, deleted: baselineId });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_compare", {
        title: "Compare experiment result to baseline",
        description: "Match cases by scenario, manifest, seed, and parameters; classify metric deltas, regressions, improvements, dependency changes, and unmatched cases.",
        inputSchema: {
            resultId: z.string().min(1),
            baselineId: z.string().min(1),
        },
    }, async ({ resultId, baselineId }) => {
        try {
            const [result, baseline] = await Promise.all([
                storage.getExperimentResult(resultId),
                storage.getExperimentBaseline(baselineId),
            ]);
            if (!result) return fail(`Experiment result "${resultId}" does not exist.`);
            if (!baseline) return fail(`Experiment baseline "${baselineId}" does not exist.`);
            const comparison = compareExperimentToBaseline(result, baseline, {
                metricDefinitions: result.metricDefinitions?.length ? result.metricDefinitions : baseline.metricDefinitions,
            });
            return ok({ ok: true, resultId, baselineId, comparison });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_run_status", {
        title: "Get experiment run status",
        description: "Inspect persisted queue progress for one result, or list results still marked running or paused.",
        inputSchema: { resultId: z.string().min(1).optional() },
    }, async ({ resultId }) => {
        try {
            if (resultId) {
                const result = await storage.getExperimentResult(resultId);
                if (!result) return fail(`Experiment result "${resultId}" does not exist.`);
                return ok({ ok: true, result: resultSummary(result), browserRequiredForControl: true });
            }
            const active = [];
            for (const entry of await storage.listExperimentResults()) {
                if (!["running", "paused"].includes(entry.status)) continue;
                const result = await storage.getExperimentResult(entry.id);
                if (result) active.push(resultSummary(result));
            }
            return ok({ ok: true, active, browserRequiredForControl: true });
        } catch (error) { return fail(error); }
    });

    server.registerTool("experiment_run_start", {
        title: "Start experiment suite",
        description: "Validate a saved suite, expand its deterministic matrix, and ask one authoritative open simulator tab to run the cases sequentially.",
        inputSchema: {
            suiteId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative().optional(),
            resultId: z.string().min(1).optional(),
            failFast: z.boolean().optional(),
            openWorkspace: z.boolean().optional(),
        },
    }, async ({ suiteId, expectedRevision, resultId, failFast, openWorkspace = true }) => {
        try {
            const suite = await storage.getExperimentSuite(suiteId);
            if (!suite) return fail(`Experiment suite "${suiteId}" does not exist.`);
            if (expectedRevision !== undefined && Number(suite.revision) !== expectedRevision) {
                return fail(`Experiment suite revision conflict: expected ${expectedRevision}, current revision is ${suite.revision}.`);
            }
            const validation = await storage.validateExperimentSuite(suiteId);
            if (!validation.ok) return fail("Experiment suite validation found issues.", validation);
            const cases = validation.matrix?.cases ?? [];
            if (cases.length === 0) return fail("The experiment suite has no compatible cases to run.", validation);
            const queuedResultId = resultId || `${suiteId}-result-${Date.now().toString(36)}`;
            if (await storage.getExperimentResult(queuedResultId)) {
                return fail(`Experiment result "${queuedResultId}" already exists.`);
            }
            return ok({
                ok: true,
                suiteId,
                resultId: queuedResultId,
                revision: suite.revision,
                caseCount: cases.length,
                ...browserCommand("start", suiteId, { suiteId, resultId: queuedResultId, failFast, openWorkspace }),
            });
        } catch (error) { return fail(error); }
    });

    for (const action of ["pause", "resume", "cancel"]) {
        server.registerTool(`experiment_run_${action}`, {
            title: `${action[0].toUpperCase()}${action.slice(1)} experiment run`,
            description: `Ask the authoritative open simulator tab to ${action} its experiment queue. An optional result id prevents controlling a different queue.`,
            inputSchema: {
                resultId: z.string().min(1).optional(),
                openWorkspace: z.boolean().optional(),
            },
        }, async ({ resultId, openWorkspace = true }) => {
            try {
                if (resultId && !await storage.getExperimentResult(resultId)) {
                    return fail(`Experiment result "${resultId}" does not exist.`);
                }
                return ok({
                    ok: true,
                    resultId: resultId ?? null,
                    ...browserCommand(action, resultId ?? null, { resultId, openWorkspace }),
                });
            } catch (error) { return fail(error); }
        });
    }

    registerCatalogResource(server, storage, {
        name: "experiment-suite-catalog",
        uri: "fusion://experiment-suites",
        title: "Experiment Suite Catalog",
        description: "Current catalog of deterministic experiment suites.",
        list: () => storage.listExperimentSuites(),
    });
    registerCatalogResource(server, storage, {
        name: "experiment-result-catalog",
        uri: "fusion://experiment-results",
        title: "Experiment Result Catalog",
        description: "Current catalog of persisted experiment evidence.",
        list: () => storage.listExperimentResults(),
    });
    registerCatalogResource(server, storage, {
        name: "experiment-baseline-catalog",
        uri: "fusion://experiment-baselines",
        title: "Experiment Baseline Catalog",
        description: "Current catalog of immutable experiment baselines.",
        list: () => storage.listExperimentBaselines(),
    });

    registerDocumentResource(server, {
        name: "experiment-suite",
        template: "fusion://experiment-suites/{suiteId}",
        title: "Experiment Suite",
        description: "Complete suite authoring document with revision and deterministic matrix inputs.",
        variable: "suiteId",
        list: () => storage.listExperimentSuites(),
        get: (id) => storage.getExperimentSuite(id),
        missing: (id) => `Experiment suite "${id}" does not exist.`,
    });
    registerDocumentResource(server, {
        name: "experiment-result",
        template: "fusion://experiment-results/{resultId}",
        title: "Experiment Result",
        description: "Complete persisted per-case evidence, outcomes, metrics, dependencies, and log ids.",
        variable: "resultId",
        list: () => storage.listExperimentResults(),
        get: (id) => storage.getExperimentResult(id),
        missing: (id) => `Experiment result "${id}" does not exist.`,
    });
    registerDocumentResource(server, {
        name: "experiment-baseline",
        template: "fusion://experiment-baselines/{baselineId}",
        title: "Experiment Baseline",
        description: "Complete immutable baseline snapshot and provenance.",
        variable: "baselineId",
        list: () => storage.listExperimentBaselines(),
        get: (id) => storage.getExperimentBaseline(id),
        missing: (id) => `Experiment baseline "${id}" does not exist.`,
    });
}

function registerCatalogResource(server, _storage, options) {
    server.registerResource(options.name, options.uri, {
        title: options.title,
        description: options.description,
        mimeType: "application/json",
    }, async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await options.list(), null, 2) }],
    }));
}

function registerDocumentResource(server, options) {
    server.registerResource(options.name, new ResourceTemplate(options.template, {
        list: async () => ({
            resources: (await options.list()).map((entry) => ({
                uri: options.template.replace(`{${options.variable}}`, encodeURIComponent(entry.id)),
                name: entry.name || entry.id,
                description: `${entry.status || `Revision ${entry.revision ?? "?"}`}`,
                mimeType: "application/json",
            })),
        }),
        complete: {
            [options.variable]: async (value) => (await options.list())
                .map((entry) => entry.id)
                .filter((id) => id.startsWith(value)),
        },
    }), {
        title: options.title,
        description: options.description,
        mimeType: "application/json",
    }, async (uri, variables) => {
        const id = decodeURIComponent(String(variables[options.variable]));
        const document = await options.get(id);
        if (!document) throw new Error(options.missing(id));
        return {
            contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(document, null, 2) }],
        };
    });
}
