import { VISUAL_ASSET_ERROR_CODES, visualAssetError } from "../StorageErrors.js";

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_SOI = Buffer.from([0xff, 0xd8]);
export const KTX2_IDENTIFIER = Buffer.from([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
]);
export const GLB_MAGIC = 0x46546c67;
export const GLB_JSON_CHUNK = 0x4e4f534a;
export const GLB_BIN_CHUNK = 0x004e4942;

const KTX2_MODEL_ETC1S = 163;
const KTX2_MODEL_UASTC = 166;
const KTX2_SUPERCOMPRESSION_NONE = 0;
const KTX2_SUPERCOMPRESSION_BASISLZ = 1;
const KTX2_SUPERCOMPRESSION_ZSTD = 2;

function mediaError(message) {
    return visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_MEDIA, message);
}

function graphError(message) {
    return visualAssetError(VISUAL_ASSET_ERROR_CODES.INVALID_GRAPH, message);
}

function readU32(bytes, offset) {
    if (offset + 4 > bytes.length) throw mediaError("Truncated binary header.");
    return bytes.readUInt32LE(offset);
}

function readU64(bytes, offset) {
    if (offset + 8 > bytes.length) throw mediaError("Truncated binary header.");
    const lo = bytes.readUInt32LE(offset);
    const hi = bytes.readUInt32LE(offset + 4);
    if (hi > 0xfffff) throw mediaError("Binary offset exceeds the safe integer range.");
    const value = hi * 0x100000000 + lo;
    if (!Number.isSafeInteger(value)) throw mediaError("Binary offset exceeds the safe integer range.");
    return value;
}

export function sniffMediaType(bytes) {
    if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
    if (bytes.length >= 12 && bytes.subarray(0, 12).equals(KTX2_IDENTIFIER)) return "image/ktx2";
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === GLB_MAGIC) return "model/gltf-binary";
    const start = bytes.subarray(0, Math.min(bytes.length, 8)).toString("utf8").trimStart();
    if (start.startsWith("{") || start.startsWith("[")) return "model/gltf+json";
    return "application/octet-stream";
}

export function inspectVisualAssetBytes(bytes, mediaType, limits) {
    if (mediaType === "image/png") return inspectPng(bytes, limits);
    if (mediaType === "image/jpeg") return inspectJpeg(bytes, limits);
    if (mediaType === "image/ktx2") return inspectKtx2(bytes, limits);
    if (mediaType === "model/gltf-binary") return inspectGlbContainer(bytes, limits);
    if (mediaType === "model/gltf+json") {
        if (bytes.length > limits.gltfJsonBytes) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                `glTF JSON exceeds the ${limits.gltfJsonBytes}-byte limit.`,
            );
        }
        return {
            mediaType,
            width: 0,
            height: 0,
            mipLevels: 0,
            decodedBytesEstimate: bytes.length,
            jsonBytes: bytes,
            binBytes: null,
        };
    }
    if (mediaType === "application/octet-stream") {
        return { mediaType, width: 0, height: 0, mipLevels: 0, decodedBytesEstimate: bytes.length };
    }
    throw mediaError(`Unsupported visual asset media type ${mediaType}.`);
}

export function inspectPng(bytes, limits) {
    if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw mediaError("PNG signature is missing or corrupt.");
    }
    let offset = 8;
    let header = null;
    while (offset + 12 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString("ascii", offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;
        if (dataEnd + 4 > bytes.length || length > bytes.length) {
            throw mediaError("PNG chunk is truncated or overflows the file.");
        }
        if (type === "IHDR") {
            if (header) throw mediaError("PNG contains more than one IHDR chunk.");
            if (length !== 13) throw mediaError("PNG IHDR chunk is not 13 bytes.");
            const width = bytes.readUInt32BE(dataStart);
            const height = bytes.readUInt32BE(dataStart + 4);
            const bitDepth = bytes[dataStart + 8];
            const colorType = bytes[dataStart + 9];
            header = { width, height, bitDepth, colorType };
        }
        offset = dataEnd + 4;
        if (type === "IEND") break;
    }
    if (!header) throw mediaError("PNG is missing an IHDR chunk.");
    assertTextureDimensions(header.width, header.height, 1, limits);
    const channels = header.colorType === 6 || header.colorType === 4 ? 4 : header.colorType === 2 ? 3 : 1;
    const bytesPerSample = header.bitDepth > 8 ? 2 : 1;
    const decodedBytesEstimate = header.width * header.height * Math.max(4, channels) * bytesPerSample;
    return {
        mediaType: "image/png",
        width: header.width,
        height: header.height,
        mipLevels: 1,
        decodedBytesEstimate,
        bitDepth: header.bitDepth,
        colorType: header.colorType,
    };
}

