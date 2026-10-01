import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import {
    fsyncDir,
    mapFsError,
    maybeFault,
    writeExclusiveFile,
} from "../storage/visual-assets/atomicFs.js";

export const ARTIFACT_VERIFICATION_ERROR_CODES = Object.freeze({
    HOSTILE: "ARTIFACT_HOSTILE",
    INVALID: "ARTIFACT_INVALID",
    HASH_MISMATCH: "ARTIFACT_HASH_MISMATCH",
    LIMIT_EXCEEDED: "ARTIFACT_LIMIT_EXCEEDED",
    TIMEOUT: "ARTIFACT_TIMEOUT",
    CANCELLED: "ARTIFACT_CANCELLED",
    IO: "ARTIFACT_IO",
});

export const DEFAULT_MAX_ARTIFACT_CHUNK_BYTES = 32 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const PERCENT_TRAVERSAL = /%(?:2e|2f|5c)/i;

export class ArtifactVerificationError extends Error {
    constructor(code, message, details = {}) {
        super(message, details.cause ? { cause: details.cause } : undefined);
        this.name = "ArtifactVerificationError";
        this.code = code;
        if (details.path !== undefined) this.path = details.path;
    }
}

export function artifactVerificationError(code, message, details) {
    return new ArtifactVerificationError(code, message, details);
}

function mappedError(error) {
    if (error instanceof ArtifactVerificationError) return error;
    if (error?.name === "AbortError") {
        return artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.CANCELLED, "Artifact operation was cancelled.", { cause: error });
    }
    const mapped = mapFsError(error);
    return artifactVerificationError(
        ARTIFACT_VERIFICATION_ERROR_CODES.IO,
        `Artifact I/O failed: ${mapped?.message ?? String(mapped)}`,
        { cause: mapped },
    );
}

export function resolveContentLimits(ceilings, overrides = {}, {
    integerKeys = [],
    minimums = {},
} = {}) {
    if (!ceilings || typeof ceilings !== "object" || Array.isArray(ceilings)) {
        throw new TypeError("Content-limit ceilings must be an object.");
    }
    const integer = new Set(integerKeys);
    const resolved = {};
    for (const [key, ceilingValue] of Object.entries(ceilings)) {
        const ceiling = Number(ceilingValue);
        const supplied = overrides[key] === undefined ? ceiling : Number(overrides[key]);
        const minimum = Number(minimums[key] ?? 0);
        if (!Number.isFinite(ceiling) || ceiling < minimum) {
            throw new TypeError(`Content-limit ceiling ${key} must be a finite number greater than or equal to ${minimum}.`);
        }
        if (!Number.isFinite(supplied) || supplied < minimum) {
            throw new TypeError(`Content limit ${key} must be a finite number greater than or equal to ${minimum}.`);
        }
        const normalized = integer.has(key) ? Math.floor(supplied) : supplied;
        resolved[key] = Math.min(normalized, ceiling);
    }
    const unknown = Object.keys(overrides).find((key) => !Object.hasOwn(ceilings, key));
    if (unknown) throw new TypeError(`Unknown content limit ${unknown}.`);
    return Object.freeze(resolved);
}

export function validateArchivePath(value, { maxBytes = 99 } = {}) {
    const name = String(value ?? "");
    if (!name) throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, "Archive entry names must not be empty.");
    if (name.includes("\0")) throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, "Archive entry names must not contain NUL.");
    if (name.includes("\\")) throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, "Archive entry names must not contain backslashes.");
    if (name.startsWith("/")) throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, "Archive entry names must be relative.");
    if (PERCENT_TRAVERSAL.test(name)) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, "Archive entry names must not contain encoded traversal.");
    }
    if (name.normalize("NFC") !== name) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, "Archive entry names must be NFC.");
    }
    const segments = name.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw artifactVerificationError(
            ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE,
            "Archive entry names must not contain empty, parent, or current-directory segments.",
        );
    }
    if (/[^\u0020-\u007e]/u.test(name)) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, "Archive entry names must be printable ASCII.");
    }
    if (Buffer.byteLength(name, "utf8") > maxBytes) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HOSTILE, "Archive entry name exceeds the frozen USTAR name field.");
    }
    return name;
}

