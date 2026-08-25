export const SFLOG_VERSION = 1;

export const RECORD_TAGS = Object.freeze({
    SCHEMA: 0x01,
    CYCLE: 0x02,
    EVENT: 0x03,
    CHECKPOINT: 0x04,
    ATTACHMENT: 0x05,
});

const TYPE_CODES = Object.freeze({
    json: 0x00,
    boolean: 0x01,
    int32: 0x02,
    uint32: 0x03,
    int64: 0x04,
    uint64: 0x05,
    float32: 0x06,
    float64: 0x07,
    string: 0x08,
    bytes: 0x09,
    vec3: 0x0a,
    pose3: 0x0b,
    "float64[]": 0x0c,
    "int32[]": 0x0d,
    "boolean[]": 0x0e,
});

const CODE_TYPES = Object.fromEntries(Object.entries(TYPE_CODES).map(([type, code]) => [code, type]));
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function normalizeType(type) {
    if (TYPE_CODES[type] !== undefined) return type;
    if (type === "bool") return "boolean";
    if (type === "array[json]") return "json";
    if (type === "message") return "json";
    return "json";
}

function jsonStringify(value) {
    return JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return { __sflogBigInt: item.toString() };
        if (ArrayBuffer.isView(item)) {
            return { __sflogTypedArray: item.constructor.name, values: Array.from(item) };
        }
        return item;
    });
}

function jsonParse(value) {
    return JSON.parse(value, (_key, item) => {
        if (item?.__sflogBigInt) return BigInt(item.__sflogBigInt);
        if (item?.__sflogTypedArray && Array.isArray(item.values)) {
            const ctor = globalThis[item.__sflogTypedArray];
            return typeof ctor === "function" ? new ctor(item.values) : item.values;
        }
        return item;
    });
}

export class ByteWriter {
    constructor(initialSize = 1024) {
        this.buffer = new Uint8Array(initialSize);
        this.length = 0;
    }

    _grow(additional) {
        const required = this.length + additional;
        if (required <= this.buffer.length) return;
        let size = this.buffer.length;
        while (size < required) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buffer);
        this.buffer = next;
    }

    uint8(value) {
        this._grow(1);
        this.buffer[this.length++] = Number(value) & 0xff;
    }

    uint16(value) {
        this._grow(2);
        new DataView(this.buffer.buffer).setUint16(this.length, Number(value), true);
        this.length += 2;
    }

    uint32(value) {
        this._grow(4);
        new DataView(this.buffer.buffer).setUint32(this.length, Number(value), true);
        this.length += 4;
    }

    uint64(value) {
        this._grow(8);
        new DataView(this.buffer.buffer).setBigUint64(this.length, BigInt(value), true);
        this.length += 8;
    }

    float32(value) {
        this._grow(4);
        new DataView(this.buffer.buffer).setFloat32(this.length, Number(value) || 0, true);
        this.length += 4;
    }

    float64(value) {
        this._grow(8);
        new DataView(this.buffer.buffer).setFloat64(this.length, Number(value) || 0, true);
        this.length += 8;
    }

    varuint(value) {
        let remaining = BigInt(Math.max(0, Number(value) || 0));
        while (remaining >= 0x80n) {
            this.uint8(Number((remaining & 0x7fn) | 0x80n));
            remaining >>= 7n;
        }
        this.uint8(Number(remaining));
    }

    zigzag(value) {
        const integer = BigInt(Math.trunc(Number(value) || 0));
        const encoded = integer >= 0n ? integer << 1n : ((-integer) << 1n) - 1n;
        this.varuint(encoded);
    }

    bytes(bytes) {
        const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        this._grow(value.byteLength);
        this.buffer.set(value, this.length);
        this.length += value.byteLength;
    }

    sizedBytes(bytes) {
        this.varuint(bytes?.byteLength || 0);
        this.bytes(bytes);
    }

    string(value) {
        this.sizedBytes(textEncoder.encode(String(value ?? "")));
    }

    finish() {
        return this.buffer.slice(0, this.length);
    }
}

export class ByteReader {
    constructor(bytes) {
        this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
        this.offset = 0;
    }

    get remaining() {
        return this.bytes.length - this.offset;
    }

    _require(length) {
        if (this.remaining < length) throw new Error("Unexpected end of SFLog data.");
    }

    uint8() {
        this._require(1);
        return this.bytes[this.offset++];
    }

    uint16() {
        this._require(2);
        const value = new DataView(this.bytes.buffer, this.bytes.byteOffset).getUint16(this.offset, true);
        this.offset += 2;
        return value;
    }

