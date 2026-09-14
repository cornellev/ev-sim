import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import test from "node:test";

import { createGltfImportPlan } from "../app/editor-assets/GltfImportPlan.js";
import { compileAssetDefinition } from "../app/editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { AssetRepository } from "../app/3d/editor/assets/AssetRepository.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { EditorAssetStore } from "../server/storage/EditorAssetStore.js";
import {
    decodeAssetAppearanceGeometry,
    decodeAssetSourceGeometry,
} from "../server/storage/ServerAssetGeometryDecoder.js";
import {
    buildGlb,
    createAssetStore,
    makeEmbeddedBaseColorGlb,
    makeEmbeddedBaseColorGltf,
    makePng,
    publishAsset,
} from "./helpers/visual-assets.js";

const encoder = new TextEncoder();

function glbChunks(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    const binLength = view.getUint32(20 + jsonLength, true);
    return {
        json: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))),
        bin: bytes.subarray(28 + jsonLength, 28 + jsonLength + binLength),
    };
}

test("ED-06 GLTF import plans rewrite selected dependencies and preserve GLB BIN bytes", () => {
    const buffer = new Uint8Array([1, 2, 3, 4]);
    const image = new Uint8Array([137, 80, 78, 71]);
    const gltf = encoder.encode(JSON.stringify({
        asset: { version: "2.0" },
        buffers: [{ uri: "../data/mesh.bin", byteLength: buffer.length }],
        images: [{ uri: "../textures/albedo.png" }],
    }));
    const plan = createGltfImportPlan([
        { path: "models/crate.gltf", bytes: gltf },
        { path: "data/mesh.bin", bytes: buffer },
        { path: "textures/albedo.png", bytes: image },
    ], { entryPath: "models/crate.gltf" });
    const rewritten = JSON.parse(new TextDecoder().decode(plan.modelBytes));
    assert.equal(rewritten.buffers[0].uri, `sha256:${sha256ExactBytes(buffer)}`);
    assert.equal(rewritten.images[0].uri, `sha256:${sha256ExactBytes(image)}`);
    assert.deepEqual(plan.dependencies.map((entry) => entry.path), ["data/mesh.bin", "textures/albedo.png"]);

    const bin = new Uint8Array([8, 7, 6, 5]);
    const source = buildGlb({ asset: { version: "2.0" }, buffers: [{ byteLength: 4 }] }, bin);
    const glb = createGltfImportPlan([{ path: "model.glb", bytes: source }], { entryPath: "model.glb" });
    assert.deepEqual([...glbChunks(glb.modelBytes).bin], [...bin]);
});

test("ED-06 GLTF import plans unpack bufferView and data URI images without rewriting BIN", () => {
    const png = makePng();
    const digest = sha256ExactBytes(png);
    const packed = makeEmbeddedBaseColorGlb(png);
    const originalBin = glbChunks(packed).bin;
    const plan = createGltfImportPlan([{ path: "crate.glb", bytes: packed }], { entryPath: "crate.glb" });
    const rewritten = glbChunks(plan.modelBytes);
    assert.equal(rewritten.json.images[0].uri, `sha256:${digest}`);
    assert.equal(rewritten.json.images[0].bufferView, undefined);
    assert.equal(plan.dependencies.length, 1);
    assert.equal(plan.dependencies[0].mediaType, "image/png");
    assert.equal(plan.dependencies[0].sha256, digest);
    assert.deepEqual([...plan.dependencies[0].bytes], [...png]);
    assert.deepEqual([...rewritten.bin], [...originalBin]);

    const dataPlan = createGltfImportPlan([{ path: "crate.gltf", bytes: makeEmbeddedBaseColorGltf(png) }], { entryPath: "crate.gltf" });
    const dataJson = JSON.parse(new TextDecoder().decode(dataPlan.modelBytes));
    assert.equal(dataJson.images[0].uri, `sha256:${digest}`);
    assert.equal(dataPlan.dependencies.length, 1);
    assert.equal(dataPlan.dependencies[0].sha256, digest);
});

test("ED-06 GLTF import plans dedupe shared bufferView images and reject unsupported media", () => {
    const png = makePng();
    const packed = makeEmbeddedBaseColorGlb(png);
    const { json, bin } = glbChunks(packed);
    json.images.push({ bufferView: json.images[0].bufferView, mimeType: "image/png" });
    const shared = createGltfImportPlan([{ path: "shared.glb", bytes: buildGlb(json, Buffer.from(bin)) }], { entryPath: "shared.glb" });
    assert.equal(shared.dependencies.length, 1);
    assert.equal(shared.dependencies[0].sha256, sha256ExactBytes(png));
    assert.equal(glbChunks(shared.modelBytes).json.images[1].uri, `sha256:${sha256ExactBytes(png)}`);

    const webp = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    assert.throws(
        () => createGltfImportPlan([{ path: "bad.glb", bytes: makeEmbeddedBaseColorGlb(webp) }], { entryPath: "bad.glb" }),
        /Embedded image must be PNG, JPEG, or KTX2/,
    );
});

