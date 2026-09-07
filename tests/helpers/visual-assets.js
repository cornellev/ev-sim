import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

import {
    VISUAL_ASSET_USE_KIND,
    VISUAL_ASSET_USE_VERSION,
    VISUAL_SOURCE_OPERATIONS,
    hashVisualAssetUse,
    normalizeVisualAssetUse,
    normalizeVisualSourceRegistry,
} from "../../app/simulation/visual/VisualLayer.js";
import { VisualAssetStore } from "../../server/storage/VisualAssetStore.js";
import { PNG_SIGNATURE, KTX2_IDENTIFIER } from "../../server/storage/visual-assets/mediaInspectors.js";

export function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

export function allPermissions(overrides = {}) {
    return {
        ...Object.fromEntries(VISUAL_SOURCE_OPERATIONS.map((operation) => [operation, false])),
        ...overrides,
    };
}

export function ownedGrant(id = "owned-lab", overrides = {}) {
    const { permissions, ...rest } = overrides;
    return {
        id,
        kind: "owned",
        status: "active",
        ancestorIds: [],
        ...rest,
        permissions: allPermissions({
            ...Object.fromEntries(VISUAL_SOURCE_OPERATIONS.map((operation) => [operation, true])),
            ...permissions,
        }),
    };
}

export function restrictedGrant(id, overrides = {}) {
    const { permissions, ...rest } = overrides;
    return {
        id,
        kind: rest.kind ?? "owned",
        status: "active",
        ancestorIds: [],
        ...rest,
        permissions: allPermissions(permissions),
    };
}

