import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import { createHash } from "node:crypto";

import { createEnvironmentPackageLifecycleAdapter } from "../server/marketplace/ArtifactAdapters.js";
import {
    ENVIRONMENT_PACKAGE_MANIFEST,
    exportEnvironmentPackage,
    readEnvironmentPackagePreparation,
    verifyEnvironmentPackage,
} from "../server/marketplace/EnvironmentPackage.js";
import { MarketplaceReceiptStore } from "../server/marketplace/client/MarketplaceReceiptStore.js";
import { StorageService } from "../server/storage/StorageService.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { normalizeVisualLayer } from "../app/simulation/visual/VisualLayer.js";
import {
    makePng,
    makeTriangleGlb,
    ownedGrant,
    publishAsset,
    restrictedGrant,
    writeRegistry,
} from "./helpers/visual-assets.js";

async function fixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const service = new StorageService(directory, options);
    await service.createEnvironment({ id: "portable-yard", name: "Portable Yard", supportedEditorSourceVersions: [1] });
    return { directory, service };
}

async function writeExport(service, destination, expectedRevision = 1) {
    const exported = await exportEnvironmentPackage({
        storageService: service,
        environmentId: "portable-yard",
        expectedRevision,
    });
    await pipeline(exported.stream, (await fs.open(destination, "wx")).createWriteStream());
    await exported.completion;
    return fs.readFile(destination);
}

test("MKT-10 environment export treats a null abort signal as no cancellation", async (t) => {
    const { directory, service } = await fixture(t);
    const destination = path.join(directory, "null-signal.tar");
    const output = (await fs.open(destination, "wx")).createWriteStream();
    const exported = await exportEnvironmentPackage({
        storageService: service,
        environmentId: "portable-yard",
        expectedRevision: 1,
        output,
        signal: null,
    });
    assert.equal(exported.manifest.environment.environmentId, "portable-yard");
    const verified = await verifyEnvironmentPackage(destination, { signal: null });
    t.after(() => verified.cleanup());
    assert.equal(verified.environment.environmentId, "portable-yard");
});

test("MKT-10 environment export is deterministic and verifies an exact empty authoring closure", async (t) => {
    const { directory, service } = await fixture(t);
    const firstPath = path.join(directory, "first.tar");
    const secondPath = path.join(directory, "second.tar");
    const first = await writeExport(service, firstPath);
    const second = await writeExport(service, secondPath);
    assert.deepEqual(first, second);
    const verified = await verifyEnvironmentPackage(first, { retainStaging: true });
    t.after(() => verified.cleanup());
    assert.equal(verified.entries[0].name, ENVIRONMENT_PACKAGE_MANIFEST);
    assert.equal(verified.environment.environmentId, "portable-yard");
    assert.equal(verified.environment.schemaVersion, 4);
    assert.deepEqual(verified.manifest.assets.roots, []);
    assert.equal(verified.revisions.size, 0);
    assert.equal(verified.uses.size, 0);
});

