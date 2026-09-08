import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import test from "node:test";

import { VISUAL_ASSET_ERROR_CODES } from "../server/storage/StorageErrors.js";
import { inspectKtx2, inspectPng } from "../server/storage/visual-assets/mediaInspectors.js";
import { resolveVisualAssetLimits } from "../server/storage/VisualAssetLimits.js";
import {
    createAssetStore,
    buildGlb,
    makeHostileGlb,
    makeJpeg,
    makeKtx2,
    makePng,
    makeTriangleGlb,
    publishAsset,
    sha256Hex,
    triangleGltfJson,
} from "./helpers/visual-assets.js";

const limits = resolveVisualAssetLimits({
    publishedBytes: 8 * 1024 * 1024,
    stagingBytes: 4 * 1024 * 1024,
    decodedClosureBytes: 8 * 1024 * 1024,
});

async function withStore(fn, options = {}) {
    const { dir, store } = await createAssetStore({ limits, ...options });
    try {
        return await fn(store, dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

test("G-SECURITY publishes valid PNG JPEG KTX2 and GLB and rejects hostile graphs", async () => {
    await withStore(async (store) => {
        const png = await publishAsset(store, makePng(), { mediaType: "image/png", role: "texture" });
        const jpeg = await publishAsset(store, makeJpeg(), { mediaType: "image/jpeg", role: "texture" });
        const ktx = await publishAsset(store, makeKtx2(), { mediaType: "image/ktx2", role: "texture" });
        const glb = await publishAsset(store, makeTriangleGlb(), { mediaType: "model/gltf-binary", role: "mesh" });
        assert.equal(png.use.asset.role, "texture");
        assert.equal(jpeg.validation.inspected.width, 1);
        assert.equal(ktx.validation.inspected.mipLevels, 1);
        assert.equal(glb.use.asset.mediaType, "model/gltf-binary");

        const cases = [
            ["http uri", makeHostileGlb((json) => { json.buffers[0].uri = "http://evil.example/x.bin"; }), "INVALID_GRAPH"],
            ["file uri", makeHostileGlb((json) => { json.buffers[0].uri = "file:///etc/passwd"; }), "INVALID_GRAPH"],
            ["relative uri", makeHostileGlb((json) => { json.buffers[0].uri = "../secret.bin"; }), "INVALID_GRAPH"],
            ["blob uri", makeHostileGlb((json) => { json.images = [{ uri: "blob:abc" }]; }), "INVALID_GRAPH"],
            ["extras", makeHostileGlb((json) => { json.nodes[0].extras = { truthId: "building-1" }; }), "INVALID_GRAPH"],
            ["animation", makeHostileGlb((json) => { json.animations = [{ channels: [], samplers: [] }]; }), "INVALID_GRAPH"],
            ["skins", makeHostileGlb((json) => { json.skins = [{ joints: [0] }]; }), "INVALID_GRAPH"],
            ["morph", makeHostileGlb((json) => { json.meshes[0].primitives[0].targets = [{ POSITION: 0 }]; }), "INVALID_GRAPH"],
            ["blend", makeHostileGlb((json) => { json.materials = [{ alphaMode: "BLEND" }]; }), "INVALID_GRAPH"],
            ["extension", makeHostileGlb((json) => { json.extensionsRequired = ["KHR_materials_transmission"]; }), "INVALID_GRAPH"],
            ["nonfinite", makeHostileGlb((json) => { json.nodes[0].translation = [1, 1e400, 0]; }), "INVALID_GRAPH"],
        ];
        for (const [name, bytes, code] of cases) {
            await assert.rejects(
                () => publishAsset(store, bytes, { mediaType: "model/gltf-binary", role: "mesh" }),
                (error) => error.code === VISUAL_ASSET_ERROR_CODES[code] || error.code === `VISUAL_ASSET_${code}`,
                name,
            );
        }
    });
});

test("G-SECURITY rejects MIME mismatch, digest mismatch, oversized textures, and malformed accessors", async () => {
    await withStore(async (store) => {
        const png = makePng();
        await assert.rejects(
            () => publishAsset(store, png, { mediaType: "model/gltf-binary", role: "mesh" }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.INVALID_MEDIA,
        );
        const upload = await store.createUpload({
            asset: { sha256: "b".repeat(64), mediaType: "image/png", sizeBytes: png.length, role: "texture" },
            sourceIds: ["owned-lab"],
            dependencies: {},
        });
        await assert.rejects(
            () => store.writeUploadContent(upload.id, png, { contentLength: png.length }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.INVALID_METADATA,
        );
        assert.throws(
            () => inspectPng(makePng({ width: 9000, height: 8 }), limits),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
        );
        const deep = makeHostileGlb((json) => {
            json.nodes = Array.from({ length: 65 }, (_, index) => (
                index === 64 ? { mesh: 0 } : { children: [index + 1] }
            ));
            json.scenes = [{ nodes: [0] }];
        });
        await assert.rejects(
            () => publishAsset(store, deep, { mediaType: "model/gltf-binary", role: "mesh" }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE
                || error.code === VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
        );
        const overflow = makeHostileGlb((json) => {
            json.bufferViews[0].byteLength = 999999;
            json.accessors[0].count = Number.MAX_SAFE_INTEGER;
        });
        await assert.rejects(
            () => publishAsset(store, overflow, { mediaType: "model/gltf-binary", role: "mesh" }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH
                || error.code === VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
        );
    });
});

test("G-SECURITY rejects corrupt CAS objects, symlinks, and invalid ranges", async () => {
    await withStore(async (store, dir) => {
        const bytes = makePng();
        const published = await publishAsset(store, bytes, { mediaType: "image/png", role: "texture" });
        const casPath = path.join(dir, "visual-assets", "sha256", published.use.asset.sha256);
        const sameSize = Buffer.from(bytes);
        sameSize[sameSize.length - 1] ^= 0xff;
        await fs.writeFile(casPath, sameSize);
        await assert.rejects(
            () => store.statUseContent(published.useHash),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.CORRUPT,
        );

        const second = await publishAsset(store, makeJpeg(), { mediaType: "image/jpeg", role: "texture" });
        const jpegPath = path.join(dir, "visual-assets", "sha256", second.use.asset.sha256);
        const target = `${jpegPath}.link-target`;
        await fs.rename(jpegPath, target);
        await fs.symlink(target, jpegPath);
        await assert.rejects(
            () => store.statUseContent(second.useHash),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.SYMLINK
                || error.code === VISUAL_ASSET_ERROR_CODES.CORRUPT,
        );

        const third = await publishAsset(store, makePng({ width: 2, height: 2 }), { mediaType: "image/png", role: "texture" });
        await assert.rejects(
            () => store.openUseContent(third.useHash, { start: 0, end: 1_000_000 }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.RANGE_NOT_SATISFIABLE,
        );
        const opened = await store.openUseContent(third.useHash, { start: 0, end: 3 });
        const chunks = [];
        for await (const chunk of opened.stream) chunks.push(chunk);
        assert.equal(Buffer.concat(chunks).length, 4);
    });
});

test("KTX2 inspector allows the reviewed Basis/UASTC profile and rejects expansion bombs", () => {
    const valid = inspectKtx2(makeKtx2(), limits);
    assert.equal(valid.colorModel, 166);
    const bomb = Buffer.from(makeKtx2());
    bomb.writeBigUInt64LE(0xffffffffffffn, 80 + 16);
    assert.throws(() => inspectKtx2(bomb, limits), /decoded-size|safe integer|uncompressed/);
});

test("G-SECURITY rejects optional extension bypasses and oversized embedded images before loaders", async () => {
    await withStore(async (store) => {
        const transmission = makeHostileGlb((json) => {
            json.extensionsUsed = ["KHR_materials_transmission"];
            json.materials = [{ extensions: { KHR_materials_transmission: { transmissionFactor: 1 } } }];
            json.meshes[0].primitives[0].material = 0;
        });
        await assert.rejects(
            () => publishAsset(store, transmission, { mediaType: "model/gltf-binary", role: "mesh" }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
        );
        const usedOnly = makeHostileGlb((json) => {
            json.extensionsUsed = ["KHR_materials_transmission"];
        });
        await assert.rejects(
            () => publishAsset(store, usedOnly, { mediaType: "model/gltf-binary", role: "mesh" }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH,
        );
        const hostileObjectGraph = makeHostileGlb((json) => {
            let nested = {};
            json.materials = [{ extensions: { KHR_materials_unlit: nested } }];
            json.meshes[0].primitives[0].material = 0;
            for (let index = 0; index < 100; index += 1) {
                nested.child = {};
                nested = nested.child;
            }
        });
        await assert.rejects(
            () => publishAsset(store, hostileObjectGraph, { mediaType: "model/gltf-binary", role: "mesh" }),
            (error) => error.code === VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
        );

        const base = makeTriangleGlb();
        const jsonLength = base.readUInt32LE(12);
        const bin = base.subarray(20 + jsonLength + 8);
        const uv = Buffer.alloc(24);
        const json = triangleGltfJson(bin.length + uv.length);
        json.bufferViews.push({ buffer: 0, byteOffset: bin.length, byteLength: uv.length });
        json.accessors.push({ bufferView: 2, componentType: 5126, count: 3, type: "VEC2" });
        json.meshes[0].primitives[0].attributes.TEXCOORD_0 = 2;
        json.meshes[0].primitives[0].material = 0;
        json.images = [{ uri: `data:image/png;base64,${makePng({ width: 8, height: 8 }).toString("base64")}` }];
        json.textures = [{ source: 0 }];
        json.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
        const embedded = buildGlb(json, Buffer.concat([bin, uv]));
        const tight = resolveVisualAssetLimits({
            ...limits,
            textureDimension: 4,
        });
        const { dir, store: tightStore } = await createAssetStore({ limits: tight });
        try {
            await assert.rejects(
                () => publishAsset(tightStore, embedded, { mediaType: "model/gltf-binary", role: "mesh" }),
                (error) => error.code === VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
            );
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});

test("content access revalidates missing and stale validation evidence without changing use identity", async () => {
    await withStore(async (store, dir) => {
        const published = await publishAsset(store, makePng(), { mediaType: "image/png", role: "texture" });
        const validationPath = path.join(dir, "visual-assets", "validation", "sha256", `${published.useHash}.json`);
        const stale = { ...published.validation, version: 1 };
        await fs.writeFile(validationPath, JSON.stringify(stale));
        await store.statUseContent(published.useHash);
        assert.equal((await store.getValidation(published.useHash)).version, 2);

        await fs.rm(validationPath);
        const opened = await store.openUseContent(published.useHash);
        await opened.release();
        assert.equal((await store.getValidation(published.useHash)).version, 2);
        assert.equal((await store.getUse(published.useHash)).asset.sha256, published.use.asset.sha256);
    });
});
