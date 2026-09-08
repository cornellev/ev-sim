/**
 * Compact little-endian codec for cev-sim.bake-atlas-contribution@1.
 * Records are sorted so identical observations encode to identical bytes.
 */

import { sha256ExactBytes } from "../../../simulation/visual/VisualLayer.js";
import { hashBakeConstruction } from "./BakeConstructionPolicy.js";

export const BAKE_ATLAS_CONTRIBUTION_KIND = "cev-sim.bake-atlas-contribution";
export const BAKE_ATLAS_CONTRIBUTION_VERSION = 1;
export const BAKE_ATLAS_CONTRIBUTION_MAGIC = 0x31415443; // "CAT1"
export const BAKE_ATLAS_CONTRIBUTION_VERSION_V2 = 2;
export const BAKE_ATLAS_CONTRIBUTION_MAGIC_V2 = 0x32415443; // "CAT2"

const HEADER_BYTES = 64;
const RECORD_BYTES = 36;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function contributionError(message) {
    const error = new Error(message);
    error.code = "BAKE_CONTRIBUTION_INVALID";
    return error;
}

export function quantizeConfidence(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(65535, Math.round(number * 65535)));
}

export function quantizeFacing(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(65535, Math.round(((number + 1) * 0.5) * 65535)));
}

export function unquantizeConfidence(value) {
    return value / 65535;
}

export function unquantizeFacing(value) {
    return (value / 65535) * 2 - 1;
}

function writeUint16(view, offset, value) {
    view.setUint16(offset, value >>> 0, true);
}

function writeInt32(view, offset, value) {
    view.setInt32(offset, value | 0, true);
}

function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
}

function writeFloat32(view, offset, value) {
    view.setFloat32(offset, value, true);
}

function parseChunkKey(chunkKey) {
    const [cx, cz] = String(chunkKey).split(",").map((part) => Number.parseInt(part, 10));
    return {
        cx: Number.isFinite(cx) ? cx : 0,
        cz: Number.isFinite(cz) ? cz : 0,
    };
}

function chunkKeyFromCoord(cx, cz) {
    return `${cx},${cz}`;
}

function compareRecords(left, right) {
    if (left.cx !== right.cx) return left.cx - right.cx;
    if (left.cz !== right.cz) return left.cz - right.cz;
    if (left.pageIndex !== right.pageIndex) return left.pageIndex - right.pageIndex;
    if (left.texelY !== right.texelY) return left.texelY - right.texelY;
    if (left.texelX !== right.texelX) return left.texelX - right.texelX;
    if (left.triangleIndex !== right.triangleIndex) return left.triangleIndex - right.triangleIndex;
    if (left.pixelIndex !== right.pixelIndex) return left.pixelIndex - right.pixelIndex;
    if (left.confidenceQ !== right.confidenceQ) return right.confidenceQ - left.confidenceQ;
    if (left.facingQ !== right.facingQ) return right.facingQ - left.facingQ;
    if (left.distance !== right.distance) return left.distance - right.distance;
    return 0;
}

function normalizeRecord(record) {
    const coord = parseChunkKey(record.chunkKey);
    const rgba = record.rgba ?? [0, 0, 0, 0];
    return {
        cx: coord.cx,
        cz: coord.cz,
        chunkKey: chunkKeyFromCoord(coord.cx, coord.cz),
        pageIndex: record.pageIndex >>> 0,
        texelX: record.texelX >>> 0,
        texelY: record.texelY >>> 0,
        r: rgba[0] & 0xff,
        g: rgba[1] & 0xff,
        b: rgba[2] & 0xff,
        a: rgba[3] & 0xff,
        confidenceQ: quantizeConfidence(record.confidence),
        facingQ: quantizeFacing(record.facing),
        distance: Number.isFinite(record.distance) ? record.distance : Number.POSITIVE_INFINITY,
        pixelIndex: record.pixelIndex >>> 0,
        triangleIndex: record.triangleIndex >>> 0,
    };
}

