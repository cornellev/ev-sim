/**
 * Deterministic PNG and GLB encoders for VIS-08 projected captured radiance.
 * PNG uses filter 0 and stored (uncompressed) DEFLATE. GLB uses stable JSON
 * key order, 4-byte padding, little-endian numerics, and no timestamps/UUIDs.
 */

import { sha256ExactBytes } from "../../../simulation/visual/VisualLayer.js";

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
export const PROJECTED_CAPTURED_RADIANCE_WRITER = Object.freeze({
    id: "projected-captured-radiance",
    version: 1,
});
export const PROJECTED_CAPTURED_RADIANCE_OPTIONS = Object.freeze({
    cellSizePx: 10,
    maxTriangleDepthDelta: 1,
    surfaceOffset: 0.005,
    pngFilter: "none",
    pngDeflate: "stored-zlib",
    glbPadding: "gltf-2",
});

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let crc = index;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
        }
        table[index] = crc >>> 0;
    }
    return table;
})();

function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.length;
    }
    return bytes;
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
        crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (let index = 0; index < bytes.length; index += 1) {
        a += bytes[index];
        if (a >= 65521) a -= 65521;
        b += a;
        if (b >= 65521) b -= 65521;
    }
    return ((b << 16) | a) >>> 0;
}

function writeUint32BE(target, offset, value) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

function writeUint32LE(target, offset, value) {
    target[offset] = value & 0xff;
    target[offset + 1] = (value >>> 8) & 0xff;
    target[offset + 2] = (value >>> 16) & 0xff;
    target[offset + 3] = (value >>> 24) & 0xff;
}

function pngChunk(type, data) {
    const typeBytes = Uint8Array.from(type, (character) => character.charCodeAt(0));
    const length = new Uint8Array(4);
    writeUint32BE(length, 0, data.length);
    const crcBytes = new Uint8Array(4);
    writeUint32BE(crcBytes, 0, crc32(concatBytes([typeBytes, data])));
    return concatBytes([length, typeBytes, data, crcBytes]);
}

function deflateStored(data) {
    if (data.length === 0) {
        return Uint8Array.of(0x01, 0x00, 0x00, 0xff, 0xff);
    }
    const chunks = [];
    let offset = 0;
    while (offset < data.length) {
        const remaining = data.length - offset;
        const len = Math.min(remaining, 65535);
        const header = new Uint8Array(5);
        header[0] = offset + len >= data.length ? 0x01 : 0x00;
        header[1] = len & 0xff;
        header[2] = (len >>> 8) & 0xff;
        const nlen = (~len) & 0xffff;
        header[3] = nlen & 0xff;
        header[4] = (nlen >>> 8) & 0xff;
        chunks.push(header, data.subarray(offset, offset + len));
        offset += len;
    }
    return concatBytes(chunks);
}

function zlibStored(data) {
    const checksum = new Uint8Array(4);
    writeUint32BE(checksum, 0, adler32(data));
    return concatBytes([Uint8Array.of(0x78, 0x01), deflateStored(data), checksum]);
}

function filteredScanlines(rgba, width, height) {
    const rowBytes = width * 4;
    const scanlines = new Uint8Array(height * (1 + rowBytes));
    for (let y = 0; y < height; y += 1) {
        const dst = y * (1 + rowBytes);
        scanlines[dst] = 0;
        scanlines.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), dst + 1);
    }
    return scanlines;
}

/**
 * Encode a top-left RGBA8 PNG with filter-none and stored zlib DEFLATE.
 * Invalid pixels must already have alpha 0. Bytes are not re-encoded as sRGB.
 */
export function encodeDeterministicRgbaPng(rgba, width, height) {
    const w = Math.max(0, Math.floor(width));
    const h = Math.max(0, Math.floor(height));
    if (!w || !h) throw new Error("PNG dimensions must be positive.");
    const pixels = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
    if (pixels.length !== w * h * 4) {
        throw new Error(`PNG RGBA buffer must be ${w * h * 4} bytes.`);
    }
    const ihdr = new Uint8Array(13);
    writeUint32BE(ihdr, 0, w);
    writeUint32BE(ihdr, 4, h);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return concatBytes([
        PNG_SIGNATURE,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", zlibStored(filteredScanlines(pixels, w, h))),
        pngChunk("IEND", new Uint8Array(0)),
    ]);
}

function padTo4(bytes, padByte) {
    const pad = (4 - (bytes.length % 4)) % 4;
    if (!pad) return bytes;
    const padded = new Uint8Array(bytes.length + pad);
    padded.set(bytes, 0);
    if (padByte) padded.fill(padByte, bytes.length);
    return padded;
}

