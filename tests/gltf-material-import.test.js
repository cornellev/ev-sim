import assert from "node:assert/strict";
import test from "node:test";

import { Z_UP_ORIENTATION, orientationId } from "../app/editor-assets/AssetOrientation.js";
import { validateAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { materialsFromGltf } from "../app/editor-assets/GltfMaterialImport.js";
import { createImportedAssetDefinition } from "../app/3d/editor/assets/AssetModelLoader.js";

const DIGEST = "ab".repeat(32);
const USE_HASH = "cd".repeat(32);

test("MESH-04 glTF materials keep factors, textures, and sub-1 alpha as MASK", () => {
    const json = {
        materials: [
            {
                name: "paint",
                pbrMetallicRoughness: {
                    baseColorFactor: [0.2, 0.4, 0.6, 0.25],
                    metallicFactor: 0,
                    roughnessFactor: 0.75,
                    baseColorTexture: { index: 0, texCoord: 0 },
                },
            },
            { name: "glass", alphaMode: "BLEND", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } },
        ],
        textures: [{ source: 0 }],
        images: [{ uri: `sha256:${DIGEST}` }],
        nodes: [{ mesh: 0 }, { name: "empty" }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    };
    const imported = materialsFromGltf(json, { [`sha256:${DIGEST}`]: USE_HASH });
    assert.equal(imported.materials[0].id, "paint");
    assert.equal(imported.materials[0].alphaMode, "MASK");
    assert.equal(imported.materials[0].alphaCutoff, 0.5);
    assert.deepEqual(imported.materials[0].parameters.baseColorFactor, [0.2, 0.4, 0.6, 0.25]);
    assert.equal(imported.materials[0].parameters.metallicFactor, 0);
    assert.equal(imported.materials[0].parameters.roughnessFactor, 0.75);
    assert.equal(imported.materials[0].textures[0].slot, "baseColor");
    assert.equal(imported.materials[0].textures[0].useHash, USE_HASH);
    assert.equal(imported.materials[0].textures[0].assetUri, `sha256:${DIGEST}`);
    assert.equal(imported.materials[1].alphaMode, "MASK");
    assert.equal(imported.materialIdByNode.get(0), "paint");
    assert.equal(imported.materialIdByNode.has(1), false);

    const definition = createImportedAssetDefinition({
        lease: { gltfJson: json, dependencies: { [`sha256:${DIGEST}`]: USE_HASH }, root: { traverse() {} } },
        modelUseHash: "a".repeat(64),
        name: "Crate",
    });
    assert.equal(definition.parts[0].materialBindings.default, "paint");
    assert.deepEqual(validateAssetDefinition(definition), []);
    assert.equal(createImportedAssetDefinition({
        lease: { root: { traverse() {} } },
        modelUseHash: "b".repeat(64),
    }).materials.length, 0);
    assert.equal(orientationId(Z_UP_ORIENTATION), "z-up");
    assert.ok(Math.abs(Math.hypot(...Z_UP_ORIENTATION) - 1) <= 1e-6);
});
