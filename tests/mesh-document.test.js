import assert from "node:assert/strict";
import test from "node:test";

import { parseObjPackage } from "../app/editor-assets/mesh/ObjParser.js";
import { parsePly } from "../app/editor-assets/mesh/PlyParser.js";
import { parseStl } from "../app/editor-assets/mesh/StlParser.js";

const encoder = new TextEncoder();
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function objFiles(text, extras = []) {
    return [{ path: "crate.obj", bytes: encoder.encode(text) }, ...extras];
}

test("MESH-01 OBJ groups, materials, negative indices, and n-gons parse stably", () => {
    const text = [
        "mtllib crate.mtl",
        "o Left",
        "v 0 0 0",
        "v 1 0 0",
        "v 0 1 0",
        "v 1 1 0",
        "vn 0 0 1",
        "usemtl paint",
        "f -4//-1 -3//-1 -2//-1 -1//-1",
        "o Right",
        "v 2 0 0",
        "v 3 0 0",
        "v 2 1 0",
        "f -3//-1 -2//-1 -1//-1",
        "l 1 2",
    ].join("\n");
    const mtl = [
        "newmtl paint",
        "Kd 0.2 0.4 0.6",
        "d 0.5",
        "Ns 250",
        "Ka 0 0 0",
        "map_Kd -s 1 1 1 albedo.png",
    ].join("\n");
    const files = objFiles(text, [
        { path: "crate.mtl", bytes: encoder.encode(mtl) },
        { path: "albedo.png", bytes: png },
    ]);
    assert.throws(() => parseObjPackage(files, "crate.obj"), /line and point/);

    const withoutLine = text.replace("\nl 1 2", "");
    const packageFiles = objFiles(withoutLine, [
        { path: "crate.mtl", bytes: encoder.encode(mtl) },
        { path: "albedo.png", bytes: png },
    ]);
    const first = parseObjPackage(packageFiles, "crate.obj");
    const second = parseObjPackage(packageFiles, "crate.obj");
    assert.deepEqual(first, second);
    assert.deepEqual(first.nodes.map((node) => node.name), ["Left", "Right"]);
    assert.deepEqual(first.nodes[0].primitives[0].indices, [0, 1, 2, 0, 2, 3]);
    assert.equal(first.nodes[0].primitives[0].materialId, "paint");
    assert.deepEqual(first.nodes[0].primitives[0].positions[0], [0, 0, 0]);
    assert.deepEqual(first.nodes[0].primitives[0].normals[0], [0, 0, 1]);
    assert.deepEqual(first.nodes[1].primitives[0].positions[0], [2, 0, 0]);
    assert.deepEqual(first.nodes[1].primitives[0].normals[0], [0, 0, 1]);
    assert.equal(first.nodes[1].primitives[0].uvs, null);
    assert.equal(first.materials[0].d, 0.5);
    assert.equal(first.materials[0].ns, 250);
    assert.deepEqual(first.materials[0].kd, [0.2, 0.4, 0.6]);
    assert.equal(first.materials[0].mapKd, "albedo.png");
    assert.deepEqual([...first.images[0].bytes], [...png]);
});

test("MESH-01 OBJ rejects a missing MTL and a path that leaves the package", () => {
    assert.throws(() => parseObjPackage(objFiles("mtllib missing.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"), "crate.obj"), /not selected/);
    const escaped = objFiles("mtllib ../secret.mtl\n", [{ path: "secret.mtl", bytes: encoder.encode("newmtl paint\n") }]);
    assert.throws(() => parseObjPackage(escaped, "crate.obj"), /traverses outside the package/);
    const absolute = objFiles("mtllib /tmp/secret.mtl\n");
    assert.throws(() => parseObjPackage(absolute, "crate.obj"), /not a selected package path/);
});

test("MESH-01 STL binary and ASCII describe the same triangle", () => {
    const ascii = [
        "solid crate",
        "facet normal 0 0 1",
        " outer loop",
        "  vertex 0 0 0",
        "  vertex 1 0 0",
        "  vertex 0 1 0",
        " endloop",
        "endfacet",
        "endsolid crate",
    ].join("\n");
    const binary = new Uint8Array(84 + 50);
    const view = new DataView(binary.buffer);
    view.setUint32(80, 1, true);
    view.setFloat32(92, 1, true);
    view.setFloat32(108, 1, true);
    view.setFloat32(124, 1, true);
    const fromAscii = parseStl(encoder.encode(ascii), "crate");
    const fromBinary = parseStl(binary, "crate");
    assert.equal(fromAscii.nodes.length, 1);
    assert.equal(fromBinary.nodes[0].name, "crate");
    assert.deepEqual(fromAscii.nodes[0].primitives[0].positions, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    assert.deepEqual(fromBinary.nodes[0].primitives[0].positions, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    assert.deepEqual(fromBinary.nodes[0].primitives[0].normals[0], [0, 0, 1]);
    assert.deepEqual(fromAscii.nodes[0].primitives[0].indices, [0, 1, 2]);
});

test("MESH-01 PLY triangulates polygon faces and rejects big-endian", () => {
    const ascii = [
        "ply",
        "format ascii 1.0",
        "comment unit square",
        "element vertex 4",
        "property float x",
        "property float y",
        "property float z",
        "property uchar red",
        "element face 1",
        "property list uchar int vertex_indices",
        "end_header",
        "0 0 0 255",
        "1 0 0 255",
        "1 1 0 255",
        "0 1 0 255",
        "4 0 1 2 3",
    ].join("\n");
    const parsed = parsePly(encoder.encode(ascii), "square");
    assert.equal(parsed.nodes[0].name, "square");
    assert.deepEqual(parsed.nodes[0].primitives[0].indices, [0, 1, 2, 0, 2, 3]);
    assert.equal(parsed.nodes[0].primitives[0].normals, null);
    assert.throws(() => parsePly(encoder.encode("ply\nformat binary_big_endian 1.0\nend_header\n"), "square"), /binary_big_endian/);

    const header = encoder.encode([
        "ply",
        "format binary_little_endian 1.0",
        "element vertex 3",
        "property float x",
        "property float y",
        "property float z",
        "element face 1",
        "property list uchar int vertex_indices",
        "end_header\n",
    ].join("\n"));
    const body = new Uint8Array(3 * 12 + 1 + 12);
    const view = new DataView(body.buffer);
    view.setFloat32(12, 1, true);
    view.setFloat32(28, 1, true);
    body[36] = 3;
    view.setInt32(37, 0, true);
    view.setInt32(41, 1, true);
    view.setInt32(45, 2, true);
    const binary = new Uint8Array(header.length + body.length);
    binary.set(header);
    binary.set(body, header.length);
    const fromBinary = parsePly(binary, "triangle");
    assert.deepEqual(fromBinary.nodes[0].primitives[0].positions, [[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    assert.deepEqual(fromBinary.nodes[0].primitives[0].indices, [0, 1, 2]);
});
