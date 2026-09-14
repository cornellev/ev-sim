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

test("ED-06 model loader fails closed when a glTF texture dependency decodes to null", async () => {
    const bytes = new Uint8Array([1]);
    const digest = sha256ExactBytes(bytes);
    class FakeGLTFLoader {
        async parseAsync() {
            return {
                scene: new THREE.Group(),
                parser: {
                    json: { textures: [{}] },
                    async getDependencies() { return [null]; },
                },
            };
        }
    }
    const loader = new AssetModelLoader({
        THREE,
        GLTFLoader: FakeGLTFLoader,
        assetClient: {
            async validateClosure() {},
            async getUse() { return { asset: { sha256: digest, sizeBytes: 1, mediaType: "model/gltf-binary", role: "mesh" }, dependencies: {} }; },
            async getUseContent() { return { bytes, mediaType: "model/gltf-binary" }; },
        },
    });
    await assert.rejects(() => loader.acquire("f".repeat(64)), /texture failed to decode/);
    assert.equal(loader.entries.size, 0);
});

test("ED-06 acquireRevision keeps v1 source materials and binds v2 appearance maps", async () => {
    const modelBytes = new Uint8Array([1, 2, 3]);
    const textureBytes = new Uint8Array([4, 5, 6]);
    const modelDigest = sha256ExactBytes(modelBytes);
    const textureDigest = sha256ExactBytes(textureBytes);
    const modelUse = "1".repeat(64);
    const textureUse = "2".repeat(64);
    const uses = {
        [modelUse]: { asset: { sha256: modelDigest, sizeBytes: 3, mediaType: "model/gltf-binary", role: "mesh" }, dependencies: {} },
        [textureUse]: { asset: { sha256: textureDigest, sizeBytes: 3, mediaType: "image/png", role: "texture" }, dependencies: {} },
    };
    const contents = {
        [modelUse]: { bytes: modelBytes, mediaType: "model/gltf-binary" },
        [textureUse]: { bytes: textureBytes, mediaType: "image/png" },
    };
    const fakeMap = () => ({
        isTexture: true,
        sourceId: "albedo",
        offset: { set() {} },
        repeat: { set() {} },
        colorSpace: null,
        flipY: true,
        matrixAutoUpdate: false,
        needsUpdate: false,
        clone() { return fakeMap(); },
        dispose() { this.disposed = true; },
    });
    const loader = new AssetModelLoader({
        THREE,
        assetClient: {
            async validateClosure() {},
            async getUse(useHash) { return uses[useHash]; },
            async getUseContent(useHash) { return contents[useHash]; },
        },
        async parseGltf() {
            const root = new THREE.Group();
            root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ name: "mat-a" })));
            return { scene: root };
        },
        async decodeTexture() { return fakeMap(); },
    });
    const v1 = await loader.acquireRevision({ version: 1, modelUseHash: modelUse });
    assert.equal(v1.root.children[0].material.map, null);
    v1.release();

    const appearance = [{
        id: "mat-a",
        mode: "unlit-captured-radiance",
        alphaMode: "OPAQUE",
        alphaCutoff: 0.5,
        doubleSided: false,
        parameters: {
            baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1,
            emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1,
            occlusionStrength: 1, clearcoatFactor: 0, clearcoatRoughnessFactor: 0,
            sheenColorFactor: [0, 0, 0], sheenRoughnessFactor: 0,
            specularFactor: 1, specularColorFactor: [1, 1, 1],
        },
        textures: [{
            slot: "baseColor", assetUri: `sha256:${textureDigest}`, useHash: textureUse, texCoord: 0,
            transform: { offset: [0, 0], rotation: 0, scale: [1, 1] },
        }],
        extensions: ["KHR_materials_unlit"],
    }];
    const v2 = await loader.acquireRevision({ version: 2, modelUseHash: modelUse, appearance });
    assert.equal(v2.root.children[0].material.type, "MeshBasicMaterial");
    assert.equal(v2.root.children[0].material.map.sourceId, "albedo");
    v2.release();
});
