/**
 * Compact little-endian codec for cev-sim.bake-atlas-contribution@1.
 * Records are sorted so identical observations encode to identical bytes.
 */

import { sha256ExactBytes } from "../../../simulation/visual/VisualLayer.js";
import { hashBakeConstruction } from "./BakeConstructionPolicy.js";

export const BAKE_ATLAS_CONTRIBUTION_KIND = "cev-sim.bake-atlas-contribution";
export const BAKE_ATLAS_CONTRIBUTION_VERSION = 1;
export const BAKE_ATLAS_CONTRIBUTION_MAGIC = 0x31415443; // "CAT1"

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

export function encodeBakeAtlasContribution({
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

export function decodeBakeAtlasContribution(bytes) {
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
    const encoded = encodeBakeAtlasContribution({ unitId, constructionHash, records });
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

export function hashBakeAtlasContribution(bytes) {
    return sha256ExactBytes(bytes instanceof Uint8Array ? bytes : decodeBakeAtlasContribution(bytes).bytes);
}

export function contributionConstructionHash(construction) {
    return hashBakeConstruction(construction);
}
