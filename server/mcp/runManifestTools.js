import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { storageEvents } from "./events.js";
import { fail, ok } from "./toolResult.js";

const JsonObjectSchema = z.record(z.string(), z.any());

function publish(id, action, data = null) {
    return storageEvents.publish({ domain: "run-manifest", id, action, data });
}

function resolvedSummary(resolved) {
    return {
        manifestId: resolved.manifest.id,
        definitionHash: resolved.definitionHash,
        resolvedHash: resolved.resolvedHash,
        dependencyHashes: resolved.dependencyHashes,
    };
}

/**
 * Register catalog, authoring, validation, portable bundle, and launch support
 * for deterministic run manifests.
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("../storage/StorageService.js").StorageService} storage
 */
export function registerRunManifestTools(server, storage) {
    server.registerTool("run_manifest_list", {
        title: "List run manifests",
        description: "List named deterministic simulation run manifests with revisions and hashes.",
        inputSchema: {},
    }, async () => {
        try { return ok({ ok: true, manifests: await storage.listRunManifests() }); }
        catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_get", {
        title: "Get run manifest",
        description: "Get the complete authoring manifest and optimistic revision metadata.",
        inputSchema: { manifestId: z.string().min(1) },
    }, async ({ manifestId }) => {
        try {
            const manifest = await storage.getRunManifest(manifestId);
            if (!manifest) return fail(`Run manifest "${manifestId}" does not exist.`);
            return ok({ ok: true, manifest });
        } catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_create", {
        title: "Create run manifest",
        description: "Create a versioned cev-sim.run-manifest from a complete authoring document.",
        inputSchema: { manifest: JsonObjectSchema },
    }, async ({ manifest }) => {
        try {
            const created = await storage.createRunManifest(manifest);
            publish(created.id, "created", { revision: created.revision });
            return ok({ ok: true, manifest: created });
        } catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_update", {
        title: "Update run manifest",
        description: "Replace an authoring manifest using its expected optimistic revision.",
        inputSchema: {
            manifestId: z.string().min(1),
            expectedRevision: z.number().int().nonnegative(),
            manifest: JsonObjectSchema,
        },
    }, async ({ manifestId, expectedRevision, manifest }) => {
        try {
            const updated = await storage.putRunManifest(manifestId, { manifest, expectedRevision });
            publish(manifestId, "updated", { revision: updated.revision });
            return ok({ ok: true, manifest: updated });
        } catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_duplicate", {
        title: "Duplicate run manifest",
        description: "Copy a saved run manifest to a new stable id.",
        inputSchema: {
            manifestId: z.string().min(1),
            newManifestId: z.string().min(1),
            name: z.string().min(1).optional(),
        },
    }, async ({ manifestId, newManifestId, name }) => {
        try {
            const created = await storage.duplicateRunManifest(manifestId, { id: newManifestId, name });
            publish(created.id, "created", { sourceId: manifestId, revision: created.revision });
            return ok({ ok: true, manifest: created });
        } catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_delete", {
        title: "Delete run manifest",
        description: "Delete a saved run manifest by stable id.",
        inputSchema: { manifestId: z.string().min(1) },
    }, async ({ manifestId }) => {
        try {
            if (!await storage.getRunManifest(manifestId)) {
                return fail(`Run manifest "${manifestId}" does not exist.`);
            }
            await storage.deleteRunManifest(manifestId);
            publish(manifestId, "deleted");
            return ok({ ok: true, deleted: manifestId });
        } catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_validate", {
        title: "Validate run manifest",
        description: "Validate schema, deterministic constraints, references, and dependency hashes. Optionally validate an unsaved draft.",
        inputSchema: {
            manifestId: z.string().min(1),
            manifest: JsonObjectSchema.optional(),
        },
    }, async ({ manifestId, manifest }) => {
        try {
            const result = await storage.validateRunManifest(manifestId, manifest ? { manifest } : null);
            return result.ok ? ok({ ok: true, ...result }) : fail("Run manifest validation found issues.", result);
        } catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_resolve", {
        title: "Resolve run manifest",
        description: "Resolve a saved manifest into its immutable environment, scripts, bindings, schemas, and dependency hashes.",
        inputSchema: { manifestId: z.string().min(1) },
    }, async ({ manifestId }) => {
        try {
            const resolved = await storage.resolveRunManifest(manifestId);
            return ok({ ok: true, resolved });
        } catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_export", {
        title: "Export run bundle",
        description: "Export a portable cev-sim.run-bundle with all resolved dependencies and hashes.",
        inputSchema: { manifestId: z.string().min(1) },
    }, async ({ manifestId }) => {
        try { return ok({ ok: true, bundle: await storage.exportRunManifest(manifestId) }); }
        catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_import", {
        title: "Import run bundle",
        description: "Import a portable run bundle using conflict-safe dependency ids.",
        inputSchema: { bundle: JsonObjectSchema },
    }, async ({ bundle }) => {
        try {
            const created = await storage.importRunBundle(bundle);
            publish(created.id, "created", { imported: true, revision: created.revision });
            return ok({ ok: true, manifest: created });
        } catch (error) { return fail(error); }
    });

    server.registerTool("run_manifest_launch", {
        title: "Validate and launch run manifest",
        description: "Resolve a saved manifest and ask the authoritative open simulator tab to launch it.",
        inputSchema: {
            manifestId: z.string().min(1),
            autoplay: z.boolean().optional(),
        },
    }, async ({ manifestId, autoplay = false }) => {
        try {
            const resolved = await storage.resolveRunManifest(manifestId);
            const command = publish(manifestId, "launch", { autoplay });
            return ok({
                ok: true,
                ...resolvedSummary(resolved),
                command,
                browserRequiredForLaunch: true,
            });
        } catch (error) { return fail(error); }
    });

    server.registerResource("run-manifest-catalog", "fusion://run-manifests", {
        title: "Run Manifest Catalog",
        description: "Current catalog of versioned deterministic simulation run manifests.",
        mimeType: "application/json",
    }, async (uri) => ({
        contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(await storage.listRunManifests(), null, 2),
        }],
    }));

    server.registerResource("run-manifest", new ResourceTemplate("fusion://run-manifests/{manifestId}", {
        list: async () => ({
            resources: (await storage.listRunManifests()).map((entry) => ({
                uri: `fusion://run-manifests/${encodeURIComponent(entry.id)}`,
                name: entry.name,
                description: `Revision ${entry.revision} · ${entry.environmentId}`,
                mimeType: "application/json",
            })),
        }),
        complete: {
            manifestId: async (value) => (await storage.listRunManifests())
                .map((entry) => entry.id)
                .filter((id) => id.startsWith(value)),
        },
    }), {
        title: "Run Manifest",
        description: "Complete authoring manifest with revision and definition hash.",
        mimeType: "application/json",
    }, async (uri, variables) => {
        const manifestId = decodeURIComponent(String(variables.manifestId));
        const manifest = await storage.getRunManifest(manifestId);
        if (!manifest) throw new Error(`Run manifest "${manifestId}" does not exist.`);
        return {
            contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(manifest, null, 2) }],
        };
    });
}