    uint32() {
        this._require(4);
        const value = new DataView(this.bytes.buffer, this.bytes.byteOffset).getUint32(this.offset, true);
        this.offset += 4;
        return value;
    }

    uint64() {
        this._require(8);
        const value = new DataView(this.bytes.buffer, this.bytes.byteOffset).getBigUint64(this.offset, true);
        this.offset += 8;
        return value;
    }

    float32() {
        this._require(4);
        const value = new DataView(this.bytes.buffer, this.bytes.byteOffset).getFloat32(this.offset, true);
        this.offset += 4;
        return value;
    }

    float64() {
        this._require(8);
        const value = new DataView(this.bytes.buffer, this.bytes.byteOffset).getFloat64(this.offset, true);
        this.offset += 8;
        return value;
    }

    varuint() {
        let result = 0n;
        let shift = 0n;
        for (let index = 0; index < 10; index += 1) {
            const byte = this.uint8();
            result |= BigInt(byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) {
                const number = Number(result);
                if (!Number.isSafeInteger(number)) throw new Error("SFLog varint exceeds the JavaScript safe integer range.");
                return number;
            }
            shift += 7n;
        }
        throw new Error("Invalid SFLog varint.");
    }

    zigzag() {
        const encoded = BigInt(this.varuint());
        return Number((encoded & 1n) === 0n ? encoded >> 1n : -((encoded + 1n) >> 1n));
    }

    readBytes(length) {
        this._require(length);
        const result = this.bytes.subarray(this.offset, this.offset + length);
        this.offset += length;
        return result;
    }

    sizedBytes() {
        return this.readBytes(this.varuint());
    }

    string() {
        return textDecoder.decode(this.sizedBytes());
    }
}

export function encodeSignalValue(typeName, value) {
    const type = normalizeType(typeName);
    const writer = new ByteWriter(64);
    switch (type) {
        case "boolean":
            writer.uint8(value ? 1 : 0);
            break;
        case "int32":
        case "int64":
            writer.zigzag(value);
            break;
        case "uint32":
        case "uint64":
            writer.varuint(value);
            break;
        case "float32":
            writer.float32(value);
            break;
        case "float64":
            writer.float64(value);
            break;
        case "string":
            writer.string(value);
            break;
        case "bytes":
            writer.bytes(value instanceof Uint8Array ? value : new Uint8Array(value || []));
            break;
        case "vec3":
            writer.float64(value?.x);
            writer.float64(value?.y);
            writer.float64(value?.z);
            break;
        case "pose3":
            writer.float64(value?.position?.x);
            writer.float64(value?.position?.y);
            writer.float64(value?.position?.z);
            writer.float64(value?.rotation?.x);
            writer.float64(value?.rotation?.y);
            writer.float64(value?.rotation?.z);
            break;
        case "float64[]":
            writer.varuint(value?.length || 0);
            for (const item of value || []) writer.float64(item);
            break;
        case "int32[]":
            writer.varuint(value?.length || 0);
            for (const item of value || []) writer.zigzag(item);
            break;
        case "boolean[]":
            writer.varuint(value?.length || 0);
            for (const item of value || []) writer.uint8(item ? 1 : 0);
            break;
        default:
            writer.bytes(textEncoder.encode(jsonStringify(value ?? null)));
    }
    return writer.finish();
}

export function decodeSignalValue(typeName, bytes) {
    const type = normalizeType(typeName);
    const reader = new ByteReader(bytes);
    switch (type) {
        case "boolean": return reader.uint8() !== 0;
        case "int32":
        case "int64": return reader.zigzag();
        case "uint32":
        case "uint64": return reader.varuint();
        case "float32": return reader.float32();
        case "float64": return reader.float64();
        case "string": return reader.string();
        case "bytes": return new Uint8Array(bytes);
        case "vec3": return { x: reader.float64(), y: reader.float64(), z: reader.float64() };
        case "pose3": return {
            position: { x: reader.float64(), y: reader.float64(), z: reader.float64() },
            rotation: { x: reader.float64(), y: reader.float64(), z: reader.float64(), order: "XYZ" },
        };
        case "float64[]": return Array.from({ length: reader.varuint() }, () => reader.float64());
        case "int32[]": return Array.from({ length: reader.varuint() }, () => reader.zigzag());
        case "boolean[]": return Array.from({ length: reader.varuint() }, () => reader.uint8() !== 0);
        default: return jsonParse(textDecoder.decode(bytes));
    }
}

