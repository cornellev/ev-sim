import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { EditorAssetStore } from "../server/storage/EditorAssetStore.js";
import { compileAssetDefinition } from "../app/editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { decodeAssetSourceGeometry } from "../server/storage/ServerAssetGeometryDecoder.js";
import { MarketplaceReceiptStore } from "../server/marketplace/client/MarketplaceReceiptStore.js";
import {
    ASSET_PACKAGE_MANIFEST,
    exportAssetPackage,
    verifyAssetPackage,
} from "../server/marketplace/AssetPackage.js";
import { createAssetPackageLifecycleAdapter } from "../server/marketplace/ArtifactAdapters.js";
import {
    createAssetStore,
    makeNamedMaterialGlb,
    makeTriangleGlb,
    publishAsset,
    sha256Hex,
} from "./helpers/visual-assets.js";

async function exportedFixture(t) {
    const source = await createAssetStore();
    t.after(() => fs.rm(source.dir, { recursive: true, force: true }));
    const model = await publishAsset(source.store, makeTriangleGlb(), {
        mediaType: "model/gltf-binary",
        role: "mesh",
    });
    const editor = new EditorAssetStore(source.dir, {
        visualAssets: source.store,
        now: () => new Date("2026-09-28T12:00:00.000Z"),
    });
    await editor.publishRevision({
        assetId: "crate",
        name: "Crate",
        tags: ["cargo"],
        publicationId: "crate-source-publication",
        modelUseHash: model.useHash,
    }, 0);
    const firstPath = path.join(source.dir, "assets-1.tar");
    const secondPath = path.join(source.dir, "assets-2.tar");
    for (const destination of [firstPath, secondPath]) {
        const exported = await exportAssetPackage({
            editorAssetStore: editor,
            visualAssetStore: source.store,
            roots: [{ assetId: "crate", revision: 1 }],
        });
        await pipeline(exported.stream, (await fs.open(destination, "wx")).createWriteStream());
        await exported.completion;
    }
    return { source, editor, firstPath, secondPath, model };
}

test("MKT-09 asset-package export is byte-stable and verifies its exact revision/use/blob closure", async (t) => {
    const fixture = await exportedFixture(t);
    const first = await fs.readFile(fixture.firstPath);
    const second = await fs.readFile(fixture.secondPath);
    assert.deepEqual(first, second);
    const verified = await verifyAssetPackage(first, { retainStaging: true });
    t.after(() => verified.cleanup());
    assert.equal(verified.archiveSha256, sha256Hex(first));
    assert.deepEqual(verified.manifest.roots, [{ assetId: "crate", revision: 1 }]);
    assert.equal(verified.revisions.size, 1);
    assert.equal(verified.uses.size, 1);
    assert.equal(verified.manifest.blobs.length, 1);
    assert.equal(verified.entries[0].name, ASSET_PACKAGE_MANIFEST);
    assert.deepEqual(verified.assetOrder, ["crate@1"]);
    assert.deepEqual(verified.useOrder, [fixture.model.useHash]);
    await assert.rejects(
        verifyAssetPackage(first, { limits: { manifestBytes: 1 } }),
        (error) => /byte ceiling|manifest limit/iu.test(error.message),
    );
});

test("MKT-09 asset-package lifecycle maps and imports revisions without reusing foreign publication IDs", async (t) => {
    const fixture = await exportedFixture(t);
    const destination = await createAssetStore();
    t.after(() => fs.rm(destination.dir, { recursive: true, force: true }));
    const editor = new EditorAssetStore(destination.dir, {
        visualAssets: destination.store,
        assetStudioEnabled: true,
        now: () => new Date("2026-09-28T13:00:00.000Z"),
    });
    const receiptStore = await MarketplaceReceiptStore.open(destination.dir);
    const adapter = createAssetPackageLifecycleAdapter({
        editorAssetStore: editor,
        visualAssetStore: destination.store,
        receiptStore,
    });
    const bytes = await fs.readFile(fixture.firstPath);
    const release = {
        itemId: "portable-crate",
        releaseVersion: "1.0.0",
        artifact: { sha256: sha256Hex(bytes), sizeBytes: bytes.length },
    };
    const context = {
        source: {
            sourceId: "11111111-1111-4111-8111-111111111111",
            registryId: "22222222-2222-4222-8222-222222222222",
        },
        workDirectory: path.join(destination.dir, "marketplace-work"),
    };
    const artifactHandle = {
        path: fixture.firstPath,
        mediaType: adapter.contract.mediaType,
        sha256: release.artifact.sha256,
        sizeBytes: release.artifact.sizeBytes,
    };
    const inspection = await adapter.inspect(artifactHandle, { stagingRoot: path.join(destination.dir, "inspection") });
    const plan = await adapter.plan({ release, inspection, artifactHandle, context });
    assert.equal(plan.revisionMappings.length, 1);
    assert.match(plan.revisionMappings[0].localAssetId, /^crate-mkt-[a-f0-9]{12}$/u);
    assert.notEqual(plan.revisionMappings[0].publicationId, "crate-source-publication");
    for (const operation of plan.operations) {
        await adapter.commit({ release, inspection, adapterPlan: plan, artifactHandle, operation, context });
    }
    const imported = await editor.getRevision(plan.revisionMappings[0].localAssetId, 1);
    assert.equal(imported.publicationId, plan.revisionMappings[0].publicationId);
    assert.equal(imported.modelUseHash, fixture.model.useHash);
    assert.equal((await editor.get(plan.revisionMappings[0].localAssetId)).asset.folderId, null);
});