function encodeBakeAtlasContributionV1({
    unitId,
    constructionHash,
    records = [],
} = {}) {
    if (typeof unitId !== "string" || !unitId || unitId !== unitId.normalize("NFC")) {
        throw contributionError("Contribution unitId must be non-empty NFC text.");
    }
    if (typeof constructionHash !== "string" || !/^[a-f0-9]{64}$/.test(constructionHash)) {
        throw contributionError("Contribution constructionHash must be a lowercase SHA-256 digest.");
    }
    const normalized = records.map(normalizeRecord).sort(compareRecords);
    const unitBytes = textEncoder.encode(unitId);
    if (unitBytes.length > 0xffff) throw contributionError("Contribution unitId exceeds 65535 bytes.");
    const bytes = new Uint8Array(HEADER_BYTES + unitBytes.length + normalized.length * RECORD_BYTES);
    const view = new DataView(bytes.buffer);
    writeUint32(view, 0, BAKE_ATLAS_CONTRIBUTION_MAGIC);
    writeUint16(view, 4, BAKE_ATLAS_CONTRIBUTION_VERSION);
    writeUint16(view, 6, HEADER_BYTES);
    writeUint16(view, 8, unitBytes.length);
    writeUint32(view, 12, normalized.length);
    const hashBytes = Uint8Array.from({ length: 32 }, (_, index) => (
        Number.parseInt(constructionHash.slice(index * 2, index * 2 + 2), 16)
    ));
    bytes.set(hashBytes, 16);
    bytes.set(unitBytes, HEADER_BYTES);
    let offset = HEADER_BYTES + unitBytes.length;
    for (const record of normalized) {
        const recordView = new DataView(bytes.buffer, offset, RECORD_BYTES);
        writeInt32(recordView, 0, record.cx);
        writeInt32(recordView, 4, record.cz);
        writeUint16(recordView, 8, record.pageIndex);
        writeUint16(recordView, 10, record.texelX);
        writeUint16(recordView, 12, record.texelY);
        bytes[offset + 14] = record.r;
        bytes[offset + 15] = record.g;
        bytes[offset + 16] = record.b;
        bytes[offset + 17] = record.a;
        writeUint16(recordView, 18, record.confidenceQ);
        writeUint16(recordView, 20, record.facingQ);
        writeFloat32(recordView, 22, Number.isFinite(record.distance) ? record.distance : 3.4028234663852886e38);
        writeUint32(recordView, 26, record.pixelIndex);
        writeUint32(recordView, 30, record.triangleIndex);
        bytes[offset + 34] = 0;
        bytes[offset + 35] = 0;
        offset += RECORD_BYTES;
    }
    return bytes;
}