test("MKT-10 lifecycle publishes the environment last and reuses identical imported content", async (t) => {
    const source = await fixture(t);
    const archivePath = path.join(source.directory, "environment.tar");
    const bytes = await writeExport(source.service, archivePath);
    const destinationDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-destination-"));
    t.after(() => fs.rm(destinationDir, { recursive: true, force: true }));
    const destination = new StorageService(destinationDir);
    const adapter = createEnvironmentPackageLifecycleAdapter({
        storageService: destination,
        editorAssetStore: destination.editorAssets,
        visualAssetStore: destination.visualAssets,
        receiptStore: await MarketplaceReceiptStore.open(destinationDir),
    });
    const release = {
        itemId: "portable-yard-release",
        releaseVersion: "1.0.0",
        artifact: {
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
        },
    };
    const context = {
        source: {
            sourceId: "11111111-1111-4111-8111-111111111111",
            registryId: "22222222-2222-4222-8222-222222222222",
        },
        workDirectory: path.join(destinationDir, "marketplace-work"),
    };
    const artifactHandle = { path: archivePath, mediaType: adapter.contract.mediaType, ...release.artifact };
    const inspection = await adapter.inspect(artifactHandle, { stagingRoot: path.join(destinationDir, "inspection") });
    const plan = await adapter.plan({ release, inspection, artifactHandle, context });
    assert.deepEqual(plan.operations.map((entry) => entry.kind), ["publish-environment"]);
    await assert.rejects(
        adapter.commit({
            release,
            inspection,
            adapterPlan: plan,
            artifactHandle,
            operation: { ...plan.operations[0], environmentId: "tampered-yard" },
            context,
        }),
        (error) => error.code === "RECOVERY_REQUIRED",
    );
    for (const operation of plan.operations) {
        await adapter.commit({ release, inspection, adapterPlan: plan, artifactHandle, operation, context });
    }
    const imported = await destination.getEnvironment("portable-yard");
    assert.equal(imported.name, "Portable Yard");
    assert.equal(imported.revision, 1);
    const repeatContext = { ...context, workDirectory: path.join(destinationDir, "marketplace-work-repeat") };
    const repeated = await adapter.plan({ release, inspection, artifactHandle, context: repeatContext });
    assert.equal(repeated.environment.localEnvironmentId, "portable-yard");
    assert.equal(repeated.environment.expectedLocalRevision, 1);
    const edited = await destination.putEnvironment("portable-yard", {
        manifest: { ...imported, name: "User-edited after publication" },
        expectedRevision: imported.revision,
        supportedRoadGeometryVersions: [1, 2],
        supportedAssetMetricVersions: [1],
        supportedEditorSourceVersions: [1],
    });
    await assert.rejects(
        adapter.recover({
            release,
            inspection,
            adapterPlan: plan,
            artifactHandle,
            operation: plan.operations[0],
            context,
        }),
        (error) => error.code === "CONFLICT",
    );
    assert.equal((await destination.getEnvironment("portable-yard")).revision, edited.revision);
    assert.equal((await destination.getEnvironment("portable-yard")).name, "User-edited after publication");
});

test("MKT-10 durable preparation authenticates staged entry bytes", async (t) => {
    const source = await fixture(t);
    const archivePath = path.join(source.directory, "environment.tar");
    const bytes = await writeExport(source.service, archivePath);
    const destinationDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-preparation-"));
    t.after(() => fs.rm(destinationDir, { recursive: true, force: true }));
    const destination = new StorageService(destinationDir);
    const adapter = createEnvironmentPackageLifecycleAdapter({
        storageService: destination,
        editorAssetStore: destination.editorAssets,
        visualAssetStore: destination.visualAssets,
        receiptStore: await MarketplaceReceiptStore.open(destinationDir),
    });
    const release = {
        itemId: "portable-yard-preparation",
        releaseVersion: "1.0.0",
        artifact: { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length },
    };
    const context = {
        source: { sourceId: "55555555-5555-4555-8555-555555555555", registryId: "66666666-6666-4666-8666-666666666666" },
        workDirectory: path.join(destinationDir, "marketplace-work"),
    };
    const artifactHandle = { path: archivePath, mediaType: adapter.contract.mediaType, ...release.artifact };
    const inspection = await adapter.inspect(artifactHandle, { stagingRoot: path.join(destinationDir, "inspection") });
    const plan = await adapter.plan({ release, inspection, artifactHandle, context });
    const preparation = await readEnvironmentPackagePreparation({
        workDirectory: context.workDirectory,
        preparationHash: plan.preparationHash,
        archiveSha256: plan.package.archiveSha256,
    });
    await fs.appendFile(preparation.entries[0].path, "tamper");
    await assert.rejects(
        readEnvironmentPackagePreparation({
            workDirectory: context.workDirectory,
            preparationHash: plan.preparationHash,
            archiveSha256: plan.package.archiveSha256,
        }),
        (error) => error.code === "RECOVERY_REQUIRED",
    );
});