test("MKT-09 maps sparse source history contiguously and extends occupied deterministic IDs", async (t) => {
    const source = await createAssetStore();
    t.after(() => fs.rm(source.dir, { recursive: true, force: true }));
    const model = await publishAsset(source.store, makeTriangleGlb(), {
        mediaType: "model/gltf-binary",
        role: "mesh",
    });
    const sourceEditor = new EditorAssetStore(source.dir, { visualAssets: source.store });
    for (let revision = 1; revision <= 3; revision += 1) {
        await sourceEditor.publishRevision({
            assetId: "sparse",
            name: "Sparse",
            publicationId: `sparse-source-${revision}`,
            modelUseHash: model.useHash,
        }, revision - 1);
    }
    const archivePath = path.join(source.dir, "sparse.tar");
    const exported = await exportAssetPackage({
        editorAssetStore: sourceEditor,
        visualAssetStore: source.store,
        roots: [{ assetId: "sparse", revision: 3 }],
    });
    await pipeline(exported.stream, (await fs.open(archivePath, "wx")).createWriteStream());
    await exported.completion;

    const destination = await createAssetStore();
    t.after(() => fs.rm(destination.dir, { recursive: true, force: true }));
    const editor = new EditorAssetStore(destination.dir, { visualAssets: destination.store });
    const adapter = createAssetPackageLifecycleAdapter({
        editorAssetStore: editor,
        visualAssetStore: destination.store,
        receiptStore: await MarketplaceReceiptStore.open(destination.dir),
    });
    const bytes = await fs.readFile(archivePath);
    const release = { itemId: "sparse-assets", releaseVersion: "1.0.0", artifact: { sha256: sha256Hex(bytes), sizeBytes: bytes.length } };
    const baseContext = {
        source: { sourceId: "55555555-5555-4555-8555-555555555555", registryId: "66666666-6666-4666-8666-666666666666" },
    };
    const artifactHandle = { path: archivePath, mediaType: adapter.contract.mediaType, ...release.artifact };
    const inspection = await adapter.inspect(artifactHandle, { stagingRoot: path.join(destination.dir, "inspection") });
    const firstContext = { ...baseContext, workDirectory: path.join(destination.dir, "work-1") };
    const firstPlan = await adapter.plan({ release, inspection, artifactHandle, context: firstContext });
    assert.equal(firstPlan.revisionMappings[0].sourceRevision, 3);
    assert.equal(firstPlan.revisionMappings[0].localRevision, 1);
    assert.match(firstPlan.revisionMappings[0].localAssetId, /^sparse-mkt-[a-f0-9]{12}$/u);
    assert.equal(firstPlan.mappings[0].hashes.localContent.length, 64);
    for (const operation of firstPlan.operations.filter((entry) => entry.kind === "publish-visual-use")) {
        await adapter.commit({ release, inspection, adapterPlan: firstPlan, artifactHandle, operation, context: firstContext });
    }
    const unrelated = await publishAsset(destination.store, makeNamedMaterialGlb("unrelated"), {
        mediaType: "model/gltf-binary",
        role: "mesh",
    });
    await editor.publishRevision({
        assetId: firstPlan.revisionMappings[0].localAssetId,
        name: "Occupied",
        publicationId: "occupied-user-publication",
        modelUseHash: unrelated.useHash,
    }, 0);
    const secondContext = { ...baseContext, workDirectory: path.join(destination.dir, "work-2") };
    const secondPlan = await adapter.plan({ release, inspection, artifactHandle, context: secondContext });
    assert.match(secondPlan.revisionMappings[0].localAssetId, /^sparse-mkt-[a-f0-9]{16}$/u);
});