export function artifactDeadlineError(message = "Artifact operation exceeded its time budget.") {
    return artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.TIMEOUT, message);
}

export function optionalAbortSignal(signal) {
    return signal instanceof AbortSignal ? signal : undefined;
}

export function checkArtifactBoundary({ deadline = Number.POSITIVE_INFINITY, signal } = {}) {
    if (signal?.aborted) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.CANCELLED, "Artifact operation was cancelled.", { cause: signal.reason });
    }
    if (Date.now() >= deadline) throw artifactDeadlineError();
}

export async function beforeArtifactDeadline(promise, {
    deadline = Number.POSITIVE_INFINITY,
    signal,
} = {}) {
    Promise.resolve(promise).catch(() => {});
    checkArtifactBoundary({ deadline, signal });
    if (!Number.isFinite(deadline) && !signal) return promise;
    let timer;
    let abort;
    try {
        const racers = [promise];
        if (Number.isFinite(deadline)) {
            racers.push(new Promise((_, reject) => {
                timer = setTimeout(() => reject(artifactDeadlineError()), Math.max(1, deadline - Date.now()));
            }));
        }
        if (signal) {
            racers.push(new Promise((_, reject) => {
                abort = () => reject(artifactVerificationError(
                    ARTIFACT_VERIFICATION_ERROR_CODES.CANCELLED,
                    "Artifact operation was cancelled.",
                    { cause: signal.reason },
                ));
                signal.addEventListener("abort", abort, { once: true });
            }));
        }
        return await Promise.race(racers);
    } finally {
        clearTimeout(timer);
        if (abort) signal.removeEventListener("abort", abort);
    }
}

export async function closeArtifactIterator(iterator, readable) {
    readable?.destroy?.();
    const closing = Promise.resolve(iterator?.return?.()).catch(() => {});
    await Promise.race([closing, new Promise((resolve) => setImmediate(resolve))]);
}

function asChunk(value) {
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.INVALID, "Artifact streams must produce byte chunks.");
}

function digestMatches(actual, expected) {
    if (!SHA256.test(expected)) return false;
    return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

async function consumeArtifactStream(source, {
    maxBytes = Number.MAX_SAFE_INTEGER,
    expectedBytes,
    expectedSha256,
    maxChunkBytes = DEFAULT_MAX_ARTIFACT_CHUNK_BYTES,
    deadline = Number.POSITIVE_INFINITY,
    signal,
    onChunk,
} = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("maxBytes must be a non-negative safe integer.");
    if (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes)) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.LIMIT_EXCEEDED, "Declared artifact size exceeds its byte ceiling.");
    }
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes <= 0) throw new TypeError("maxChunkBytes must be a positive safe integer.");
    if (expectedSha256 !== undefined && !SHA256.test(expectedSha256)) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.INVALID, "Expected artifact digest must be lowercase SHA-256.");
    }
    const byteSource = Buffer.isBuffer(source) || source instanceof Uint8Array || source instanceof ArrayBuffer;
    const readable = byteSource ? Readable.from([asChunk(source)]) : source;
    const iterator = readable[Symbol.asyncIterator]();
    const hasher = createHash("sha256");
    let sizeBytes = 0;
    try {
        while (true) {
            const next = await beforeArtifactDeadline(iterator.next(), { deadline, signal });
            if (next.done) break;
            const chunk = asChunk(next.value);
            if (chunk.length > maxChunkBytes) {
                throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.LIMIT_EXCEEDED, "Artifact input chunk exceeds its byte ceiling.");
            }
            sizeBytes += chunk.length;
            if (sizeBytes > maxBytes || (expectedBytes !== undefined && sizeBytes > expectedBytes)) {
                throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.LIMIT_EXCEEDED, "Artifact stream exceeds its declared byte ceiling.");
            }
            checkArtifactBoundary({ deadline, signal });
            hasher.update(chunk);
            if (onChunk) await onChunk(chunk, sizeBytes);
            checkArtifactBoundary({ deadline, signal });
        }
    } finally {
        await closeArtifactIterator(iterator, readable);
    }
    if (expectedBytes !== undefined && sizeBytes !== expectedBytes) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.INVALID, `Artifact stream ended after ${sizeBytes} bytes; expected ${expectedBytes}.`);
    }
    const sha256 = hasher.digest("hex");
    if (expectedSha256 !== undefined && !digestMatches(sha256, expectedSha256)) {
        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.HASH_MISMATCH, "Artifact bytes do not match the expected SHA-256 digest.");
    }
    return { sizeBytes, sha256 };
}

