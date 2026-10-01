import assert from "node:assert/strict";
import test from "node:test";

import { encodeMeshDocumentGlb } from "../app/editor-assets/mesh/MeshGlbEncoder.js";
import { parseObjPackage } from "../app/editor-assets/mesh/ObjParser.js";
import { createMeshDocument } from "../app/editor-assets/mesh/MeshDocument.js";
import { readGlb } from "../app/simulation/visual/GlbContainer.js";
import { decodeAssetSourceGeometry } from "../server/storage/ServerAssetGeometryDecoder.js";

const encoder = new TextEncoder();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function read(glbBytes) {
    return readGlb(glbBytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
    });
}

test("MESH-02 mesh documents encode to a stable glTF 2.0 GLB", async () => {
    const document = createMeshDocument({
        nodes: [{
            id: "crate",
            name: "Crate",
            parentId: null,
            primitives: [{
                positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
                normals: [[0, 0, 1], [0, 0, 1], [0, 0, 1]],
                uvs: null,
                indices: [0, 1, 2],
                materialId: "paint",
            }],
        }],
        materials: [{ id: "paint", kd: [0.2, 0.4, 0.6], d: 0.5, ns: 250, mapKd: null }],
    });
    const first = encodeMeshDocumentGlb(document);
    const second = encodeMeshDocumentGlb(document);
    assert.deepEqual(first.glbBytes, second.glbBytes);
    assert.equal(first.mediaType, "model/gltf-binary");
    const parsed = read(first.glbBytes);
    assert.equal(parsed.json.asset.version, "2.0");
    assert.equal(parsed.json.materials[0].alphaMode, "MASK");
    assert.equal(parsed.json.materials[0].alphaCutoff, 0.5);
    assert.deepEqual(parsed.json.materials[0].pbrMetallicRoughness.baseColorFactor, [0.2, 0.4, 0.6, 0.5]);
    assert.equal(parsed.json.materials[0].pbrMetallicRoughness.metallicFactor, 0);
    assert.equal(parsed.json.materials[0].pbrMetallicRoughness.roughnessFactor, 0.75);
    assert.equal(parsed.json.meshes[0].primitives[0].mode, undefined);
    const geometry = await decodeAssetSourceGeometry("model", {
        async getUse() {
            return { asset: { mediaType: "model/gltf-binary", sizeBytes: first.glbBytes.byteLength }, dependencies: {} };
        },
        async getUseContent() {
            return { bytes: first.glbBytes };
        },
    });
    assert.deepEqual(geometry[0].vertices, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    assert.deepEqual(geometry[0].triangles, [[0, 1, 2]]);
});

test("MESH-02 OBJ textures stay external PNG dependencies", () => {
    const document = parseObjPackage([
        { path: "crate.obj", bytes: encoder.encode("mtllib crate.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl paint\nf 1/1 2/2 3/3\n") },
        { path: "crate.mtl", bytes: encoder.encode("newmtl paint\nKd 1 1 1\nmap_Kd albedo.png\n") },
        { path: "albedo.png", bytes: png },
    ], "crate.obj");
    const encoded = encodeMeshDocumentGlb(document);
    const parsed = read(encoded.glbBytes);
    assert.equal(parsed.json.images[0].uri, "albedo.png");
    assert.equal(parsed.json.images[0].mimeType, "image/png");
    assert.equal(encoded.images[0].mediaType, "image/png");
    assert.equal(parsed.json.materials[0].alphaMode, "OPAQUE");
    assert.throws(() => encodeMeshDocumentGlb(createMeshDocument({
        nodes: [{
            id: "bad", name: "Bad", parentId: null,
            primitives: [{ positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], indices: [0, 1, 2], materialId: "paint" }],
        }],
        materials: [{ id: "paint", kd: [1, 1, 1], d: 1, ns: 0, mapKd: "albedo.tga" }],
        images: [{ path: "albedo.tga", bytes: encoder.encode("not an image") }],
    })), /PNG, JPEG, or KTX2/);
});
