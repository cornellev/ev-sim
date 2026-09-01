import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

import { ByteReader, ByteWriter, SFLOG_VERSION, decodeRecordStream } from "../../app/logging/SFLogCodec.js";
import { downsampleMinMax } from "../../app/analysis/downsample.js";
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

export class LogService {
    constructor(logsDir = DEFAULT_LOGS_DIR) {
        this.logsDir = logsDir;
        this.active = new Map();
        this.indexCache = new Map();
    }

    async listLogs() {
        await fs.mkdir(this.logsDir, { recursive: true });
        await this.recoverPartialLogs();
        const entries = await fs.readdir(this.logsDir);
        const sidecars = entries.filter((name) => name.endsWith(".json"));
        const logs = await Promise.all(sidecars.map((name) => readSidecar(path.join(this.logsDir, name))));
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
            tags: Array.isArray(input.tags) ? input.tags : [],
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
        const metadata = {
            ...session.metadata,
            ...patch,
            status: patch.incomplete ? "incomplete" : "complete",
            incomplete: Boolean(patch.incomplete),
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
        return metadata;
    }

    async updateMetadata(idValue, patch = {}) {
        const metadata = await this.getMetadata(idValue);
        const updated = {
            ...metadata,
            name: patch.name === undefined ? metadata.name : String(patch.name).trim() || metadata.name,
            tags: patch.tags === undefined ? metadata.tags : (Array.isArray(patch.tags) ? patch.tags.map(String) : metadata.tags),
        };
        await this._writeSidecar(metadata.id, updated);
        return updated;
    }

    async getIndex(idValue) {
        const id = safeSegment(idValue);
        if (this.indexCache.has(id)) return this.indexCache.get(id);
        const scanned = await this._scanFile(this._finalPath(id));
        const result = {
            metadata: scanned.header.metadata,
            durationUs: scanned.chunks.at(-1)?.endUs || 0,
            chunks: scanned.chunks.map(({ startUs, endUs, offset, compressedLength, uncompressedLength, crc, hasCheckpoint }, index) => ({ index, startUs, endUs, offset, compressedLength, uncompressedLength, crc, hasCheckpoint })),
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

    async *iterateChunks(idValue, { fromUs = 0, toUs = Number.POSITIVE_INFINITY } = {}) {
        const id = safeSegment(idValue);
        const index = await this.getIndex(id);
        let startIndex = 0;
        for (const checkpoint of index.checkpoints || []) {
            if (checkpoint.timeUs > fromUs) break;
            startIndex = checkpoint.chunkIndex;
        }
        for (const chunk of index.chunks.slice(startIndex)) {
            if (chunk.startUs > toUs) break;
            yield { ...chunk, raw: await this._readIndexedChunk(this._finalPath(id), chunk) };
        }
    }

    async readSeries(idValue, { path: signalPath, field = "", fromUs = 0, toUs = Number.POSITIVE_INFINITY, maxPoints = 2000 } = {}) {
        if (!signalPath) throw new Error("A signal path is required.");
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
        const schemas = new Map(index.schemas.map((schema) => [schema.id, schema]));
        const samples = [];
        for await (const chunk of this.iterateChunks(idValue, { fromUs, toUs })) {
            const decoded = decodeRecordStream(chunk.raw, schemas);
            for (const update of decoded.updates) {
                if (update.path !== signalPath || update.timeUs < fromUs || update.timeUs > toUs) continue;
                const value = getNested(update.value, field);
                if (typeof value === "number" && Number.isFinite(value)) samples.push({ timeUs: update.timeUs, cycle: update.cycle, value });
            }
        }
        const limit = Math.min(2000, Math.max(2, Math.floor(Number(maxPoints) || 2000)));
        const downsampled = downsampleMinMax(samples, limit);
        return {
            path: signalPath,
            field: field || "",
            fromUs,
            toUs: Number.isFinite(toUs) ? toUs : index.durationUs,
            totalSamples: samples.length,
            samples: downsampled,
            downsampled: downsampled.length < samples.length,
        };
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
        const index = await this.getIndex(idValue);
        const schemas = new Map(index.schemas.map((schema) => [schema.id, schema]));
        const events = [];
        for await (const chunk of this.iterateChunks(idValue, { fromUs, toUs })) {
            const decoded = decodeRecordStream(chunk.raw, schemas);
            events.push(...decoded.events.filter((event) => event.timeUs >= fromUs && event.timeUs <= toUs));
        }
        const boundedLimit = Math.min(10000, Math.max(1, Math.floor(Number(limit) || 5000)));
        return { events: events.sort((a, b) => a.timeUs - b.timeUs).slice(-boundedLimit), truncated: events.length > boundedLimit };
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
        return readPoseSeries(this, idValue, options);
    }

    async readAutonomySnapshot(idValue, timeUs = 0, options = {}) {
        return readAutonomySnapshot(this, idValue, timeUs, options);
    }

    async _readIndexedChunk(filePath, chunk) {
        const handle = await fs.open(filePath, "r");
        try {
            const compressed = await readAt(handle, chunk.compressedLength, chunk.offset + CHUNK_HEADER_BYTES);
            const raw = gunzipSync(compressed);
            if (raw.length !== chunk.uncompressedLength) throw new Error("SFLog chunk length does not match its header.");
            if (crc32(raw) !== chunk.crc) throw new Error("SFLog chunk failed CRC validation.");
            return raw;
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

    async _scanFile(filePath, { allowPartial = false } = {}) {
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
                    decoded = decodeRecordStream(raw, schemas);
                } catch (error) {
                    if (allowPartial) break;
                    throw error;
                }
                schemas = decoded.schemas;
                const hasCheckpoint = decoded.checkpoints.length > 0;
                const chunkIndex = chunks.length;
                checkpoints.push(...decoded.checkpoints.map((checkpoint) => ({ timeUs: checkpoint.timeUs, chunkOffset: offset, chunkIndex })));
                chunks.push({ startUs, endUs, offset, uncompressedLength, compressedLength, crc: expectedCrc, hasCheckpoint });
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
        await fs.mkdir(this.logsDir, { recursive: true });
        const filePath = this._sidecarPath(id);
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(tempPath, JSON.stringify(value, null, 2));
        await fs.rename(tempPath, filePath);
    }
}
