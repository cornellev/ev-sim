import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { EnvironmentRegistry } from "../app/3d/editor/EnvironmentRegistry.js";
import { SceneProjector } from "../app/3d/editor/projection/SceneProjector.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { deltaFromTranslation } from "../app/3d/editor/objects/transformDelta.js";

function record(revision = 1) {
    return {
        id: "asset-1", typeId: "asset-instance", typeVersion: 1, name: "Crate", parentId: null, order: 0,
        components: {
            tags: [], locked: false, editorHidden: false,
            asset: { assetId: "crate", revision, position: { x: 1, y: 2, z: 3 }, rotationY: 0, scale: { x: 1, y: 1, z: 1 }, overrides: {} },
        },
    };
}

function tick() {
    return new Promise((resolve) => setImmediate(resolve));
}

test("ED-06 projector loads, transforms, picks, and releases editor-only assets outside chunks and manifests", async () => {
    const scene = new THREE.Scene();
    const document = new EnvironmentDocument({ objects: [record()] });
    let chunkAssignments = 0;
    const registry = new EnvironmentRegistry({ chunkManager: { assignEntity() { chunkAssignments += 1; return null; }, listChunks() { return []; } } });
    const notificationFlags = [];
    registry.subscribe((_snapshot, event) => notificationFlags.push(event.affectsPersistence));
    let releases = 0;
    const models = {
        async acquire(modelUseHash, options) {
            const root = new THREE.Group();
            root.userData.cevSimVisualPreviewOnly = true;
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
            mesh.userData.cevSimVisualPreviewOnly = true;
            root.add(mesh);
            return { root, localBounds: new THREE.Box3().setFromObject(root), release() { releases += 1; } };
        },
        async acquireRevision(revision, options) {
            return models.acquire(revision.modelUseHash, options);
        },
    };
    const runtime = { editorAssets: { repository: { async getRevision() { return { modelUseHash: "a".repeat(64) }; } }, models } };
    const projector = new SceneProjector({ data: { simulation: () => ({ render() {} }) }, scene, document, registry, runtime }).attach();
    projector.setEditorAssetsEnabled(true);
    await projector.whenAssetInstancesIdle();
    const entity = registry.getEntity("asset:asset-1");
    assert.equal(entity.editorOnly, true);
    assert.equal(entity.object3D.position.x, 1);
    assert.equal(chunkAssignments, 0);
    assert.deepEqual(registry.toManifest(), { objects: {} });
    assert.equal(registry.findEntityFromObject3D(entity.object3D.children[0]), entity);
    assert.equal(notificationFlags.at(-1), false);

    const service = createEnvironmentCommandService({ document });
    const movedRoot = entity.object3D;
    assert.equal(service.run("transformObjects", { objectIds: ["asset-1"], delta: deltaFromTranslation({ x: 4, z: -1 }) }).ok, true);
    assert.equal(registry.getEntity("asset:asset-1").object3D, movedRoot);
    assert.deepEqual(movedRoot.position.toArray(), [5, 2, 2]);

    projector.setEditorAssetsEnabled(false);
    assert.equal(registry.getEntity("asset:asset-1"), null);
    assert.equal(scene.children.includes(movedRoot), false);
    assert.equal(releases, 1);
    projector.dispose();
});

test("ED-06 delayed completion cannot resurrect a deleted asset instance", async () => {
    const scene = new THREE.Scene();
    const document = new EnvironmentDocument({ objects: [record()] });
    const registry = new EnvironmentRegistry();
    let resolveRevision;
    const revision = new Promise((resolve) => { resolveRevision = resolve; });
    let acquisitions = 0;
    const runtime = { editorAssets: {
        repository: { getRevision() { return revision; } },
        models: { async acquire() { acquisitions += 1; return { root: new THREE.Group(), localBounds: new THREE.Box3(), release() {} }; }, async acquireRevision(revision, options) { return this.acquire(revision.modelUseHash, options); } },
    } };
    const projector = new SceneProjector({ scene, document, registry, runtime }).attach();
    projector.setEditorAssetsEnabled(true);
    const idle = projector.whenAssetInstancesIdle();
    const service = createEnvironmentCommandService({ document });
    assert.equal(service.run("deleteObjects", { objectIds: ["asset-1"] }).ok, true);
    resolveRevision({ modelUseHash: "b".repeat(64) });
    await idle;
    await tick();
    assert.equal(acquisitions, 0);
    assert.equal(registry.getEntity("asset:asset-1"), null);
    assert.equal(scene.children.length, 0);
    projector.dispose();
});

