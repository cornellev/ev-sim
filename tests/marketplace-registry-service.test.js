import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import sharp from "sharp";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { marketplaceDocumentBytes } from "../server/marketplace/MarketplaceContracts.js";
import { exportRunTemplatePackage } from "../server/marketplace/RunTemplatePackage.js";
import { MarketplaceRegistryService } from "../server/marketplace/registry/RegistryService.js";
import { MarketplaceRegistryStore } from "../server/marketplace/registry/RegistryStore.js";
import { blobPath, registryPaths, resolveRegistryPath } from "../server/marketplace/registry/RegistryLayout.js";
import { StorageService } from "../server/storage/StorageService.js";
import { marketplacePluginDocuments } from "./helpers/marketplacePluginDocuments.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const documents = JSON.parse(await fs.readFile(new URL("./fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));

async function registry(t) {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-registry-service-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, "registry");
    await MarketplaceRegistryStore.initialize(root);
    const store = await MarketplaceRegistryStore.open(root);
    t.after(() => store.close());
    return { root, store, service: new MarketplaceRegistryService(store) };
}

function pluginDocuments(resource, artifact, { item: itemOverrides = {}, release: releaseOverrides = {} } = {}) {
    return marketplacePluginDocuments({
        item: { ...structuredClone(documents.item), previews: [], ...itemOverrides },
        release: { ...structuredClone(documents.release), ...releaseOverrides },
        artifact,
        resource,
    });
}

test("MKT-03 concurrent identical artifacts deduplicate to one verified CAS object without executing plugin modules", async (t) => {
    const { root, service } = await registry(t);
    const resource = await pluginFixtureResource({
        mutateFiles(files) {
            files["runtime/index.js"] = new TextEncoder().encode("throw new Error('registry inspection executed plugin');\nexport default {};\n");
        },
    });
    const bytes = Buffer.from(JSON.stringify(resource));
    const results = await Promise.all(Array.from({ length: 8 }, () => service.admitArtifact(bytes, { contentKind: "plugin" })));
    assert.equal(results.filter((entry) => entry.created).length, 1);
    assert.equal(new Set(results.map((entry) => entry.descriptor.sha256)).size, 1);
    const paths = registryPaths(root);
    assert.deepEqual(await fs.readdir(paths.blobs), [results[0].descriptor.sha256]);
    assert.deepEqual(await fs.readdir(paths.blobRecords), [`${results[0].descriptor.sha256}.json`]);
    assert.deepEqual(await fs.readdir(paths.uploadStaging), []);
});

test("MKT-03 item presentation can change, identity cannot, and release tuples are immutable", async (t) => {
    const { service } = await registry(t);
    const resource = await pluginFixtureResource();
    const artifact = (await service.admitArtifact(Buffer.from(JSON.stringify(resource)), { contentKind: "plugin" })).descriptor;
    const aligned = pluginDocuments(resource, artifact);
    const first = await service.admitItem(marketplaceDocumentBytes(aligned.item));
    const retry = await service.admitItem(marketplaceDocumentBytes(aligned.item));
    assert.equal(first.revision, 2);
    assert.equal(retry.revision, 2);
    const updated = await service.admitItem(marketplaceDocumentBytes({ ...aligned.item, displayName: "Updated Control Pack" }));
    assert.equal(updated.revision, 3);
    await assert.rejects(
        service.admitItem(marketplaceDocumentBytes({ ...aligned.item, publisherId: "com.other.publisher" })),
        (error) => error.code === "CONFLICT",
    );

    const admitted = await service.admitRelease(marketplaceDocumentBytes(aligned.release), { track: "stable" });
    assert.equal(admitted.revision, 4);
    const releaseRetry = await service.admitRelease(marketplaceDocumentBytes(aligned.release), { track: "stable" });
    assert.equal(releaseRetry.revision, 4);
    await assert.rejects(
        service.admitRelease(marketplaceDocumentBytes({ ...aligned.release, changelog: "Different immutable bytes." })),
        (error) => error.code === "CONFLICT" && /immutable/u.test(error.message),
    );
    const dependency = {
        itemId: aligned.release.itemId,
        releaseVersion: aligned.release.releaseVersion,
        artifactSha256: artifact.sha256,
    };
    const resourceV2 = await pluginFixtureResource({ mutateDocument(document) { document.version = "2.0.0"; } });
    const artifactV2 = (await service.admitArtifact(Buffer.from(JSON.stringify(resourceV2)), { contentKind: "plugin" })).descriptor;
    const alignedV2 = pluginDocuments(resourceV2, artifactV2, { release: { dependencies: [dependency] } });
    const dependent = await service.admitRelease(marketplaceDocumentBytes(alignedV2.release));
    assert.equal(dependent.revision, 5);
    const resourceV201 = await pluginFixtureResource({ mutateDocument(document) { document.version = "2.0.1"; } });
    const artifactV201 = (await service.admitArtifact(Buffer.from(JSON.stringify(resourceV201)), { contentKind: "plugin" })).descriptor;
    const alignedV201 = pluginDocuments(resourceV201, artifactV201, {
        release: { dependencies: [{ ...dependency, artifactSha256: "0".repeat(64) }] },
    });
    await assert.rejects(
        service.admitRelease(marketplaceDocumentBytes(alignedV201.release)),
        (error) => error.code === "CONFLICT" && /dependency/u.test(error.message),
    );
    assert.equal((await service.verifyRegistry()).ok, true);
});

