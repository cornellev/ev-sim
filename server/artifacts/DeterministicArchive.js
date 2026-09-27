import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
    ARTIFACT_VERIFICATION_ERROR_CODES,
    DEFAULT_MAX_ARTIFACT_CHUNK_BYTES,
    artifactVerificationError,
    beforeArtifactDeadline,
    checkArtifactBoundary,
    closeArtifactIterator,
    createArtifactStagingArea,
    resolveContentLimits,
    stageArtifactStream,
    validateArchivePath,
} from "./ArtifactVerification.js";

export const USTAR_BLOCK_SIZE = 512;
export const USTAR_MAX_ENTRY_BYTES = 8_589_934_591;
export const DETERMINISTIC_ARCHIVE_LIMITS = Object.freeze({
    archiveBytes: 50 * 1024 ** 3,
    entryBytes: USTAR_MAX_ENTRY_BYTES,
    entries: 100_000,
    temporaryBytes: 50 * 1024 ** 3,
    inodes: 100_000,
    maxChunkBytes: DEFAULT_MAX_ARTIFACT_CHUNK_BYTES,
    verificationTimeoutMs: 60_000,
});

const USTAR_MODE = 0o644;
const USTAR_MAGIC = Buffer.from("ustar\0", "latin1");
const USTAR_VERSION = Buffer.from("00", "latin1");
const ZERO_BLOCK = Buffer.alloc(USTAR_BLOCK_SIZE);
const REGULAR_TYPEFLAG = 0x30;
const COMPRESSION_MAGICS = [
    [0x1f, 0x8b],
    ...Array.from({ length: 9 }, (_, index) => [0x42, 0x5a, 0x68, 0x31 + index]),
    [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
    [0x28, 0xb5, 0x2f, 0xfd],
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
    [0x1f, 0x9d],
];
const FORBIDDEN_TYPEFLAGS = new Set([
    0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37,
    0x41, 0x44, 0x4b, 0x4c, 0x4d, 0x53, 0x56, 0x58,
    0x67, 0x78,
]);

function hostile(message) {
    throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, message);
}

function invalid(message) {
    throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.INVALID, message);
}

function limit(message) {
    throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.LIMIT_EXCEEDED, message);
}

function asBytes(value, label = "bytes") {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    invalid(`${label} must be exact bytes.`);
}

export function resolveDeterministicArchiveLimits(overrides = {}) {
    return resolveContentLimits(DETERMINISTIC_ARCHIVE_LIMITS, overrides, {
        integerKeys: ["archiveBytes", "entryBytes", "entries", "temporaryBytes", "inodes", "maxChunkBytes", "verificationTimeoutMs"],
    });
}

function encodeOctal(value, fieldLength) {
    if (!Number.isSafeInteger(value) || value < 0) invalid("USTAR numeric fields must be non-negative safe integers.");
    const digits = fieldLength - 1;
    const octal = value.toString(8);
    if (octal.length > digits) limit("USTAR numeric field exceeds the canonical width.");
    const field = Buffer.alloc(fieldLength);
    field.write(octal.padStart(digits, "0"), 0, digits, "latin1");
    return field;
}

function headerChecksum(header) {
    let sum = 0;
    for (let index = 0; index < USTAR_BLOCK_SIZE; index += 1) {
        sum += index >= 148 && index < 156 ? 0x20 : header[index];
    }
    return sum;
}

function encodeChecksum(sum) {
    const octal = sum.toString(8).padStart(6, "0");
    if (octal.length > 6) invalid("USTAR checksum exceeds six octal digits.");
    return Buffer.from(`${octal}\0 `, "latin1");
}

function writeCString(target, offset, value, length) {
    const bytes = Buffer.from(String(value ?? ""), "utf8");
    if (bytes.length >= length) invalid("USTAR string field exceeds its fixed width.");
    bytes.copy(target, offset);
}

export function padToUstarBlock(size) {
    const remainder = size % USTAR_BLOCK_SIZE;
    return remainder === 0 ? 0 : USTAR_BLOCK_SIZE - remainder;
}