test("ED-06 projector applies v2 appearance maps onto the compiled mesh lease", async () => {
    const scene = new THREE.Scene();
    const document = new EnvironmentDocument({ objects: [record(2)] });
    const registry = new EnvironmentRegistry();
    const map = {
        isTexture: true, sourceId: "albedo",
        clone() {
            return { isTexture: true, sourceId: "albedo", offset: { set() {} }, repeat: { set() {} }, colorSpace: null, flipY: true, matrixAutoUpdate: false, needsUpdate: false, dispose() {} };
        },
    };
    const models = {
        async acquire() {
            const root = new THREE.Group();
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ name: "mat-a" }));
            root.add(mesh);
            return { root, localBounds: new THREE.Box3().setFromObject(root), release() {} };
        },
        async acquireRevision(revision, options) {
            const lease = await models.acquire(revision.modelUseHash, options);
            if (revision.version !== 2) return lease;
            lease.root.children[0].material = new THREE.MeshBasicMaterial({ name: "mat-a", map });
            return lease;
        },
    };
    const runtime = {
        editorAssets: {
            repository: {
                async getRevision() {
                    return {
                        version: 2, modelUseHash: "a".repeat(64),
                        appearance: [{ id: "mat-a", textures: [{ slot: "baseColor", useHash: "t".repeat(64) }] }],
                    };
                },
            },
            models,
        },
    };
    const projector = new SceneProjector({ data: { simulation: () => ({ render() {} }) }, scene, document, registry, runtime }).attach();
    projector.setEditorAssetsEnabled(true);
    await projector.whenAssetInstancesIdle();
    const mesh = registry.getEntity("asset:asset-1").object3D.children[0];
    assert.equal(mesh.material.map.sourceId, "albedo");
    projector.dispose();
});

function tileRecord() {
    return {
        id: "tile", typeId: "tile", typeVersion: 2, name: "GLTF Tile", parentId: null, order: 0,
        components: {
            tags: [], locked: false, editorHidden: false,
            asset: { assetId: "base", revision: 1, position: { x: 2, y: 3, z: 4 }, rotationY: 0.25, scale: { x: 2, y: 1, z: 0.5 }, overrides: {} },
            tile: { provider: "gltf", assetTypeVersion: 1 },
        },
    };
}

function stubRuntime({ getRevision, acquireRevision } = {}) {
    const models = {
        async acquire() {
            const root = new THREE.Group();
            root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
            return { root, localBounds: new THREE.Box3().setFromObject(root), release() {} };
        },
        async acquireRevision(revision, options) {
            if (acquireRevision) return acquireRevision(revision, options);
            return models.acquire(revision.modelUseHash, options);
        },
    };
    return {
        editorAssets: {
            repository: {
                getRevision: getRevision ?? (async () => ({ modelUseHash: "a".repeat(64) })),
            },
            models,
        },
    };
}

test("whenIdle resolves after a delayed revision fetch and parents the root", async () => {
    const scene = new THREE.Scene();
    const document = new EnvironmentDocument({ objects: [record()] });
    const registry = new EnvironmentRegistry();
    let resolveRevision;
    const revision = new Promise((resolve) => { resolveRevision = resolve; });
    const projector = new SceneProjector({
        data: { simulation: () => ({ render() {} }) },
        scene, document, registry, runtime: stubRuntime({ getRevision: () => revision }),
    }).attach();
    projector.setEditorAssetsEnabled(true);
    const idle = projector.whenAssetInstancesIdle();
    let settled = false;
    idle.then(() => { settled = true; });
    await tick();
    assert.equal(settled, false);
    assert.equal(registry.getEntity("asset:asset-1"), null);
    resolveRevision({ modelUseHash: "a".repeat(64) });
    await idle;
    assert.equal(settled, true);
    const entity = registry.getEntity("asset:asset-1");
    assert.equal(projector.assetInstanceEntries().get("asset-1").status, "ready");
    assert.equal(scene.children.includes(entity.object3D), true);
    projector.dispose();
});

test("whenIdle waits for GLTF tiles while editor instances stay disabled", async () => {
    const scene = new THREE.Scene();
    const document = new EnvironmentDocument({ objects: [record(), tileRecord()] });
    const registry = new EnvironmentRegistry();
    const projector = new SceneProjector({
        data: { simulation: () => ({ render() {} }) },
        scene, document, registry, runtime: stubRuntime(),
    }).attach();
    projector.syncAssetInstances();
    await projector.whenAssetInstancesIdle();
    assert.equal(registry.getEntity("asset:asset-1"), null);
    const tile = registry.getEntity("asset:tile");
    assert.equal(tile.kind, "tile");
    assert.equal(tile.editorOnly, false);
    assert.equal(scene.children.includes(tile.object3D), true);
    assert.equal(projector.assetInstanceEntries().has("asset-1"), false);
    projector.dispose();
});

test("whenIdle fulfills when a revision fetch fails", async () => {
    const scene = new THREE.Scene();
    const document = new EnvironmentDocument({ objects: [record()] });
    const registry = new EnvironmentRegistry();
    const projector = new SceneProjector({
        data: { simulation: () => ({ render() {} }) },
        scene, document, registry,
        runtime: stubRuntime({ getRevision: async () => { throw new Error("missing revision"); } }),
    }).attach();
    projector.setEditorAssetsEnabled(true);
    await projector.whenAssetInstancesIdle();
    const entry = projector.assetInstanceEntries().get("asset-1");
    assert.equal(entry.status, "error");
    assert.equal(entry.error.message, "missing revision");
    assert.equal(registry.getEntity("asset:asset-1"), null);
    projector.dispose();
});