function encodeSchemaRecord(writer, id, descriptor) {
    writer.uint8(RECORD_TAGS.SCHEMA);
    writer.varuint(id);
    writer.uint8(TYPE_CODES[normalizeType(descriptor.type)]);
    writer.string(descriptor.path);
    writer.string(descriptor.unit || "");
    writer.string(jsonStringify({
        source: descriptor.source || null,
        category: descriptor.category || null,
        replayRole: descriptor.replayRole || "derived",
        logClass: descriptor.logClass || "standard",
        description: descriptor.description || null,
        metadata: descriptor.metadata || {},
    }));
}

function estimateVaruintBytes(value) {
    let remaining = Math.max(0, Math.floor(Number(value) || 0));
    let size = 1;
    while (remaining >= 0x80) {
        remaining = Math.floor(remaining / 0x80);
        size += 1;
    }
    return size;
}

function estimateSizedBytes(byteLength) {
    return estimateVaruintBytes(byteLength) + byteLength;
}

function estimateStringBytes(value) {
    return estimateSizedBytes(textEncoder.encode(String(value ?? "")).byteLength);
}

function estimateRecordBytes(record, schemas) {
    if (record.kind === "schema") {
        const descriptor = record.descriptor || {};
        return 2
            + estimateVaruintBytes(record.id)
            + estimateStringBytes(descriptor.path)
            + estimateStringBytes(descriptor.unit || "")
            + estimateStringBytes(jsonStringify({
                source: descriptor.source || null,
                category: descriptor.category || null,
                replayRole: descriptor.replayRole || "derived",
                logClass: descriptor.logClass || "standard",
                description: descriptor.description || null,
                metadata: descriptor.metadata || {},
            }));
    }
    if (record.kind === "update") {
        const schema = schemas.get(record.id);
        const encoded = encodeSignalValue(schema?.type || "json", record.value);
        // CYCLE framing amortized: tag + timestamp + cycle + count + id + sized payload
        return 1 + 10 + estimateVaruintBytes(record.cycle || 0) + 1
            + estimateVaruintBytes(record.id)
            + estimateSizedBytes(encoded.byteLength);
    }
    if (record.kind === "event") {
        return 1
            + estimateVaruintBytes(record.event.timeUs)
            + estimateStringBytes(record.event.category)
            + estimateStringBytes(record.event.name)
            + estimateStringBytes(record.event.severity)
            + estimateStringBytes(jsonStringify(record.event.payload ?? null));
    }
    if (record.kind === "checkpoint") {
        let size = 1 + estimateVaruintBytes(record.timeUs) + estimateVaruintBytes(record.values.length);
        for (const value of record.values) {
            const schema = schemas.get(value.id);
            const encoded = encodeSignalValue(schema?.type || "json", value.value);
            size += estimateVaruintBytes(value.id) + estimateSizedBytes(encoded.byteLength);
        }
        return size;
    }
    if (record.kind === "attachment") {
        return 1
            + estimateVaruintBytes(record.timeUs)
            + estimateStringBytes(record.name)
            + estimateStringBytes(record.mime)
            + estimateSizedBytes(record.bytes?.byteLength || 0);
    }
    return 48;
}

export class SFLogBatchEncoder {
    constructor() {
        this.schemaIds = new Map();
        this.schemas = new Map();
        this.nextSchemaId = 1;
        this.records = [];
        this.startUs = null;
        this.endUs = null;
        this._byteEstimate = 0;
    }

    _schema(descriptor) {
        const key = `${descriptor.path}\u0000${normalizeType(descriptor.type)}`;
        let id = this.schemaIds.get(key);
        if (id) return id;
        id = this.nextSchemaId++;
        this.schemaIds.set(key, id);
        this.schemas.set(id, { ...descriptor, type: normalizeType(descriptor.type) });
        this._pushRecord({ kind: "schema", id, descriptor: this.schemas.get(id) });
        return id;
    }

    _pushRecord(record) {
        const estimatedBytes = estimateRecordBytes(record, this.schemas);
        record.estimatedBytes = estimatedBytes;
        this.records.push(record);
        this._byteEstimate += estimatedBytes;
    }

    addUpdate(message) {
        if (!message?.path || !message?.entry) return;
        const descriptor = message.descriptor || { path: message.path, type: message.entry.type || "json" };
        const id = this._schema(descriptor);
        const timeUs = Math.max(0, Math.round(message.timeUs ?? message.entry.timeUs ?? 0));
        this._range(timeUs);
        this._pushRecord({
            kind: "update",
            id,
            timeUs,
            cycle: message.cycle ?? message.entry.cycle ?? 0,
            value: message.entry.value,
        });
    }