/** Optional overrides are intentionally retained for hostile-archive tests. */
export function encodeUstarHeader({
    name,
    size,
    typeflag = "0",
    mode = USTAR_MODE,
    uid = 0,
    gid = 0,
    mtime = 0,
    uname = "",
    gname = "",
    linkname = "",
    magic = USTAR_MAGIC,
    version = USTAR_VERSION,
    prefix = "",
    devmajor = null,
    devminor = null,
    checksum = "auto",
    modeField = null,
    uidField = null,
    gidField = null,
    sizeField = null,
    mtimeField = null,
} = {}) {
    const header = Buffer.alloc(USTAR_BLOCK_SIZE);
    writeCString(header, 0, name, 100);
    (modeField ?? encodeOctal(mode, 8)).copy(header, 100);
    (uidField ?? encodeOctal(uid, 8)).copy(header, 108);
    (gidField ?? encodeOctal(gid, 8)).copy(header, 116);
    (sizeField ?? encodeOctal(size, 12)).copy(header, 124);
    (mtimeField ?? encodeOctal(mtime, 12)).copy(header, 136);
    header.fill(0x20, 148, 156);
    header[156] = typeof typeflag === "number" ? typeflag : String(typeflag).charCodeAt(0);
    writeCString(header, 157, linkname, 100);
    Buffer.from(magic).copy(header, 257, 0, 6);
    Buffer.from(version).copy(header, 263, 0, 2);
    writeCString(header, 265, uname, 32);
    writeCString(header, 297, gname, 32);
    if (devmajor != null) encodeOctal(devmajor, 8).copy(header, 329);
    if (devminor != null) encodeOctal(devminor, 8).copy(header, 337);
    writeCString(header, 345, prefix, 155);
    const encoded = checksum === "auto" ? encodeChecksum(headerChecksum(header)) : Buffer.from(checksum);
    encoded.copy(header, 148, 0, 8);
    return header;
}

export function encodeUstarFile(name, content, headerOverrides = {}) {
    const bytes = asBytes(content, name);
    const header = encodeUstarHeader({ name, size: bytes.length, ...headerOverrides });
    const padding = Buffer.alloc(padToUstarBlock(bytes.length));
    return Buffer.concat(padding.length ? [header, bytes, padding] : [header, bytes]);
}

export function ustarEof() {
    return Buffer.concat([Buffer.from(ZERO_BLOCK), Buffer.from(ZERO_BLOCK)]);
}

function prepareEntries(entries) {
    if (!Array.isArray(entries)) throw new TypeError("Archive entries must be an array.");
    const exact = new Set();
    const folded = new Set();
    return entries.map((entry, index) => {
        const name = validateArchivePath(entry?.name);
        const fold = name.toLowerCase();
        if (exact.has(name) || folded.has(fold)) hostile("Archive contains duplicate or case-colliding entry names.");
        exact.add(name);
        folded.add(fold);
        const sources = ["bytes", "path", "stream", "open"].filter((key) => entry?.[key] !== undefined);
        if (sources.length !== 1) invalid(`Archive entry ${name} must declare exactly one byte source.`);
        const bytes = entry.bytes === undefined ? null : asBytes(entry.bytes, name);
        const sizeBytes = entry.sizeBytes ?? bytes?.length;
        if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > USTAR_MAX_ENTRY_BYTES) {
            limit(`Archive entry ${name} has an invalid USTAR size.`);
        }
        if (bytes && bytes.length !== sizeBytes) invalid(`Archive entry ${name} bytes do not match its declared size.`);
        if (entry.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(entry.sha256)) invalid(`Archive entry ${name} digest must be lowercase SHA-256.`);
        return { ...entry, index, name, bytes, sizeBytes };
    });
}

function projectedArchiveSize(entries) {
    return USTAR_BLOCK_SIZE * 2 + entries.reduce(
        (total, entry) => total + USTAR_BLOCK_SIZE + entry.sizeBytes + padToUstarBlock(entry.sizeBytes),
        0,
    );
}

