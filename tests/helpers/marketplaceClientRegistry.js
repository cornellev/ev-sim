import { promises as fs } from "node:fs";
import path from "node:path";

import sharp from "sharp";

import { marketplaceDocumentBytes } from "../../server/marketplace/MarketplaceContracts.js";
import { MarketplaceRegistryHttpServer } from "../../server/marketplace/registry/RegistryHttpServer.js";
import { MarketplaceRegistryService } from "../../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../../server/marketplace/registry/RegistryStore.js";
import { marketplacePluginDocuments } from "./marketplacePluginDocuments.js";
import { pluginFixtureResource } from "./pluginFixtures.js";

const documentsPromise = fs.readFile(new URL("../fixtures/marketplace/documents.v1.json", import.meta.url), "utf8")
    .then((text) => JSON.parse(text));

export async function createPopulatedClientRegistry(parent, { pluginResource = null, includeCollection = false } = {}) {
    const documents = await documentsPromise;
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, {
        offlineRootKeyPath: path.join(parent, "root.pem"),
    });
    const store = await MarketplaceRegistryStore.open(root);
    const service = new MarketplaceRegistryService(store);
    const resource = pluginResource ?? await pluginFixtureResource();
    const artifactBytes = Buffer.from(JSON.stringify(resource));
    const artifact = (await service.admitArtifact(artifactBytes, { contentKind: "plugin" })).descriptor;
    const previewBytes = await sharp({
        create: { width: 4, height: 3, channels: 3, background: "#2f6feb" },
    }).png().toBuffer();
    const preview = (await service.admitPreview(previewBytes, { mediaType: "image/png" })).descriptor;
    const aligned = marketplacePluginDocuments({
        item: documents.item,
        release: documents.release,
        artifact,
        resource,
    });
    const item = {
        ...structuredClone(aligned.item),
        description: `${documents.item.description}\n\n![Remote preview](https://example.invalid/untrusted.png)\n\n[Unsafe link](javascript:alert(1))\n\n<script>alert("raw html")</script>`,
        previews: [{ ...preview, alt: "Control Pack preview" }],
    };
    await service.admitItem(marketplaceDocumentBytes(item));
    const release = structuredClone(aligned.release);
    await service.admitRelease(marketplaceDocumentBytes(release), { track: "stable" });
    let collection = null;
    if (includeCollection) {
        const member = {
            itemId: release.itemId,
            releaseVersion: release.releaseVersion,
            artifactSha256: release.artifact.sha256,
        };
        const document = {
            kind: "cev-sim.marketplace-collection",
            version: 1,
            members: [{ release: member, group: "Controllers" }],
        };
        const collectionArtifact = (await service.admitArtifact(marketplaceDocumentBytes(document), { contentKind: "collection" })).descriptor;
        const collectionItem = {
            ...structuredClone(item),
            itemId: "com.example.control-collection",
            contentKind: "collection",
            displayName: "Control Collection",
            summary: "An exact controller collection.",
            description: "Installs the signed exact controller member in one plan.",
            previews: [],
            tags: ["collection", "control"],
            categories: ["collections"],
        };
        const collectionRelease = {
            ...structuredClone(release),
            itemId: collectionItem.itemId,
            contentKind: "collection",
            artifact: collectionArtifact,
            capabilities: [],
            dependencies: [member],
            compatibility: {
                ...structuredClone(release.compatibility),
                contracts: [{ kind: "cev-sim.marketplace-collection", versions: [1] }],
                runtimes: [],
            },
        };
        await service.admitItem(marketplaceDocumentBytes(collectionItem));
        await service.admitRelease(marketplaceDocumentBytes(collectionRelease), { track: "stable" });
        collection = Object.freeze({ item: collectionItem, release: collectionRelease, document });
    }
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
        resource,
        collection,
    });
}