test("MKT-09 v2 import rewrites nested pins, recompiles child-first, and preserves metric geometry", async (t) => {
    const source = await createAssetStore();
    t.after(() => fs.rm(source.dir, { recursive: true, force: true }));
    const model = await publishAsset(source.store, makeTriangleGlb(), {
        mediaType: "model/gltf-binary",
        role: "mesh",
    });
    const sourceEditor = new EditorAssetStore(source.dir, {
        visualAssets: source.store,
        assetStudioEnabled: true,
        now: () => new Date("2026-09-28T14:00:00.000Z"),
    });
    const childDefinition = createEmptyAssetDefinition({ modelUseHash: model.useHash, name: "Child" });
    const childCompiled = compileAssetDefinition(childDefinition, {
        sourceGeometries: { source: await decodeAssetSourceGeometry(model.useHash, source.store) },
    });
    const child = await sourceEditor.publishRevision({
        assetId: "child",
        name: "Child",
        publicationId: "child-source-publication",
        expectedAssetRevision: 0,
        modelUseHash: model.useHash,
        definition: childDefinition,
        metric: childCompiled.metric,
        metricHash: childCompiled.metricHash,
        appearance: childCompiled.materials,
    }, 0);
    const parentDefinition = {
        kind: "cev-sim.asset-definition",
        version: 1,
        normalization: { metersPerUnit: 1, orientation: [0, 0, 0, 1], pivot: [0, 0, 0] },
        sources: [],
        parts: [{
            id: "child-part", parentId: null, order: 0, name: "Child",
            transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
            content: { kind: "asset-reference", assetId: "child", revision: 1 },
            appearanceVisible: true,
            materialBindings: {},
        }],
        materials: [],
        lidarProxies: [],
        collisionProxies: [],
    };
    const parentCompiled = compileAssetDefinition(parentDefinition, {
        resolvedChildren: { "child@1": child.revision },
    });
    const parent = await sourceEditor.publishRevision({
        assetId: "parent",
        name: "Parent",
        publicationId: "parent-source-publication",
        expectedAssetRevision: 0,
        modelUseHash: child.revision.modelUseHash,
        definition: parentDefinition,
        metric: parentCompiled.metric,
        metricHash: parentCompiled.metricHash,
        appearance: parentCompiled.materials,
    }, 1);
    const archivePath = path.join(source.dir, "nested.tar");
    const exported = await exportAssetPackage({
        editorAssetStore: sourceEditor,
        visualAssetStore: source.store,
        roots: [{ assetId: "parent", revision: 1 }],
    });
    await pipeline(exported.stream, (await fs.open(archivePath, "wx")).createWriteStream());
    await exported.completion;

    const destination = await createAssetStore();
    t.after(() => fs.rm(destination.dir, { recursive: true, force: true }));
    const destinationEditor = new EditorAssetStore(destination.dir, {
        visualAssets: destination.store,
        assetStudioEnabled: true,
        now: () => new Date("2026-09-28T15:00:00.000Z"),
    });
    const adapter = createAssetPackageLifecycleAdapter({
        editorAssetStore: destinationEditor,
        visualAssetStore: destination.store,
        receiptStore: await MarketplaceReceiptStore.open(destination.dir),
    });
    const bytes = await fs.readFile(archivePath);
    const release = { itemId: "nested-assets", releaseVersion: "1.0.0", artifact: { sha256: sha256Hex(bytes), sizeBytes: bytes.length } };
    const context = {
        source: { sourceId: "33333333-3333-4333-8333-333333333333", registryId: "44444444-4444-4444-8444-444444444444" },
        workDirectory: path.join(destination.dir, "marketplace-work"),
    };
    const artifactHandle = { path: archivePath, mediaType: adapter.contract.mediaType, ...release.artifact };
    const inspection = await adapter.inspect(artifactHandle, { stagingRoot: path.join(destination.dir, "inspection") });
    const plan = await adapter.plan({ release, inspection, artifactHandle, context });
    for (const operation of plan.operations) await adapter.commit({ release, inspection, adapterPlan: plan, artifactHandle, operation, context });
    const childMap = plan.revisionMappings.find((entry) => entry.sourceAssetId === "child");
    const parentMap = plan.revisionMappings.find((entry) => entry.sourceAssetId === "parent");
    const importedParent = await destinationEditor.getRevision(parentMap.localAssetId, parentMap.localRevision);
    assert.deepEqual(importedParent.definition.parts[0].content, {
        kind: "asset-reference",
        assetId: childMap.localAssetId,
        revision: childMap.localRevision,
    });
    assert.deepEqual(importedParent.metric, parent.revision.metric);
    assert.equal(importedParent.metricHash, parent.revision.metricHash);
    assert.equal(importedParent.geometryHash, parent.revision.geometryHash);
    assert.ok(importedParent.appearance.every((material) => material.id.startsWith(`asset:${parentMap.localAssetId}:1:material:`)));
    const repeatedContext = { ...context, workDirectory: path.join(destination.dir, "marketplace-work-repeat") };
    const repeated = await adapter.plan({ release, inspection, artifactHandle, context: repeatedContext });
    assert.deepEqual(
        repeated.revisionMappings.map((entry) => [entry.sourceAssetId, entry.localAssetId]),
        plan.revisionMappings.map((entry) => [entry.sourceAssetId, entry.localAssetId]),
    );
    assert.ok(repeated.groups.every((entry) => entry.reused));
});