test("ED-06 GLTF import plans reject ambiguity, missing dependencies, URLs, and traversal", () => {
    const model = (uri) => encoder.encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri, byteLength: 1 }] }));
    assert.throws(() => createGltfImportPlan([{ path: "a.gltf", bytes: model("x.bin") }], { entryPath: "a.gltf" }), /was not selected/);
    assert.throws(() => createGltfImportPlan([{ path: "a.gltf", bytes: model("https:\/\/example.test/x.bin") }], { entryPath: "a.gltf" }), /not a selected package path/);
    assert.throws(() => createGltfImportPlan([{ path: "a.gltf", bytes: model("../x.bin") }], { entryPath: "a.gltf" }), /traverses outside/);
    assert.throws(() => createGltfImportPlan([
        { path: "a/../model.gltf", bytes: model("data:application/octet-stream;base64,AA==") },
        { path: "model.gltf", bytes: model("data:application/octet-stream;base64,AA==") },
    ], { entryPath: "model.gltf" }), /ambiguous/);
});

test("ED-06 repository uploads dependencies first, validates the model, and aborts unfinished staging", async () => {
    const events = [];
    let counter = 0;
    const visualAssets = {
        async createUpload(body) { events.push(["create", body]); return { id: `upload-${++counter}` }; },
        async putUploadContent(id, bytes) { events.push(["put", id, bytes.byteLength]); return { useHash: String(counter).repeat(64).slice(0, 64) }; },
        async validateClosure(body) { events.push(["validate", body]); return { ok: true }; },
        async cancelUpload(id) { events.push(["cancel", id]); },
    };
    const repository = new AssetRepository({ visualAssets, fetch: async () => { throw new Error("unused"); } });
    const result = await repository.import([
        { path: "crate.gltf", bytes: encoder.encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: "crate.bin", byteLength: 1 }] })) },
        { path: "crate.bin", bytes: new Uint8Array([1]) },
    ], "owned", null, { entryPath: "crate.gltf" });
    assert.equal(result.suggestedName, "crate");
    assert.deepEqual(events.map((entry) => entry[0]), ["create", "put", "create", "put", "validate"]);
    assert.equal(events[2][1].dependencies[Object.keys(events[2][1].dependencies)[0]], "1".repeat(64));

    const cancelled = [];
    const aborting = new AssetRepository({
        fetch: async () => { throw new Error("unused"); },
        visualAssets: {
            async createUpload() { return { id: "unfinished" }; },
            async putUploadContent() { throw new DOMException("cancelled", "AbortError"); },
            async cancelUpload(id) { cancelled.push(id); },
        },
    });
    await assert.rejects(() => aborting.import([{ path: "model.gltf", bytes: encoder.encode(JSON.stringify({ asset: { version: "2.0" } })) }], "owned", null, { entryPath: "model.gltf" }), /cancelled/);
    assert.deepEqual(cancelled, ["unfinished"]);
});

test("ED-06 packed GLB import publishes a source that ED-07 can decode and save", async (t) => {
    const fixture = await createAssetStore();
    t.after(() => fs.rm(fixture.dir, { recursive: true, force: true }));
    const png = makePng();
    const plan = createGltfImportPlan([{ path: "crate.glb", bytes: makeEmbeddedBaseColorGlb(png) }], { entryPath: "crate.glb" });
    const texture = await publishAsset(fixture.store, plan.dependencies[0].bytes, {
        mediaType: "image/png", role: "texture",
    });
    const source = await publishAsset(fixture.store, plan.modelBytes, {
        mediaType: "model/gltf-binary",
        role: "mesh",
        dependencies: { [`sha256:${plan.dependencies[0].sha256}`]: texture.useHash },
    });
    const appearance = await decodeAssetAppearanceGeometry(source.useHash, fixture.store);
    assert.equal(appearance.materials[0].descriptor.textures[0].slot, "baseColor");
    assert.equal(appearance.materials[0].descriptor.textures[0].useHash, texture.useHash);

    const definition = createEmptyAssetDefinition({ modelUseHash: source.useHash, name: "Crate" });
    definition.normalization.pivot = [1, 0, 0];
    const compiled = compileAssetDefinition(definition, {
        sourceGeometries: { source: await decodeAssetSourceGeometry(source.useHash, fixture.store) },
    });
    const catalog = new EditorAssetStore(fixture.dir, { visualAssets: fixture.store, assetStudioEnabled: true });
    const published = await catalog.publishRevision({
        assetId: "packed-crate",
        name: "Packed crate",
        publicationId: "packed-crate-publication",
        expectedAssetRevision: 0,
        modelUseHash: source.useHash,
        definition,
        metric: compiled.metric,
        metricHash: compiled.metricHash,
        appearance: compiled.materials,
    }, 0);
    assert.equal(published.revision.version, 2);
    assert.equal(published.revision.appearance[0].textures[0].slot, "baseColor");
    assert.equal(published.revision.appearance[0].textures[0].useHash, texture.useHash);
});