    addEvent(event) {
        if (!event) return;
        const timeUs = Math.max(0, Math.round(event.timeUs || 0));
        this._range(timeUs);
        this._pushRecord({ kind: "event", event: { ...event, timeUs } });
    }

    addCheckpoint(snapshot, descriptors, timeUs) {
        const values = [];
        for (const [path, entry] of Object.entries(snapshot || {})) {
            const descriptor = descriptors.find((item) => item.path === path) || { path, type: entry.type || "json" };
            if (!['input', 'state'].includes(descriptor.replayRole)) continue;
            values.push({ id: this._schema(descriptor), value: entry.value });
        }
        const normalizedTime = Math.max(0, Math.round(timeUs || 0));
        this._range(normalizedTime);
        this._pushRecord({ kind: "checkpoint", timeUs: normalizedTime, values });
    }

    addAttachment({ name, mime = "application/octet-stream", bytes, timeUs = 0 }) {
        this._range(timeUs);
        this._pushRecord({
            kind: "attachment",
            name,
            mime,
            bytes: bytes instanceof Uint8Array ? bytes : textEncoder.encode(String(bytes || "")),
            timeUs,
        });
    }

    _range(timeUs) {
        this.startUs = this.startUs === null ? timeUs : Math.min(this.startUs, timeUs);
        this.endUs = this.endUs === null ? timeUs : Math.max(this.endUs, timeUs);
    }

    get byteEstimate() {
        return this._byteEstimate;
    }

    get pendingRecordCount() {
        return this.records.length;
    }

    /**
     * Re-emit every known schema before pending records. Call this after an
     * encoded batch is intentionally dropped so future updates remain decodable.
     */
    repeatSchemas() {
        const records = [...this.schemas.entries()].map(([id, descriptor]) => ({
            kind: "schema",
            id,
            descriptor,
        }));
        for (const record of records) record.estimatedBytes = estimateRecordBytes(record, this.schemas);
        this.records.unshift(...records);
        this._byteEstimate += records.reduce((total, record) => total + record.estimatedBytes, 0);
    }

    /**
     * Encode and remove records until adding the next group would exceed maxBytes.
     * Returns null when empty. Throws when a single unsplittable record exceeds maxBytes.
     */
    flushUpTo(maxBytes = Number.POSITIVE_INFINITY) {
        if (this.records.length === 0) return null;
        const limit = Math.max(1, Math.floor(Number(maxBytes) || 0));
        let takeCount = 0;
        let estimated = 0;
        while (takeCount < this.records.length) {
            const record = this.records[takeCount];
            const nextCost = Number(record.estimatedBytes || estimateRecordBytes(record, this.schemas));
            if (takeCount > 0 && estimated + nextCost > limit) break;
            if (takeCount === 0 && nextCost > limit) {
                throw new Error(`Log record exceeds the ${limit} byte batch limit and cannot be split.`);
            }
            estimated += nextCost;
            takeCount += 1;
        }
        const batchRecords = this.records.splice(0, takeCount);
        this._byteEstimate = Math.max(0, this._byteEstimate - estimated);
        const startUs = batchRecords.reduce((min, record) => {
            const timeUs = record.timeUs ?? record.event?.timeUs ?? 0;
            return Math.min(min, timeUs);
        }, Number.POSITIVE_INFINITY);
        const endUs = batchRecords.reduce((max, record) => {
            const timeUs = record.timeUs ?? record.event?.timeUs ?? 0;
            return Math.max(max, timeUs);
        }, 0);
        if (this.records.length === 0) {
            this.startUs = null;
            this.endUs = null;
        } else {
            this.startUs = this.records.reduce((min, record) => {
                const timeUs = record.timeUs ?? record.event?.timeUs ?? 0;
                return Math.min(min, timeUs);
            }, Number.POSITIVE_INFINITY);
            this.endUs = this.records.reduce((max, record) => {
                const timeUs = record.timeUs ?? record.event?.timeUs ?? 0;
                return Math.max(max, timeUs);
            }, 0);
        }
        return {
            bytes: encodeRecords(batchRecords, this.schemas),
            startUs: Number.isFinite(startUs) ? startUs : 0,
            endUs,
        };
    }

    flush() {
        return this.flushUpTo(Number.POSITIVE_INFINITY);
    }
}

