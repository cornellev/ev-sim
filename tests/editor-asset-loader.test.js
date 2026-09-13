import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { AssetModelLoader } from "../app/3d/editor/assets/AssetModelLoader.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";

test("ED-06 model loader validates bytes, deduplicates decoding, strips user data, and disposes at final release", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = sha256ExactBytes(bytes);
    const useHash = "c".repeat(64);
    let reads = 0;
    let parses = 0;
    let disposals = 0;
    const assetClient = {
        async validateClosure() { return { ok: true }; },
        async getUse() { return { asset: { sha256: digest, sizeBytes: bytes.length, mediaType: "model/gltf-binary", role: "mesh" }, dependencies: {} }; },
        async getUseContent() { reads += 1; return { bytes, mediaType: "model/gltf-binary" }; },
    };
    const loader = new AssetModelLoader({
        THREE,
        assetClient,
        async parseGltf() {
            parses += 1;
            const root = new THREE.Group();
            root.userData = { hostile: true };
            const geometry = new THREE.BoxGeometry(1, 1, 1);
            const originalDispose = geometry.dispose.bind(geometry);
            geometry.dispose = () => { disposals += 1; originalDispose(); };
            const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
            mesh.userData = { truthId: "bad" };
            root.add(mesh);
            return { scene: root };
        },
    });
    const [left, right] = await Promise.all([loader.acquire(useHash), loader.acquire(useHash)]);
    assert.equal(reads, 1);
    assert.equal(parses, 1);
    assert.notEqual(left.root, right.root);
    assert.deepEqual(left.root.userData, { cevSimVisualPreviewOnly: true });
    assert.deepEqual(left.root.children[0].userData, { cevSimVisualPreviewOnly: true });
    assert.ok(left.localBounds.getSize(new THREE.Vector3()).length() > 0);
    left.release();
    assert.equal(disposals, 0);
    right.release();
    assert.equal(disposals, 1);
});

test("ED-06 model loader rejects corrupt bytes and decoder failures without caching them", async () => {
    const bytes = new Uint8Array([9]);
    const assetClient = {
        async validateClosure() {},
        async getUse() { return { asset: { sha256: "0".repeat(64), sizeBytes: 1, mediaType: "model/gltf-binary", role: "mesh" }, dependencies: {} }; },
        async getUseContent() { return { bytes, mediaType: "model/gltf-binary" }; },
    };
    const corrupt = new AssetModelLoader({ THREE, assetClient, async parseGltf() { throw new Error("should not parse"); } });
    await assert.rejects(() => corrupt.acquire("d".repeat(64)), /identity verification/);
    assert.equal(corrupt.entries.size, 0);

    const digest = sha256ExactBytes(bytes);
    assetClient.getUse = async () => ({ asset: { sha256: digest, sizeBytes: 1, mediaType: "model/gltf-binary", role: "mesh" }, dependencies: {} });
    const failed = new AssetModelLoader({ THREE, assetClient, async parseGltf() { throw new Error("decoder failed"); } });
    await assert.rejects(() => failed.acquire("e".repeat(64)), /decoder failed/);
    assert.equal(failed.entries.size, 0);
});
