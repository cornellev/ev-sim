import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";

import { VisualLayerClient } from "../app/3d/environment/visual/VisualLayerClient.js";
import { createDefaultRunManifest, computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import {
    hashVisualLayer,
    hashVisualLayerAccess,
    normalizeVisualLayer,
    normalizeVisualLayerAccess,
} from "../app/simulation/visual/VisualLayer.js";
import { mountStorageApi } from "../server/routes/storageApi.js";
import { StorageService } from "../server/storage/StorageService.js";
import { VISUAL_LAYER_ERROR_CODES } from "../server/storage/StorageErrors.js";
import {
    makeJpeg,
    makePng,
    ownedGrant,
    publishAsset,
    restrictedGrant,
    sha256Hex,
    writeRegistry,
} from "./helpers/visual-assets.js";

function layerFor(worldHash, assets) {
    return normalizeVisualLayer({
        kind: "cev-sim.visual-layer",
        version: 1,
        sourceWorldHash: worldHash,
        assetProfile: { id: "static-gltf-surface", version: 1 },
        assets,
        materials: [],
        chunks: [],
        instances: [],
        bindings: [],
        appearanceDependencies: [],
    });
}

function v2Document(id = "yard") {
    return {
        environmentId: id,
        name: "Yard",
        schemaVersion: 2,
        templateId: "blank",
        roadStylePreset: "default",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: false,
        document: {
            environmentId: id,
            chunkSize: 20,
            roads: {
                nodes: [{ id: "n0", x: 0, z: 0 }, { id: "n1", x: 10, z: 0 }],
                edges: [{ id: "e0", startNodeId: "n0", endNodeId: "n1", bidirectional: true, width: 4, laneCount: 1 }],
            },
            buildings: [{
                buildingId: "building-0",
                footprint: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }],
                height: 8,
            }],
            features: [],
            earth: null,
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: false,
        },
    };
}