export function encodeDeterministicArchive(entries, {
    maxBufferedBytes = 64 * 1024 * 1024,
    limits: overrides = {},
} = {}) {
    if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 0) {
        throw new TypeError("maxBufferedBytes must be a non-negative safe integer.");
    }
    const limits = resolveDeterministicArchiveLimits(overrides);
    const prepared = prepareEntries(entries);
    if (prepared.length > limits.entries) limit("Archive exceeds the entry-count ceiling.");
    if (prepared.some((entry) => !entry.bytes)) invalid("Buffered archive encoding requires byte-backed entries.");
    const sizeBytes = projectedArchiveSize(prepared);
    if (sizeBytes > limits.archiveBytes || sizeBytes > maxBufferedBytes) limit("Buffered archive exceeds its byte ceiling.");
    const chunks = [];
    const hasher = createHash("sha256");
    for (const entry of prepared) {
        if (entry.sizeBytes > limits.entryBytes) limit(`Archive entry ${entry.name} exceeds the entry-byte ceiling.`);
        if (entry.sha256 && createHash("sha256").update(entry.bytes).digest("hex") !== entry.sha256) {
            throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HASH_MISMATCH, `Archive entry ${entry.name} does not match its expected digest.`);
        }
        const encoded = encodeUstarFile(entry.name, entry.bytes);
        hasher.update(encoded);
        chunks.push(encoded);
    }
    const eof = ustarEof();
    hasher.update(eof);
    chunks.push(eof);
    return { bytes: Buffer.concat(chunks, sizeBytes), sha256: hasher.digest("hex"), sizeBytes };
}

async function openEntrySource(entry, deadline, signal) {
    if (entry.bytes !== null) return Readable.from([entry.bytes]);
    if (entry.path !== undefined) return createReadStream(entry.path, { signal });
    if (entry.stream !== undefined) return entry.stream;
    return beforeArtifactDeadline(Promise.resolve(entry.open()), { deadline, signal });
}

export function createDeterministicArchiveStream(entries, {
    limits: overrides = {},
    deadline,
    signal,
} = {}) {
    const limits = resolveDeterministicArchiveLimits(overrides);
    deadline ??= Date.now() + limits.verificationTimeoutMs;
    const prepared = prepareEntries(entries);
    if (prepared.length > limits.entries) limit("Archive exceeds the entry-count ceiling.");
    if (projectedArchiveSize(prepared) > limits.archiveBytes) limit("Archive exceeds the archive-byte ceiling.");
    for (const entry of prepared) {
        if (entry.sizeBytes > limits.entryBytes) limit(`Archive entry ${entry.name} exceeds the entry-byte ceiling.`);
    }
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    completion.catch(() => {});
    let settled = false;
    const generate = async function* generateArchive() {
        const archiveHasher = createHash("sha256");
        const completedEntries = [];
        let sizeBytes = 0;
        const emit = (chunk) => {
            checkArtifactBoundary({ deadline, signal });
            sizeBytes += chunk.length;
            if (sizeBytes > limits.archiveBytes) limit("Archive exceeds the archive-byte ceiling.");
            archiveHasher.update(chunk);
            return chunk;
        };
        try {
            for (const entry of prepared) {
                yield emit(encodeUstarHeader({ name: entry.name, size: entry.sizeBytes }));
                const source = await openEntrySource(entry, deadline, signal);
                const readable = Readable.from(source);
                const iterator = readable[Symbol.asyncIterator]();
                const entryHasher = createHash("sha256");
                let received = 0;
                try {
                    while (true) {
                        const next = await beforeArtifactDeadline(iterator.next(), { deadline, signal });
                        if (next.done) break;
                        const chunk = asBytes(next.value, entry.name);
                        if (chunk.length > limits.maxChunkBytes) limit("Archive entry input chunk exceeds the streaming ceiling.");
                        received += chunk.length;
                        if (received > entry.sizeBytes) invalid(`Archive entry ${entry.name} exceeds its declared size.`);
                        entryHasher.update(chunk);
                        yield emit(chunk);
                    }
                } finally {
                    await closeArtifactIterator(iterator, readable);
                }
                if (received !== entry.sizeBytes) invalid(`Archive entry ${entry.name} is truncated.`);
                const sha256 = entryHasher.digest("hex");
                if (entry.sha256 && sha256 !== entry.sha256) {
                    throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HASH_MISMATCH, `Archive entry ${entry.name} does not match its expected digest.`);
                }
                completedEntries.push({ index: entry.index, name: entry.name, sizeBytes: received, sha256 });
                const padding = padToUstarBlock(received);
                if (padding) yield emit(Buffer.alloc(padding));
            }
            yield emit(ustarEof());
            settled = true;
            resolveCompletion({
                sha256: archiveHasher.digest("hex"),
                sizeBytes,
                entries: completedEntries,
            });
        } catch (error) {
            settled = true;
            rejectCompletion(error);
            throw error;
        } finally {
            if (!settled) rejectCompletion(artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.IO, "Archive stream closed before completion."));
        }
    };
    const stream = Readable.from(generate());
    stream.on("error", () => {});
    const timer = Number.isFinite(deadline) ? setTimeout(() => {
        const error = artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.TIMEOUT, "Archive stream exceeded its time budget.");
        rejectCompletion(error);
        stream.destroy(error);
    }, Math.max(1, deadline - Date.now())) : null;
    timer?.unref?.();
    stream.once("close", () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        rejectCompletion(artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.IO, "Archive stream closed before completion."));
    });
    return { stream, completion };
}

