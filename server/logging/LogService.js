import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

import { ByteReader, ByteWriter, SFLOG_VERSION, decodeRecordStream } from "../../app/logging/SFLogCodec.js";
import { downsampleMinMax } from "../../app/analysis/downsample.js";
import {
    LOG_CATALOG_FILENAME,
    createLogCatalog,
    logCatalogDefinition,
    normalizeLogCatalog,
    normalizeLogFolderId,
} from "../../app/logging/LogCatalogDocument.js";
import {
    backfillEvidenceFromAttachments,
    createEmptyLogEvidence,
    hasCompleteEvidenceIndex,
    mergeLogEvidence,
    normalizeLogEvidence,
    projectEvidenceFromRunResult,
} from "../../app/logging/LogEvidenceDocument.js";
import { MAX_LOG_BATCH_BYTES } from "../../app/logging/LogLimits.js";
import { collectAttachments, readAutonomySnapshot, readPoseSeries } from "./spatialLogQueries.js";

const DEFAULT_LOGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "logs");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const HEADER_MAGIC = Buffer.from("SFLG");
const CHUNK_MAGIC = Buffer.from("CHNK");
const INDEX_MAGIC = Buffer.from("INDX");
const END_MAGIC = Buffer.from("SEND");
const CHUNK_HEADER_BYTES = 36;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024 * 1024;
const INFLATED_CHUNK_CACHE_BYTES = 256 * 1024 * 1024;

const INDEX_DECODE_OPTIONS = Object.freeze({
    includeUpdates: false,
    includeCheckpointValues: false,
    includeEvents: false,
    includeAttachments: false,
});

function pathDecodeOptions(signalPath) {
    return {
        includeUpdates: (schema) => schema.path === signalPath,
        includeCheckpointValues: false,
        includeEvents: false,
        includeAttachments: false,
    };
}

async function readAt(handle, length, position) {
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
        if (bytesRead === 0) throw new Error("Unexpected end of SFLog file.");
        offset += bytesRead;
    }
    return buffer;
}

function getNested(value, field) {
    if (!field) return value;
    return String(field).split(".").reduce((current, key) => current?.[key], value);
}

function safeSegment(value) {
    const text = String(value ?? "").trim();
    if (!text || text === "." || text === ".." || /[\\/]/.test(text)) {
        throw new Error(`Invalid log id: ${JSON.stringify(value)}`);
    }
    return encodeURIComponent(text);
}