test("MKT-10 remaps direct asset pins before guarded environment publication", async (t) => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-assets-"));
    t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
    const sourceRegistry = await writeRegistry(sourceDir, [ownedGrant()]);
    const source = new StorageService(sourceDir, { visualAssets: { registryPath: sourceRegistry } });
    const model = await publishAsset(source.visualAssets, makeTriangleGlb(), {
        mediaType: "model/gltf-binary",
        role: "mesh",
    });
    await source.editorAssets.publishRevision({
        assetId: "crate",
        name: "Crate",
        publicationId: "source-crate",
        modelUseHash: model.useHash,
    }, 0);
    const created = await source.createEnvironment({ id: "asset-yard", name: "Asset Yard", supportedEditorSourceVersions: [1] });
    const assetRecord = {
        id: "crate-one",
        typeId: "asset-instance",
        typeVersion: 1,
        name: "Crate",
        parentId: null,
        order: created.document.objects.length,
        components: {
            tags: [], locked: false, editorHidden: false,
            asset: {
                assetId: "crate",
                revision: 1,
                position: { x: 2, y: 0, z: 3 },
                rotationY: 0,
                scale: { x: 1, y: 1, z: 1 },
                overrides: {},
            },
        },
    };
    const tileRecord = {
        ...structuredClone(assetRecord),
        id: "tile",
        typeId: "tile",
        typeVersion: 2,
        name: "Imported GLTF Tile",
        order: assetRecord.order + 1,
    };
    tileRecord.components.tile = { provider: "gltf", assetTypeVersion: 1 };
    await source.putEnvironment("asset-yard", {
        manifest: {
            ...created,
            document: { ...created.document, objects: [...created.document.objects, assetRecord, tileRecord] },
        },
        expectedRevision: created.revision,
        supportedRoadGeometryVersions: [1, 2],
        supportedAssetMetricVersions: [1],
        supportedEditorSourceVersions: [1],
    });
    const archivePath = path.join(sourceDir, "asset-environment.tar");
    const exported = await exportEnvironmentPackage({ storageService: source, environmentId: "asset-yard", expectedRevision: 2 });
    await pipeline(exported.stream, (await fs.open(archivePath, "wx")).createWriteStream());
    await exported.completion;
    const bytes = await fs.readFile(archivePath);

    const destinationDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-assets-destination-"));
    t.after(() => fs.rm(destinationDir, { recursive: true, force: true }));
    const destinationRegistry = await writeRegistry(destinationDir, [ownedGrant()]);
    const destination = new StorageService(destinationDir, { visualAssets: { registryPath: destinationRegistry } });
    const adapter = createEnvironmentPackageLifecycleAdapter({
        storageService: destination,
        editorAssetStore: destination.editorAssets,
        visualAssetStore: destination.visualAssets,
        receiptStore: await MarketplaceReceiptStore.open(destinationDir),
    });
    const release = {
        itemId: "asset-yard-release",
        releaseVersion: "1.0.0",
        artifact: { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length },
    };
    const context = {
        source: { sourceId: "33333333-3333-4333-8333-333333333333", registryId: "44444444-4444-4444-8444-444444444444" },
        workDirectory: path.join(destinationDir, "marketplace-work"),
    };
    const artifactHandle = { path: archivePath, mediaType: adapter.contract.mediaType, ...release.artifact };
    const inspection = await adapter.inspect(artifactHandle, { stagingRoot: path.join(destinationDir, "inspection") });
    const plan = await adapter.plan({ release, inspection, artifactHandle, context });
    assert.deepEqual(plan.operations.map((entry) => entry.kind), [
        "publish-visual-use",
        "publish-editor-asset-revision",
        "publish-environment",
    ]);
    for (const operation of plan.operations) await adapter.commit({ release, inspection, adapterPlan: plan, artifactHandle, operation, context });
    const imported = await destination.getEnvironment("asset-yard");
    const importedRecord = imported.document.objects.find((entry) => entry.id === "crate-one");
    assert.match(importedRecord.components.asset.assetId, /^crate-mkt-[a-f0-9]{12}$/u);
    assert.equal(importedRecord.components.asset.revision, 1);
    const importedTile = imported.document.objects.find((entry) => entry.id === "tile");
    assert.equal(importedTile.components.asset.assetId, importedRecord.components.asset.assetId);
    assert.equal(importedTile.components.tile.provider, "gltf");
    assert.equal(importedTile.components.tile.assetTypeVersion, 1);
    assert.ok(await destination.editorAssets.getRevision(importedRecord.components.asset.assetId, 1));
});

test("MKT-10 detects an environment edit before export finalization", async (t) => {
    let service;
    const fixtureValue = await fixture(t, {
        faults: {
            async marketplaceEnvironmentExportBeforeRecheck() {
                const current = await service.getEnvironment("portable-yard");
                await service.putEnvironment("portable-yard", {
                    manifest: { ...current, name: "Changed during export" },
                    expectedRevision: current.revision,
                    supportedRoadGeometryVersions: [1, 2],
                    supportedAssetMetricVersions: [1],
                    supportedEditorSourceVersions: [1],
                });
            },
        },
    });
    service = fixtureValue.service;
    await assert.rejects(
        exportEnvironmentPackage({ storageService: service, environmentId: "portable-yard", expectedRevision: 1 }),
        (error) => error.code === "CONFLICT",
    );
});