function readCString(buffer, offset, length) {
    const slice = buffer.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    const bytes = end === -1 ? slice : slice.subarray(0, end);
    if (end !== -1 && !slice.subarray(end).every((value) => value === 0)) hostile("USTAR string fields must be NUL-terminated with zero padding.");
    return { text: bytes.toString("utf8"), bytes };
}

function assertCanonicalNumeric(field, value, length) {
    if (!field.equals(encodeOctal(value, length))) hostile("USTAR numeric fields must use the frozen canonical octal encoding.");
}

function parseCanonicalSize(field) {
    if (field[11] !== 0) hostile("USTAR size fields must use canonical NUL-terminated octal.");
    const text = field.subarray(0, 11).toString("latin1");
    if (!/^[0-7]{11}$/.test(text)) hostile("USTAR size fields must be twelve-byte canonical octal.");
    const value = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(value) || value < 0) hostile("USTAR size field is not a safe integer.");
    assertCanonicalNumeric(field, value, 12);
    return value;
}

function parseHeader(header) {
    if (header.equals(ZERO_BLOCK)) return { zero: true, header };
    if (!header.subarray(257, 263).equals(USTAR_MAGIC)) hostile("Archive magic must be the frozen POSIX USTAR marker.");
    if (!header.subarray(263, 265).equals(USTAR_VERSION)) hostile("Archive version must be the frozen USTAR 00 marker.");
    const typeflag = header[156];
    if (typeflag !== REGULAR_TYPEFLAG) {
        if (typeflag === 0) hostile("Archive regular files must use typeflag '0', not NUL.");
        if (FORBIDDEN_TYPEFLAGS.has(typeflag)) hostile("Archive entries must be regular files; links, devices, sparse, PAX, and GNU headers are forbidden.");
        hostile("Archive entries must be frozen-profile regular files.");
    }
    if (header.subarray(157, 257).some((value) => value !== 0)) hostile("Archive link names must be empty.");
    if (header.subarray(329, 345).some((value) => value !== 0)) hostile("Archive device fields must be zero.");
    const prefix = readCString(header, 345, 155).text;
    if (prefix) hostile("USTAR prefix fields must be empty in the frozen profile.");
    const name = validateArchivePath(readCString(header, 0, 100).text);
    assertCanonicalNumeric(header.subarray(100, 108), USTAR_MODE, 8);
    assertCanonicalNumeric(header.subarray(108, 116), 0, 8);
    assertCanonicalNumeric(header.subarray(116, 124), 0, 8);
    assertCanonicalNumeric(header.subarray(136, 148), 0, 12);
    if (header.subarray(265, 329).some((value) => value !== 0)) hostile("Archive owner and group names must be empty.");
    const size = parseCanonicalSize(header.subarray(124, 136));
    if (!header.equals(encodeUstarHeader({ name, size }))) hostile("Archive headers must match the frozen USTAR profile byte-for-byte.");
    return { zero: false, name, size, header };
}