function createId() {
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    return `log-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function createCrcTable() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let value = n;
        for (let k = 0; k < 8; k += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[n] = value >>> 0;
    }
    return table;
}

const CRC_TABLE = createCrcTable();

export function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function buildFileHeader(metadata) {
    const metadataBytes = textEncoder.encode(JSON.stringify(metadata));
    const writer = new ByteWriter(12 + metadataBytes.length);
    writer.bytes(HEADER_MAGIC);
    writer.uint16(SFLOG_VERSION);
    writer.uint16(0x0003); // little endian + gzip chunks
    writer.uint32(metadataBytes.length);
    writer.bytes(metadataBytes);
    return writer.finish();
}

function parseFileHeader(bytes) {
    if (bytes.byteLength < 4) throw new Error("The file is too short to be a valid SFLog.");
    const prefix = textDecoder.decode(bytes.subarray(0, Math.min(bytes.byteLength, 32)));
    if (!prefix.startsWith("SFLG")) {
        if (prefix.startsWith("RLOG")) throw new Error("RLOG import is not supported yet; import a native .sflog file.");
        if (prefix.startsWith("WPILOG")) throw new Error("WPILOG import is not supported yet; import a native .sflog file.");
        if (prefix.includes(",") || prefix.includes("\n")) throw new Error("CSV import is not supported yet; import a native .sflog file.");
        throw new Error("Unsupported log format; expected an SFLog file with SFLG magic.");
    }
    const reader = new ByteReader(bytes);
    if (textDecoder.decode(reader.readBytes(4)) !== "SFLG") throw new Error("Not an SFLog file.");
    const version = reader.uint16();
    if (version !== SFLOG_VERSION) throw new Error(`Unsupported SFLog version ${version}.`);
    const flags = reader.uint16();
    const metadataLength = reader.uint32();
    if (metadataLength > 16 * 1024 * 1024) throw new Error("SFLog metadata is too large.");
    const metadata = JSON.parse(textDecoder.decode(reader.readBytes(metadataLength)));
    return { version, flags, metadata, headerLength: reader.offset };
}

function buildChunkHeader({ startUs, endUs, uncompressedLength, compressedLength, crc }) {
    const writer = new ByteWriter(CHUNK_HEADER_BYTES);
    writer.bytes(CHUNK_MAGIC);
    writer.uint64(startUs);
    writer.uint64(endUs);
    writer.uint32(uncompressedLength);
    writer.uint32(compressedLength);
    writer.uint32(crc);
    writer.uint32(0);
    return writer.finish();
}

function buildIndexFooter(index) {
    const writer = new ByteWriter(16 + index.length * 25);
    writer.bytes(INDEX_MAGIC);
    writer.uint32(index.length);
    for (const entry of index) {
        writer.uint64(entry.startUs);
        writer.uint64(entry.endUs);
        writer.uint64(entry.offset);
        writer.uint8(entry.hasCheckpoint ? 1 : 0);
    }
    return writer.finish();
}

async function readSidecar(filePath) {
    try {
        return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

function catalogHash(definition) {
    const normalize = (entry) => {
        if (Array.isArray(entry)) return entry.map(normalize);
        if (!entry || typeof entry !== "object") return entry;
        return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, normalize(entry[key])]));
    };
    return createHash("sha256").update(JSON.stringify(normalize(definition))).digest("hex");
}

function emptyCatalogDocument() {
    const catalog = createLogCatalog();
    return {
        ...catalog,
        revision: 0,
        definitionHash: catalogHash(logCatalogDefinition(catalog)),
        createdAt: null,
        updatedAt: null,
    };
}

function isLogSidecarName(name, files) {
    if (!name.endsWith(".json") || name === LOG_CATALOG_FILENAME) return false;
    const id = name.slice(0, -".json".length);
    return files.has(`${id}.sflog`) || files.has(`${id}.partial`);
}

async function withFileBytes(logsDir, metadata, files) {
    const folderId = normalizeLogFolderId(metadata?.folderId);
    let bytes = Number(metadata?.bytes);
    if (!Number.isFinite(bytes)) {
        const fileName = files.has(`${metadata.id}.sflog`) ? `${metadata.id}.sflog` : `${metadata.id}.partial`;
        try {
            bytes = (await fs.stat(path.join(logsDir, fileName))).size;
        } catch {
            bytes = 0;
        }
    }
    return { ...metadata, folderId, bytes };
}

export class LogService {
    constructor(logsDir = DEFAULT_LOGS_DIR) {
        this.logsDir = logsDir;
        this.catalogPath = path.join(logsDir, LOG_CATALOG_FILENAME);
        this.active = new Map();
        this.indexCache = new Map();
        this._inflatedChunks = new Map();
        this._inflatedChunkBytes = 0;
        this._logOps = new Map();
        this._pathSampleCache = new Map();
        this._catalogWriteChain = Promise.resolve();
    }

    _queueLogOp(id, fn) {
        const previous = this._logOps.get(id) || Promise.resolve();
        const run = previous.catch(() => {}).then(fn);
        this._logOps.set(id, run);
        return run;
    }

    _cachedInflatedChunk(id, chunkIndex) {
        return this._inflatedChunks.get(id)?.get(chunkIndex) || null;
    }

    _forgetInflatedLog(id) {
        const chunks = this._inflatedChunks.get(id);
        if (!chunks) return;
        this._inflatedChunks.delete(id);
        for (const bytes of chunks.values()) this._inflatedChunkBytes -= bytes.byteLength || bytes.length || 0;
        if (this._inflatedChunkBytes < 0) this._inflatedChunkBytes = 0;
    }

    _rememberInflatedChunk(id, chunkIndex, raw) {
        let chunks = this._inflatedChunks.get(id);
        if (chunks?.has(chunkIndex)) return;
        const size = raw.byteLength || raw.length || 0;
        if (size > INFLATED_CHUNK_CACHE_BYTES) return;
        while (this._inflatedChunkBytes + size > INFLATED_CHUNK_CACHE_BYTES) {
            const oldestOther = [...this._inflatedChunks.keys()].find((key) => key !== id);
            if (oldestOther == null) return;
            this._forgetInflatedLog(oldestOther);
        }
        if (!chunks) {
            chunks = new Map();
            this._inflatedChunks.set(id, chunks);
        }
        chunks.set(chunkIndex, raw);
        this._inflatedChunkBytes += size;
    }

    async listLogs() {
        await fs.mkdir(this.logsDir, { recursive: true });
        await this.recoverPartialLogs();
        const entries = await fs.readdir(this.logsDir);
        const files = new Set(entries);
        const sidecars = entries.filter((name) => isLogSidecarName(name, files));
        const logs = await Promise.all(sidecars.map(async (name) => {
            const metadata = await readSidecar(path.join(this.logsDir, name));
            if (!metadata) return null;
            const ensured = await this._ensureEvidenceIndex(metadata);
            return withFileBytes(this.logsDir, ensured, files);
        }));
        return logs.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    }

    async createSession(input = {}) {
        await fs.mkdir(this.logsDir, { recursive: true });
        const id = safeSegment(input.id || createId());
        const partialPath = this._partialPath(id);
        const finalPath = this._finalPath(id);
        try {
            await fs.access(finalPath);
            throw new Error(`Log "${id}" already exists.`);
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }

        const evidence = input.evidence
            ? normalizeLogEvidence(input.evidence)
            : createEmptyLogEvidence({
                manifestId: input.manifestId || null,
                runId: input.runId || null,
                definitionHash: input.definitionHash || null,
                resolvedHash: input.resolvedHash || null,
                gitCommit: input.gitHash || null,
            });
        const metadata = {
            id,
            name: String(input.name || `Recording ${new Date().toLocaleString()}`),
            createdAt: new Date().toISOString(),
            status: "recording",
            format: "sflog",
            version: SFLOG_VERSION,
            environmentId: input.environmentId || null,
            profile: input.profile || null,
            simulator: input.simulator || null,
            appVersion: input.appVersion || null,
            gitHash: input.gitHash || null,
            runId: input.runId || null,
            manifestId: input.manifestId || null,
            manifestRevision: input.manifestRevision || null,
            definitionHash: input.definitionHash || null,
            resolvedHash: input.resolvedHash || null,
            provenance: input.provenance || null,
            evidence,
            tags: Array.isArray(input.tags) ? input.tags : [],
            folderId: normalizeLogFolderId(input.folderId),
            incomplete: false,
        };
        const header = buildFileHeader(metadata);
        await fs.writeFile(partialPath, header, { flag: "wx" });
        await this._writeSidecar(id, { ...metadata, bytes: header.length, durationUs: 0 });
        this.active.set(id, {
            id,
            metadata,
            partialPath,
            index: [],
            bytesWritten: header.length,
            lastSequence: -1,
            pending: [],
            pendingBytes: 0,
            pendingStartUs: null,
            pendingEndUs: null,
            writeChain: Promise.resolve(),
            ingestSchemas: new Map(),
        });
        return { id, metadata };
    }

    async appendBatch(idValue, { sequence, startUs, endUs, bytes }) {
        const id = safeSegment(idValue);
        const session = this.active.get(id);
        if (!session) throw new Error(`Recording session "${id}" is not active.`);
        const seq = Number(sequence);
        if (!Number.isInteger(seq) || seq < 0) throw new Error("Batch sequence must be a non-negative integer.");
        if (seq <= session.lastSequence) {
            return { nextSequence: session.lastSequence + 1, bytesWritten: session.bytesWritten, duplicate: true };
        }
        if (seq !== session.lastSequence + 1) throw new Error(`Expected batch ${session.lastSequence + 1}, received ${seq}.`);

        const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        if (payload.byteLength > MAX_LOG_BATCH_BYTES) throw new Error(`Log batch exceeds the ${MAX_LOG_BATCH_BYTES} byte limit.`);
        const validated = decodeRecordStream(payload, session.ingestSchemas);
        session.ingestSchemas = validated.schemas;
        session.lastSequence = seq;
        session.pending.push(payload);
        session.pendingBytes += payload.byteLength;
        session.pendingStartUs = session.pendingStartUs === null ? Number(startUs) : Math.min(session.pendingStartUs, Number(startUs));
        session.pendingEndUs = session.pendingEndUs === null ? Number(endUs) : Math.max(session.pendingEndUs, Number(endUs));

        if (session.pendingBytes >= 1024 * 1024 || session.pendingEndUs - session.pendingStartUs >= 1e6) {
            await this._flush(session);
        }
        return { nextSequence: session.lastSequence + 1, bytesWritten: session.bytesWritten, duplicate: false };
    }

    async finalize(idValue, patch = {}) {
        const id = safeSegment(idValue);
        const session = this.active.get(id);
        if (!session) throw new Error(`Recording session "${id}" is not active.`);
        await this._flush(session);

        const indexOffset = session.bytesWritten;
        const footer = buildIndexFooter(session.index);
        const locator = new ByteWriter(12);
        locator.uint64(indexOffset);
        locator.bytes(END_MAGIC);
        await fs.appendFile(session.partialPath, Buffer.from(footer));
        await fs.appendFile(session.partialPath, Buffer.from(locator.finish()));
        session.bytesWritten += footer.length + 12;

        const finalPath = this._finalPath(id);
        await fs.rename(session.partialPath, finalPath);
        const durationUs = session.index.at(-1)?.endUs || 0;
        const { runResult, evidence: evidencePatch, ...restPatch } = patch || {};
        let evidence = session.metadata.evidence
            ? normalizeLogEvidence(session.metadata.evidence)
            : createEmptyLogEvidence({
                manifestId: session.metadata.manifestId,
                runId: session.metadata.runId,
                definitionHash: session.metadata.definitionHash,
                resolvedHash: session.metadata.resolvedHash,
                gitCommit: session.metadata.gitHash,
            });
        if (runResult) {
            evidence = mergeLogEvidence(evidence, projectEvidenceFromRunResult(runResult));
        }
        if (evidencePatch) {
            evidence = mergeLogEvidence(evidence, evidencePatch);
        }
        const metadata = {
            ...session.metadata,
            ...restPatch,
            evidence,
            status: restPatch.incomplete ? "incomplete" : "complete",
            incomplete: Boolean(restPatch.incomplete),
            completedAt: new Date().toISOString(),
            durationUs,
            bytes: session.bytesWritten,
        };
        await this._writeSidecar(id, metadata);
        this.active.delete(id);
        this.indexCache.delete(id);
        return metadata;
    }

    async _flush(session) {
        if (session.pending.length === 0) return;
        const raw = Buffer.concat(session.pending.map((bytes) => Buffer.from(bytes)));
        const compressed = gzipSync(raw, { level: 6 });
        const decoded = this._decodeForIndex(raw, session);
        const header = buildChunkHeader({
            startUs: session.pendingStartUs || 0,
            endUs: session.pendingEndUs || session.pendingStartUs || 0,
            uncompressedLength: raw.length,
            compressedLength: compressed.length,
            crc: crc32(raw),
        });
        const offset = session.bytesWritten;
        session.writeChain = session.writeChain.then(() => fs.appendFile(session.partialPath, Buffer.concat([Buffer.from(header), compressed])));
        await session.writeChain;
        session.index.push({
            startUs: session.pendingStartUs || 0,
            endUs: session.pendingEndUs || session.pendingStartUs || 0,
            offset,
            compressedLength: compressed.length,
            uncompressedLength: raw.length,
            hasCheckpoint: decoded.checkpoints.length > 0,
        });
        session.bytesWritten += header.length + compressed.length;
        session.pending = [];
        session.pendingBytes = 0;
        session.pendingStartUs = null;
        session.pendingEndUs = null;
        await this._writeSidecar(session.id, {
            ...session.metadata,
            status: "recording",
            bytes: session.bytesWritten,
            durationUs: session.index.at(-1)?.endUs || 0,
        });
    }

    _decodeForIndex(raw, session) {
        session.schemas ||= new Map();
        const decoded = decodeRecordStream(raw, session.schemas);
        session.schemas = decoded.schemas;
        return decoded;
    }

    async getMetadata(idValue) {
        const id = safeSegment(idValue);
        const metadata = await readSidecar(this._sidecarPath(id));
        if (!metadata) throw new Error(`Log "${id}" was not found.`);
        const ensured = await this._ensureEvidenceIndex(metadata);
        return { ...ensured, folderId: normalizeLogFolderId(ensured.folderId) };
    }

    async updateMetadata(idValue, patch = {}) {
        const metadata = await this.getMetadata(idValue);
        const updated = {
            ...metadata,
            name: patch.name === undefined ? metadata.name : String(patch.name).trim() || metadata.name,
            tags: patch.tags === undefined ? metadata.tags : (Array.isArray(patch.tags) ? patch.tags.map(String) : metadata.tags),
            folderId: patch.folderId === undefined ? normalizeLogFolderId(metadata.folderId) : normalizeLogFolderId(patch.folderId),
            evidence: patch.evidence === undefined
                ? metadata.evidence
                : mergeLogEvidence(metadata.evidence, patch.evidence),
        };
        await this._writeSidecar(metadata.id, updated);
        return updated;
    }

    /**
     * Strict internal linker for managed/browser experiment lineage. Never rewrites .sflog bytes.
     */
    async linkExperimentEvidence(idValue, input = {}) {
        const metadata = await this.getMetadata(idValue);
        const patch = projectEvidenceFromRunResult({
            suiteId: input.suiteId ?? null,
            resultId: input.resultId ?? null,
            caseId: input.caseId ?? null,
            runId: input.runId ?? null,
            manifestId: input.manifestId ?? null,
            definitionHash: input.definitionHash ?? null,
            resolvedHash: input.resolvedHash ?? null,
            simulationSemanticHash: input.simulationSemanticHash ?? null,
            episodeHash: input.episodeHash ?? null,
            trajectoryHash: input.trajectoryHash ?? null,
            worldHash: input.worldHash ?? input.dependencyHashes?.world ?? null,
            calibrationHash: input.calibrationHash ?? input.dependencyHashes?.calibration ?? null,
            candidateModels: input.candidateModels ?? [],
            gitCommit: input.gitCommit ?? input.gitHash ?? null,
        });
        const evidence = mergeLogEvidence(metadata.evidence, patch);
        const updated = { ...metadata, evidence };
        await this._writeSidecar(metadata.id, updated);
        return updated;
    }

    async _ensureEvidenceIndex(metadata) {
        if (!metadata?.id) return metadata;
        if (hasCompleteEvidenceIndex(metadata.evidence) && metadata.evidence?.kind === "cev-sim.log-evidence") {
            try {
                return { ...metadata, evidence: normalizeLogEvidence(metadata.evidence) };
            } catch {
                // Fall through and rebuild from attachments/header fields.
            }
        }
        if (metadata.status === "recording" || this.active.has(metadata.id)) {
            return {
                ...metadata,
                evidence: metadata.evidence
                    ? normalizeLogEvidence(metadata.evidence)
                    : createEmptyLogEvidence({
                        manifestId: metadata.manifestId,
                        runId: metadata.runId,
                        definitionHash: metadata.definitionHash,
                        resolvedHash: metadata.resolvedHash,
                        gitCommit: metadata.gitHash,
                    }),
            };
        }
        let attachments = [];
        try {
            attachments = await collectAttachments(this, metadata.id, {
                names: ["run-manifest.json", "run-results.json", "calibration.json", "provenance.json"],
            });
        } catch (error) {
            const evidence = mergeLogEvidence(
                metadata.evidence,
                createEmptyLogEvidence({
                    manifestId: metadata.manifestId,
                    runId: metadata.runId,
                    definitionHash: metadata.definitionHash,
                    resolvedHash: metadata.resolvedHash,
                    gitCommit: metadata.gitHash,
                    source: {
                        backfilled: true,
                        warnings: [`Attachment backfill failed: ${error.message}`],
                    },
                }),
            );
            const updated = { ...metadata, evidence };
            await this._writeSidecar(metadata.id, updated);
            return updated;
        }
        const evidence = backfillEvidenceFromAttachments(metadata, attachments);
        const updated = { ...metadata, evidence };
        await this._writeSidecar(metadata.id, updated);
        return updated;
    }

    async getCatalog() {
        await fs.mkdir(this.logsDir, { recursive: true });
        const stored = await readSidecar(this.catalogPath);
        if (!stored) return emptyCatalogDocument();
        try {
            return normalizeLogCatalog(stored);
        } catch {
            return emptyCatalogDocument();
        }
    }

    putCatalog(value = {}) {
        const requested = value.catalog ?? value;
        const expectedRevision = value.expectedRevision ?? requested.revision;
        const operation = this._catalogWriteChain.catch(() => {}).then(async () => {
            const current = await this.getCatalog();
            const currentRevision = Number(current.revision || 0);
            if (expectedRevision !== undefined && Number(expectedRevision) !== currentRevision) {
                throw new Error(`Log catalog revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`);
            }
            const now = new Date().toISOString();
            const normalized = normalizeLogCatalog(requested);
            const definition = logCatalogDefinition(normalized);
            const catalog = {
                ...definition,
                revision: currentRevision + 1,
                definitionHash: catalogHash(definition),
                createdAt: current.createdAt ?? now,
                updatedAt: now,
            };
            await this._writeJsonFile(this.catalogPath, catalog);
            await this._unfileMissingFolders(catalog.folders);
            return catalog;
        });
        this._catalogWriteChain = operation;
        return operation;
    }

    async deleteLogs(ids = []) {
        const results = [];
        for (const id of ids) {
            try {
                await this.deleteLog(id);
                results.push({ id, deleted: true });
            } catch (error) {
                results.push({ id, deleted: false, error: error.message });
            }
        }
        return { results };
    }

    async getIndex(idValue) {
        const id = safeSegment(idValue);
        if (this.indexCache.has(id)) return this.indexCache.get(id);
        const scanned = await this._scanFile(this._finalPath(id), { cacheId: id });
        const result = {
            metadata: scanned.header.metadata,
            durationUs: scanned.chunks.at(-1)?.endUs || 0,
            chunks: scanned.chunks.map(({ startUs, endUs, offset, compressedLength, uncompressedLength, crc, hasCheckpoint, schemaIds }, index) => ({
                index,
                startUs,
                endUs,
                offset,
                compressedLength,
                uncompressedLength,
                crc,
                hasCheckpoint,
                schemaIds: schemaIds || [],
            })),
            checkpoints: scanned.checkpoints,
            schemas: [...scanned.schemas.values()],
        };
        this.indexCache.set(id, result);
        return result;
    }

    async readChunks(idValue, { fromUs = 0, toUs = Number.POSITIVE_INFINITY } = {}) {
        const chunks = [];
        for await (const chunk of this.iterateChunks(idValue, { fromUs, toUs })) chunks.push(chunk.raw);
        return Buffer.concat(chunks);
    }

    async readChunk(idValue, chunkIndex) {
        const id = safeSegment(idValue);
        const index = await this.getIndex(id);
        const chunk = index.chunks[Number(chunkIndex)];
        if (!chunk || !Number.isInteger(Number(chunkIndex))) throw new Error(`Log chunk ${chunkIndex} does not exist.`);
        return this._readIndexedChunk(this._finalPath(id), chunk);
    }

    async *iterateChunks(idValue, { fromUs = 0, toUs = Number.POSITIVE_INFINITY, verifyCrc = true } = {}) {
        const id = safeSegment(idValue);
        const index = await this.getIndex(id);
        let startIndex = 0;
        for (const checkpoint of index.checkpoints || []) {
            if (checkpoint.timeUs > fromUs) break;
            startIndex = checkpoint.chunkIndex;
        }
        const needed = index.chunks.slice(startIndex).filter((chunk) => chunk.startUs <= toUs);
        const missing = needed.filter((chunk) => !this._cachedInflatedChunk(id, chunk.index));
        let handle = null;
        try {
            if (missing.length) handle = await fs.open(this._finalPath(id), "r");
            for (const chunk of needed) {
                let raw = this._cachedInflatedChunk(id, chunk.index);
                if (!raw) {
                    raw = await this._readChunkFromHandle(handle, chunk, { verifyCrc });
                    this._rememberInflatedChunk(id, chunk.index, raw);
                }
                yield { ...chunk, raw };
            }
        } finally {
            await handle?.close();
        }
    }

    async readSeries(idValue, { path: signalPath, field = "", fromUs = 0, toUs = Number.POSITIVE_INFINITY, maxPoints = 2000 } = {}) {
        if (!signalPath) throw new Error("A signal path is required.");
        const id = safeSegment(idValue);
        return this._queueLogOp(id, () => this._readSeries(id, { path: signalPath, field, fromUs, toUs, maxPoints }));
    }

    async _readSeries(idValue, { path: signalPath, field = "", fromUs = 0, toUs = Number.POSITIVE_INFINITY, maxPoints = 2000 } = {}) {
        const index = await this.getIndex(idValue);
        const descriptor = index.schemas.find((schema) => schema.path === signalPath);
        const boundedToUs = Number.isFinite(toUs) ? toUs : index.durationUs;
        if (!descriptor) {
            return {
                path: signalPath,
                field: field || "",
                fromUs,
                toUs: boundedToUs,
                totalSamples: 0,
                samples: [],
                downsampled: false,
            };
        }
        const rawSamples = await this._loadPathSamples(idValue, descriptor, { fromUs, toUs: boundedToUs });
        const samples = [];
        for (const sample of rawSamples) {
            const value = getNested(sample.value, field);
            if (typeof value === "number" && Number.isFinite(value)) {
                samples.push({ timeUs: sample.timeUs, cycle: sample.cycle, value });
            }
        }
        const limit = Math.min(2000, Math.max(2, Math.floor(Number(maxPoints) || 2000)));
        const downsampled = downsampleMinMax(samples, limit);
        return {
            path: signalPath,
            field: field || "",
            fromUs,
            toUs: boundedToUs,
            totalSamples: samples.length,
            samples: downsampled,
            downsampled: downsampled.length < samples.length,
        };
    }

    async _loadPathSamples(idValue, descriptor, { fromUs = 0, toUs = Number.POSITIVE_INFINITY } = {}) {
        const cacheKey = `${idValue}\0${descriptor.path}\0${fromUs}\0${toUs}`;
        if (this._pathSampleCache.has(cacheKey)) return this._pathSampleCache.get(cacheKey);
        const schemas = new Map((await this.getIndex(idValue)).schemas.map((schema) => [schema.id, schema]));
        const decodeOptions = pathDecodeOptions(descriptor.path);
        const samples = [];
        for await (const chunk of this.iterateChunks(idValue, { fromUs, toUs, verifyCrc: false })) {
            if (Array.isArray(chunk.schemaIds) && chunk.schemaIds.length && !chunk.schemaIds.includes(descriptor.id)) continue;
            const decoded = decodeRecordStream(chunk.raw, schemas, decodeOptions);
            for (const update of decoded.updates) {
                if (update.path !== descriptor.path || update.timeUs < fromUs || update.timeUs > toUs) continue;
                samples.push({ timeUs: update.timeUs, cycle: update.cycle, value: update.value });
            }
        }
        if (this._pathSampleCache.size >= 24) {
            const oldest = this._pathSampleCache.keys().next().value;
            this._pathSampleCache.delete(oldest);
        }
        this._pathSampleCache.set(cacheKey, samples);
        return samples;
    }

    async readSnapshot(idValue, timeUs = 0, { includeHeavy = true } = {}) {
        const index = await this.getIndex(idValue);
        const cursorUs = Math.min(index.durationUs, Math.max(0, Number(timeUs) || 0));
        const schemas = new Map(index.schemas.map((schema) => [schema.id, schema]));
        const heavyPaths = includeHeavy
            ? new Set()
            : new Set(index.schemas
                .filter((schema) => schema.type === "bytes" || schema.logClass === "heavy")
                .map((schema) => schema.path));
        const shouldInclude = (signalPath) => includeHeavy || !heavyPaths.has(signalPath);
        const updates = [];
        let checkpoint = null;
        for await (const chunk of this.iterateChunks(idValue, { fromUs: cursorUs, toUs: cursorUs })) {
            const decoded = decodeRecordStream(chunk.raw, schemas);
            updates.push(...decoded.updates.filter((update) => update.timeUs <= cursorUs));
            for (const candidate of decoded.checkpoints) {
                if (candidate.timeUs <= cursorUs && (!checkpoint || candidate.timeUs >= checkpoint.timeUs)) checkpoint = candidate;
            }
        }
        const snapshot = {};
        for (const [signalPath, value] of Object.entries(checkpoint?.values ?? {})) {
            if (shouldInclude(signalPath)) snapshot[signalPath] = structuredClone(value);
        }
        const checkpointUs = checkpoint?.timeUs || 0;
        for (const update of updates.sort((a, b) => a.timeUs - b.timeUs)) {
            if (update.timeUs >= checkpointUs && shouldInclude(update.path)) {
                snapshot[update.path] = structuredClone(update.value);
            }
        }
        return { timeUs: cursorUs, snapshot };
    }

    async readEvents(idValue, { fromUs = 0, toUs = Number.POSITIVE_INFINITY, limit = 5000 } = {}) {
        const id = safeSegment(idValue);
        return this._queueLogOp(id, async () => {
            const index = await this.getIndex(id);
            const schemas = new Map(index.schemas.map((schema) => [schema.id, schema]));
            const events = [];
            for await (const chunk of this.iterateChunks(id, { fromUs, toUs, verifyCrc: false })) {
                const decoded = decodeRecordStream(chunk.raw, schemas, {
                    includeUpdates: false,
                    includeCheckpointValues: false,
                    includeAttachments: false,
                });
                events.push(...decoded.events.filter((event) => event.timeUs >= fromUs && event.timeUs <= toUs));
            }
            const boundedLimit = Math.min(10000, Math.max(1, Math.floor(Number(limit) || 5000)));
            return { events: events.sort((a, b) => a.timeUs - b.timeUs).slice(-boundedLimit), truncated: events.length > boundedLimit };
        });
    }

    async readAttachments(idValue, { names = null } = {}) {
        const attachments = await collectAttachments(this, idValue, { names });
        return {
            attachments: attachments.map((attachment) => ({
                name: attachment.name,
                mime: attachment.mime,
                bytes: Buffer.from(attachment.bytes).toString("base64"),
            })),
        };
    }

    async readPoseSeries(idValue, options = {}) {
        const id = safeSegment(idValue);
        return this._queueLogOp(id, () => readPoseSeries(this, id, options));
    }

    async readAutonomySnapshot(idValue, timeUs = 0, options = {}) {
        return readAutonomySnapshot(this, idValue, timeUs, options);
    }

    async _readChunkFromHandle(handle, chunk, { verifyCrc = true } = {}) {
        const compressed = await readAt(handle, chunk.compressedLength, chunk.offset + CHUNK_HEADER_BYTES);
        const raw = gunzipSync(compressed);
        if (raw.length !== chunk.uncompressedLength) throw new Error("SFLog chunk length does not match its header.");
        if (verifyCrc && crc32(raw) !== chunk.crc) throw new Error("SFLog chunk failed CRC validation.");
        return raw;
    }

    async _readIndexedChunk(filePath, chunk, options = {}) {
        const handle = await fs.open(filePath, "r");
        try {
            return await this._readChunkFromHandle(handle, chunk, options);
        } finally {
            await handle.close();
        }
    }

    async importLog(bytes, { name } = {}) {
        await fs.mkdir(this.logsDir, { recursive: true });
        const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        if (payload.byteLength > MAX_IMPORT_BYTES) throw new Error("Imported log exceeds the 2 GiB limit.");
        const tempPath = path.join(this.logsDir, `.import-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
        await fs.writeFile(tempPath, payload);
        return this._catalogImportedFile(tempPath, payload.byteLength, name);
    }

    async importStream(readable, { name } = {}) {
        await fs.mkdir(this.logsDir, { recursive: true });
        const tempPath = path.join(this.logsDir, `.import-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
        const handle = await fs.open(tempPath, "wx");
        let size = 0;
        try {
            for await (const chunk of readable) {
                size += chunk.byteLength;
                if (size > MAX_IMPORT_BYTES) throw new Error("Imported log exceeds the 2 GiB limit.");
                await handle.write(chunk);
            }
        } catch (error) {
            await handle.close();
            await fs.rm(tempPath, { force: true });
            throw error;
        }
        await handle.close();
        return this._catalogImportedFile(tempPath, size, name);
    }

    async _catalogImportedFile(tempPath, size, name) {
        try {
            const scanned = await this._scanFile(tempPath);
            const id = safeSegment(createId());
            await fs.rename(tempPath, this._finalPath(id));
            const metadata = {
                ...scanned.header.metadata,
                id,
                name: String(name || scanned.header.metadata.name || "Imported Log"),
                importedAt: new Date().toISOString(),
                status: "complete",
                durationUs: scanned.chunks.at(-1)?.endUs || 0,
                bytes: size,
            };
            await this._writeSidecar(id, metadata);
            return metadata;
        } catch (error) {
            await fs.rm(tempPath, { force: true });
            throw error;
        }
    }

    async deleteLog(idValue) {
        const id = safeSegment(idValue);
        if (this.active.has(id)) throw new Error("Stop the active recording before deleting it.");
        await Promise.all([
            fs.rm(this._finalPath(id), { force: true }),
            fs.rm(this._partialPath(id), { force: true }),
            fs.rm(this._sidecarPath(id), { force: true }),
        ]);
        this.indexCache.delete(id);
        this._forgetInflatedLog(id);
        for (const key of [...this._pathSampleCache.keys()]) {
            if (key.startsWith(`${id}\0`)) this._pathSampleCache.delete(key);
        }
        return true;
    }

    async recoverPartialLogs() {
        await fs.mkdir(this.logsDir, { recursive: true });
        const entries = await fs.readdir(this.logsDir);
        for (const name of entries.filter((entry) => entry.endsWith(".partial"))) {
            const id = name.slice(0, -".partial".length);
            if (this.active.has(id)) continue;
            const partialPath = this._partialPath(id);
            try {
                const scanned = await this._scanFile(partialPath, { allowPartial: true });
                await fs.truncate(partialPath, scanned.validEnd);
                const indexOffset = scanned.validEnd;
                const footer = buildIndexFooter(scanned.chunks);
                const locator = new ByteWriter(12);
                locator.uint64(indexOffset);
                locator.bytes(END_MAGIC);
                await fs.appendFile(partialPath, Buffer.concat([Buffer.from(footer), Buffer.from(locator.finish())]));
                await fs.rename(partialPath, this._finalPath(id));
                const previous = await readSidecar(this._sidecarPath(id));
                await this._writeSidecar(id, {
                    ...scanned.header.metadata,
                    ...previous,
                    id,
                    status: "incomplete",
                    incomplete: true,
                    recoveredAt: new Date().toISOString(),
                    durationUs: scanned.chunks.at(-1)?.endUs || 0,
                    bytes: scanned.validEnd + footer.length + 12,
                });
            } catch (error) {
                const previous = await readSidecar(this._sidecarPath(id));
                if (previous) await this._writeSidecar(id, { ...previous, status: "corrupt", incomplete: true, recoveryError: error.message });
            }
        }
    }

    async _scanFile(filePath, { allowPartial = false, cacheId = null } = {}) {
        const handle = await fs.open(filePath, "r");
        try {
            const stat = await handle.stat();
            if (stat.size < 12) throw new Error("The file is too short to be a valid SFLog.");
            const prefix = await readAt(handle, 12, 0);
            const metadataLength = prefix.readUInt32LE(8);
            if (metadataLength > 16 * 1024 * 1024) throw new Error("SFLog metadata is too large.");
            const headerBytes = await readAt(handle, 12 + metadataLength, 0);
            const header = parseFileHeader(headerBytes);
            const chunks = [];
            let schemas = new Map();
            const checkpoints = [];
            let offset = header.headerLength;
            let indexOffset = null;

            if (!allowPartial) {
                const locatorBytes = await readAt(handle, 12, stat.size - 12);
                if (locatorBytes.subarray(8).toString("utf8") !== "SEND") throw new Error("SFLog is missing its footer locator.");
                indexOffset = Number(new DataView(locatorBytes.buffer, locatorBytes.byteOffset, 8).getBigUint64(0, true));
                if (!Number.isSafeInteger(indexOffset) || indexOffset < offset || indexOffset > stat.size - 12) throw new Error("SFLog footer points outside the index boundary.");
            }

            const dataLimit = indexOffset ?? stat.size;
            while (offset + 4 <= dataLimit) {
                const magicBytes = await readAt(handle, 4, offset);
                const magic = magicBytes.toString("utf8");
                if (magic === "INDX") break;
                if (magic !== "CHNK") {
                    if (allowPartial) break;
                    throw new Error(`Invalid SFLog chunk magic at byte ${offset}.`);
                }
                if (offset + CHUNK_HEADER_BYTES > dataLimit) {
                    if (allowPartial) break;
                    throw new Error("Truncated SFLog chunk header.");
                }
                const chunkHeader = await readAt(handle, CHUNK_HEADER_BYTES, offset);
                const view = new DataView(chunkHeader.buffer, chunkHeader.byteOffset, CHUNK_HEADER_BYTES);
                const startUs = Number(view.getBigUint64(4, true));
                const endUs = Number(view.getBigUint64(12, true));
                const uncompressedLength = view.getUint32(20, true);
                const compressedLength = view.getUint32(24, true);
                const expectedCrc = view.getUint32(28, true);
                if (uncompressedLength > MAX_CHUNK_BYTES || compressedLength > MAX_CHUNK_BYTES) {
                    if (allowPartial) break;
                    throw new Error("SFLog chunk exceeds the 64 MiB safety limit.");
                }
                const dataEnd = offset + CHUNK_HEADER_BYTES + compressedLength;
                if (dataEnd > dataLimit) {
                    if (allowPartial) break;
                    throw new Error("Truncated SFLog chunk payload.");
                }
                let decoded;
                try {
                    const compressed = await readAt(handle, compressedLength, offset + CHUNK_HEADER_BYTES);
                    const raw = gunzipSync(compressed);
                    if (raw.length !== uncompressedLength) throw new Error("SFLog chunk length does not match its header.");
                    if (crc32(raw) !== expectedCrc) throw new Error("SFLog chunk failed CRC validation.");
                    decoded = decodeRecordStream(raw, schemas, INDEX_DECODE_OPTIONS);
                    if (cacheId) this._rememberInflatedChunk(cacheId, chunks.length, raw);
                } catch (error) {
                    if (allowPartial) break;
                    throw error;
                }
                schemas = decoded.schemas;
                const hasCheckpoint = decoded.checkpoints.length > 0;
                const chunkIndex = chunks.length;
                checkpoints.push(...decoded.checkpoints.map((checkpoint) => ({ timeUs: checkpoint.timeUs, chunkOffset: offset, chunkIndex })));
                chunks.push({
                    startUs,
                    endUs,
                    offset,
                    uncompressedLength,
                    compressedLength,
                    crc: expectedCrc,
                    hasCheckpoint,
                    schemaIds: [...(decoded.observedSchemaIds || [])],
                });
                offset = dataEnd;
            }

            const validEnd = offset;
            if (allowPartial) return { header, chunks, schemas, checkpoints, validEnd };
            if (offset !== indexOffset) throw new Error("SFLog is incomplete or missing its index.");
            const indexLength = stat.size - 12 - indexOffset;
            const indexBytes = await readAt(handle, indexLength, indexOffset);
            if (indexBytes.subarray(0, 4).toString("utf8") !== "INDX") throw new Error("SFLog is incomplete or missing its index.");
            const indexView = new DataView(indexBytes.buffer, indexBytes.byteOffset, indexBytes.byteLength);
            const entryCount = indexView.getUint32(4, true);
            if (8 + entryCount * 25 !== indexBytes.length) throw new Error("SFLog index length is invalid.");
            if (entryCount !== chunks.length) throw new Error("SFLog index does not match its chunk count.");
            for (let index = 0; index < entryCount; index += 1) {
                const entryOffset = 8 + index * 25;
                const chunk = chunks[index];
                const matches = Number(indexView.getBigUint64(entryOffset, true)) === chunk.startUs
                    && Number(indexView.getBigUint64(entryOffset + 8, true)) === chunk.endUs
                    && Number(indexView.getBigUint64(entryOffset + 16, true)) === chunk.offset
                    && (indexView.getUint8(entryOffset + 24) !== 0) === chunk.hasCheckpoint;
                if (!matches) throw new Error(`SFLog index entry ${index} does not match its chunk.`);
            }
            return { header, chunks, schemas, checkpoints, validEnd };
        } finally {
            await handle.close();
        }
    }

    getFilePath(idValue) {
        return this._finalPath(safeSegment(idValue));
    }

    _finalPath(id) { return path.join(this.logsDir, `${id}.sflog`); }
    _partialPath(id) { return path.join(this.logsDir, `${id}.partial`); }
    _sidecarPath(id) { return path.join(this.logsDir, `${id}.json`); }

    async _writeSidecar(id, value) {
        await this._writeJsonFile(this._sidecarPath(id), value);
    }

    async _writeJsonFile(filePath, value) {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(value, null, 2));
        await fs.rename(tempPath, filePath);
    }

    async _unfileMissingFolders(folders) {
        const folderIds = new Set((folders || []).map((folder) => folder.id));
        const logs = await this.listLogs();
        await Promise.all(logs
            .filter((log) => log.folderId && !folderIds.has(log.folderId))
            .map((log) => this.updateMetadata(log.id, { folderId: null })));
    }
}