test("MKT-10 rejects legacy, built-in, live-network, and export-denied sources", async (t) => {
    const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-legacy-"));
    t.after(() => fs.rm(legacyDir, { recursive: true, force: true }));
    const legacy = new StorageService(legacyDir, { environmentSchemaVersion: 3 });
    const saved = await legacy.createEnvironment({ id: "legacy-yard", name: "Legacy Yard", supportedEditorSourceVersions: [1] });
    assert.equal(saved.schemaVersion, 3);
    await assert.rejects(
        exportEnvironmentPackage({ storageService: legacy, environmentId: "legacy-yard", expectedRevision: saved.revision }),
        /schema-v4/i,
    );
    await assert.rejects(
        exportEnvironmentPackage({ storageService: legacy, environmentId: "igvc" }),
        /saved environment/i,
    );

    const portable = await fixture(t);
    const base = await portable.service.getEnvironment("portable-yard");
    const google = structuredClone(base);
    google.document.objects.push({
        id: "tile",
        typeId: "tile",
        typeVersion: 1,
        name: "Live Google Tiles",
        parentId: null,
        order: google.document.objects.length,
        components: { tags: [], locked: false, editorHidden: false },
    });
    await assert.rejects(
        exportEnvironmentPackage({
            storageService: { snapshotMarketplaceEnvironment: async () => ({ environment: google, descriptor: null, access: null }) },
            environmentId: "portable-yard",
            expectedRevision: base.revision,
        }),
        /not portable/i,
    );

    const deniedDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-denied-"));
    t.after(() => fs.rm(deniedDir, { recursive: true, force: true }));
    const deniedRegistry = await writeRegistry(deniedDir, [ownedGrant()]);
    const denied = new StorageService(deniedDir, { visualAssets: { registryPath: deniedRegistry } });
    const deniedAsset = await publishAsset(denied.visualAssets, makeTriangleGlb(), { mediaType: "model/gltf-binary", role: "mesh" });
    await denied.editorAssets.publishRevision({
        assetId: "denied-crate",
        name: "Denied Crate",
        publicationId: "denied-crate-publication",
        modelUseHash: deniedAsset.useHash,
    }, 0);
    const deniedEnvironment = await denied.createEnvironment({ id: "denied-yard", name: "Denied Yard", supportedEditorSourceVersions: [1] });
    const deniedObject = {
        id: "denied-one",
        typeId: "asset-instance",
        typeVersion: 1,
        name: "Denied",
        parentId: null,
        order: deniedEnvironment.document.objects.length,
        components: {
            tags: [], locked: false, editorHidden: false,
            asset: {
                assetId: "denied-crate", revision: 1,
                position: { x: 0, y: 0, z: 0 }, rotationY: 0,
                scale: { x: 1, y: 1, z: 1 }, overrides: {},
            },
        },
    };
    const deniedSaved = await denied.putEnvironment("denied-yard", {
        manifest: { ...deniedEnvironment, document: { ...deniedEnvironment.document, objects: [...deniedEnvironment.document.objects, deniedObject] } },
        expectedRevision: deniedEnvironment.revision,
        supportedRoadGeometryVersions: [1, 2],
        supportedAssetMetricVersions: [1],
        supportedEditorSourceVersions: [1],
    });
    await writeRegistry(deniedDir, [restrictedGrant("owned-lab", {
        permissions: { "persistent-cache": true, "machine-interpretation": true, retention: true },
    })]);
    await assert.rejects(
        exportEnvironmentPackage({ storageService: denied, environmentId: "denied-yard", expectedRevision: deniedSaved.revision }),
        (error) => error.code === "VISUAL_ASSET_RIGHTS_DENIED",
    );
});

