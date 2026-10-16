import assert from "node:assert/strict";
import test from "node:test";

import { packVehicleGltf, readPackedGlb } from "../app/vehicles/model/packVehicleGltf.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { makePng } from "./helpers/visual-assets.js";

const GLB_MAGIC = 0x46546c67;

function magic(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
}

test("VEH-02a packs a glTF buffer and PNG into a real GLB", () => {
    const geometry = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const png = makePng();
    const json = {
        asset: { version: "2.0" },
        buffers: [{ uri: "mesh.bin", byteLength: geometry.length }],
        images: [{ uri: "albedo.png" }],
    };
    const sourceJson = new TextEncoder().encode(JSON.stringify(json));
    const packed = packVehicleGltf({
        json,
        buffers: [geometry],
        imageBytes: [png],
    });
    const again = packVehicleGltf({
        json,
        buffers: [geometry],
        imageBytes: [png],
    });
    assert.equal(magic(packed.glbBytes), GLB_MAGIC);
    assert.equal(new DataView(packed.glbBytes.buffer, packed.glbBytes.byteOffset, packed.glbBytes.byteLength).getUint32(4, true), 2);
    assert.notDeepEqual([...packed.glbBytes.subarray(0, sourceJson.length)], [...sourceJson]);
    const parsed = readPackedGlb(packed.glbBytes);
    assert.equal(parsed.json.buffers[0].uri, undefined);
    assert.equal(parsed.json.buffers[0].byteLength, geometry.length);
    assert.deepEqual([...parsed.bin.subarray(0, geometry.length)], [...geometry]);
    assert.equal([...parsed.bin].includes(0x89), false);
    const imageName = `${sha256ExactBytes(png)}.png`;
    assert.equal(parsed.json.images[0].uri, imageName);
    assert.deepEqual(packed.dependencies.map((entry) => entry.name), [imageName]);
    assert.deepEqual([...packed.dependencies[0].bytes], [...png]);
    assert.deepEqual([...packed.glbBytes], [...again.glbBytes]);
});

test("VEH-02a canonical JSON is independent of source key order", () => {
    const geometry = new Uint8Array([4, 3, 2, 1]);
    const first = packVehicleGltf({
        json: { asset: { version: "2.0", generator: "sample" }, buffers: [{ uri: "a.bin", byteLength: 4 }] },
        buffers: [geometry],
    });
    const second = packVehicleGltf({
        json: { buffers: [{ byteLength: 4, uri: "a.bin" }], asset: { generator: "sample", version: "2.0" } },
        buffers: [geometry],
    });
    assert.deepEqual([...first.glbBytes], [...second.glbBytes]);
});

test("VEH-02a extracts an embedded image from the BIN chunk", () => {
    const geometry = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const png = makePng();
    const bin = new Uint8Array(geometry.length + png.length);
    bin.set(geometry, 0);
    bin.set(png, geometry.length);
    const packed = packVehicleGltf({
        json: {
            asset: { version: "2.0" },
            buffers: [{ byteLength: bin.length }],
            bufferViews: [
                { buffer: 0, byteOffset: 0, byteLength: geometry.length },
                { buffer: 0, byteOffset: geometry.length, byteLength: png.length },
            ],
            images: [{ bufferView: 1, mimeType: "image/png" }],
        },
        buffers: [bin],
    });
    const parsed = readPackedGlb(packed.glbBytes);
    assert.equal(parsed.json.buffers[0].byteLength, geometry.length);
    assert.equal(parsed.json.images[0].bufferView, undefined);
    assert.equal(parsed.json.images[0].uri, `${sha256ExactBytes(png)}.png`);
    assert.equal([...parsed.bin].includes(0x89), false);
});

test("VEH-02a assigns ordinal names and rejects animation, skins, and unknown extensions", () => {
    const packed = packVehicleGltf({
        json: { asset: { version: "2.0" }, nodes: [{ name: "Door" }, { mesh: 0 }] },
    });
    assert.deepEqual(packed.nodes.map((node) => node.name), ["Door", "part-0"]);
    assert.deepEqual(packed.nodes[1].path, ["part-0"]);
    assert.throws(() => packVehicleGltf({ json: { asset: { version: "2.0" }, animations: [{}] } }), /Animation is not permitted/);
    assert.throws(() => packVehicleGltf({ json: { asset: { version: "2.0" }, skins: [{}] } }), /Skins are not permitted/);
    assert.throws(() => packVehicleGltf({ json: { asset: { version: "2.0" }, extensionsUsed: ["NOPE"] } }), /not permitted/);
});
