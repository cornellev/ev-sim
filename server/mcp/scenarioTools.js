import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { storageEvents } from "./events.js";
import { fail, ok } from "./toolResult.js";

const JsonObjectSchema = z.record(z.string(), z.any());

function publish(id, action, data = null) {
    return storageEvents.publish({ domain: "scenario", id, action, data });
}

/**
 * Register scenario catalog, authoring, validation, route verification, and
 * immutable dependency-resolution capabilities.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("../storage/StorageService.js").StorageService} storage
 */
export function registerScenarioTools(server, storage) {
    server.registerTool("scenario_list", {
        title: "List scenarios",
        description: "List reusable model-independent scenarios with revisions, folders, environments, and hashes.",
        inputSchema: {},
    }, async () => {
        try { return ok({ ok: true, scenarios: await storage.listScenarios() }); }
        catch (error) { return fail(error); }
    });

    server.registerTool("scenario_get", {
        title: "Get scenario",
        description: "Get a complete cev-sim.scenario authoring document and optimistic revision metadata.",
        inputSchema: { scenarioId: z.string().min(1) },
    }, async ({ scenarioId }) => {
        try {
            const scenario = await storage.getScenario(scenarioId);
            if (!scenario) return fail(`Scenario "${scenarioId}" does not exist.`);
            return ok({ ok: true, scenario });
        } catch (error) { return fail(error); }
    });

    server.registerTool("scenario_create", {
        title: "Create scenario",
        description: "Create a versioned cev-sim.scenario from a complete human-readable authoring document.",
        inputSchema: { scenario: JsonObjectSchema },
    }, async ({ scenario }) => {
        try {
            const created = await storage.createScenario(scenario);
            publish(created.id, "created", { revision: created.revision });
            return ok({ ok: true, scenario: created });
        } catch (error) { return fail(error); }
    });

    server.registerTool("scenario_update", {
        title: "Update scenario",
        description: "Replace a scenario authoring document using its expected optimistic revision.",
        inputSchema: {
            scenarioId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
            scenario: JsonObjectSchema,
        },
    }, async ({ scenarioId, expectedRevision, scenario }) => {
        try {
            const updated = await storage.putScenario(scenarioId, { scenario, expectedRevision });
            publish(scenarioId, "updated", { revision: updated.revision });
            return ok({ ok: true, scenario: updated });
        } catch (error) { return fail(error); }
    });

    server.registerTool("scenario_duplicate", {
        title: "Duplicate scenario",
        description: "Copy a saved scenario to a new stable id without changing the source.",
        inputSchema: {
            scenarioId: z.string().min(1),
            newScenarioId: z.string().min(1),
            name: z.string().min(1).optional(),
            folderId: z.string().min(1).nullable().optional(),
        },
    }, async ({ scenarioId, newScenarioId, name, folderId }) => {
        try {
            const created = await storage.duplicateScenario(scenarioId, { id: newScenarioId, name, folderId });
            publish(created.id, "created", { sourceId: scenarioId, revision: created.revision });
            return ok({ ok: true, scenario: created });
        } catch (error) { return fail(error); }
    });

    server.registerTool("scenario_delete", {
        title: "Delete scenario",
        description: "Delete a saved scenario using an optional optimistic revision guard.",
        inputSchema: {
            scenarioId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative().optional(),
        },
    }, async ({ scenarioId, expectedRevision }) => {
        try {
            if (!await storage.getScenario(scenarioId)) return fail(`Scenario "${scenarioId}" does not exist.`);
            await storage.deleteScenario(scenarioId, expectedRevision);
            publish(scenarioId, "deleted");
            return ok({ ok: true, deleted: scenarioId });
        } catch (error) { return fail(error); }
    });

    server.registerTool("scenario_validate", {
        title: "Validate scenario",
        description: "Validate actors, routes, zones, triggers, completion, outcomes, scripts, sensors, parameters, and dependencies. Optionally validate an unsaved draft.",
        inputSchema: {
            scenarioId: z.string().min(1),
            scenario: JsonObjectSchema.optional(),
        },
    }, async ({ scenarioId, scenario }) => {
        try {
            const validation = await storage.validateScenario(scenarioId, scenario ? { scenario } : null);
            return validation.ok
                ? ok({ ok: true, ...validation })
                : fail("Scenario validation found issues.", validation);
        } catch (error) { return fail(error); }
    });

    server.registerTool("scenario_resolve", {
        title: "Resolve scenario",
        description: "Resolve a scenario into frozen environment, route, script, vehicle, parameter, and dependency hashes.",
        inputSchema: {
            scenarioId: z.string().min(1),
            parameterValues: JsonObjectSchema.optional(),
            expectedHash: z.string().min(1).optional(),
        },
    }, async ({ scenarioId, parameterValues, expectedHash }) => {
        try {
            const resolved = await storage.resolveScenario(scenarioId, { parameterValues, expectedHash });
            return ok({ ok: true, resolved });
        } catch (error) { return fail(error); }
    });

    server.registerTool("scenario_verify_route", {
        title: "Verify scenario route",
        description: "Run deterministic directed A* for one authored route. Accepts an optional unsaved scenario draft and returns canonical verified geometry without saving it.",
        inputSchema: {
            scenarioId: z.string().min(1),
            routeId: z.string().min(1),
            scenario: JsonObjectSchema.optional(),
        },
    }, async ({ scenarioId, routeId, scenario }) => {
        try {
            const verification = await storage.verifyScenarioRoute(scenarioId, { routeId, scenario });
            return ok({ ok: true, routeId, verification });
        } catch (error) { return fail(error); }
    });

    server.registerTool("scenario_catalog_get", {
        title: "Get scenario folder catalog",
        description: "Get the ordered single-level scenario folder catalog and its optimistic revision.",
        inputSchema: {},
    }, async () => {
        try { return ok({ ok: true, catalog: await storage.getScenarioCatalog() }); }
        catch (error) { return fail(error); }
    });

    server.registerTool("scenario_catalog_update", {
        title: "Update scenario folder catalog",
        description: "Replace the ordered scenario folder catalog using its expected optimistic revision.",
        inputSchema: {
            expectedRevision: z.number().int().nonnegative(),
            catalog: JsonObjectSchema,
        },
    }, async ({ expectedRevision, catalog }) => {
        try {
            const updated = await storage.putScenarioCatalog({ catalog, expectedRevision });
            storageEvents.publish({ domain: "scenario-catalog", action: "updated", data: { revision: updated.revision } });
            return ok({ ok: true, catalog: updated });
        } catch (error) { return fail(error); }
    });

    server.registerResource("scenario-catalog", "fusion://scenarios", {
        title: "Scenario Catalog",
        description: "Current catalog of reusable versioned scenarios.",
        mimeType: "application/json",
    }, async (uri) => ({
        contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(await storage.listScenarios(), null, 2),
        }],
    }));

    server.registerResource("scenario-folder-catalog", "fusion://scenario-folders", {
        title: "Scenario Folder Catalog",
        description: "Ordered single-level folder catalog for the Scenarios workspace.",
        mimeType: "application/json",
    }, async (uri) => ({
        contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(await storage.getScenarioCatalog(), null, 2),
        }],
    }));

    server.registerResource("scenario", new ResourceTemplate("fusion://scenarios/{scenarioId}", {
        list: async () => ({
            resources: (await storage.listScenarios()).map((entry) => ({
                uri: `fusion://scenarios/${encodeURIComponent(entry.id)}`,
                name: entry.name,
                description: `Revision ${entry.revision} · ${entry.environmentId}`,
                mimeType: "application/json",
            })),
        }),
        complete: {
            scenarioId: async (value) => (await storage.listScenarios())
                .map((entry) => entry.id)
                .filter((id) => id.startsWith(value)),
        },
    }), {
        title: "Scenario",
        description: "Complete scenario authoring document with revision and definition hash.",
        mimeType: "application/json",
    }, async (uri, variables) => {
        const scenarioId = decodeURIComponent(String(variables.scenarioId));
        const scenario = await storage.getScenario(scenarioId);
        if (!scenario) throw new Error(`Scenario "${scenarioId}" does not exist.`);
        return {
            contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(scenario, null, 2) }],
        };
    });
}