function detectCompression(prefix) {
    return COMPRESSION_MAGICS.some((magic) => magic.every((byte, index) => prefix[index] === byte));
}

class ArchiveReader {
    constructor(source, limits, deadline, signal) {
        this.limits = limits;
        this.deadline = deadline;
        this.signal = signal;
        this.pulled = 0;
        if (Buffer.isBuffer(source) || source instanceof Uint8Array || source instanceof ArrayBuffer) {
            this.pending = asBytes(source, "archive");
            this.pulled = this.pending.length;
            if (this.pulled > limits.archiveBytes) limit("Archive exceeds the archive-byte ceiling.");
            this.readable = null;
            this.iterator = null;
        } else {
            this.pending = Buffer.alloc(0);
            this.readable = Readable.from(source);
            this.iterator = this.readable[Symbol.asyncIterator]();
        }
    }

    async fill(size) {
        checkArtifactBoundary(this);
        while (this.pending.length < size && this.iterator) {
            const next = await beforeArtifactDeadline(this.iterator.next(), this);
            if (next.done) {
                this.iterator = null;
                break;
            }
            const chunk = asBytes(next.value, "archive");
            this.pulled += chunk.length;
            if (chunk.length > this.limits.maxChunkBytes || this.pulled > this.limits.archiveBytes) {
                await this.close();
                limit(chunk.length > this.limits.maxChunkBytes
                    ? "Archive input chunk exceeds the streaming ceiling."
                    : "Archive exceeds the archive-byte ceiling.");
            }
            this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
        }
    }

    async peek(size) {
        await this.fill(size);
        return this.pending.subarray(0, Math.min(size, this.pending.length));
    }

    async readExact(size, hasher) {
        const chunks = [];
        for await (const chunk of this.readChunks(size, hasher)) chunks.push(Buffer.from(chunk));
        return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
    }

    async *readChunks(size, hasher) {
        let remaining = size;
        while (remaining > 0) {
            await this.fill(1);
            if (!this.pending.length) hostile("Archive is truncated.");
            const length = Math.min(remaining, this.pending.length);
            const slice = this.pending.subarray(0, length);
            this.pending = this.pending.subarray(length);
            remaining -= length;
            hasher.update(slice);
            yield slice;
        }
    }

    async close() {
        if (!this.iterator) return;
        const iterator = this.iterator;
        this.iterator = null;
        await closeArtifactIterator(iterator, this.readable);
    }
}

