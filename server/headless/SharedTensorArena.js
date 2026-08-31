import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHARED_TENSOR_MAGIC = Buffer.from("CEVSHM1\0", "ascii");
export const SHARED_TENSOR_HEADER_VERSION = 1;
export const SHARED_TENSOR_HEADER_BYTES = 192;
export const SHARED_TENSOR_ALIGNMENT = 64;
export const SHARED_TENSOR_GENERATIONS = 3;

const OFFSET = Object.freeze({
    magic: 0,
    version: 8,
    headerBytes: 12,
    environmentTokenHash: 16,
    generation: 48,
    sequence: 56,
    payloadLength: 64,
    tensorSpecHash: 72,
    contentDigest: 104,
});

function align(value, alignment = SHARED_TENSOR_ALIGNMENT) {
    return Math.ceil(value / alignment) * alignment;
}

function sha256(value) {
    return createHash("sha256").update(value).digest();
}

export function tensorSpecIdentity(spec = {}) {
    return `${Number(spec.dtype)}:${(spec.shape || []).map((entry) => String(entry)).join(",")}:${Number(spec.byteOrder ?? spec.byte_order)}`;
}

function uint64(value, name) {
    const result = BigInt(value);
    if (result < 0n || result > 0xffff_ffff_ffff_ffffn) throw new RangeError(`${name} must be a uint64 value.`);
    return result;
}