function decodeBakeAtlasContributionV1(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    if (source.length < HEADER_BYTES) throw contributionError("Contribution is truncated.");
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    if (view.getUint32(0, true) !== BAKE_ATLAS_CONTRIBUTION_MAGIC) {
        throw contributionError("Contribution magic is not cev-sim.bake-atlas-contribution@1.");
    }
    const version = view.getUint16(4, true);
    if (version !== BAKE_ATLAS_CONTRIBUTION_VERSION) {
        throw contributionError("unsupported bake-atlas-contribution version");
    }
    const headerSize = view.getUint16(6, true);
    const unitLength = view.getUint16(8, true);
    const recordCount = view.getUint32(12, true);
    if (headerSize !== HEADER_BYTES) throw contributionError("Contribution header size is not canonical.");
    const expected = HEADER_BYTES + unitLength + recordCount * RECORD_BYTES;
    if (source.length !== expected) throw contributionError("Contribution length does not match the canonical layout.");
    const constructionHash = [...source.subarray(16, 48)]
        .map((entry) => entry.toString(16).padStart(2, "0"))
        .join("");
    const unitId = textDecoder.decode(source.subarray(HEADER_BYTES, HEADER_BYTES + unitLength));
    if (!unitId || unitId !== unitId.normalize("NFC")) {
        throw contributionError("Contribution unitId must be non-empty NFC text.");
    }
    const records = [];
    let offset = HEADER_BYTES + unitLength;
    for (let index = 0; index < recordCount; index += 1) {
        if (source[offset + 34] !== 0 || source[offset + 35] !== 0) {
            throw contributionError("Contribution records contain unknown padding bytes.");
        }
        const recordView = new DataView(source.buffer, source.byteOffset + offset, RECORD_BYTES);
        const cx = recordView.getInt32(0, true);
        const cz = recordView.getInt32(4, true);
        records.push({
            chunkKey: chunkKeyFromCoord(cx, cz),
            pageIndex: recordView.getUint16(8, true),
            texelX: recordView.getUint16(10, true),
            texelY: recordView.getUint16(12, true),
            rgba: [
                source[offset + 14],
                source[offset + 15],
                source[offset + 16],
                source[offset + 17],
            ],
            confidence: unquantizeConfidence(recordView.getUint16(18, true)),
            confidenceQ: recordView.getUint16(18, true),
            facing: unquantizeFacing(recordView.getUint16(20, true)),
            facingQ: recordView.getUint16(20, true),
            distance: recordView.getFloat32(22, true),
            pixelIndex: recordView.getUint32(26, true),
            triangleIndex: recordView.getUint32(30, true),
        });
        offset += RECORD_BYTES;
    }
    const encoded = encodeBakeAtlasContributionV1({ unitId, constructionHash, records });
    if (encoded.length !== source.length) {
        throw contributionError("Contribution is not in canonical encoded form.");
    }
    for (let index = 0; index < source.length; index += 1) {
        if (encoded[index] !== source[index]) {
            throw contributionError("Contribution is not in canonical encoded form.");
        }
    }
    return Object.freeze({
        kind: BAKE_ATLAS_CONTRIBUTION_KIND,
        version: BAKE_ATLAS_CONTRIBUTION_VERSION,
        unitId,
        constructionHash,
        records: Object.freeze(records),
        bytes: source,
        sha256: sha256ExactBytes(source),
    });
}

const V2_HEADER_BYTES = 96;
const V2_RECORD_BYTES = 64;
const V2_CHANNELS = Object.freeze([
    "base-color", "normal", "roughness", "metalness", "emissive", "occlusion",
]);
const V2_CHANNEL_COMPONENTS = Object.freeze([3, 3, 1, 1, 3, 1]);

function digestBytes(value, label) {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
        throw contributionError(`${label} must be a lowercase SHA-256 digest.`);
    }
    return Uint8Array.from({ length: 32 }, (_, index) => (
        Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
    ));
}

function bytesDigest(bytes) {
    return [...bytes].map((entry) => entry.toString(16).padStart(2, "0")).join("");
}