function writeFloat32LE(target, offset, value) {
    const view = new DataView(target.buffer, target.byteOffset, target.byteLength);
    view.setFloat32(offset, value, true);
}

function minMax3(positions) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < positions.length; index += 3) {
        const x = positions[index];
        const y = positions[index + 1];
        const z = positions[index + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
    }
    return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function align(offset, size) {
    const rem = offset % size;
    return rem === 0 ? offset : offset + (size - rem);
}

/**
 * Encode a centered triangle mesh as a GLB with an unlit MASK material.
 * Texture pixels live in a sibling PNG; the descriptor applies the map.
 */
export function encodeProjectedCaptureGlb({
    positions,
    uvs,
    indices,
    materialId,
} = {}) {
    const vertexCount = positions.length / 3;
    const indexCount = indices.length;
    if (!vertexCount || !indexCount) {
        throw new Error("Projected GLB requires positions and indices.");
    }
    const useUint32 = vertexCount > 65535;
    const indexStride = useUint32 ? 4 : 2;
    const positionBytes = new Uint8Array(positions.length * 4);
    const uvBytes = new Uint8Array(uvs.length * 4);
    for (let index = 0; index < positions.length; index += 1) {
        writeFloat32LE(positionBytes, index * 4, positions[index]);
    }
    for (let index = 0; index < uvs.length; index += 1) {
        writeFloat32LE(uvBytes, index * 4, uvs[index]);
    }
    const indexBytes = new Uint8Array(align(indexCount * indexStride, 4));
    if (useUint32) {
        const view = new DataView(indexBytes.buffer);
        for (let index = 0; index < indexCount; index += 1) {
            view.setUint32(index * 4, indices[index], true);
        }
    } else {
        const view = new DataView(indexBytes.buffer);
        for (let index = 0; index < indexCount; index += 1) {
            view.setUint16(index * 2, indices[index], true);
        }
    }

    const positionOffset = 0;
    const uvOffset = align(positionOffset + positionBytes.length, 4);
    const indexOffset = align(uvOffset + uvBytes.length, 4);
    const binLength = indexOffset + indexBytes.length;
    const bin = new Uint8Array(binLength);
    bin.set(positionBytes, positionOffset);
    bin.set(uvBytes, uvOffset);
    bin.set(indexBytes, indexOffset);
    const bounds = minMax3(positions);

    const json = {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: materialId }],
        meshes: [{
            name: materialId,
            primitives: [{
                attributes: { POSITION: 0, TEXCOORD_0: 1 },
                indices: 2,
                material: 0,
                mode: 4,
            }],
        }],
        materials: [{
            name: materialId,
            alphaMode: "MASK",
            alphaCutoff: 0.5,
            doubleSided: true,
            extensions: { KHR_materials_unlit: {} },
            pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] },
        }],
        accessors: [
            {
                bufferView: 0,
                byteOffset: 0,
                componentType: 5126,
                count: vertexCount,
                type: "VEC3",
                min: bounds.min,
                max: bounds.max,
            },
            {
                bufferView: 1,
                byteOffset: 0,
                componentType: 5126,
                count: vertexCount,
                type: "VEC2",
            },
            {
                bufferView: 2,
                byteOffset: 0,
                componentType: useUint32 ? 5125 : 5123,
                count: indexCount,
                type: "SCALAR",
            },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: positionOffset, byteLength: positionBytes.length, target: 34962 },
            { buffer: 0, byteOffset: uvOffset, byteLength: uvBytes.length, target: 34962 },
            { buffer: 0, byteOffset: indexOffset, byteLength: indexCount * indexStride, target: 34963 },
        ],
        buffers: [{ byteLength: binLength }],
        extensionsUsed: ["KHR_materials_unlit"],
        extensionsRequired: ["KHR_materials_unlit"],
    };

    const jsonBytes = padTo4(new TextEncoder().encode(JSON.stringify(json)), 0x20);
    const binChunk = padTo4(bin, 0);
    const jsonHeader = new Uint8Array(8);
    writeUint32LE(jsonHeader, 0, jsonBytes.length);
    writeUint32LE(jsonHeader, 4, 0x4e4f534a);
    const binHeader = new Uint8Array(8);
    writeUint32LE(binHeader, 0, binChunk.length);
    writeUint32LE(binHeader, 4, 0x004e4942);
    const header = new Uint8Array(12);
    writeUint32LE(header, 0, 0x46546c67);
    writeUint32LE(header, 4, 2);
    const total = 12 + jsonHeader.length + jsonBytes.length + binHeader.length + binChunk.length;
    writeUint32LE(header, 8, total);
    return concatBytes([header, jsonHeader, jsonBytes, binHeader, binChunk]);
}

export function digestBytes(bytes) {
    return sha256ExactBytes(bytes);
}