export function inspectJpeg(bytes, limits) {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw mediaError("JPEG SOI marker is missing.");
    }
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
        if (offset + 3 >= bytes.length) throw mediaError("JPEG marker is truncated.");
        const size = bytes.readUInt16BE(offset + 2);
        if (size < 2 || offset + 2 + size > bytes.length) throw mediaError("JPEG marker length overflows the file.");
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            if (size < 8) throw mediaError("JPEG SOF segment is too short.");
            const precision = bytes[offset + 4];
            const height = bytes.readUInt16BE(offset + 5);
            const width = bytes.readUInt16BE(offset + 7);
            header = { width, height, precision };
        }
        offset += 2 + size;
    }
    if (!header) throw mediaError("JPEG is missing an SOF dimension marker.");
    assertTextureDimensions(header.width, header.height, 1, limits);
    const decodedBytesEstimate = header.width * header.height * 4 * (header.precision > 8 ? 2 : 1);
    return {
        mediaType: "image/jpeg",
        width: header.width,
        height: header.height,
        mipLevels: 1,
        decodedBytesEstimate,
        precision: header.precision,
    };
}

export function inspectKtx2(bytes, limits) {
    if (bytes.length < 104 || !bytes.subarray(0, 12).equals(KTX2_IDENTIFIER)) {
        throw mediaError("KTX2 identifier is missing or the header is truncated.");
    }
    const vkFormat = readU32(bytes, 12);
    const typeSize = readU32(bytes, 16);
    const pixelWidth = readU32(bytes, 20);
    const pixelHeight = readU32(bytes, 24);
    const pixelDepth = readU32(bytes, 28);
    const layerCount = readU32(bytes, 32);
    const faceCount = readU32(bytes, 36);
    const levelCount = readU32(bytes, 40);
    const supercompressionScheme = readU32(bytes, 44);
    const dfdByteOffset = readU32(bytes, 48);
    const dfdByteLength = readU32(bytes, 52);
    const kvdByteOffset = readU32(bytes, 56);
    const kvdByteLength = readU32(bytes, 60);
    const sgdByteOffset = readU64(bytes, 64);
    const sgdByteLength = readU64(bytes, 72);
    if (vkFormat !== 0) throw mediaError("KTX2 vkFormat must be UNDEFINED for the reviewed Basis/UASTC profile.");
    if (typeSize !== 1) throw mediaError("KTX2 typeSize must be 1 for the reviewed Basis/UASTC profile.");
    if (pixelDepth !== 0) throw mediaError("KTX2 3D textures are not permitted.");
    if (layerCount !== 0) throw mediaError("KTX2 array textures are not permitted.");
    if (faceCount !== 1) throw mediaError("KTX2 cubemaps are not permitted.");
    if (levelCount < 1 || levelCount > limits.textureMipLevels) {
        throw mediaError(`KTX2 mip count ${levelCount} exceeds the ${limits.textureMipLevels}-level ceiling.`);
    }
    assertTextureDimensions(pixelWidth, pixelHeight, levelCount, limits);
    const maxMips = Math.floor(Math.log2(Math.max(pixelWidth, pixelHeight))) + 1;
    if (levelCount > maxMips) throw mediaError("KTX2 mip count exceeds the dimensions.");

    const levelIndexOffset = 80;
    const levelIndexBytes = levelCount * 24;
    if (levelIndexOffset + levelIndexBytes > bytes.length) throw mediaError("KTX2 level index is truncated.");
    const levels = [];
    let decodedBytesEstimate = 0;
    for (let index = 0; index < levelCount; index += 1) {
        const entry = levelIndexOffset + index * 24;
        const byteOffset = readU64(bytes, entry);
        const byteLength = readU64(bytes, entry + 8);
        const uncompressedByteLength = readU64(bytes, entry + 16);
        if (byteOffset + byteLength > bytes.length) throw mediaError("KTX2 mip level overflows the file.");
        if (uncompressedByteLength > limits.decodedClosureBytes) {
            throw visualAssetError(
                VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                "KTX2 uncompressed mip length exceeds the decoded-size budget.",
            );
        }
        decodedBytesEstimate += uncompressedByteLength || byteLength;
        levels.push({ byteOffset, byteLength, uncompressedByteLength });
    }
    assertNonOverlappingRanges(levels.map((level) => [level.byteOffset, level.byteLength]), "KTX2 mip");
    assertSectionInFile(bytes.length, dfdByteOffset, dfdByteLength, "DFD");
    assertSectionInFile(bytes.length, kvdByteOffset, kvdByteLength, "KVD");
    assertSectionInFile(bytes.length, sgdByteOffset, sgdByteLength, "SGD");
    if (dfdByteLength < 16) throw mediaError("KTX2 DFD is too short.");
    const dfdTotalSize = readU32(bytes, dfdByteOffset);
    if (dfdTotalSize !== dfdByteLength) throw mediaError("KTX2 DFD total size does not match the index.");
    const colorModel = bytes[dfdByteOffset + 12];
    const allowed = (
        (supercompressionScheme === KTX2_SUPERCOMPRESSION_BASISLZ && colorModel === KTX2_MODEL_ETC1S)
        || (supercompressionScheme === KTX2_SUPERCOMPRESSION_NONE && colorModel === KTX2_MODEL_UASTC)
        || (supercompressionScheme === KTX2_SUPERCOMPRESSION_ZSTD && colorModel === KTX2_MODEL_UASTC)
    );
    if (!allowed) {
        throw mediaError("KTX2 must use the reviewed Basis ETC1S or UASTC profile.");
    }
    if (supercompressionScheme === KTX2_SUPERCOMPRESSION_BASISLZ && sgdByteLength === 0) {
        throw mediaError("BasisLZ KTX2 files must include a supercompression global data section.");
    }
    const rgbaEstimate = mipChainBytes(pixelWidth, pixelHeight, levelCount);
    return {
        mediaType: "image/ktx2",
        width: pixelWidth,
        height: pixelHeight,
        mipLevels: levelCount,
        decodedBytesEstimate: Math.max(decodedBytesEstimate, rgbaEstimate),
        colorModel,
        supercompressionScheme,
        levels,
    };
}

