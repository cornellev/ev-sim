import { promises as fs } from "node:fs";
import path from "node:path";

import { marketplaceDocumentBytes } from "../../server/marketplace/MarketplaceContracts.js";
import { MarketplaceRegistryHttpServer } from "../../server/marketplace/registry/RegistryHttpServer.js";
import { MarketplaceRegistryService } from "../../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../../server/marketplace/registry/RegistryStore.js";
import { pluginFixtureResource } from "./pluginFixtures.js";

const documents = JSON.parse(await fs.readFile(new URL("../fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));

export async function createPopulatedClientRegistry(parent) {
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, {
        offlineRootKeyPath: path.join(parent, "root.pem"),
    });
    const store = await MarketplaceRegistryStore.open(root);
    const service = new MarketplaceRegistryService(store);
    const artifactBytes = Buffer.from(JSON.stringify(await pluginFixtureResource()));
    const artifact = (await service.admitArtifact(artifactBytes, { contentKind: "plugin" })).descriptor;
    const item = { ...structuredClone(documents.item), previews: [] };
    await service.admitItem(marketplaceDocumentBytes(item));
    const release = { ...structuredClone(documents.release), artifact };
    await service.admitRelease(marketplaceDocumentBytes(release));
    await store.close();
    const server = await MarketplaceRegistryHttpServer.open(root);
    const address = await server.listen({ port: 0 });
    return Object.freeze({
        root,
        server,
        baseUrl: `http://127.0.0.1:${address.port}/`,
        item,
        release,
    });
}
