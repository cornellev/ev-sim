import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { applyPublishedAppearance } from "../app/3d/editor/assets/applyPublishedAppearance.js";
import { VISUAL_PREVIEW_ERROR_CODES } from "../app/simulation/visual/VisualLayer.js";

const PARAMETERS = {
    baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9,
    emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1,
    occlusionStrength: 1, clearcoatFactor: 0, clearcoatRoughnessFactor: 0,
    sheenColorFactor: [0, 0, 0], sheenRoughnessFactor: 0,
    specularFactor: 1, specularColorFactor: [1, 1, 1],
};

function fakeTexture(id) {
    return {
        isTexture: true,
        id,
        disposed: false,
        colorSpace: null,
        flipY: true,
        channel: 0,
        offset: { x: 0, y: 0, set(x, y) { this.x = x; this.y = y; } },
        rotation: 0,
        repeat: { x: 1, y: 1, set(x, y) { this.x = x; this.y = y; } },
        matrixAutoUpdate: false,
        needsUpdate: false,
        clone() {
            const next = fakeTexture(`${id}-clone`);
            next.sourceId = id;
            return next;
        },
        dispose() { this.disposed = true; },
    };
}

function unlitDescriptor(id, useHash) {
    return {
        id,
        mode: "unlit-captured-radiance",
        alphaMode: "OPAQUE",
        alphaCutoff: 0.5,
        doubleSided: false,
        parameters: structuredClone(PARAMETERS),
        textures: [{
            slot: "baseColor",
            assetUri: `sha256:${"a".repeat(64)}`,
            useHash,
            texCoord: 0,
            transform: { offset: [0, 0], rotation: 0, scale: [1, 1] },
        }],
        extensions: ["KHR_materials_unlit"],
    };
}

test("published appearance binds per-material unlit maps and disposes replacements", () => {
    const root = new THREE.Group();
    const meshA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ name: "mat-a" }));
    const meshB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ name: "mat-b" }));
    root.add(meshA, meshB);
    const texA = fakeTexture("a");
    const texB = fakeTexture("b");
    const dispose = applyPublishedAppearance({
        root,
        THREE,
        appearance: [unlitDescriptor("mat-a", "use-a"), unlitDescriptor("mat-b", "use-b")],
        texturesByUseHash: new Map([["use-a", texA], ["use-b", texB]]),
    });
    assert.equal(meshA.material.type, "MeshBasicMaterial");
    assert.equal(meshB.material.type, "MeshBasicMaterial");
    assert.equal(meshA.material.map.sourceId, "a");
    assert.equal(meshB.material.map.sourceId, "b");
    assert.notEqual(meshA.material.map, meshB.material.map);
    const maps = [meshA.material.map, meshB.material.map];
    dispose();
    assert.equal(maps.every((texture) => texture.disposed), true);
});

test("published appearance fails closed when a declared texture use is missing", () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ name: "mat-a" }));
    const original = mesh.material;
    assert.throws(
        () => applyPublishedAppearance({
            root: mesh,
            THREE,
            appearance: [unlitDescriptor("mat-a", "missing")],
            texturesByUseHash: new Map(),
        }),
        (error) => error.code === VISUAL_PREVIEW_ERROR_CODES.ASSET_MISSING,
    );
    assert.equal(mesh.material, original);
});
