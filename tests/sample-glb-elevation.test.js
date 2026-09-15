import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { collectGlbMeshes, sampleVerticalGlbElevation } from "../app/3d/editor/tools/sampleGlbElevation.js";
import { VISUAL_PREVIEW_USERDATA } from "../app/3d/environment/visual/VisualPreviewIsolation.js";

function boxMesh({ x = 0, y = 0, z = 0, height = 2, width = 10 } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, width), new THREE.MeshBasicMaterial());
    mesh.position.set(x, y, z);
    mesh.updateMatrixWorld(true);
    return mesh;
}

function registryFrom(entities) {
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    return {
        listEntities: () => entities.map(({ object3D, ...summary }) => summary),
        getEntity: (id) => byId.get(id) ?? null,
    };
}

test("collectGlbMeshes keeps tile and asset-instance meshes and ignores roads and previews", () => {
    const tile = boxMesh({ y: 5 });
    const road = boxMesh({ y: 100 });
    const preview = boxMesh({ y: 50 });
    preview.userData[VISUAL_PREVIEW_USERDATA.previewOnly] = true;
    const meshes = collectGlbMeshes(registryFrom([
        { id: "asset:tile", kind: "tile", visible: true, object3D: tile },
        { id: "road:e", kind: "road", visible: true, object3D: road },
        { id: "asset:preview", kind: "asset-instance", visible: true, object3D: preview },
        { id: "asset:hidden", kind: "asset-instance", visible: false, object3D: boxMesh({ y: 8 }) },
    ]));
    assert.equal(meshes.length, 1);
    assert.equal(meshes[0], tile);
});

test("sampleVerticalGlbElevation picks the hit closest to the current control-point Y", () => {
    const ground = boxMesh({ y: 2, height: 2 });
    const overpass = boxMesh({ y: 20, height: 2 });
    const meshes = [ground, overpass];
    const nearGround = sampleVerticalGlbElevation(meshes, { x: 0, z: 0, y: 0 });
    const nearOverpass = sampleVerticalGlbElevation(meshes, { x: 0, z: 0, y: 18 });
    assert.ok(nearGround > 0.5 && nearGround < 3.5, `expected ground hit, got ${nearGround}`);
    assert.ok(nearOverpass > 18 && nearOverpass < 22, `expected overpass hit, got ${nearOverpass}`);
    assert.equal(sampleVerticalGlbElevation(meshes, { x: 40, z: 40, y: 0 }), null);
});
