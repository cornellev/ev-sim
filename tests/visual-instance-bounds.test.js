import assert from "node:assert/strict";
import test from "node:test";

import { compileAssetVisualLayer } from "../app/editor-assets/AssetVisualLayerCompiler.js";
import { VisualChunkResidencyController } from "../app/3d/environment/visual/VisualChunkResidencyController.js";
import { glbTriangleBounds } from "../app/simulation/visual/GlbBounds.js";
import {
    assertVisualLayer,
    hashVisualLayer,
} from "../app/simulation/visual/VisualLayer.js";
import { buildGlb, makeTriangleGlb, triangleGltfJson } from "./helpers/visual-assets.js";

const DIGEST = "a".repeat(64);
const MODEL_DIGEST = "b".repeat(64);
const WORLD_HASH = "c".repeat(64);

function tileRecord(x = 0) {
    return {
        id: "tile",
        typeId: "tile",
        typeVersion: 2,
        components: {
            tile: { provider: "gltf", assetTypeVersion: 2 },
            asset: {
                assetId: "asset-1",
                revision: 1,
                position: { x, y: 0, z: 0 },
                rotationY: 0,
                scale: { x: 1, y: 1, z: 1 },
            },
        },
    };
}

function compile(meshBounds, x = 0) {
    return compileAssetVisualLayer({
        world: { hash: WORLD_HASH, description: { assetProxies: [] } },
        inputs: [{
            record: tileRecord(x),
            revision: { version: 2, modelUseHash: DIGEST, appearance: [] },
            ...(meshBounds ? { meshBounds } : {}),
        }],
        closureUses: [{
            useHash: DIGEST,
            use: {
                asset: {
                    sha256: MODEL_DIGEST,
                    mediaType: "model/gltf-binary",
                    sizeBytes: 4,
                    role: "mesh",
                },
                dependencies: {},
                sourceIds: ["owned"],
            },
        }],
    }).description;
}

test("published triangle bounds follow node matrices", () => {
    const identity = glbTriangleBounds(makeTriangleGlb());
    assert.deepEqual(identity, { min: [0, 0, 0], max: [1, 1, 0] });

    const json = triangleGltfJson();
    json.nodes[0].matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 0, 0, 1];
    const moved = glbTriangleBounds(buildGlb(json));
    assert.deepEqual(moved.min, [100, 0, 0]);
    assert.deepEqual(moved.max, [101, 1, 0]);

    delete json.accessors[0].min;
    assert.throws(() => glbTriangleBounds(buildGlb(json)), /min and max/);
});

test("compiled asset instances carry world bounds and omit them when unknown", () => {
    const plain = compile();
    assert.equal(Object.hasOwn(plain.instances[0], "bounds"), false);
    const shifted = compile({ min: [0, 0, 0], max: [1, 2, 3] }, 10);
    assert.deepEqual(shifted.instances[0].bounds, { min: [10, 0, 0], max: [11, 2, 3] });
    assertVisualLayer(shifted);
    assert.notEqual(hashVisualLayer(plain), hashVisualLayer(shifted));
    assert.throws(() => compile({ min: [2, 0, 0], max: [1, 0, 0] }), /min must not exceed max/);
});

test("residency admits a camera inside mesh bounds far from the instance origin", () => {
    const uri = `sha256:${DIGEST}`;
    const controller = new VisualChunkResidencyController({
        requiredRadiusMeters: 100,
        prefetchRadiusMeters: 120,
        maxResidentChunks: 4,
    });
    const base = {
        chunks: [{ id: "asset-chunk:tile", instanceIds: ["asset:tile"] }],
        instances: [{
            id: "asset:tile",
            lodLevels: [uri, `sha256:${"d".repeat(64)}`, `sha256:${"e".repeat(64)}`],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        }],
    };
    const camera = { x: -136.6, y: -8.5, z: 13.2 };
    const unloaded = controller.plan(base, { position: camera });
    assert.equal(unloaded.required.length, 0);
    assert.equal(unloaded.prefetch.length, 0);
    assert.equal(unloaded.selectedLods["asset:tile"].index, 1);

    const covered = controller.plan({
        ...base,
        instances: [{
            ...base.instances[0],
            bounds: { min: [-168, -33, -136], max: [128, 61, 159] },
        }],
    }, { position: camera });
    assert.deepEqual(covered.required.map((chunk) => chunk.id), ["asset-chunk:tile"]);
    assert.equal(covered.selectedLods["asset:tile"].index, 0);
    assert.equal(covered.selectedLods["asset:tile"].distance, 0);
});
