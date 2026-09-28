import { promises as fs } from "node:fs";
import path from "node:path";

import sharp from "sharp";

import { marketplaceDocumentBytes } from "../../server/marketplace/MarketplaceContracts.js";
import { MarketplaceRegistryHttpServer } from "../../server/marketplace/registry/RegistryHttpServer.js";
import { MarketplaceRegistryService } from "../../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../../server/marketplace/registry/RegistryStore.js";
import { pluginFixtureResource } from "./pluginFixtures.js";

const documentsPromise = fs.readFile(new URL("../fixtures/marketplace/documents.v1.json", import.meta.url), "utf8")
    .then((text) => JSON.parse(text));

export async function createPopulatedClientRegistry(parent) {
    const documents = await documentsPromise;
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, {
        offlineRootKeyPath: path.join(parent, "root.pem"),
    });
    const store = await MarketplaceRegistryStore.open(root);
    const service = new MarketplaceRegistryService(store);
    const artifactBytes = Buffer.from(JSON.stringify(await pluginFixtureResource()));
    const artifact = (await service.admitArtifact(artifactBytes, { contentKind: "plugin" })).descriptor;
    const previewBytes = await sharp({
        create: { width: 4, height: 3, channels: 3, background: "#2f6feb" },
    }).png().toBuffer();
    const preview = (await service.admitPreview(previewBytes, { mediaType: "image/png" })).descriptor;
    const item = {
        ...structuredClone(documents.item),
        description: `${documents.item.description}\n\n![Remote preview](https://example.invalid/untrusted.png)\n\n[Unsafe link](javascript:alert(1))\n\n<script>alert("raw html")</script>`,
        previews: [{ ...preview, alt: "Control Pack preview" }],
    };
    await service.admitItem(marketplaceDocumentBytes(item));
    const release = { ...structuredClone(documents.release), artifact };
    await service.admitRelease(marketplaceDocumentBytes(release), { track: "stable" });
    await store.close();
    const server = await MarketplaceRegistryHttpServer.open(root);
    const address = await server.listen({ port: 0 });
    return Object.freeze({
        root,
        server,
        baseUrl: `http://127.0.0.1:${address.port}/`,
        item,
        release,
        preview,
        previewBytes,
    });
}
