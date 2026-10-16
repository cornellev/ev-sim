/**
 * Browser-safe vehicle model checks. Server preflight stays sha256:-only.
 * Limits match the visual-asset contract ceilings.
 */

import { sniffImageMediaType } from "../../editor-assets/GltfImportPlan.js";
import { GLB_BIN_CHUNK, GLB_MAGIC, readGlb } from "../../simulation/visual/GlbContainer.js";
import {
    RUN_PACKAGE_PROFILE,
    VISUAL_ALPHA_MODES,
    VISUAL_MATERIAL_EXTENSIONS,
    sha256ExactBytes,
} from "../../simulation/visual/VisualLayer.js";
import { isCanonicalDependencyName } from "../VehicleManifest.js";

const ALLOWED_EXTENSIONS = new Set(VISUAL_MATERIAL_EXTENSIONS);
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KTX2_IDENTIFIER = Object.freeze([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const KTX2_MODEL_ETC1S = 163;
const KTX2_MODEL_UASTC = 166;
const CONTENT_NAME = /^([a-f0-9]{64})\.(glb|png|jpg|ktx2)$/;
const EXTENSION_MEDIA = Object.freeze({
    glb: "model/gltf-binary",
    png: "image/png",
    jpg: "image/jpeg",
    ktx2: "image/ktx2",
});

/** Copies of VISUAL_ASSET_CONTRACT_CEILINGS fields that RUN_PACKAGE_PROFILE does not carry. */
export const VEHICLE_MODEL_LIMITS = Object.freeze({
    ...RUN_PACKAGE_PROFILE.limits,
    gltfJsonBytes: 32 * 1024 * 1024,
    decodedClosureBytes: 4 * 1024 ** 3,
});

function bytesOf(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("Vehicle model bytes are required.");
}

function dataView(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u32le(bytes, offset) {
    if (offset + 4 > bytes.length) throw new Error("Truncated binary header.");
    return dataView(bytes).getUint32(offset, true);
}

function u32be(bytes, offset) {
    if (offset + 4 > bytes.length) throw new Error("Truncated binary header.");
    return dataView(bytes).getUint32(offset, false);
}

function u16be(bytes, offset) {
    if (offset + 2 > bytes.length) throw new Error("Truncated binary header.");
    return dataView(bytes).getUint16(offset, false);
}

function u64le(bytes, offset) {
    if (offset + 8 > bytes.length) throw new Error("Truncated binary header.");
    const lo = u32le(bytes, offset);
    const hi = u32le(bytes, offset + 4);
    if (hi > 0xfffff) throw new Error("Binary offset exceeds the safe integer range.");
    const value = hi * 0x100000000 + lo;
    if (!Number.isSafeInteger(value)) throw new Error("Binary offset exceeds the safe integer range.");
    return value;
}

function startsWith(bytes, signature) {
    return signature.every((value, index) => bytes[index] === value);
}

function hasItems(value) {
    return Array.isArray(value) && value.length > 0;
}

function enumerate(value) {
    return Array.isArray(value) ? value.entries() : [];
}

function assertSafeCount(value, path) {
    if (value === undefined || value === null) return;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${path} must be a non-negative safe integer.`);
    }
}

function assertDeadline(deadline) {
    if (deadline !== Infinity && Date.now() > deadline) {
        throw new Error("glTF preflight validation exceeded its time limit.");
    }
}

function assertTextureDimensions(width, height, mipLevels, limits) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw new Error("Texture dimensions must be positive safe integers.");
    }
    if (width > limits.textureDimension || height > limits.textureDimension) {
        throw new Error(`Texture dimensions ${width}x${height} exceed the ${limits.textureDimension}-pixel ceiling.`);
    }
    if (mipLevels > limits.textureMipLevels) {
        throw new Error(`Texture mip count exceeds the ${limits.textureMipLevels}-level ceiling.`);
    }
}

function inspectPngBytes(bytes, limits) {
    if (bytes.length < 8 || !startsWith(bytes, PNG_SIGNATURE)) throw new Error("PNG signature is missing or corrupt.");
    let offset = 8;
    let header = null;
    while (offset + 12 <= bytes.length) {
        const length = u32be(bytes, offset);
        const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length || length > bytes.length) throw new Error("PNG chunk is truncated or overflows the file.");
        if (type === "IHDR") {
            if (header) throw new Error("PNG contains more than one IHDR chunk.");
            if (length !== 13) throw new Error("PNG IHDR chunk is not 13 bytes.");
            header = {
                width: u32be(bytes, dataStart),
                height: u32be(bytes, dataStart + 4),
                bitDepth: bytes[dataStart + 8],
                colorType: bytes[dataStart + 9],
            };
        }
        offset = dataEnd + 4;
        if (type === "IEND") break;
    }
    if (!header) throw new Error("PNG is missing an IHDR chunk.");
    assertTextureDimensions(header.width, header.height, 1, limits);
    const channels = header.colorType === 6 || header.colorType === 4 ? 4 : header.colorType === 2 ? 3 : 1;
    const bytesPerSample = header.bitDepth > 8 ? 2 : 1;
    return {
        mediaType: "image/png",
        width: header.width,
        height: header.height,
        mipLevels: 1,
        decodedBytesEstimate: header.width * header.height * Math.max(4, channels) * bytesPerSample,
    };
}

function inspectJpegBytes(bytes, limits) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("JPEG SOI marker is missing.");
    let offset = 2;
    let header = null;
    while (offset + 1 < bytes.length) {
        if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        let marker = bytes[offset + 1];
        while (marker === 0xff && offset + 1 < bytes.length) {
            offset += 1;
            marker = bytes[offset + 1];
        }
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
        }
        if (offset + 3 >= bytes.length) throw new Error("JPEG marker is truncated.");
        const size = u16be(bytes, offset + 2);
        if (size < 2 || offset + 2 + size > bytes.length) throw new Error("JPEG marker length overflows the file.");
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (size < 8) throw new Error("JPEG SOF segment is too short.");
            const precision = bytes[offset + 4];
            header = {
                width: u16be(bytes, offset + 7),
                height: u16be(bytes, offset + 5),
                precision,
            };
        }
        offset += 2 + size;
    }
    if (!header) throw new Error("JPEG is missing an SOF dimension marker.");
    assertTextureDimensions(header.width, header.height, 1, limits);
    return {
        mediaType: "image/jpeg",
        width: header.width,
        height: header.height,
        mipLevels: 1,
        decodedBytesEstimate: header.width * header.height * 4 * (header.precision > 8 ? 2 : 1),
    };
}

function assertSection(fileLength, offset, length, label) {
    if (length === 0 && offset === 0) return;
    if (offset + length > fileLength) throw new Error(`KTX2 ${label} section overflows the file.`);
}

function mipChainBytes(width, height, levels) {
    let total = 0;
    let w = width;
    let h = height;
    for (let index = 0; index < levels; index += 1) {
        total += w * h * 4;
        w = Math.max(1, Math.floor(w / 2));
        h = Math.max(1, Math.floor(h / 2));
    }
    return total;
}

function inspectKtx2Bytes(bytes, limits) {
    if (bytes.length < 104 || !startsWith(bytes, KTX2_IDENTIFIER)) {
        throw new Error("KTX2 identifier is missing or the header is truncated.");
    }
    const pixelWidth = u32le(bytes, 20);
    const pixelHeight = u32le(bytes, 24);
    const pixelDepth = u32le(bytes, 28);
    const layerCount = u32le(bytes, 32);
    const faceCount = u32le(bytes, 36);
    const levelCount = u32le(bytes, 40);
    const supercompressionScheme = u32le(bytes, 44);
    const dfdByteOffset = u32le(bytes, 48);
    const dfdByteLength = u32le(bytes, 52);
    const kvdByteOffset = u32le(bytes, 56);
    const kvdByteLength = u32le(bytes, 60);
    const sgdByteOffset = u64le(bytes, 64);
    const sgdByteLength = u64le(bytes, 72);
    if (u32le(bytes, 12) !== 0) throw new Error("KTX2 vkFormat must be UNDEFINED for the reviewed Basis/UASTC profile.");
    if (u32le(bytes, 16) !== 1) throw new Error("KTX2 typeSize must be 1 for the reviewed Basis/UASTC profile.");
    if (pixelDepth !== 0) throw new Error("KTX2 3D textures are not permitted.");
    if (layerCount !== 0) throw new Error("KTX2 array textures are not permitted.");
    if (faceCount !== 1) throw new Error("KTX2 cubemaps are not permitted.");
    if (levelCount < 1 || levelCount > limits.textureMipLevels) {
        throw new Error(`KTX2 mip count ${levelCount} exceeds the ${limits.textureMipLevels}-level ceiling.`);
    }
    assertTextureDimensions(pixelWidth, pixelHeight, levelCount, limits);
    const maxMips = Math.floor(Math.log2(Math.max(pixelWidth, pixelHeight))) + 1;
    if (levelCount > maxMips) throw new Error("KTX2 mip count exceeds the dimensions.");
    const levelIndexOffset = 80;
    const levelIndexBytes = levelCount * 24;
    if (levelIndexOffset + levelIndexBytes > bytes.length) throw new Error("KTX2 level index is truncated.");
    const levels = [];
    let decodedBytesEstimate = 0;
    for (let index = 0; index < levelCount; index += 1) {
        const entry = levelIndexOffset + index * 24;
        const byteOffset = u64le(bytes, entry);
        const byteLength = u64le(bytes, entry + 8);
        const uncompressedByteLength = u64le(bytes, entry + 16);
        if (byteOffset + byteLength > bytes.length) throw new Error("KTX2 mip level overflows the file.");
        if (uncompressedByteLength > limits.decodedClosureBytes) {
            throw new Error("KTX2 uncompressed mip length exceeds the decoded-size budget.");
        }
        decodedBytesEstimate += uncompressedByteLength || byteLength;
        levels.push([byteOffset, byteLength]);
    }
    const ordered = [...levels].sort((left, right) => left[0] - right[0]);
    let cursor = 0;
    for (const [start, length] of ordered) {
        if (start < cursor) throw new Error("KTX2 mip ranges overlap.");
        cursor = start + length;
    }
    assertSection(bytes.length, dfdByteOffset, dfdByteLength, "DFD");
    assertSection(bytes.length, kvdByteOffset, kvdByteLength, "KVD");
    assertSection(bytes.length, sgdByteOffset, sgdByteLength, "SGD");
    if (dfdByteLength < 16) throw new Error("KTX2 DFD is too short.");
    if (u32le(bytes, dfdByteOffset) !== dfdByteLength) throw new Error("KTX2 DFD total size does not match the index.");
    const colorModel = bytes[dfdByteOffset + 12];
    const allowed = (
        (supercompressionScheme === 1 && colorModel === KTX2_MODEL_ETC1S)
        || (supercompressionScheme === 0 && colorModel === KTX2_MODEL_UASTC)
        || (supercompressionScheme === 2 && colorModel === KTX2_MODEL_UASTC)
    );
    if (!allowed) throw new Error("KTX2 must use the reviewed Basis ETC1S or UASTC profile.");
    if (supercompressionScheme === 1 && sgdByteLength === 0) {
        throw new Error("BasisLZ KTX2 files must include a supercompression global data section.");
    }
    return {
        mediaType: "image/ktx2",
        width: pixelWidth,
        height: pixelHeight,
        mipLevels: levelCount,
        decodedBytesEstimate: Math.max(decodedBytesEstimate, mipChainBytes(pixelWidth, pixelHeight, levelCount)),
    };
}

/** PNG, JPEG, and KTX2 dimension checks used by the vehicle closure. */
export function inspectVehicleImage(bytes, limits = VEHICLE_MODEL_LIMITS) {
    const source = bytesOf(bytes);
    const mediaType = sniffImageMediaType(source);
    if (mediaType === "image/png") return inspectPngBytes(source, limits);
    if (mediaType === "image/jpeg") return inspectJpegBytes(source, limits);
    if (mediaType === "image/ktx2") return inspectKtx2Bytes(source, limits);
    throw new Error(`Embedded image must be PNG, JPEG, or KTX2.`);
}

function assertNodeTransform(node, path) {
    if (node?.matrix) {
        if (!Array.isArray(node.matrix) || node.matrix.length !== 16) {
            throw new Error(`${path}.matrix must be a 16-number affine matrix.`);
        }
        for (const [index, entry] of node.matrix.entries()) {
            if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`${path}.matrix.${index} must be finite.`);
        }
        if (node.matrix[3] !== 0 || node.matrix[7] !== 0 || node.matrix[11] !== 0 || node.matrix[15] !== 1) {
            throw new Error(`${path}.matrix must be a column-major affine matrix.`);
        }
    }
    for (const field of ["translation", "rotation", "scale"]) {
        const values = node?.[field];
        if (!values) continue;
        if (!Array.isArray(values)) throw new Error(`${path}.${field} must be an array.`);
        for (const [index, entry] of values.entries()) {
            if (typeof entry !== "number" || !Number.isFinite(entry)) throw new Error(`${path}.${field}.${index} must be finite.`);
        }
    }
}

function assertRestrictedGraph(value, limits, deadline) {
    const maxObjects = Math.max(4096, limits.nodesPerMesh * 16);
    const maxDepth = limits.graphDepth + 16;
    const pending = [{ value, path: "gltf", depth: 0 }];
    let visited = 0;
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current.value || typeof current.value !== "object") continue;
        visited += 1;
        if ((visited & 1023) === 0) assertDeadline(deadline);
        if (visited > maxObjects || current.depth > maxDepth) {
            throw new Error("glTF object graph exceeds the bounded validation profile.");
        }
        if (Array.isArray(current.value)) {
            for (let index = current.value.length - 1; index >= 0; index -= 1) {
                pending.push({ value: current.value[index], path: `${current.path}.${index}`, depth: current.depth + 1 });
            }
            continue;
        }
        if (Object.hasOwn(current.value, "extras")) throw new Error(`${current.path}.extras is not permitted in visual profile v1.`);
        if (current.value.extensions !== undefined) {
            if (!current.value.extensions || typeof current.value.extensions !== "object" || Array.isArray(current.value.extensions)) {
                throw new Error(`${current.path}.extensions must be an object.`);
            }
            for (const extension of Object.keys(current.value.extensions)) {
                if (!ALLOWED_EXTENSIONS.has(extension)) {
                    throw new Error(`${current.path}.extensions.${extension} is not permitted.`);
                }
            }
        }
        for (const [key, child] of Object.entries(current.value)) {
            pending.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
        }
    }
}

function sceneGraphDepth(json, limit, deadline) {
    const nodes = json.nodes ?? [];
    const indegree = new Uint32Array(nodes.length);
    const depth = new Uint32Array(nodes.length);
    for (const [index, node] of nodes.entries()) {
        if ((index & 1023) === 0) assertDeadline(deadline);
        for (const child of node?.children ?? []) {
            if (!Number.isInteger(child) || child < 0 || child >= nodes.length) {
                throw new Error(`nodes.${index} contains an out-of-range child.`);
            }
            indegree[child] += 1;
        }
    }
    const queue = [];
    for (let index = 0; index < nodes.length; index += 1) {
        if (indegree[index] === 0) {
            queue.push(index);
            depth[index] = 1;
        }
    }
    let processed = 0;
    let max = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
        if ((cursor & 1023) === 0) assertDeadline(deadline);
        const index = queue[cursor];
        processed += 1;
        max = Math.max(max, depth[index]);
        if (depth[index] > limit) throw new Error(`glTF scene graph depth exceeds the ${limit} ceiling.`);
        for (const child of nodes[index]?.children ?? []) {
            depth[child] = Math.max(depth[child], depth[index] + 1);
            indegree[child] -= 1;
            if (indegree[child] === 0) queue.push(child);
        }
    }
    if (processed !== nodes.length) throw new Error("glTF node graph contains a cycle.");
    return max;
}

/** Structural glTF rules shared with visual preflight. URI scheme is not checked here. */
export function assertVehicleGltfGraph(json, limits = VEHICLE_MODEL_LIMITS, deadline = Infinity) {
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("glTF JSON must be an object.");
    if (json.asset?.version !== "2.0") throw new Error("Only glTF 2.0 assets are accepted.");
    assertRestrictedGraph(json, limits, deadline);
    if (hasItems(json.animations)) throw new Error("Animation is not permitted in visual profile v1.");
    if (hasItems(json.skins)) throw new Error("Skins are not permitted in visual profile v1.");
    for (const [index, mesh] of enumerate(json.meshes)) {
        for (const [primitiveIndex, primitive] of enumerate(mesh?.primitives)) {
            if (hasItems(primitive?.targets)) {
                throw new Error(`meshes.${index}.primitives.${primitiveIndex} morph targets are not permitted.`);
            }
        }
    }
    for (const [index, node] of enumerate(json.nodes)) {
        if (node?.skin !== undefined) throw new Error(`nodes.${index}.skin is not permitted.`);
        if (hasItems(node?.weights)) throw new Error(`nodes.${index}.weights morph weights are not permitted.`);
        assertNodeTransform(node, `nodes.${index}`);
    }
    for (const [index, material] of enumerate(json.materials)) {
        const alphaMode = material?.alphaMode ?? "OPAQUE";
        if (!VISUAL_ALPHA_MODES.includes(alphaMode)) {
            throw new Error(`materials.${index}.alphaMode ${JSON.stringify(alphaMode)} is not permitted.`);
        }
    }
    for (const extension of [...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]) {
        if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error(`glTF extension ${JSON.stringify(extension)} is not permitted.`);
    }
    const accessors = json.accessors ?? [];
    const bufferViews = json.bufferViews ?? [];
    const buffers = json.buffers ?? [];
    for (const [index, buffer] of enumerate(buffers)) assertSafeCount(buffer?.byteLength, `buffers.${index}.byteLength`);
    for (const [index, view] of enumerate(bufferViews)) {
        const buffer = buffers[view?.buffer];
        if (!buffer) throw new Error(`bufferViews.${index} references a missing buffer.`);
        const offset = Number(view.byteOffset) || 0;
        const length = Number(view.byteLength) || 0;
        assertSafeCount(offset, `bufferViews.${index}.byteOffset`);
        assertSafeCount(length, `bufferViews.${index}.byteLength`);
        if (offset + length > (Number(buffer.byteLength) || 0)) throw new Error(`bufferViews.${index} overflows its buffer.`);
    }
    let triangles = 0;
    let vertices = 0;
    for (const [meshIndex, mesh] of enumerate(json.meshes)) {
        let meshTriangles = 0;
        let meshVertices = 0;
        for (const [primitiveIndex, primitive] of enumerate(mesh?.primitives)) {
            const mode = primitive?.mode ?? 4;
            if (mode !== 4) throw new Error(`meshes.${meshIndex}.primitives.${primitiveIndex} must use TRIANGLES topology.`);
            const position = primitive?.attributes?.POSITION;
            if (position === undefined) throw new Error(`meshes.${meshIndex}.primitives.${primitiveIndex} is missing POSITION.`);
            const count = Number(accessors[position]?.count) || 0;
            meshVertices += count;
            if (primitive.indices !== undefined) {
                const indexCount = Number(accessors[primitive.indices]?.count) || 0;
                if (indexCount % 3 !== 0) throw new Error("Indexed triangle accessors must be a multiple of 3.");
                meshTriangles += indexCount / 3;
            } else {
                if (count % 3 !== 0) throw new Error("Unindexed triangle accessors must be a multiple of 3.");
                meshTriangles += count / 3;
            }
        }
        if (meshVertices > limits.nodesPerMesh) {
            throw new Error(`Mesh ${meshIndex} has ${meshVertices} vertices, exceeding the ${limits.nodesPerMesh} ceiling.`);
        }
        if (meshTriangles > limits.trianglesPerMesh) {
            throw new Error(`Mesh ${meshIndex} has ${meshTriangles} triangles, exceeding the ${limits.trianglesPerMesh} ceiling.`);
        }
        triangles += meshTriangles;
        vertices += meshVertices;
    }
    const nodeCount = (json.nodes ?? []).length;
    if (nodeCount > limits.nodesPerMesh) {
        throw new Error(`glTF node count ${nodeCount} exceeds the ${limits.nodesPerMesh} ceiling.`);
    }
    const depth = sceneGraphDepth(json, limits.graphDepth, deadline);
    return { nodeCount, vertices, triangles, depth };
}

function resolvedLimits(overrides) {
    return overrides ? { ...VEHICLE_MODEL_LIMITS, ...overrides } : VEHICLE_MODEL_LIMITS;
}

function assertAssetBudget(bytes, limits, label) {
    if (bytes.byteLength > limits.assetBytes) {
        throw new Error(`${label} exceeds the ${limits.assetBytes}-byte ceiling.`);
    }
}

/**
 * Check one fetched model member. Content-addressed names must match the bytes.
 * Version 2 URL loads do not use this.
 */
export function assertVehicleMemberBytes(member, bytes) {
    const data = bytesOf(bytes);
    const digest = sha256ExactBytes(data);
    const name = String(member?.name ?? "");
    if (member?.sha256 && member.sha256 !== digest) {
        throw new Error(`Vehicle model member "${name || member?.url}" failed byte identity verification.`);
    }
    const named = CONTENT_NAME.exec(name);
    if (named && named[1] !== digest) {
        throw new Error(`Vehicle model member "${name}" failed byte identity verification.`);
    }
    if (member?.size != null && Number(member.size) !== data.byteLength) {
        throw new Error(`Vehicle model member "${name}" size does not match its bytes.`);
    }
    const extension = named?.[2];
    if (extension === "glb" || member?.mediaType === "model/gltf-binary") {
        if (data.length < 12 || u32le(data, 0) !== GLB_MAGIC) {
            throw new Error(`Vehicle model member "${name}" is not a GLB.`);
        }
        if (member?.mediaType && member.mediaType !== "model/gltf-binary") {
            throw new Error(`Vehicle model member "${name}" media type does not match its bytes.`);
        }
    } else if (extension || (typeof member?.mediaType === "string" && member.mediaType.startsWith("image/"))) {
        let sniffed;
        try {
            sniffed = sniffImageMediaType(data);
        } catch (error) {
            throw new Error(`Vehicle model member "${name}" ${error.message}`);
        }
        const expected = extension ? EXTENSION_MEDIA[extension] : member.mediaType;
        if (sniffed !== expected || (member?.mediaType && member.mediaType !== sniffed)) {
            throw new Error(`Vehicle model member "${name}" media type does not match its bytes.`);
        }
    }
    return data;
}

function vehicleNodeTable(json) {
    const nodes = json?.nodes ?? [];
    const parents = Array.from({ length: nodes.length }, () => -1);
    nodes.forEach((node, index) => {
        for (const child of node?.children ?? []) {
            if (!Number.isInteger(child) || child < 0 || child >= nodes.length) continue;
            if (parents[child] === -1) parents[child] = index;
        }
    });
    return { count: nodes.length, parents };
}

/**
 * Describe one staged vehicle file. Content-addressed names must match the
 * bytes. Other package names stay opaque so legacy bundles can be staged.
 */
export function describeVehicleStageMember(name, bytes) {
    const data = bytesOf(bytes);
    if (data.byteLength === 0) throw new Error("Vehicle stage member is empty.");
    if (!isCanonicalDependencyName(name)) {
        throw new Error(`Invalid vehicle stage member name ${JSON.stringify(name)}.`);
    }
    const digest = sha256ExactBytes(data);
    const named = CONTENT_NAME.exec(name);
    if (named) {
        assertVehicleMemberBytes({ name, sha256: digest, size: data.byteLength }, data);
        return {
            name,
            sha256: digest,
            size: data.byteLength,
            mediaType: EXTENSION_MEDIA[named[2]],
        };
    }
    let mediaType = "application/octet-stream";
    try {
        mediaType = sniffImageMediaType(data);
    } catch {
        if (data.length >= 4 && data[0] === 0x67 && data[1] === 0x6c && data[2] === 0x54 && data[3] === 0x46) {
            mediaType = "model/gltf-binary";
        }
    }
    return { name, sha256: digest, size: data.byteLength, mediaType };
}

/**
 * Validate a packed vehicle GLB and its sibling image files.
 * Image URIs must be `<sha256>.png`, `<sha256>.jpg`, or `<sha256>.ktx2`.
 */
export function validateVehicleModelClosure({ glbBytes, dependencies = [], limits: limitOverrides = null } = {}) {
    const limits = resolvedLimits(limitOverrides);
    const source = bytesOf(glbBytes);
    assertAssetBudget(source, limits, "Canonical GLB");
    const parsed = readGlb(source, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
        copyChunks: true,
        ErrorType: Error,
        headerMessage: "Canonical GLB has an invalid version-2 header.",
        chunkMessage: "Canonical GLB has an invalid chunk table.",
    });
    if (parsed.jsonChunk.length > limits.gltfJsonBytes) {
        throw new Error(`glTF JSON exceeds the ${limits.gltfJsonBytes}-byte limit.`);
    }
    const graph = assertVehicleGltfGraph(parsed.json, limits);
    const bin = parsed.chunks.find((chunk) => chunk.type === GLB_BIN_CHUNK)?.bytes ?? parsed.bin ?? null;
    for (const [index, buffer] of enumerate(parsed.json.buffers)) {
        if (buffer?.uri) throw new Error(`buffers.${index} must be packed into the GLB BIN chunk.`);
    }
    for (const [index, view] of enumerate(parsed.json.bufferViews)) {
        if (bin && view?.buffer === 0 && !parsed.json.buffers?.[view.buffer]?.uri) {
            const end = (Number(view.byteOffset) || 0) + (Number(view.byteLength) || 0);
            if (end > bin.length) throw new Error(`bufferViews.${index} overflows the GLB BIN chunk.`);
        }
    }
    const declared = new Map();
    for (const entry of dependencies) {
        if (!entry?.name || declared.has(entry.name)) throw new Error(`Duplicate dependency "${entry?.name}".`);
        if (!isCanonicalDependencyName(entry.name) || !CONTENT_NAME.test(entry.name) || entry.name.endsWith(".glb")) {
            throw new Error(`Dependency "${entry.name}" must be a content-addressed sibling filename.`);
        }
        declared.set(entry.name, entry);
    }
    const referenced = new Set();
    let decodedBytesEstimate = Number(parsed.json.buffers?.[0]?.byteLength) || bin?.length || 0;
    for (const [index, image] of enumerate(parsed.json.images)) {
        const uri = image?.uri;
        if (typeof uri !== "string" || !CONTENT_NAME.test(uri) || uri.endsWith(".glb") || !isCanonicalDependencyName(uri)) {
            throw new Error(`images.${index}.uri must be a content-addressed sibling filename.`);
        }
        const entry = declared.get(uri);
        if (!entry) throw new Error(`Image "${uri}" does not match a declared dependency.`);
        referenced.add(uri);
        const imageBytes = bytesOf(entry.bytes);
        assertAssetBudget(imageBytes, limits, `Dependency "${uri}"`);
        const digest = sha256ExactBytes(imageBytes);
        if (digest !== uri.slice(0, 64) || (entry.sha256 && entry.sha256 !== digest)) {
            throw new Error(`Dependency "${uri}" failed byte identity verification.`);
        }
        const inspected = inspectVehicleImage(imageBytes, limits);
        const extension = uri.split(".").at(-1);
        if (inspected.mediaType !== EXTENSION_MEDIA[extension] || (entry.mediaType && entry.mediaType !== inspected.mediaType)) {
            throw new Error(`Dependency "${uri}" media type does not match its bytes.`);
        }
        decodedBytesEstimate += inspected.decodedBytesEstimate;
    }
    for (const name of declared.keys()) {
        if (!referenced.has(name)) throw new Error(`Dependency "${name}" is not referenced by the model.`);
    }
    if (decodedBytesEstimate > limits.decodedClosureBytes) {
        throw new Error(`Decoded model closure exceeds the ${limits.decodedClosureBytes}-byte ceiling.`);
    }
    return { ...graph, decodedBytesEstimate, nodeTable: vehicleNodeTable(parsed.json) };
}
