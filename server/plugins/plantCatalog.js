import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";

export function buildPlantCatalog({ documents = [] } = {}) {
    const plants = [];
    for (const item of documents) {
        const metadata = item.metadata || {};
        for (const plant of item.document?.plants ?? []) {
            plants.push({
                id: plant.id,
                pluginId: metadata.pluginId,
                version: metadata.version,
                packageHash: metadata.packageHash,
                runtimeHash: metadata.runtimeHash,
                parameters: plant.parameters ?? [],
            });
        }
    }
    plants.sort((left, right) => left.id.localeCompare(right.id) || left.packageHash.localeCompare(right.packageHash));
    return { ok: true, plants };
}

export async function listPlantCatalog(storage) {
    const library = await storage.listPluginLibrary();
    const documents = [];
    for (const metadata of library.packages) {
        try {
            const resource = await storage.getPluginPackage(metadata.packageHash);
            const verified = verifyPluginPackage(resource);
            documents.push({ metadata, document: verified.document, resource: verified.resource });
        } catch {
            // Stale library rows must not fail the whole catalog.
        }
    }
    return buildPlantCatalog({ documents });
}
