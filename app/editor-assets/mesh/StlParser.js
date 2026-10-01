/** ASCII and binary STL parser. Binary wins when the byte length matches the facet table. */

import { createMeshDocument } from "./MeshDocument.js";

function bytesOf(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return new Uint8Array(value);
    throw new TypeError("STL bytes are required.");
}

function finite(token, label) {
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(`${label} ${JSON.stringify(token)} is not a finite number.`);
    return Object.is(value, -0) ? 0 : value;
}

function slug(name) {
    const cleaned = String(name ?? "").trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
    return cleaned || "object";
}

function isBinaryStl(bytes) {
    if (bytes.length < 84) return false;
    const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
    return bytes.length === 84 + count * 50;
}

function parseBinary(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = view.getUint32(80, true);
    const positions = [];
    const normals = [];
    const indices = [];
    for (let facet = 0; facet < count; facet += 1) {
        const offset = 84 + facet * 50;
        const normal = [0, 1, 2].map((axis) => view.getFloat32(offset + axis * 4, true));
        for (let vertex = 0; vertex < 3; vertex += 1) {
            const start = offset + 12 + vertex * 12;
            positions.push([0, 1, 2].map((axis) => view.getFloat32(start + axis * 4, true)));
            normals.push(normal.slice());
            indices.push(facet * 3 + vertex);
        }
    }
    return { positions, normals, indices };
}

function parseAscii(bytes) {
    const positions = [];
    const normals = [];
    const indices = [];
    let normal = null;
    let vertices = [];
    for (const raw of new TextDecoder().decode(bytes).split(/\r?\n/u)) {
        const line = raw.trim();
        const lower = line.toLowerCase();
        if (lower.startsWith("facet normal")) {
            const channels = line.slice("facet normal".length).trim().split(/\s+/u);
            normal = [0, 1, 2].map((index) => finite(channels[index], "STL normal"));
            vertices = [];
        } else if (lower.startsWith("vertex")) {
            const channels = line.slice("vertex".length).trim().split(/\s+/u);
            vertices.push([0, 1, 2].map((index) => finite(channels[index], "STL vertex")));
        } else if (lower.startsWith("endfacet")) {
            if (!normal || vertices.length !== 3) throw new Error("STL facet must contain a normal and three vertices.");
            const offset = positions.length;
            for (const vertex of vertices) {
                positions.push(vertex);
                normals.push(normal.slice());
            }
            indices.push(offset, offset + 1, offset + 2);
            normal = null;
            vertices = [];
        }
    }
    return { positions, normals, indices };
}

export function parseStl(bytes, name = "object") {
    const source = bytesOf(bytes);
    const geometry = isBinaryStl(source) ? parseBinary(source) : parseAscii(source);
    if (geometry.indices.length === 0) throw new Error("STL file has no triangles.");
    const id = slug(name);
    return createMeshDocument({
        nodes: [{
            id,
            name: String(name ?? "").trim() || id,
            parentId: null,
            primitives: [{ ...geometry, uvs: null, materialId: null }],
        }],
    });
}