function bufferView(value) {
    if (Buffer.isBuffer(value)) return value;
    if (!ArrayBuffer.isView(value)) throw new TypeError("Shared tensor payload must be a byte view.");
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function buildHeader({ environmentToken, generation, sequence, payload, spec }) {
    const header = Buffer.alloc(SHARED_TENSOR_HEADER_BYTES);
    SHARED_TENSOR_MAGIC.copy(header, OFFSET.magic);
    header.writeUInt32LE(SHARED_TENSOR_HEADER_VERSION, OFFSET.version);
    header.writeUInt32LE(SHARED_TENSOR_HEADER_BYTES, OFFSET.headerBytes);
    sha256(Buffer.from(environmentToken, "utf8")).copy(header, OFFSET.environmentTokenHash);
    header.writeBigUInt64LE(uint64(generation, "generation"), OFFSET.generation);
    header.writeBigUInt64LE(uint64(sequence, "sequence"), OFFSET.sequence);
    header.writeBigUInt64LE(uint64(payload.byteLength, "payload length"), OFFSET.payloadLength);
    sha256(Buffer.from(tensorSpecIdentity(spec), "utf8")).copy(header, OFFSET.tensorSpecHash);
    sha256(payload).copy(header, OFFSET.contentDigest);
    return header;
}

export function parseSharedTensorHeader(value) {
    const header = bufferView(value);
    if (header.byteLength < SHARED_TENSOR_HEADER_BYTES) throw new Error("Shared tensor header is truncated.");
    if (!header.subarray(OFFSET.magic, OFFSET.magic + SHARED_TENSOR_MAGIC.length).equals(SHARED_TENSOR_MAGIC)) {
        throw new Error("Shared tensor header magic is invalid.");
    }
    if (header.readUInt32LE(OFFSET.version) !== SHARED_TENSOR_HEADER_VERSION
        || header.readUInt32LE(OFFSET.headerBytes) !== SHARED_TENSOR_HEADER_BYTES) {
        throw new Error("Shared tensor header version is unsupported.");
    }
    return {
        environmentTokenHash: header.subarray(OFFSET.environmentTokenHash, OFFSET.environmentTokenHash + 32).toString("hex"),
        generation: header.readBigUInt64LE(OFFSET.generation),
        sequence: header.readBigUInt64LE(OFFSET.sequence),
        payloadLength: header.readBigUInt64LE(OFFSET.payloadLength),
        tensorSpecHash: header.subarray(OFFSET.tensorSpecHash, OFFSET.tensorSpecHash + 32).toString("hex"),
        contentDigest: header.subarray(OFFSET.contentDigest, OFFSET.contentDigest + 32).toString("hex"),
    };
}

/** A private, three-generation file-backed arena for one environment. */
export class SharedTensorArena {
    static async create({ environmentToken, sizeBytes, rootDirectory = os.tmpdir() }) {
        const arena = new SharedTensorArena({ environmentToken, sizeBytes });
        await arena._open(rootDirectory);
        return arena;
    }

    constructor({ environmentToken, sizeBytes }) {
        this.environmentToken = String(environmentToken || "");
        this.sizeBytes = align(Number(sizeBytes));
        if (!this.environmentToken) throw new TypeError("A shared-memory environment token is required.");
        if (!Number.isSafeInteger(this.sizeBytes)
            || this.sizeBytes < SHARED_TENSOR_GENERATIONS * (SHARED_TENSOR_HEADER_BYTES + SHARED_TENSOR_ALIGNMENT)) {
            throw new RangeError("Shared tensor arena is too small for three response generations.");
        }
        this.allocations = new Map();
        this.writeTail = Promise.resolve();
        this.closed = false;
    }

    async _open(rootDirectory) {
        this.directory = await fs.mkdtemp(path.join(path.resolve(rootDirectory), "cev-sim-shm-"));
        await fs.chmod(this.directory, 0o700);
        this.regionName = path.join(this.directory, `${randomBytes(16).toString("hex")}.arena`);
        // The randomized basename is the transport-visible environment token;
        // readers can validate it without a second protocol field.
        this.environmentToken = path.basename(this.regionName);
        this.file = await fs.open(this.regionName, "wx+", 0o600);
        await this.file.truncate(this.sizeBytes);
    }

    _retireTransientAllocations(generation) {
        for (const [offset, allocation] of this.allocations) {
            if (!allocation.retained
                && allocation.generation + BigInt(SHARED_TENSOR_GENERATIONS) <= generation) {
                this.allocations.delete(offset);
            }
        }
    }

    _allocate(allocationBytes) {
        const sorted = [...this.allocations.values()]
            .sort((left, right) => left.headerOffset - right.headerOffset);
        let cursor = 0;
        for (const allocation of sorted) {
            if (allocation.headerOffset - cursor >= allocationBytes) return cursor;
            cursor = Math.max(cursor, allocation.headerOffset + allocation.allocationBytes);
        }
        return cursor + allocationBytes <= this.sizeBytes ? cursor : null;
    }

    _serialize(operation) {
        const result = this.writeTail.then(operation);
        this.writeTail = result.catch(() => {});
        return result;
    }

    publishTensor(bytes, spec, options) {
        return this._serialize(() => this._publishTensor(bytes, spec, options));
    }

    async _publishTensor(bytes, spec, { generation, sequence, retained = false }) {
        if (this.closed || !this.file) throw new Error("Shared tensor arena is closed.");
        const payload = bufferView(bytes);
        const normalizedGeneration = uint64(generation, "generation");
        const normalizedSequence = uint64(sequence, "sequence");
        this._retireTransientAllocations(normalizedGeneration);
        const allocationBytes = align(SHARED_TENSOR_HEADER_BYTES + payload.byteLength);
        const headerOffset = this._allocate(allocationBytes);
        if (headerOffset === null) {
            throw Object.assign(new Error("Shared tensor arena allocation is exhausted."), {
                code: "RESOURCE_LIMIT",
                details: { allocationBytes, arenaBytes: this.sizeBytes },
            });
        }
        const payloadOffset = headerOffset + SHARED_TENSOR_HEADER_BYTES;
        const header = buildHeader({
            environmentToken: this.environmentToken,
            generation: normalizedGeneration,
            sequence: normalizedSequence,
            payload,
            spec,
        });
        await this.file.write(payload, 0, payload.byteLength, payloadOffset);
        await this.file.write(header, 0, header.byteLength, headerOffset);
        this.allocations.set(headerOffset, {
            headerOffset,
            allocationBytes,
            generation: normalizedGeneration,
            retained: Boolean(retained),
            refCount: retained ? 1 : 0,
        });
        return {
            regionName: this.regionName,
            generation: normalizedGeneration.toString(),
            offsetBytes: String(payloadOffset),
            lengthBytes: String(payload.byteLength),
            sequence: normalizedSequence.toString(),
        };
    }

    release(reference) {
        return this._serialize(() => this._release(reference));
    }

    retain(reference) {
        return this._serialize(() => {
            const payloadOffset = Number(reference?.offsetBytes ?? reference?.offset_bytes);
            const allocation = this.allocations.get(payloadOffset - SHARED_TENSOR_HEADER_BYTES);
            if (!allocation?.retained) return false;
            allocation.refCount += 1;
            return true;
        });
    }

    async _release(reference) {
        if (this.closed || !this.file) return false;
        const payloadOffset = Number(reference?.offsetBytes ?? reference?.offset_bytes);
        if (!Number.isSafeInteger(payloadOffset)) return false;
        const headerOffset = payloadOffset - SHARED_TENSOR_HEADER_BYTES;
        const allocation = this.allocations.get(headerOffset);
        if (!allocation) return false;
        if (allocation.refCount > 1) {
            allocation.refCount -= 1;
            return true;
        }
        this.allocations.delete(headerOffset);
        await this.file.write(Buffer.alloc(SHARED_TENSOR_MAGIC.length), 0, SHARED_TENSOR_MAGIC.length, headerOffset);
        return true;
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        await this.writeTail;
        await this.file?.close().catch(() => {});
        this.file = null;
        if (this.directory) await fs.rm(this.directory, { recursive: true, force: true });
    }

    invalidate() {
        return this._serialize(() => this._invalidate());
    }

    async _invalidate() {
        if (this.closed || !this.file) return;
        await this.file.truncate(0);
        await this.file.truncate(this.sizeBytes);
        this.allocations.clear();
    }
}

export async function validateSharedTensorReference(reference, {
    environmentToken,
    spec,
    copy = true,
} = {}) {
    const offset = Number(reference?.offsetBytes ?? reference?.offset_bytes);
    const length = Number(reference?.lengthBytes ?? reference?.length_bytes);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
        || offset < SHARED_TENSOR_HEADER_BYTES || length < 0) {
        throw new Error("Shared tensor reference bounds are invalid.");
    }
    const file = await fs.open(String(reference.regionName ?? reference.region_name), "r");
    try {
        const stat = await file.stat();
        if (!stat.isFile() || offset + length > stat.size) throw new Error("Shared tensor region or bounds are invalid.");
        const before = Buffer.alloc(SHARED_TENSOR_HEADER_BYTES);
        const payload = Buffer.alloc(length);
        const after = Buffer.alloc(SHARED_TENSOR_HEADER_BYTES);
        await file.read(before, 0, before.length, offset - SHARED_TENSOR_HEADER_BYTES);
        await file.read(payload, 0, payload.length, offset);
        await file.read(after, 0, after.length, offset - SHARED_TENSOR_HEADER_BYTES);
        if (!before.equals(after)) throw new Error("Shared tensor header changed while reading.");
        const header = parseSharedTensorHeader(before);
        if (header.environmentTokenHash !== sha256(Buffer.from(String(environmentToken), "utf8")).toString("hex")) {
            throw new Error("Shared tensor environment token is invalid.");
        }
        if (header.generation !== BigInt(reference.generation)
            || header.sequence !== BigInt(reference.sequence)
            || header.payloadLength !== BigInt(length)) {
            throw new Error("Shared tensor generation, sequence, or length is invalid.");
        }
        if (header.tensorSpecHash !== sha256(Buffer.from(tensorSpecIdentity(spec), "utf8")).toString("hex")) {
            throw new Error("Shared tensor specification hash is invalid.");
        }
        if (header.contentDigest !== sha256(payload).toString("hex")) {
            throw new Error("Shared tensor content digest is invalid.");
        }
        return copy ? Buffer.from(payload) : payload;
    } finally {
        await file.close();
    }
}
