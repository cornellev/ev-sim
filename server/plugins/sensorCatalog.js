import { buildRevisionedSensorCatalog } from "../../app/plugin/PluginSensorAuthoring.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";

export async function listSensorCatalog(storage) {
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
    return buildRevisionedSensorCatalog({
        library: { ...library, packages },
        documents,
    });
}
