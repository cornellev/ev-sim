import assert from "node:assert/strict";
import test from "node:test";

import { createGltfImportPlan } from "../app/editor-assets/GltfImportPlan.js";
import { AssetRepository } from "../app/3d/editor/assets/AssetRepository.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { buildGlb } from "./helpers/visual-assets.js";

const encoder = new TextEncoder();

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
    const view = new DataView(glb.modelBytes.buffer, glb.modelBytes.byteOffset, glb.modelBytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    const binLength = view.getUint32(20 + jsonLength, true);
    assert.deepEqual([...glb.modelBytes.slice(28 + jsonLength, 28 + jsonLength + binLength)], [...bin]);
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