test("MKT-03 refuses to repair or overwrite corrupted CAS bytes", async (t) => {
    const { root, service } = await registry(t);
    const bytes = Buffer.from(JSON.stringify(await pluginFixtureResource()));
    const admitted = await service.admitArtifact(bytes, { contentKind: "plugin" });
    const casPath = resolveRegistryPath(registryPaths(root), blobPath(admitted.descriptor.sha256));
    await fs.writeFile(casPath, Buffer.alloc(bytes.length, 0));
    await assert.rejects(
        service.admitArtifact(bytes, { contentKind: "plugin" }),
        (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.deepEqual(await fs.readFile(casPath), Buffer.alloc(bytes.length, 0));
});

test("MKT-03 validates and preserves exact PNG, JPEG, and WebP preview bytes and rejects masquerading", async (t) => {
    const { root, service } = await registry(t);
    for (const [format, mediaType] of [["png", "image/png"], ["jpeg", "image/jpeg"], ["webp", "image/webp"]]) {
        const bytes = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#123456" } })[format]().toBuffer();
        const admitted = await service.admitPreview(bytes, { mediaType });
        assert.deepEqual(
            await fs.readFile(resolveRegistryPath(registryPaths(root), blobPath(admitted.descriptor.sha256))),
            bytes,
        );
        assert.equal(admitted.preview.width, 3);
        assert.equal(admitted.preview.height, 2);
    }
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ffffff" } }).png().toBuffer();
    await assert.rejects(service.admitPreview(png, { mediaType: "image/jpeg" }), /JPEG preview|not jpeg/u);
    await assert.rejects(service.admitPreview(Buffer.concat([png, Buffer.from("<html>")]), { mediaType: "image/png" }), /trailing/u);
    assert.deepEqual(await fs.readdir(registryPaths(root).uploadStaging), []);
});

test("MKT-03 verification reconstructs targets and dry-run GC never deletes unreferenced blobs", async (t) => {
    const { root, service } = await registry(t);
    const resource = await pluginFixtureResource();
    const artifact = (await service.admitArtifact(Buffer.from(JSON.stringify(resource)), { contentKind: "plugin" })).descriptor;
    const aligned = pluginDocuments(resource, artifact);
    const orphanPreview = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#000000" } }).png().toBuffer();
    const orphan = await service.admitPreview(orphanPreview, { mediaType: "image/png" });
    await service.admitItem(marketplaceDocumentBytes(aligned.item));
    await service.admitRelease(marketplaceDocumentBytes(aligned.release));
    assert.equal((await service.verifyRegistry()).ok, true);
    const plan = await service.planGarbageCollection({ graceMs: 0 });
    assert.deepEqual(plan.unreferencedBlobs, [orphan.descriptor.sha256]);
    await assert.doesNotReject(fs.access(resolveRegistryPath(registryPaths(root), blobPath(orphan.descriptor.sha256))));
});

test("MKT-11 registry admits run-template inventories only after their exact plugin releases", async (t) => {
    const { root, service } = await registry(t);
    const resource = await pluginFixtureResource();
    const pluginArtifact = (await service.admitArtifact(Buffer.from(JSON.stringify(resource)), { contentKind: "plugin" })).descriptor;
    const plugin = pluginDocuments(resource, pluginArtifact);
    await service.admitItem(marketplaceDocumentBytes(plugin.item));

    const authoring = new StorageService(path.join(root, "template-authoring"));
    await authoring.plugins.putPackage(resource);
    const environment = await authoring.createEnvironment({ id: "registry-yard", name: "Registry Yard", supportedEditorSourceVersions: [1] });
    const manifest = await authoring.createRunManifest({
        ...createDefaultRunManifest({ id: "registry-template", environment: { id: environment.environmentId, expectedHash: null } }),
        plugins: {
            enabled: true,
            artifacts: [{ pluginId: plugin.item.itemId, expectedHash: resource.packageHash, capabilities: [] }],
        },
    });
    const archivePath = path.join(root, "template-authoring.tar");
    const exported = await exportRunTemplatePackage({
        storageService: authoring,
        manifestId: manifest.id,
        expectedRevision: manifest.revision,
        pluginReleaseRefs: [{
            packageHash: resource.packageHash,
            itemId: plugin.release.itemId,
            releaseVersion: plugin.release.releaseVersion,
            artifactSha256: pluginArtifact.sha256,
        }],
    });
    await pipeline(exported.stream, (await fs.open(archivePath, "wx")).createWriteStream());
    await exported.completion;
    const templateArtifact = (await service.admitArtifact(await fs.readFile(archivePath), { contentKind: "run-template" })).descriptor;
    const templateItem = {
        ...structuredClone(documents.item),
        itemId: "com.example.editable-template",
        contentKind: "run-template",
        previews: [],
    };
    const templateRelease = {
        ...structuredClone(documents.release),
        itemId: templateItem.itemId,
        contentKind: "run-template",
        artifact: templateArtifact,
        capabilities: [],
        compatibility: {
            ...structuredClone(documents.release.compatibility),
            contracts: [{ kind: "cev-sim.run-template-package", versions: [1] }],
        },
        dependencies: [],
        embeddedPlugins: [{
            pluginId: plugin.item.itemId,
            packageHash: resource.packageHash,
            runtimeHash: resource.runtimeHash,
            release: {
                itemId: plugin.release.itemId,
                releaseVersion: plugin.release.releaseVersion,
                artifactSha256: pluginArtifact.sha256,
            },
        }],
    };
    await service.admitItem(marketplaceDocumentBytes(templateItem));
    await assert.rejects(service.admitRelease(marketplaceDocumentBytes(templateRelease)), /not admitted with the exact artifact/u);
    await service.admitRelease(marketplaceDocumentBytes(plugin.release));
    await service.admitRelease(marketplaceDocumentBytes(templateRelease));
    assert.equal((await service.verifyRegistry()).ok, true);
});

test("MKT-04 keeps the standalone loopback listener out of the application server import graph", async () => {
    const root = new URL("../server/marketplace/", import.meta.url);
    const files = await fs.readdir(root, { recursive: true });
    for (const file of files.filter((entry) => entry.endsWith(".js"))) {
        const source = await fs.readFile(new URL(file, root), "utf8");
        if (file === "registry/RegistryHttpServer.js" || file === "RegistryCli.js") {
            assert.match(source, /node:http|createServer\s*\(|\.listen\s*\(/u, file);
        } else {
            assert.doesNotMatch(source, /node:http|createServer\s*\(|\.listen\s*\(/u, file);
        }
    }
    const application = await fs.readFile(new URL("../server/App.js", import.meta.url), "utf8");
    assert.doesNotMatch(application, /RegistryHttpServer|MarketplaceRegistryReader|cev-sim-marketplace|cev-mkt/u);
});
