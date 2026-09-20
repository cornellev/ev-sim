import { createAuthoringRegistry, buildRevisionedUnitCatalog } from "../../app/plugin/PluginAuthoring.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { ScriptManager } from "../../app/scripting/ScriptManager.js";
import { formatRestoreErrors, restoreManagerFromGraph } from "../../app/scripting/GraphDocument.js";
import { createUnresolvedPluginUnit } from "../../app/scripting/units/UnresolvedPluginUnit.js";
import { NodePluginModuleSource } from "../plugins/NodePluginModuleSource.js";

export async function loadInstalledPluginDocuments(storage) {
    const library = await storage.listPluginLibrary();
    const documents = [];
    const packages = [];
    for (const metadata of library.packages) {
        try {
            const resource = await storage.getPluginPackage(metadata.packageHash);
            const verified = verifyPluginPackage(resource);
            documents.push({ metadata, document: verified.document, resource: verified.resource });
            packages.push(metadata);
        } catch {
            // Stale library rows must not fail the whole catalog.
        }
    }
    return { library: { ...library, packages }, documents };
}

export async function listUnitCatalog(storage) {
    const { library, documents } = await loadInstalledPluginDocuments(storage);
    return buildRevisionedUnitCatalog({ library, documents });
}

export async function createStorageAuthoringRegistry(storage, locks, options = {}) {
    return createAuthoringRegistry({
        locks,
        getPackage: (packageHash) => storage.getPluginPackage(packageHash),
        moduleSource: new NodePluginModuleSource({ pluginStore: storage.plugins }),
        ...options,
    });
}

export async function compileGraph(storage, graph, name = "compiled-program") {
    if (!graph || typeof graph !== "object") {
        const error = new Error("Missing graph.");
        error.status = 400;
        throw error;
    }
    const authoring = await createStorageAuthoringRegistry(storage, graph.pluginLocks);
    let manager = null;
    try {
        const unresolved = new Set(authoring.unresolvedTypes);
        manager = restoreManagerFromGraph(graph, (type) => authoring.registry.get(type), {
            createManager: () => new ScriptManager({
                blockRegistry: authoring.registry,
                pluginHost: authoring.host,
                scopeId: "authoring:compile",
            }),
            onMissingBlock: (node) => {
                unresolved.add(node.type);
                const lock = authoring.locks.find((entry) => entry.types.includes(node.type)) || null;
                return createUnresolvedPluginUnit(node, { lock });
            },
        });
        if (unresolved.size > 0) {
            const types = [...unresolved].sort();
            throw new Error(`Missing plugin types: ${types.join(", ")}. Restore the locked package before compiling.`);
        }
        if (manager.restoreErrors?.length) {
            throw new Error(formatRestoreErrors(manager.restoreErrors));
        }
        return { ok: true, artifact: manager.compile(name) };
    } finally {
        manager?.dispose?.();
        authoring.dispose();
    }
}