function encodeRecords(records, schemas) {
    const writer = new ByteWriter(Math.max(1024, records.length * 48));
    let index = 0;
    let lastCycleTimeUs = null;
    while (index < records.length) {
        const record = records[index];
        if (record.kind === "schema") {
            encodeSchemaRecord(writer, record.id, record.descriptor);
            index += 1;
            continue;
        }
        if (record.kind === "update") {
            const group = [record];
            index += 1;
            while (index < records.length) {
                const next = records[index];
                if (next.kind !== "update" || next.timeUs !== record.timeUs || next.cycle !== record.cycle) break;
                group.push(next);
                index += 1;
            }
            writer.uint8(RECORD_TAGS.CYCLE);
            const timestampCode = lastCycleTimeUs === null || record.timeUs < lastCycleTimeUs
                ? record.timeUs * 2 + 1
                : (record.timeUs - lastCycleTimeUs) * 2;
            writer.varuint(timestampCode);
            lastCycleTimeUs = record.timeUs;
            writer.varuint(record.cycle || 0);
            writer.varuint(group.length);
            for (const update of group) {
                const schema = schemas.get(update.id);
                const encoded = encodeSignalValue(schema.type, update.value);
                writer.varuint(update.id);
                writer.sizedBytes(encoded);
            }
            continue;
        }
        if (record.kind === "event") {
            writer.uint8(RECORD_TAGS.EVENT);
            writer.varuint(record.event.timeUs);
            writer.string(record.event.category);
            writer.string(record.event.name);
            writer.string(record.event.severity);
            writer.string(jsonStringify(record.event.payload ?? null));
        } else if (record.kind === "checkpoint") {
            writer.uint8(RECORD_TAGS.CHECKPOINT);
            writer.varuint(record.timeUs);
            writer.varuint(record.values.length);
            for (const value of record.values) {
                const schema = schemas.get(value.id);
                writer.varuint(value.id);
                writer.sizedBytes(encodeSignalValue(schema.type, value.value));
            }
        } else if (record.kind === "attachment") {
            writer.uint8(RECORD_TAGS.ATTACHMENT);
            writer.varuint(record.timeUs);
            writer.string(record.name);
            writer.string(record.mime);
            writer.sizedBytes(record.bytes);
        }
        index += 1;
    }
    return writer.finish();
}

export function decodeRecordStream(bytes, initialSchemas = new Map()) {
    const reader = new ByteReader(bytes);
    const schemas = new Map(initialSchemas);
    const updates = [];
    const events = [];
    const checkpoints = [];
    const attachments = [];
    let lastCycleTimeUs = 0;

    while (reader.remaining > 0) {
        const tag = reader.uint8();
        if (tag === RECORD_TAGS.SCHEMA) {
            const id = reader.varuint();
            const type = CODE_TYPES[reader.uint8()] || "json";
            const path = reader.string();
            const unit = reader.string() || null;
            const metadata = jsonParse(reader.string() || "{}");
            schemas.set(id, { id, path, type, unit, ...metadata });
            continue;
        }
        if (tag === RECORD_TAGS.CYCLE) {
            const timestampCode = reader.varuint();
            const timeUs = timestampCode % 2 === 1
                ? Math.floor(timestampCode / 2)
                : lastCycleTimeUs + timestampCode / 2;
            lastCycleTimeUs = timeUs;
            const cycle = reader.varuint();
            const count = reader.varuint();
            for (let item = 0; item < count; item += 1) {
                const id = reader.varuint();
                const schema = schemas.get(id);
                if (!schema) throw new Error(`SFLog update references unknown schema ${id}.`);
                updates.push({ id, path: schema.path, descriptor: schema, timeUs, cycle, value: decodeSignalValue(schema.type, reader.sizedBytes()) });
            }
            continue;
        }
        if (tag === RECORD_TAGS.EVENT) {
            events.push({
                timeUs: reader.varuint(),
                category: reader.string(),
                name: reader.string(),
                severity: reader.string(),
                payload: jsonParse(reader.string()),
            });
            continue;
        }
        if (tag === RECORD_TAGS.CHECKPOINT) {
            const timeUs = reader.varuint();
            const count = reader.varuint();
            const values = {};
            for (let item = 0; item < count; item += 1) {
                const id = reader.varuint();
                const schema = schemas.get(id);
                if (!schema) throw new Error(`SFLog checkpoint references unknown schema ${id}.`);
                values[schema.path] = decodeSignalValue(schema.type, reader.sizedBytes());
            }
            checkpoints.push({ timeUs, values });
            continue;
        }
        if (tag === RECORD_TAGS.ATTACHMENT) {
            attachments.push({ timeUs: reader.varuint(), name: reader.string(), mime: reader.string(), bytes: new Uint8Array(reader.sizedBytes()) });
            continue;
        }
        throw new Error(`Unknown SFLog record tag 0x${tag.toString(16)}.`);
    }
    return { schemas, updates, events, checkpoints, attachments };
}
