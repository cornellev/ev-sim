/** Small box GLBs for vehicle wheel measurement tests. */

import { writeGlb } from "../../app/simulation/visual/GlbContainer.js";

const BOX_INDICES = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    2, 6, 7, 2, 7, 3,
    0, 3, 7, 0, 7, 4,
    1, 5, 6, 1, 6, 2,
];

function align4(value) {
    return Math.ceil(value / 4) * 4;
}

function boxPositions(center, size, vertexDelta = null) {
    const hx = size.x / 2;
    const hy = size.y / 2;
    const hz = size.z / 2;
    const corners = [
        [-hx, -hy, -hz], [hx, -hy, -hz], [hx, hy, -hz], [-hx, hy, -hz],
        [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz],
    ];
    const positions = new Float32Array(24);
    corners.forEach((corner, index) => {
        positions[index * 3] = center.x + corner[0];
        positions[index * 3 + 1] = center.y + corner[1];
        positions[index * 3 + 2] = center.z + corner[2];
    });
    if (vertexDelta) {
        positions[vertexDelta.index * 3 + vertexDelta.axis] += vertexDelta.delta;
    }
    return positions;
}

/**
 * @param {Array<{ name: string, center: {x,y,z}, size: {x,y,z}, rotation?: number[], vertexDelta?: {index, axis, delta} }>} parts
 */
export function buildBoxGlb(parts) {
    const json = {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: parts.map((_, index) => index) }],
        nodes: [],
        meshes: [],
        accessors: [],
        bufferViews: [],
        buffers: [{ byteLength: 0 }],
    };
    const pieces = [];
    let cursor = 0;
    for (const [index, part] of parts.entries()) {
        const positions = boxPositions(part.center ?? { x: 0, y: 0, z: 0 }, part.size, part.vertexDelta);
        const indices = Uint16Array.from(BOX_INDICES);
        const posBytes = new Uint8Array(positions.buffer.slice(positions.byteOffset, positions.byteOffset + positions.byteLength));
        const indexBytes = new Uint8Array(indices.buffer.slice(indices.byteOffset, indices.byteOffset + indices.byteLength));
        const posOffset = align4(cursor);
        cursor = posOffset + posBytes.byteLength;
        const indexOffset = align4(cursor);
        cursor = indexOffset + indexBytes.byteLength;
        pieces.push({ posOffset, posBytes, indexOffset, indexBytes });
        const positionAccessor = json.accessors.length;
        json.bufferViews.push({ buffer: 0, byteOffset: posOffset, byteLength: posBytes.byteLength });
        json.accessors.push({
            bufferView: json.bufferViews.length - 1,
            componentType: 5126,
            count: 8,
            type: "VEC3",
        });
        json.bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: indexBytes.byteLength });
        json.accessors.push({
            bufferView: json.bufferViews.length - 1,
            componentType: 5123,
            count: indices.length,
            type: "SCALAR",
        });
        json.meshes.push({
            primitives: [{ attributes: { POSITION: positionAccessor }, indices: positionAccessor + 1, mode: 4 }],
        });
        const node = { name: part.name, mesh: index };
        if (part.rotation) node.rotation = part.rotation;
        if (part.translation) node.translation = part.translation;
        json.nodes.push(node);
    }
    const bin = new Uint8Array(align4(cursor));
    for (const piece of pieces) {
        bin.set(piece.posBytes, piece.posOffset);
        bin.set(piece.indexBytes, piece.indexOffset);
    }
    json.buffers[0].byteLength = bin.byteLength;
    return writeGlb(json, bin);
}

export const WHEEL_SIZE = Object.freeze({ x: 0.5, y: 0.5, z: 0.25 });

export function symmetricWheelParts() {
    return [
        { name: "wheel-left", center: { x: 0.75, y: 0.25, z: 0.5 }, size: WHEEL_SIZE },
        { name: "wheel-right", center: { x: 0.75, y: 0.25, z: -0.5 }, size: WHEEL_SIZE },
    ];
}
