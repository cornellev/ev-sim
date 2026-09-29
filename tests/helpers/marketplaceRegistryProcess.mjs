import { createPopulatedClientRegistry } from "./marketplaceClientRegistry.js";

const parent = process.argv[2];
if (!parent) throw new TypeError("Expected a registry parent directory.");

const registry = await createPopulatedClientRegistry(parent, { includeCollection: true, signed: true, includeUpdate: true });
process.stdout.write(`${JSON.stringify({
    baseUrl: registry.baseUrl,
    item: registry.item,
    release: registry.release,
    preview: registry.preview,
    plugin: {
        packageHash: registry.resource.packageHash,
        runtimeHash: registry.resource.runtimeHash,
        uiHash: registry.resource.uiHash,
    },
    publisher: registry.publisher,
    update: {
        release: registry.update.release,
        packageHash: registry.update.resource.packageHash,
        runtimeHash: registry.update.resource.runtimeHash,
        uiHash: registry.update.resource.uiHash,
    },
    collection: registry.collection,
})}\n`);

let closing = false;
async function close() {
    if (closing) return;
    closing = true;
    await registry.server.close();
    process.exit(0);
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
