import { z } from "zod";

import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { storageEvents } from "./events.js";
import { fail, ok } from "./toolResult.js";
import { installPluginSource, removePluginSource } from "../plugins/pluginLibrary.js";

const SourceSchema = z.object({
    kind: z.enum(["directory", "digest"]),
    path: z.string().optional(),
    packageHash: z.string().optional(),
});

function publish(pluginId, action, data) {
    return storageEvents.publish({ domain: "plugin", id: pluginId, action, data });
}

/**
 * @param {import("@modelcontextprotocol/sdk/server/mcp.js").McpServer} server
 * @param {import("../storage/StorageService.js").StorageService} storage
 */
export function registerPluginTools(server, storage) {
    server.registerTool(
        "plugin_list",
        {
            title: "List installed plugins",
            description: "List the revisioned local plugin library. CAS bytes remain after removal.",
            inputSchema: {},
        },
        async () => {
            try {
                const library = await storage.listPluginLibrary();
                return ok({ ok: true, revision: library.revision, packages: library.packages });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "plugin_get",
        {
            title: "Get plugin package",
            description: "Return verified package metadata and the parsed plugin.json document. File bytes remain on the CAS GET routes.",
            inputSchema: {
                packageHash: z.string().min(64).max(64),
            },
        },
        async ({ packageHash }) => {
            try {
                const resource = await storage.getPluginPackage(packageHash);
                const verified = verifyPluginPackage(resource);
                return ok({
                    ok: true,
                    package: {
                        pluginId: verified.document.id,
                        version: verified.document.version,
                        packageHash: verified.resource.packageHash,
                        runtimeHash: verified.resource.runtimeHash,
                        ...(verified.resource.uiHash ? { uiHash: verified.resource.uiHash } : {}),
                        document: verified.document,
                    },
                });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "plugin_install",
        {
            title: "Install plugin",
            description: "Install a verified plugin into the local library from an absolute directory or an existing CAS digest.",
            inputSchema: {
                source: SourceSchema,
            },
        },
        async ({ source }) => {
            try {
                const metadata = await installPluginSource(storage, source);
                const library = await storage.listPluginLibrary();
                publish(metadata.pluginId, "installed", {
                    packageHash: metadata.packageHash,
                    revision: library.revision,
                });
                return ok({ ok: true, package: metadata, revision: library.revision });
            } catch (error) {
                return fail(error);
            }
        },
    );

    server.registerTool(
        "plugin_remove",
        {
            title: "Remove plugin from library",
            description: "Remove library membership for one pluginId+packageHash. CAS bytes and immutable URLs are retained.",
            inputSchema: {
                pluginId: z.string().min(1),
                packageHash: z.string().min(64).max(64),
            },
        },
        async ({ pluginId, packageHash }) => {
            try {
                const removed = await removePluginSource(storage, { pluginId, packageHash });
                if (!removed) return fail(`Plugin "${pluginId}" package ${packageHash} is not in the library.`);
                const library = await storage.listPluginLibrary();
                publish(pluginId, "removed", { packageHash, revision: library.revision });
                return ok({ ok: true, removed: true, revision: library.revision });
            } catch (error) {
                return fail(error);
            }
        },
    );
}
