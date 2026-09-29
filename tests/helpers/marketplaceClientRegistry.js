import { promises as fs } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import path from "node:path";

import sharp from "sharp";

import { marketplaceDocumentBytes } from "../../server/marketplace/MarketplaceContracts.js";
import { MARKETPLACE_TOKEN_SCOPES } from "../../server/marketplace/MarketplaceContract.js";
import {
    publisherKeyId,
    publisherPublicKey,
    signMarketplaceRelease,
} from "../../server/marketplace/PublisherSignatures.js";
import { MarketplaceRegistryHttpServer } from "../../server/marketplace/registry/RegistryHttpServer.js";
import { MarketplaceRegistryService } from "../../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../../server/marketplace/registry/RegistryStore.js";
import { marketplacePluginDocuments } from "./marketplacePluginDocuments.js";
import { pluginFixtureResource } from "./pluginFixtures.js";

const documentsPromise = fs.readFile(new URL("../fixtures/marketplace/documents.v1.json", import.meta.url), "utf8")
    .then((text) => JSON.parse(text));

export async function createPopulatedClientRegistry(parent, {
    pluginResource = null,
    includeCollection = false,
    signed = false,
    includeUpdate = false,
} = {}) {
    const documents = await documentsPromise;
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root, {
        offlineRootKeyPath: path.join(parent, "root.pem"),
        ...(signed ? {} : { unsafeUnsignedDevelopment: true }),
    });
    const store = await MarketplaceRegistryStore.open(root);
    const service = new MarketplaceRegistryService(store);
    const adminActor = { subject: "admin", publisherId: null, namespaces: [], scopes: MARKETPLACE_TOKEN_SCOPES };
    const publisherActor = {
        subject: "publisher",
        publisherId: documents.item.publisherId,
        namespaces: ["acme.example", "com.example.control-collection"],
        scopes: ["publish:item", "publish:release", "manage:track", "manage:yank"],
    };
    let publisher = null;
    let privateKey = null;
    if (signed) {
        const keys = generateKeyPairSync("ed25519");
        privateKey = keys.privateKey;
        const keyId = publisherKeyId(keys.publicKey);
        const createdAt = "2026-09-29T12:00:00.000Z";
        publisher = {
            kind: "cev-sim.marketplace-publisher",
            version: 1,
            publisherId: documents.item.publisherId,
            namespaces: [...publisherActor.namespaces],
            keys: [{
                keyId,
                algorithm: "ed25519",
                publicKey: publisherPublicKey(keys.publicKey),
                status: "active",
                createdAt,
                statusChangedAt: createdAt,
            }],
        };
        await service.registerPublisher(marketplaceDocumentBytes(publisher), { actor: adminActor });
    }
    const resource = pluginResource ?? await pluginFixtureResource();
    const artifactBytes = Buffer.from(JSON.stringify(resource));
    const artifact = (await service.admitArtifact(artifactBytes, { contentKind: "plugin" })).descriptor;
    const previewBytes = await sharp({
        create: { width: 4, height: 3, channels: 3, background: "#2f6feb" },
    }).png().toBuffer();
    const preview = (await service.admitPreview(previewBytes, { mediaType: "image/png" })).descriptor;
    const aligned = marketplacePluginDocuments({
        item: documents.item,
        release: {
            ...documents.release,
            ...(signed ? { executable: { pluginId: "acme.example", packageHash: resource.packageHash, runtimeHash: resource.runtimeHash } } : {}),
        },
        artifact,
        resource,
    });
    const item = {
        ...structuredClone(aligned.item),
        description: `${documents.item.description}\n\n![Remote preview](https://example.invalid/untrusted.png)\n\n[Unsafe link](javascript:alert(1))\n\n<script>alert("raw html")</script>`,
        previews: [{ ...preview, alt: "Control Pack preview" }],
    };
    await service.admitItem(marketplaceDocumentBytes(item), signed ? { actor: publisherActor } : undefined);
    const release = structuredClone(aligned.release);
    if (signed) await service.admitReleaseEnvelope(signMarketplaceRelease(release, privateKey).bytes, { actor: publisherActor, track: "stable" });
    else await service.admitRelease(marketplaceDocumentBytes(release), { track: "stable" });
    let update = null;
    if (includeUpdate) {
        if (!signed) throw new TypeError("Marketplace update fixture requires signed publisher state.");
        const updateResource = await pluginFixtureResource({
            mutateDocument(document) { document.version = "1.1.0"; },
        });
        const updateArtifact = (await service.admitArtifact(Buffer.from(JSON.stringify(updateResource)), { contentKind: "plugin" })).descriptor;
        const updateDocuments = marketplacePluginDocuments({
            item,
            release: {
                ...documents.release,
                executable: {
                    pluginId: "acme.example",
                    packageHash: updateResource.packageHash,
                    runtimeHash: updateResource.runtimeHash,
                },
            },
            artifact: updateArtifact,
            resource: updateResource,
        });
        const updateRelease = structuredClone(updateDocuments.release);
        await service.admitReleaseEnvelope(signMarketplaceRelease(updateRelease, privateKey).bytes, { actor: publisherActor, track: "beta" });
        update = Object.freeze({ release: updateRelease, resource: updateResource });
    }
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
        const { executable: _collectionExecutable, ...baseCollectionRelease } = structuredClone(release);
        const collectionRelease = {
            ...baseCollectionRelease,
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
        await service.admitItem(marketplaceDocumentBytes(collectionItem), signed ? { actor: publisherActor } : undefined);
        if (signed) await service.admitReleaseEnvelope(signMarketplaceRelease(collectionRelease, privateKey).bytes, { actor: publisherActor, track: "stable" });
        else await service.admitRelease(marketplaceDocumentBytes(collectionRelease), { track: "stable" });
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
        publisher,
        update,
        collection,
    });
}