function compareUtf8(left, right) {
    const a = textEncoder.encode(String(left));
    const b = textEncoder.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function normalizeV2Record(record) {
    const coord = parseChunkKey(record.chunkKey);
    const channel = String(record.channel ?? "");
    const channelIndex = V2_CHANNELS.indexOf(channel);
    if (channelIndex < 0) throw contributionError(`Unknown intrinsic contribution channel ${channel}.`);
    const sourceId = String(record.sourceId ?? "");
    if (!sourceId || sourceId !== sourceId.normalize("NFC")) {
        throw contributionError("Contribution sourceId must be non-empty NFC text.");
    }
    const sourceType = String(record.sourceType ?? "");
    if (sourceType !== "supplied" && sourceType !== "inferred") {
        throw contributionError("Contribution sourceType must be supplied or inferred.");
    }
    const known = record.known === true || record.known === 1;
    const components = V2_CHANNEL_COMPONENTS[channelIndex];
    const incoming = record.values ?? [];
    if (!Array.isArray(incoming) && !ArrayBuffer.isView(incoming)) {
        throw contributionError("Contribution values must be an array or typed-array view.");
    }
    if (incoming.length !== components) {
        throw contributionError(`Contribution ${channel} values require ${components} components.`);
    }
    const values = [0, 0, 0, 0];
    for (let index = 0; index < components; index += 1) {
        const value = Number(incoming[index]);
        if (!Number.isFinite(value)) throw contributionError("Contribution values must be finite.");
        if (!known && value !== 0) throw contributionError("Unknown contribution values must be zero.");
        values[index] = Object.is(value, -0) ? 0 : value;
    }
    return {
        cx: coord.cx,
        cz: coord.cz,
        chunkKey: chunkKeyFromCoord(coord.cx, coord.cz),
        pageIndex: record.pageIndex >>> 0,
        texelX: record.texelX >>> 0,
        texelY: record.texelY >>> 0,
        channel,
        channelIndex,
        sourceId,
        sourceType,
        known,
        confidenceQ: quantizeConfidence(known ? (record.combinedConfidence ?? record.confidence) : 0),
        facingQ: quantizeFacing(record.facing),
        distance: Number.isFinite(record.distance) ? record.distance : Number.POSITIVE_INFINITY,
        pixelIndex: record.pixelIndex >>> 0,
        triangleIndex: record.triangleIndex >>> 0,
        values,
        components,
    };
}

function compareV2Records(left, right) {
    if (left.cx !== right.cx) return left.cx - right.cx;
    if (left.cz !== right.cz) return left.cz - right.cz;
    if (left.pageIndex !== right.pageIndex) return left.pageIndex - right.pageIndex;
    if (left.texelY !== right.texelY) return left.texelY - right.texelY;
    if (left.texelX !== right.texelX) return left.texelX - right.texelX;
    if (left.channelIndex !== right.channelIndex) return left.channelIndex - right.channelIndex;
    const sourceOrder = compareUtf8(left.sourceId, right.sourceId);
    if (sourceOrder) return sourceOrder;
    if (left.triangleIndex !== right.triangleIndex) return left.triangleIndex - right.triangleIndex;
    if (left.pixelIndex !== right.pixelIndex) return left.pixelIndex - right.pixelIndex;
    if (left.confidenceQ !== right.confidenceQ) return right.confidenceQ - left.confidenceQ;
    if (left.facingQ !== right.facingQ) return right.facingQ - left.facingQ;
    if (left.distance !== right.distance) return left.distance - right.distance;
    return 0;
}

function encodeBakeAtlasContributionV2({ unitId, constructionHash, proposalUnitHash, records = [] } = {}) {
    if (typeof unitId !== "string" || !unitId || unitId !== unitId.normalize("NFC")) {
        throw contributionError("Contribution unitId must be non-empty NFC text.");
    }
    const normalized = records.map(normalizeV2Record).sort(compareV2Records);
    const sourceIds = [...new Set(normalized.map((record) => record.sourceId))].sort(compareUtf8);
    if (sourceIds.length > 255) throw contributionError("Contribution has more than 255 proposal sources.");
    const sourceIndex = new Map(sourceIds.map((sourceId, index) => [sourceId, index]));
    const sourceParts = sourceIds.map((sourceId) => {
        const encoded = textEncoder.encode(sourceId);
        if (encoded.length > 0xffff) throw contributionError("Contribution sourceId exceeds 65535 bytes.");
        const bytes = new Uint8Array(2 + encoded.length);
        new DataView(bytes.buffer).setUint16(0, encoded.length, true);
        bytes.set(encoded, 2);
        return bytes;
    });
    const sourceTableBytes = sourceParts.reduce((total, part) => total + part.byteLength, 0);
    const unitBytes = textEncoder.encode(unitId);
    if (unitBytes.length > 0xffff) throw contributionError("Contribution unitId exceeds 65535 bytes.");
    const bytes = new Uint8Array(
        V2_HEADER_BYTES + unitBytes.length + sourceTableBytes + normalized.length * V2_RECORD_BYTES,
    );
    const view = new DataView(bytes.buffer);
    writeUint32(view, 0, BAKE_ATLAS_CONTRIBUTION_MAGIC_V2);
    writeUint16(view, 4, BAKE_ATLAS_CONTRIBUTION_VERSION_V2);
    writeUint16(view, 6, V2_HEADER_BYTES);
    writeUint16(view, 8, unitBytes.length);
    writeUint16(view, 10, sourceIds.length);
    writeUint32(view, 12, normalized.length);
    bytes.set(digestBytes(constructionHash, "Contribution constructionHash"), 16);
    bytes.set(digestBytes(proposalUnitHash, "Contribution proposalUnitHash"), 48);
    writeUint32(view, 80, sourceTableBytes);
    bytes.set(unitBytes, V2_HEADER_BYTES);
    let offset = V2_HEADER_BYTES + unitBytes.length;
    for (const part of sourceParts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }
    for (const record of normalized) {
        const recordView = new DataView(bytes.buffer, offset, V2_RECORD_BYTES);
        writeInt32(recordView, 0, record.cx);
        writeInt32(recordView, 4, record.cz);
        writeUint16(recordView, 8, record.pageIndex);
        writeUint16(recordView, 10, record.texelX);
        writeUint16(recordView, 12, record.texelY);
        bytes[offset + 14] = record.channelIndex;
        bytes[offset + 15] = sourceIndex.get(record.sourceId);
        bytes[offset + 16] = record.sourceType === "supplied" ? 0 : 1;
        bytes[offset + 17] = record.known ? 1 : 0;
        writeUint16(recordView, 18, record.confidenceQ);
        writeUint16(recordView, 20, record.facingQ);
        writeFloat32(recordView, 22, Number.isFinite(record.distance) ? record.distance : 3.4028234663852886e38);
        writeUint32(recordView, 26, record.pixelIndex);
        writeUint32(recordView, 30, record.triangleIndex);
        for (let index = 0; index < 4; index += 1) writeFloat32(recordView, 34 + index * 4, record.values[index]);
        bytes[offset + 50] = record.components;
        offset += V2_RECORD_BYTES;
    }
    return bytes;
}

function decodeBakeAtlasContributionV2(source) {
    if (source.length < V2_HEADER_BYTES) throw contributionError("Contribution v2 is truncated.");
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    if (view.getUint16(4, true) !== BAKE_ATLAS_CONTRIBUTION_VERSION_V2) {
        throw contributionError("unsupported bake-atlas-contribution version");
    }
    const headerSize = view.getUint16(6, true);
    const unitLength = view.getUint16(8, true);
    const sourceCount = view.getUint16(10, true);
    const recordCount = view.getUint32(12, true);
    const sourceTableBytes = view.getUint32(80, true);
    if (headerSize !== V2_HEADER_BYTES) throw contributionError("Contribution v2 header size is not canonical.");
    for (let index = 84; index < V2_HEADER_BYTES; index += 1) {
        if (source[index] !== 0) throw contributionError("Contribution v2 header contains unknown bytes.");
    }
    const expected = V2_HEADER_BYTES + unitLength + sourceTableBytes + recordCount * V2_RECORD_BYTES;
    if (source.length !== expected) throw contributionError("Contribution v2 length does not match the canonical layout.");
    const constructionHash = bytesDigest(source.subarray(16, 48));
    const proposalUnitHash = bytesDigest(source.subarray(48, 80));
    const unitId = textDecoder.decode(source.subarray(V2_HEADER_BYTES, V2_HEADER_BYTES + unitLength));
    if (!unitId || unitId !== unitId.normalize("NFC")) throw contributionError("Contribution unitId must be non-empty NFC text.");
    let offset = V2_HEADER_BYTES + unitLength;
    const sourceIds = [];
    const tableEnd = offset + sourceTableBytes;
    while (offset < tableEnd) {
        if (offset + 2 > tableEnd) throw contributionError("Contribution v2 source table is truncated.");
        const length = new DataView(source.buffer, source.byteOffset + offset, 2).getUint16(0, true);
        offset += 2;
        if (offset + length > tableEnd) throw contributionError("Contribution v2 source table is truncated.");
        const sourceId = textDecoder.decode(source.subarray(offset, offset + length));
        if (!sourceId || sourceId !== sourceId.normalize("NFC")) throw contributionError("Contribution sourceId must be non-empty NFC text.");
        sourceIds.push(sourceId);
        offset += length;
    }
    if (sourceIds.length !== sourceCount || new Set(sourceIds).size !== sourceIds.length) {
        throw contributionError("Contribution v2 source table count or uniqueness is invalid.");
    }
    const sortedSourceIds = [...sourceIds].sort(compareUtf8);
    if (sourceIds.some((entry, index) => entry !== sortedSourceIds[index])) {
        throw contributionError("Contribution v2 source table is not canonically ordered.");
    }
    const records = [];
    for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
        const recordView = new DataView(source.buffer, source.byteOffset + offset, V2_RECORD_BYTES);
        for (let byteIndex = 51; byteIndex < V2_RECORD_BYTES; byteIndex += 1) {
            if (source[offset + byteIndex] !== 0) throw contributionError("Contribution v2 record contains unknown bytes.");
        }
        const channelIndex = source[offset + 14];
        const sourceIndex = source[offset + 15];
        const sourceTypeCode = source[offset + 16];
        const knownCode = source[offset + 17];
        if (!V2_CHANNELS[channelIndex] || sourceIndex >= sourceIds.length || sourceTypeCode > 1 || knownCode > 1) {
            throw contributionError("Contribution v2 record contains an invalid enum value.");
        }
        const components = source[offset + 50];
        if (components !== V2_CHANNEL_COMPONENTS[channelIndex]) throw contributionError("Contribution v2 component count is invalid.");
        const values = Array.from({ length: components }, (_, index) => recordView.getFloat32(34 + index * 4, true));
        for (let index = components; index < 4; index += 1) {
            if (recordView.getFloat32(34 + index * 4, true) !== 0) throw contributionError("Contribution v2 unused values must be zero.");
        }
        const cx = recordView.getInt32(0, true);
        const cz = recordView.getInt32(4, true);
        records.push({
            chunkKey: chunkKeyFromCoord(cx, cz),
            pageIndex: recordView.getUint16(8, true),
            texelX: recordView.getUint16(10, true),
            texelY: recordView.getUint16(12, true),
            channel: V2_CHANNELS[channelIndex],
            sourceId: sourceIds[sourceIndex],
            sourceType: sourceTypeCode === 0 ? "supplied" : "inferred",
            known: knownCode === 1,
            combinedConfidence: unquantizeConfidence(recordView.getUint16(18, true)),
            confidenceQ: recordView.getUint16(18, true),
            facing: unquantizeFacing(recordView.getUint16(20, true)),
            facingQ: recordView.getUint16(20, true),
            distance: recordView.getFloat32(22, true),
            pixelIndex: recordView.getUint32(26, true),
            triangleIndex: recordView.getUint32(30, true),
            values,
        });
        offset += V2_RECORD_BYTES;
    }
    const encoded = encodeBakeAtlasContributionV2({ unitId, constructionHash, proposalUnitHash, records });
    if (encoded.length !== source.length || encoded.some((entry, index) => entry !== source[index])) {
        throw contributionError("Contribution v2 is not in canonical encoded form.");
    }
    return Object.freeze({
        kind: BAKE_ATLAS_CONTRIBUTION_KIND,
        version: BAKE_ATLAS_CONTRIBUTION_VERSION_V2,
        unitId,
        constructionHash,
        proposalUnitHash,
        records: Object.freeze(records),
        bytes: source,
        sha256: sha256ExactBytes(source),
    });
}

export function encodeBakeAtlasContribution(options = {}) {
    if (options.version === BAKE_ATLAS_CONTRIBUTION_VERSION_V2 || options.proposalUnitHash != null) {
        return encodeBakeAtlasContributionV2(options);
    }
    return encodeBakeAtlasContributionV1(options);
}

export function decodeBakeAtlasContribution(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
    if (source.length < 4) throw contributionError("Contribution is truncated.");
    const magic = new DataView(source.buffer, source.byteOffset, source.byteLength).getUint32(0, true);
    if (magic === BAKE_ATLAS_CONTRIBUTION_MAGIC) return decodeBakeAtlasContributionV1(source);
    if (magic === BAKE_ATLAS_CONTRIBUTION_MAGIC_V2) return decodeBakeAtlasContributionV2(source);
    throw contributionError("Contribution magic is not a supported cev-sim.bake-atlas-contribution version.");
}

export function hashBakeAtlasContribution(bytes) {
    return sha256ExactBytes(bytes instanceof Uint8Array ? bytes : decodeBakeAtlasContribution(bytes).bytes);
}

export function contributionConstructionHash(construction) {
    return hashBakeConstruction(construction);
}