async function withService(fn, sources = [ownedGrant()]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-visual-access-"));
    await writeRegistry(dir, sources);
    const service = new StorageService(dir, {
        visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") },
    });
    try {
        return await fn(service, dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function withApi(fn, sources = [ownedGrant()]) {
    await withService(async (service, dir) => {
        const app = express();
        mountStorageApi(app, service);
        const server = createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const origin = `http://127.0.0.1:${server.address().port}`;
        const client = new VisualLayerClient({ baseUrl: `${origin}/api/storage/visual-layers` });
        try {
            await fn({ origin, client, service, dir });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    }, sources);
}

async function seedEnvironment(service, id = "yard") {
    const created = await service.createEnvironment({ id, name: "Yard", templateId: "blank" });
    return service.putEnvironment(id, {
        manifest: { ...created, ...v2Document(id) },
        expectedRevision: created.revision,
    });
}

test("publish and read canonical access sidecars and reject coverage errors", async () => {
    await withApi(async ({ client, service, origin, dir }) => {
        const seeded = await seedEnvironment(service);
        const worldHash = createWorldResource(seeded).hash;
        const bytes = makePng();
        const published = await publishAsset(service.visualAssets, bytes, {
            mediaType: "image/png",
            role: "texture",
        });
        const descriptor = layerFor(worldHash, [published.use.asset]);
        const publishedLayer = await client.publish({
            descriptor,
            assetUses: [{ sha256: published.use.asset.sha256, useHash: published.useHash }],
        });
        assert.equal(publishedLayer.descriptorHash, hashVisualLayer(descriptor));
        const access = normalizeVisualLayerAccess({
            kind: "cev-sim.visual-layer-access",
            version: 1,
            descriptorHash: publishedLayer.descriptorHash,
            assets: [{ sha256: published.use.asset.sha256, useHash: published.useHash }],
        });
        assert.equal(publishedLayer.accessHash, hashVisualLayerAccess(access));

        const loaded = await client.getAccess(publishedLayer.descriptorHash, publishedLayer.accessHash);
        assert.deepEqual(loaded.descriptor, descriptor);
        assert.deepEqual(loaded.access, access);
        assert.equal(JSON.stringify(loaded).includes(dir), false);
        assert.deepEqual(Object.keys(loaded).sort(), ["access", "descriptor"]);

        await assert.rejects(
            () => client.publish({
                descriptor,
                assetUses: [{ sha256: published.use.asset.sha256, useHash: "a".repeat(64) }],
            }),
            /not found|does not match|missing use/i,
        );
        await assert.rejects(
            () => client.publish({
                descriptor,
                assetUses: [
                    { sha256: published.use.asset.sha256, useHash: published.useHash },
                    { sha256: published.use.asset.sha256, useHash: published.useHash },
                ],
            }),
            /duplicate/,
        );

        const jpeg = await publishAsset(service.visualAssets, makeJpeg(), {
            mediaType: "image/jpeg",
            role: "texture",
        });
        await assert.rejects(
            () => client.publish({
                descriptor,
                assetUses: [
                    { sha256: published.use.asset.sha256, useHash: published.useHash },
                    { sha256: jpeg.use.asset.sha256, useHash: jpeg.useHash },
                ],
            }),
            /exactly once/,
        );
        await assert.rejects(
            () => client.publish({
                descriptor,
                assetUses: [{ sha256: published.use.asset.sha256, useHash: jpeg.useHash }],
            }),
            /does not match the descriptor asset/,
        );

        const missing = await fetch(`${origin}/api/storage/visual-layers/${"f".repeat(64)}/access/${publishedLayer.accessHash}`);
        assert.equal(missing.status, 404);
        assert.equal((await missing.json()).code, VISUAL_LAYER_ERROR_CODES.DESCRIPTOR_NOT_FOUND);
    });
});

test("old descriptor-only references stay readable and old clients preserve accessHash", async () => {
    await withService(async (service) => {
        const seeded = await seedEnvironment(service);
        const worldHash = createWorldResource(seeded).hash;
        const bytes = makePng();
        const published = await publishAsset(service.visualAssets, bytes, {
            mediaType: "image/png",
            role: "texture",
        });
        const descriptor = layerFor(worldHash, [published.use.asset]);
        const hashes = await service.publishVisualLayer({
            descriptor,
            assetUses: [{ sha256: published.use.asset.sha256, useHash: published.useHash }],
        });
        const beforeWorld = createWorldResource(seeded).hash;
        const beforeResolved = computeResolvedRunHash(seeded);
        const withAccess = await service.putEnvironment("yard", {
            manifest: {
                ...seeded,
                visualLayer: { descriptorHash: hashes.descriptorHash, accessHash: hashes.accessHash },
            },
            expectedRevision: seeded.revision,
        });
        assert.deepEqual(withAccess.visualLayer, {
            descriptorHash: hashes.descriptorHash,
            accessHash: hashes.accessHash,
        });
        assert.equal(createWorldResource(withAccess).hash, beforeWorld);
        assert.notEqual(computeResolvedRunHash(withAccess), beforeResolved);

        const preserved = await service.putEnvironment("yard", {
            manifest: {
                ...withAccess,
                visualLayer: { descriptorHash: hashes.descriptorHash },
            },
            expectedRevision: withAccess.revision,
        });
        assert.deepEqual(preserved.visualLayer, withAccess.visualLayer);

        const other = layerFor(worldHash, [{
            sha256: "b".repeat(64),
            mediaType: "model/gltf-binary",
            sizeBytes: 16,
            role: "mesh",
        }]);
        const otherHash = await service._visualLayerDescriptors.put(other);
        await assert.rejects(
            () => service.putEnvironment("yard", {
                manifest: { ...preserved, visualLayer: { descriptorHash: otherHash } },
                expectedRevision: preserved.revision,
            }),
            (error) => error.code === VISUAL_LAYER_ERROR_CODES.ACCESS_REQUIRED,
        );

        const created = await service.createEnvironment({ id: "field", name: "Field" });
        const fieldSeeded = await service.putEnvironment("field", {
            manifest: { ...created, ...v2Document("field") },
            expectedRevision: created.revision,
        });
        const fieldDescriptor = layerFor(createWorldResource(fieldSeeded).hash, [published.use.asset]);
        const fieldDigest = await service._visualLayerDescriptors.put(fieldDescriptor);
        const legacy = await service.putEnvironment("field", {
            manifest: { ...fieldSeeded, visualLayer: { descriptorHash: fieldDigest } },
            expectedRevision: fieldSeeded.revision,
        });
        assert.deepEqual(legacy.visualLayer, { descriptorHash: fieldDigest });
        assert.equal("accessHash" in legacy.visualLayer, false);
    });
});

test("rename retains access hashes and rebind copies use selections", async () => {
    await withService(async (service) => {
        const seeded = await seedEnvironment(service);
        const worldHash = createWorldResource(seeded).hash;
        const bytes = makePng();
        const published = await publishAsset(service.visualAssets, bytes, {
            mediaType: "image/png",
            role: "texture",
        });
        const descriptor = layerFor(worldHash, [published.use.asset]);
        const hashes = await service.publishVisualLayer({
            descriptor,
            assetUses: [{ sha256: published.use.asset.sha256, useHash: published.useHash }],
        });
        const referenced = await service.putEnvironment("yard", {
            manifest: {
                ...seeded,
                visualLayer: { descriptorHash: hashes.descriptorHash, accessHash: hashes.accessHash },
            },
            expectedRevision: seeded.revision,
        });
        const renamed = await service.renameEnvironment("yard", {
            name: "North Yard",
            expectedRevision: referenced.revision,
        });
        assert.deepEqual(renamed.visualLayer, referenced.visualLayer);

        const duplicated = await service.duplicateEnvironment("yard", {
            id: "yard-copy",
            name: "Yard Copy",
            expectedRevision: renamed.revision,
        });
        assert.notEqual(duplicated.visualLayer.descriptorHash, hashes.descriptorHash);
        assert.ok(duplicated.visualLayer.accessHash);
        assert.notEqual(duplicated.visualLayer.accessHash, hashes.accessHash);
        const copyAccess = await service._visualLayerAccess.get(duplicated.visualLayer.accessHash);
        assert.deepEqual(copyAccess.assets, [{
            sha256: published.use.asset.sha256,
            useHash: published.useHash,
        }]);
        assert.equal(copyAccess.descriptorHash, duplicated.visualLayer.descriptorHash);
        assert.equal(duplicated.evidence, null);

        const moved = await service.changeEnvironmentId("yard-copy", {
            id: "yard-moved",
            expectedRevision: duplicated.revision,
        });
        assert.notEqual(moved.visualLayer.descriptorHash, duplicated.visualLayer.descriptorHash);
        assert.notEqual(moved.visualLayer.accessHash, duplicated.visualLayer.accessHash);
        const movedAccess = await service._visualLayerAccess.get(moved.visualLayer.accessHash);
        assert.deepEqual(movedAccess.assets, copyAccess.assets);
        assert.equal(movedAccess.descriptorHash, moved.visualLayer.descriptorHash);
        assert.equal(moved.evidence, null);
    });
});

test("identical bytes under owned and restricted uses cannot launder display rights", async () => {
    const sources = [
        ownedGrant("owned-lab"),
        restrictedGrant("restricted-display", {
            permissions: {
                "persistent-cache": true,
                "machine-interpretation": true,
                "retention": true,
            },
        }),
    ];
    await withApi(async ({ client, service, origin }) => {
        const seeded = await seedEnvironment(service);
        const worldHash = createWorldResource(seeded).hash;
        const bytes = makePng();
        const owned = await publishAsset(service.visualAssets, bytes, {
            mediaType: "image/png",
            role: "texture",
            sourceIds: ["owned-lab"],
        });
        const restricted = await publishAsset(service.visualAssets, bytes, {
            mediaType: "image/png",
            role: "texture",
            sourceIds: ["restricted-display"],
        });
        assert.equal(owned.use.asset.sha256, restricted.use.asset.sha256);
        assert.notEqual(owned.useHash, restricted.useHash);
        const descriptor = layerFor(worldHash, [owned.use.asset]);
        const ownedLayer = await client.publish({
            descriptor,
            assetUses: [{ sha256: owned.use.asset.sha256, useHash: owned.useHash }],
        });
        const restrictedLayer = await client.publish({
            descriptor,
            assetUses: [{ sha256: restricted.use.asset.sha256, useHash: restricted.useHash }],
        });
        assert.equal(ownedLayer.descriptorHash, restrictedLayer.descriptorHash);
        assert.notEqual(ownedLayer.accessHash, restrictedLayer.accessHash);

        const allowed = await client.getAccess(ownedLayer.descriptorHash, ownedLayer.accessHash);
        assert.equal(allowed.access.assets[0].useHash, owned.useHash);

        const denied = await fetch(
            `${origin}/api/storage/visual-layers/${restrictedLayer.descriptorHash}/access/${restrictedLayer.accessHash}`,
        );
        assert.equal(denied.status, 403);
        assert.equal((await denied.json()).code, VISUAL_LAYER_ERROR_CODES.RIGHTS_DENIED);

        const digestUrl = await fetch(`${origin}/api/storage/visual-assets/sha256/${owned.use.asset.sha256}`);
        assert.equal(digestUrl.status, 404);
        assert.notEqual(sha256Hex(bytes), owned.useHash);
    }, sources);
});

test("corrupt access sidecars fail closed", async () => {
    await withService(async (service) => {
        const seeded = await seedEnvironment(service);
        const published = await publishAsset(service.visualAssets, makePng(), {
            mediaType: "image/png",
            role: "texture",
        });
        const hashes = await service.publishVisualLayer({
            descriptor: layerFor(createWorldResource(seeded).hash, [published.use.asset]),
            assetUses: [{ sha256: published.use.asset.sha256, useHash: published.useHash }],
        });
        await fs.writeFile(service._visualLayerAccess.pathFor(hashes.accessHash), "{not-json");
        await assert.rejects(() => service._visualLayerAccess.get(hashes.accessHash), /JSON|canonical|digest/i);
    });
});

test("conflicting import rebinds access sidecars with unchanged use selections", async () => {
    const sourceDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-visual-access-src-"));
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-visual-access-dst-"));
    await writeRegistry(sourceDir, [ownedGrant()]);
    await writeRegistry(targetDir, [ownedGrant()]);
    const source = new StorageService(sourceDir, {
        visualAssets: { registryPath: path.join(sourceDir, "visual-source-registry.json") },
    });
    const target = new StorageService(targetDir, {
        visualAssets: { registryPath: path.join(targetDir, "visual-source-registry.json") },
    });
    try {
        const created = await source.createEnvironment({ id: "yard", name: "Source Yard" });
        const seeded = await source.putEnvironment("yard", {
            manifest: { ...created, ...v2Document("yard") },
            expectedRevision: created.revision,
        });
        const png = makePng();
        const published = await publishAsset(source.visualAssets, png, {
            mediaType: "image/png",
            role: "texture",
        });
        await publishAsset(target.visualAssets, png, {
            mediaType: "image/png",
            role: "texture",
        });
        const hashes = await source.publishVisualLayer({
            descriptor: layerFor(createWorldResource(seeded).hash, [published.use.asset]),
            assetUses: [{ sha256: published.use.asset.sha256, useHash: published.useHash }],
        });
        const referenced = await source.putEnvironment("yard", {
            manifest: {
                ...seeded,
                visualLayer: { descriptorHash: hashes.descriptorHash, accessHash: hashes.accessHash },
            },
            expectedRevision: seeded.revision,
        });
        await source.createRunManifest(createDefaultRunManifest({
            id: "portable",
            environment: { id: "yard", expectedHash: null },
        }));
        const bundle = await source.exportRunManifest("portable");
        bundle.resolved.environment.manifest = referenced;

        await target.createEnvironment({ id: "yard", name: "Different Yard" });
        await target._visualLayerDescriptors.put(
            await source._visualLayerDescriptors.get(hashes.descriptorHash),
        );
        await assert.rejects(() => target.importRunBundle(bundle), /access/i);

        await target._visualLayerAccess.put(
            await source._visualLayerAccess.get(hashes.accessHash),
        );
        const imported = await target.importRunBundle(bundle);
        const importedEnv = await target.getEnvironment(imported.environment.id);
        assert.notEqual(importedEnv.visualLayer.descriptorHash, hashes.descriptorHash);
        assert.notEqual(importedEnv.visualLayer.accessHash, hashes.accessHash);
        const reboundAccess = await target._visualLayerAccess.get(importedEnv.visualLayer.accessHash);
        assert.deepEqual(reboundAccess.assets, [{
            sha256: published.use.asset.sha256,
            useHash: published.useHash,
        }]);
        assert.equal(importedEnv.evidence, null);
    } finally {
        await fs.rm(sourceDir, { recursive: true, force: true });
        await fs.rm(targetDir, { recursive: true, force: true });
    }
});