export async function hashArtifactStream(source, options = {}) {
    try {
        return await consumeArtifactStream(source, options);
    } catch (error) {
        throw mappedError(error);
    }
}

export async function stageArtifactStream(source, {
    destination,
    mode = 0o600,
    faults = {},
    ...options
} = {}) {
    if (!destination) throw new TypeError("Artifact staging destination is required.");
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    let handle = null;
    let created = false;
    let succeeded = false;
    try {
        handle = await fs.open(destination, "wx", mode);
        created = true;
        const result = await consumeArtifactStream(source, {
            ...options,
            onChunk: async (chunk) => {
                await beforeArtifactDeadline(maybeFault(faults, "write"), options);
                let offset = 0;
                while (offset < chunk.length) {
                    checkArtifactBoundary(options);
                    const written = await handle.write(chunk, offset, chunk.length - offset);
                    if (written.bytesWritten <= 0) {
                        throw artifactVerificationError(ARTIFACT_VERIFICATION_ERROR_CODES.IO, "Artifact staging write made no progress.");
                    }
                    offset += written.bytesWritten;
                }
            },
        });
        await beforeArtifactDeadline(maybeFault(faults, "fsync"), options);
        await handle.sync();
        await handle.close();
        handle = null;
        await beforeArtifactDeadline(maybeFault(faults, "dirFsync"), options);
        await fsyncDir(path.dirname(destination));
        checkArtifactBoundary(options);
        succeeded = true;
        return { ...result, path: destination };
    } catch (error) {
        throw mappedError(error);
    } finally {
        await handle?.close().catch(() => {});
        if (!succeeded && created) await fs.rm(destination, { force: true }).catch(() => {});
    }
}

export async function createArtifactStagingArea(rootDir, {
    id = randomUUID(),
    meta = {},
} = {}) {
    await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    const directory = path.join(rootDir, id);
    await fs.mkdir(directory, { recursive: false, mode: 0o700 });
    const document = {
        id,
        createdAt: new Date().toISOString(),
        phase: "created",
        entries: [],
        ...meta,
    };
    try {
        await writeExclusiveFile(path.join(directory, "meta.json"), `${JSON.stringify(document, null, 2)}\n`);
    } catch (error) {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        throw mappedError(error);
    }
    return { id, dir: directory, meta: document };
}

export async function recoverArtifactStagingAreas(rootDir, {
    ttlMs,
    now = () => new Date(),
    active = new Set(),
} = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs < 0) throw new TypeError("Staging recovery ttlMs must be non-negative.");
    let names;
    try {
        names = await fs.readdir(rootDir);
    } catch (error) {
        if (error.code === "ENOENT") return { removed: 0 };
        throw mappedError(error);
    }
    const cutoff = now().getTime() - ttlMs;
    let removed = 0;
    for (const name of names) {
        const directory = path.join(rootDir, name);
        if (active.has(directory)) continue;
        let createdAt = Number.NaN;
        try {
            const meta = JSON.parse(await fs.readFile(path.join(directory, "meta.json"), "utf8"));
            createdAt = Date.parse(meta.createdAt || 0);
        } catch {
            try {
                const stat = await fs.lstat(directory);
                if (!stat.isDirectory()) continue;
                createdAt = stat.mtimeMs;
            } catch {
                createdAt = Number.NaN;
            }
        }
        if (!Number.isFinite(createdAt) || createdAt <= cutoff) {
            await fs.rm(directory, { recursive: true, force: true });
            removed += 1;
        }
    }
    return { removed };
}
