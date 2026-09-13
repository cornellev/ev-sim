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
        async acquire() {
            const root = new THREE.Group();
            root.userData.cevSimVisualPreviewOnly = true;
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
            mesh.userData.cevSimVisualPreviewOnly = true;
            root.add(mesh);
            return { root, localBounds: new THREE.Box3().setFromObject(root), release() { releases += 1; } };
        },
    };
    const runtime = { editorAssets: { repository: { async getRevision() { return { modelUseHash: "a".repeat(64) }; } }, models } };
    const projector = new SceneProjector({ data: { simulation: () => ({ render() {} }) }, scene, document, registry, runtime }).attach();
    projector.setEditorAssetsEnabled(true);
    await tick();
    await tick();
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
        models: { async acquire() { acquisitions += 1; return { root: new THREE.Group(), localBounds: new THREE.Box3(), release() {} }; } },
    } };
    const projector = new SceneProjector({ scene, document, registry, runtime }).attach();
    projector.setEditorAssetsEnabled(true);
    const service = createEnvironmentCommandService({ document });
    assert.equal(service.run("deleteObjects", { objectIds: ["asset-1"] }).ok, true);
    resolveRevision({ modelUseHash: "b".repeat(64) });
    await tick();
    assert.equal(acquisitions, 0);
    assert.equal(registry.getEntity("asset:asset-1"), null);
    assert.equal(scene.children.length, 0);
    projector.dispose();
});