test("MKT-10 rebinds packaged visual truth only when destination world identity changes", async (t) => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-visual-source-"));
    t.after(() => fs.rm(sourceDir, { recursive: true, force: true }));
    const sourceRegistry = await writeRegistry(sourceDir, [ownedGrant()]);
    const source = new StorageService(sourceDir, { visualAssets: { registryPath: sourceRegistry } });
    const created = await source.createEnvironment({ id: "visual-yard", name: "Visual Yard", supportedEditorSourceVersions: [1] });
    const published = await publishAsset(source.visualAssets, makePng(), { mediaType: "image/png", role: "texture" });
    const descriptor = normalizeVisualLayer({
        kind: "cev-sim.visual-layer",
        version: 1,
        sourceWorldHash: createWorldResource(created).hash,
        assetProfile: { id: "static-gltf-surface", version: 1 },
        assets: [published.use.asset],
        materials: [],
        chunks: [],
        instances: [],
        bindings: [],
        appearanceDependencies: [],
    });
    const hashes = await source.publishVisualLayer({
        descriptor,
        assetUses: [{ sha256: published.use.asset.sha256, useHash: published.useHash }],
    });
    const referenced = await source.putEnvironment("visual-yard", {
        manifest: {
            ...created,
            evidence: { reportHash: "a".repeat(64) },
            visualLayer: { ...hashes, bakeReuseManifestHash: "b".repeat(64) },
        },
        expectedRevision: created.revision,
        supportedRoadGeometryVersions: [1, 2],
        supportedAssetMetricVersions: [1],
        supportedEditorSourceVersions: [1],
    });
    const archivePath = path.join(sourceDir, "visual-environment.tar");
    const exported = await exportEnvironmentPackage({ storageService: source, environmentId: "visual-yard", expectedRevision: referenced.revision });
    await pipeline(exported.stream, (await fs.open(archivePath, "wx")).createWriteStream());
    await exported.completion;
    const bytes = await fs.readFile(archivePath);

    const destinationDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-environment-visual-destination-"));
    t.after(() => fs.rm(destinationDir, { recursive: true, force: true }));
    const destinationRegistry = await writeRegistry(destinationDir, [ownedGrant()]);
    const registryBefore = await fs.readFile(destinationRegistry);
    const destination = new StorageService(destinationDir, { visualAssets: { registryPath: destinationRegistry } });
    await destination.createEnvironment({ id: "visual-yard", name: "Occupied Yard", supportedEditorSourceVersions: [1] });
    const adapter = createEnvironmentPackageLifecycleAdapter({
        storageService: destination,
        editorAssetStore: destination.editorAssets,
        visualAssetStore: destination.visualAssets,
        receiptStore: await MarketplaceReceiptStore.open(destinationDir),
    });
    const release = {
        itemId: "visual-yard-release",
        releaseVersion: "1.0.0",
        artifact: { sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length },
    };
    const context = {
        source: { sourceId: "77777777-7777-4777-8777-777777777777", registryId: "88888888-8888-4888-8888-888888888888" },
        workDirectory: path.join(destinationDir, "marketplace-work"),
    };
    const artifactHandle = { path: archivePath, mediaType: adapter.contract.mediaType, ...release.artifact };
    const inspection = await adapter.inspect(artifactHandle, { stagingRoot: path.join(destinationDir, "inspection") });
    const plan = await adapter.plan({ release, inspection, artifactHandle, context });
    assert.match(plan.environment.localEnvironmentId, /^visual-yard-mkt-[a-f0-9]{12}$/u);
    assert.notEqual(plan.environment.localWorldHash, plan.environment.sourceWorldHash);
    assert.notEqual(plan.environment.localDescriptorHash, plan.environment.sourceDescriptorHash);
    assert.deepEqual(plan.operations.map((entry) => entry.kind), [
        "publish-visual-use",
        "publish-environment-visual-layer",
        "publish-environment",
    ]);
    for (const operation of plan.operations) await adapter.commit({ release, inspection, adapterPlan: plan, artifactHandle, operation, context });
    const imported = await destination.getEnvironment(plan.environment.localEnvironmentId);
    assert.equal(imported.evidence, null);
    assert.equal(Object.hasOwn(imported.visualLayer, "bakeReuseManifestHash"), false);
    const localVisual = await destination.getVisualLayerAccess(imported.visualLayer.descriptorHash, imported.visualLayer.accessHash);
    assert.equal(localVisual.descriptor.sourceWorldHash, createWorldResource(imported).hash);
    assert.equal(localVisual.access.descriptorHash, imported.visualLayer.descriptorHash);
    assert.deepEqual(await fs.readFile(destinationRegistry), registryBefore);
});