export async function verifyDeterministicArchive(input, {
    limits: overrides = {},
    deadline,
    signal,
    entryLimit,
    stagingRoot,
    stagingDir,
    cleanupStaging = false,
    retainStaging = false,
    faults = {},
} = {}) {
    const limits = resolveDeterministicArchiveLimits(overrides);
    deadline ??= Date.now() + limits.verificationTimeoutMs;
    let ownedRoot = null;
    let staging = null;
    let reader = null;
    let succeeded = false;
    const archiveHasher = createHash("sha256");
    const entries = [];
    const exact = new Set();
    const folded = new Set();
    const normalized = new Set();
    let temporaryBytes = 0;
    try {
        checkArtifactBoundary({ deadline, signal });
        if (stagingDir) {
            await fs.mkdir(stagingDir, { recursive: true, mode: 0o700 });
            staging = { dir: stagingDir, cleanup: cleanupStaging };
        } else {
            const root = stagingRoot ?? await fs.mkdtemp(path.join(os.tmpdir(), "cev-artifact-archive-"));
            if (!stagingRoot) ownedRoot = root;
            else await fs.mkdir(root, { recursive: true, mode: 0o700 });
            staging = { ...await createArtifactStagingArea(root), cleanup: true };
        }
        reader = new ArchiveReader(input, limits, deadline, signal);
        const prefix = await reader.peek(6);
        if (prefix.length < 2) hostile("Archive is truncated.");
        if (detectCompression(prefix)) hostile("Compressed archives are forbidden; deterministic archives use uncompressed USTAR.");
        const nextHeader = async () => {
            checkArtifactBoundary({ deadline, signal });
            return parseHeader(await reader.readExact(USTAR_BLOCK_SIZE, archiveHasher));
        };
        let firstZero = false;
        while (true) {
            const header = await nextHeader();
            if (header.zero) {
                firstZero = true;
                break;
            }
            if (entries.length >= limits.entries || entries.length >= limits.inodes) limit("Archive exceeds the entry-count or inode ceiling.");
            const fold = header.name.toLowerCase();
            const nfc = header.name.normalize("NFC");
            if (exact.has(header.name)) hostile("Archive contains duplicate entry names.");
            if (folded.has(fold) || normalized.has(nfc)) hostile("Archive contains case or Unicode name collisions.");
            exact.add(header.name);
            folded.add(fold);
            normalized.add(nfc);
            const selectedLimit = entryLimit?.({ index: entries.length, name: header.name, sizeBytes: header.size }) ?? limits.entryBytes;
            if (!Number.isSafeInteger(selectedLimit) || selectedLimit < 0) throw new TypeError("entryLimit must return a non-negative safe integer.");
            if (header.size > Math.min(selectedLimit, limits.entryBytes)) limit(`Archive entry ${header.name} exceeds its byte ceiling.`);
            temporaryBytes += header.size;
            if (temporaryBytes > limits.temporaryBytes) limit("Archive exceeds the temporary-byte ceiling.");
            const stagingName = `e${String(entries.length).padStart(6, "0")}`;
            const destination = path.join(staging.dir, stagingName);
            const staged = await stageArtifactStream(reader.readChunks(header.size, archiveHasher), {
                destination,
                expectedBytes: header.size,
                maxBytes: Math.min(selectedLimit, limits.entryBytes),
                maxChunkBytes: limits.maxChunkBytes,
                deadline,
                signal,
                faults,
            });
            const paddingSize = padToUstarBlock(header.size);
            if (paddingSize) {
                const padding = await reader.readExact(paddingSize, archiveHasher);
                if (!padding.every((byte) => byte === 0)) hostile("Archive content padding must be zero.");
            }
            entries.push({
                index: entries.length,
                name: header.name,
                sizeBytes: staged.sizeBytes,
                sha256: staged.sha256,
                stagingName,
                path: destination,
            });
        }
        if (!firstZero) hostile("Archive is missing terminal zero blocks.");
        const secondZero = await nextHeader();
        if (!secondZero.zero) hostile("Archive must end with exactly two terminal zero blocks.");
        const trailing = await reader.peek(1);
        if (trailing.length) hostile("Archive must not contain trailing data after the terminal zero blocks.");
        const keep = retainStaging || !staging.cleanup;
        succeeded = true;
        return {
            sha256: archiveHasher.digest("hex"),
            sizeBytes: reader.pulled,
            entries: keep ? entries : entries.map(({ path: _path, ...entry }) => entry),
            stagingDir: keep ? staging.dir : null,
            cleanup: async () => {
                if (staging.cleanup) await fs.rm(ownedRoot ?? staging.dir, { recursive: true, force: true });
            },
        };
    } finally {
        await reader?.close();
        if (staging?.cleanup && (!succeeded || !retainStaging)) {
            await fs.rm(staging.dir, { recursive: true, force: true }).catch(() => {});
        }
        if (ownedRoot && (!succeeded || !retainStaging)) {
            await fs.rm(ownedRoot, { recursive: true, force: true }).catch(() => {});
        }
    }
}