export function inspectGlbContainer(bytes, limits) {
    if (bytes.length < 12) throw mediaError("GLB header is truncated.");
    if (bytes.readUInt32LE(0) !== GLB_MAGIC) throw mediaError("GLB magic is not glTF.");
    if (bytes.readUInt32LE(4) !== 2) throw mediaError("Only glTF 2.0 binary containers are accepted.");
    const declaredLength = bytes.readUInt32LE(8);
    if (declaredLength !== bytes.length) throw mediaError("GLB header length does not match the file size.");
    let offset = 12;
    let jsonBytes = null;
    let binBytes = null;
    while (offset + 8 <= bytes.length) {
        const chunkLength = bytes.readUInt32LE(offset);
        const chunkType = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        const end = start + chunkLength;
        if (end > bytes.length) throw mediaError("GLB chunk overflows the file.");
        if (chunkType === GLB_JSON_CHUNK) {
            if (jsonBytes) throw mediaError("GLB contains more than one JSON chunk.");
            if (chunkLength > limits.gltfJsonBytes) {
                throw visualAssetError(
                    VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
                    `GLB JSON chunk exceeds the ${limits.gltfJsonBytes}-byte limit.`,
                );
            }
            jsonBytes = bytes.subarray(start, end);
        } else if (chunkType === GLB_BIN_CHUNK) {
            if (binBytes) throw mediaError("GLB contains more than one BIN chunk.");
            binBytes = bytes.subarray(start, end);
        } else {
            throw mediaError("GLB contains an unsupported chunk type.");
        }
        offset = end + ((4 - (chunkLength % 4)) % 4);
    }
    if (!jsonBytes) throw mediaError("GLB is missing a JSON chunk.");
    return {
        mediaType: "model/gltf-binary",
        width: 0,
        height: 0,
        mipLevels: 0,
        decodedBytesEstimate: bytes.length,
        jsonBytes,
        binBytes,
    };
}

function assertTextureDimensions(width, height, mipLevels, limits) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw mediaError("Texture dimensions must be positive safe integers.");
    }
    if (width > limits.textureDimension || height > limits.textureDimension) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
            `Texture dimensions ${width}x${height} exceed the ${limits.textureDimension}-pixel ceiling.`,
        );
    }
    if (mipLevels > limits.textureMipLevels) {
        throw visualAssetError(
            VISUAL_ASSET_ERROR_CODES.REQUEST_TOO_LARGE,
            `Texture mip count exceeds the ${limits.textureMipLevels}-level ceiling.`,
        );
    }
}

function assertSectionInFile(fileLength, offset, length, label) {
    if (length === 0 && offset === 0) return;
    if (offset + length > fileLength) throw mediaError(`KTX2 ${label} section overflows the file.`);
}

function assertNonOverlappingRanges(ranges, label) {
    const ordered = [...ranges].sort((left, right) => left[0] - right[0]);
    let cursor = 0;
    for (const [start, length] of ordered) {
        if (start < cursor) throw mediaError(`${label} ranges overlap.`);
        cursor = start + length;
    }
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

export { graphError, mediaError };