export async function writeRegistry(dir, sources) {
    const document = normalizeVisualSourceRegistry({
        kind: "cev-sim.visual-source-registry",
        version: 1,
        sources,
    });
    const filePath = path.join(dir, "visual-source-registry.json");
    await fs.writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`);
    return filePath;
}

export async function createAssetStore(options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-visual-assets-"));
    const sources = options.sources ?? [ownedGrant()];
    const registryPath = await writeRegistry(dir, sources);
    const store = new VisualAssetStore(dir, {
        registryPath,
        limits: options.limits,
        now: options.now,
        faults: options.faults,
    });
    await store.initialize();
    return { dir, store, registryPath };
}

export async function publishAsset(store, bytes, {
    mediaType,
    role,
    sourceIds = ["owned-lab"],
    dependencies = {},
} = {}) {
    const asset = {
        sha256: sha256Hex(bytes),
        mediaType,
        sizeBytes: bytes.length,
        role,
    };
    const upload = await store.createUpload({ asset, sourceIds, dependencies });
    return store.writeUploadContent(upload.id, bytes, { contentLength: bytes.length });
}

export function useRecord(asset, sourceIds, dependencies = {}) {
    return normalizeVisualAssetUse({
        kind: VISUAL_ASSET_USE_KIND,
        version: VISUAL_ASSET_USE_VERSION,
        asset,
        sourceIds,
        dependencies,
    });
}

export function useHashFor(asset, sourceIds, dependencies = {}) {
    return hashVisualAssetUse(useRecord(asset, sourceIds, dependencies));
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBytes = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, crc]);
}

export function makePng({ width = 1, height = 1, red = 0xff, green = 0, blue = 0 } = {}) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const rows = [];
    for (let y = 0; y < height; y += 1) {
        const row = Buffer.alloc(1 + width * 3);
        for (let x = 0; x < width; x += 1) {
            row[1 + x * 3] = red;
            row[2 + x * 3] = green;
            row[3 + x * 3] = blue;
        }
        rows.push(row);
    }
    return Buffer.concat([
        PNG_SIGNATURE,
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

export function makeJpeg({ width = 1, height = 1 } = {}) {
    const sof = Buffer.from([
        0xff, 0xc0, 0x00, 0x0b, 0x08,
        (height >> 8) & 0xff, height & 0xff,
        (width >> 8) & 0xff, width & 0xff,
        0x01, 0x01, 0x11, 0x00,
    ]);
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
        sof,
        Buffer.from([0xff, 0xd9]),
    ]);
}

export function makeKtx2({ width = 4, height = 4 } = {}) {
    const header = Buffer.alloc(80);
    KTX2_IDENTIFIER.copy(header, 0);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(1, 16);
    header.writeUInt32LE(width, 20);
    header.writeUInt32LE(height, 24);
    header.writeUInt32LE(0, 28);
    header.writeUInt32LE(0, 32);
    header.writeUInt32LE(1, 36);
    header.writeUInt32LE(1, 40);
    header.writeUInt32LE(0, 44);
    header.writeUInt32LE(104, 48);
    header.writeUInt32LE(28, 52);
    header.writeUInt32LE(0, 56);
    header.writeUInt32LE(0, 60);
    header.writeBigUInt64LE(0n, 64);
    header.writeBigUInt64LE(0n, 72);
    const level = Buffer.alloc(24);
    level.writeBigUInt64LE(132n, 0);
    level.writeBigUInt64LE(16n, 8);
    level.writeBigUInt64LE(16n, 16);
    const dfd = Buffer.alloc(28);
    dfd.writeUInt32LE(28, 0);
    dfd.writeUInt32LE(0, 4);
    dfd.writeUInt32LE(2 | (24 << 16), 8);
    dfd[12] = 166;
    dfd[13] = 1;
    dfd[14] = 2;
    dfd[15] = 0;
    dfd[16] = 3;
    dfd[17] = 3;
    dfd[20] = 16;
    return Buffer.concat([header, level, dfd, Buffer.alloc(16, 1)]);
}

export function buildGlb(json, bin = Buffer.alloc(0)) {
    const jsonBytes = Buffer.from(JSON.stringify(json));
    const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
    const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonChunk.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    let chunks = Buffer.concat([jsonHeader, jsonChunk]);
    if (bin.length) {
        const binPad = (4 - (bin.length % 4)) % 4;
        const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);
        const binHeader = Buffer.alloc(8);
        binHeader.writeUInt32LE(binChunk.length, 0);
        binHeader.writeUInt32LE(0x004e4942, 4);
        chunks = Buffer.concat([chunks, binHeader, binChunk]);
    }
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + chunks.length, 8);
    return Buffer.concat([header, chunks]);
}

export function triangleGltfJson(bufferLength = 42) {
    return {
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            {
                bufferView: 0,
                componentType: 5126,
                count: 3,
                type: "VEC3",
                max: [1, 1, 0],
                min: [0, 0, 0],
            },
            { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
        ],
        bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 36 },
            { buffer: 0, byteOffset: 36, byteLength: 6 },
        ],
        buffers: [{ byteLength: bufferLength }],
    };
}

export function makeTriangleGlb() {
    const positions = Buffer.alloc(36);
    positions.writeFloatLE(0, 0);
    positions.writeFloatLE(0, 4);
    positions.writeFloatLE(0, 8);
    positions.writeFloatLE(1, 12);
    positions.writeFloatLE(0, 16);
    positions.writeFloatLE(0, 20);
    positions.writeFloatLE(0, 24);
    positions.writeFloatLE(1, 28);
    positions.writeFloatLE(0, 32);
    const indices = Buffer.alloc(6);
    indices.writeUInt16LE(0, 0);
    indices.writeUInt16LE(1, 2);
    indices.writeUInt16LE(2, 4);
    return buildGlb(triangleGltfJson(42), Buffer.concat([positions, indices]));
}

export function makeNamedMaterialGlb(materialName = "brick", { extras = null, secondLod = false } = {}) {
    const json = triangleGltfJson(42);
    json.materials = [{
        name: materialName,
        pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] },
        ...(extras ? { extras } : {}),
    }];
    json.meshes[0].name = "preview-mesh";
    json.meshes[0].primitives[0].material = 0;
    json.nodes[0].name = "preview-node";
    json.nodes[0].extras = extras ?? undefined;
    if (!extras) delete json.nodes[0].extras;
    void secondLod;
    const positions = Buffer.alloc(36);
    positions.writeFloatLE(0, 0);
    positions.writeFloatLE(0, 4);
    positions.writeFloatLE(0, 8);
    positions.writeFloatLE(1, 12);
    positions.writeFloatLE(0, 16);
    positions.writeFloatLE(0, 20);
    positions.writeFloatLE(0, 24);
    positions.writeFloatLE(1, 28);
    positions.writeFloatLE(0, 32);
    const indices = Buffer.alloc(6);
    indices.writeUInt16LE(0, 0);
    indices.writeUInt16LE(1, 2);
    indices.writeUInt16LE(2, 4);
    return buildGlb(json, Buffer.concat([positions, indices]));
}

export function makeTriangleGltfWithBuffer(bufferDigest) {
    const json = triangleGltfJson(42);
    json.buffers = [{ byteLength: 42, uri: `sha256:${bufferDigest}` }];
    return Buffer.from(JSON.stringify(json));
}

export function makeHostileGlb(mutate) {
    const json = triangleGltfJson(42);
    mutate(json);
    const positions = Buffer.alloc(36);
    const indices = Buffer.alloc(6);
    indices.writeUInt16LE(0, 0);
    indices.writeUInt16LE(1, 2);
    indices.writeUInt16LE(2, 4);
    return buildGlb(json, Buffer.concat([positions, indices]));
}
