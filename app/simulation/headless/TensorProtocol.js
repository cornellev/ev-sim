import { simulationSha256 } from "../kernel/SimulationHashes.js";
import { HeadlessEpisodeError } from "./HeadlessErrors.js";

export const SCALAR_TYPE = Object.freeze({
    float32: 1,
    float64: 2,
    int8: 3,
    uint8: 4,
    int16: 5,
    uint16: 6,
    int32: 7,
    uint32: 8,
    int64: 9,
    uint64: 10,
    bool: 11,
});

export const BYTE_ORDER_LITTLE_ENDIAN = 1;
const UTF8 = new TextEncoder();
const TYPE_BYTES = Object.freeze({ 1: 4, 2: 8, 3: 1, 4: 1, 5: 2, 6: 2, 7: 4, 8: 4, 9: 8, 10: 8, 11: 1 });

export function compareUtf8(left, right) {
    const a = UTF8.encode(String(left));
    const b = UTF8.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

export function tensorSpec(dtype, shape) {
    const scalar = typeof dtype === "number" ? dtype : SCALAR_TYPE[dtype];
    if (!TYPE_BYTES[scalar]) throw new TypeError(`Unsupported tensor dtype ${dtype}.`);
    const dimensions = [...shape].map((entry) => Math.max(0, Math.floor(Number(entry))));
    return { dtype: scalar, shape: dimensions, byteOrder: BYTE_ORDER_LITTLE_ENDIAN };
}

function elementCount(shape) {
    return shape.reduce((total, size) => total * size, 1);
}

export function packTensor(dtype, shape, values) {
    const spec = tensorSpec(dtype, shape);
    const entries = Array.from(values ?? []);
    const count = elementCount(spec.shape);
    if (entries.length !== count) throw new RangeError(`Tensor requires ${count} values, received ${entries.length}.`);
    const packedData = new Uint8Array(count * TYPE_BYTES[spec.dtype]);
    const view = new DataView(packedData.buffer);
    const set = {
        1: (offset, value) => view.setFloat32(offset, Number(value), true),
        2: (offset, value) => view.setFloat64(offset, Number(value), true),
        3: (offset, value) => view.setInt8(offset, Number(value)),
        4: (offset, value) => view.setUint8(offset, Number(value)),
        5: (offset, value) => view.setInt16(offset, Number(value), true),
        6: (offset, value) => view.setUint16(offset, Number(value), true),
        7: (offset, value) => view.setInt32(offset, Number(value), true),
        8: (offset, value) => view.setUint32(offset, Number(value), true),
        9: (offset, value) => view.setBigInt64(offset, BigInt(value), true),
        10: (offset, value) => view.setBigUint64(offset, BigInt(value), true),
        11: (offset, value) => view.setUint8(offset, value ? 1 : 0),
    }[spec.dtype];
    entries.forEach((value, index) => set(index * TYPE_BYTES[spec.dtype], value));
    return { spec, payload: { packedData } };
}

export function unpackTensor(tensor) {
    const spec = tensor?.spec;
    const packed = tensor?.payload?.packedData;
    if (!spec || spec.byteOrder !== BYTE_ORDER_LITTLE_ENDIAN || !(packed instanceof Uint8Array)) {
        throw new HeadlessEpisodeError("INVALID_REQUEST", "Tensor must use an inline little-endian packed payload.");
    }
    const count = elementCount(spec.shape ?? []);
    const bytes = TYPE_BYTES[spec.dtype];
    if (!bytes || packed.byteLength !== count * bytes) {
        throw new HeadlessEpisodeError("INVALID_REQUEST", "Tensor payload length does not match its declared dtype and shape.");
    }
    const view = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
    const get = {
        1: (offset) => view.getFloat32(offset, true),
        2: (offset) => view.getFloat64(offset, true),
        3: (offset) => view.getInt8(offset),
        4: (offset) => view.getUint8(offset),
        5: (offset) => view.getInt16(offset, true),
        6: (offset) => view.getUint16(offset, true),
        7: (offset) => view.getInt32(offset, true),
        8: (offset) => view.getUint32(offset, true),
        9: (offset) => view.getBigInt64(offset, true),
        10: (offset) => view.getBigUint64(offset, true),
        11: (offset) => view.getUint8(offset) !== 0,
    }[spec.dtype];
    return Array.from({ length: count }, (_, index) => get(index * bytes));
}

export function tensorMap(entries) {
    const sorted = [...entries].sort((left, right) => compareUtf8(left.name, right.name));
    const seen = new Set();
    for (const entry of sorted) {
        if (!entry.name || seen.has(entry.name)) throw new TypeError(`Tensor names must be unique and non-empty: ${entry.name}.`);
        seen.add(entry.name);
    }
    return { entries: sorted };
}

export function namedTensor(name, dtype, shape, values) {
    return { name, tensor: packTensor(dtype, shape, values) };
}

export function boxSpace(id, version, dtype, shape, low, high) {
    return { id, version, box: { tensor: tensorSpec(dtype, shape), low: [...low], high: [...high] } };
}

export function dictionarySpace(id, version, entries) {
    return {
        id,
        version,
        dictionary: {
            entries: [...entries]
                .sort((left, right) => compareUtf8(left.key, right.key)),
        },
    };
}

export function hashSpace(space) {
    return simulationSha256({ kind: "cev-sim.space", version: 1, space });
}

export const ACTION_SPACE = Object.freeze(boxSpace(
    "normalized-speed-steering",
    1,
    "float32",
    [2],
    [-1, -1],
    [1, 1],
));

export const ACTION_SPACE_HASH = hashSpace(ACTION_SPACE);

export function normalizeAction(action) {
    let values = action;
    if (Array.isArray(action?.entries)) {
        if (action.entries.length !== 1 || action.entries[0].name !== "action") {
            throw new HeadlessEpisodeError("INVALID_REQUEST", "Action TensorMap must contain exactly one tensor named action.");
        }
        const tensor = action.entries[0].tensor;
        if (tensor?.spec?.dtype !== SCALAR_TYPE.float32
            || tensor?.spec?.shape?.length !== 1
            || Number(tensor.spec.shape[0]) !== 2) {
            throw new HeadlessEpisodeError("INVALID_REQUEST", "Action tensor must be little-endian float32[2].");
        }
        values = unpackTensor(tensor);
    }
    if (ArrayBuffer.isView(values)) values = Array.from(values);
    if (!Array.isArray(values) || values.length !== 2) {
        throw new HeadlessEpisodeError("INVALID_REQUEST", "Action must contain [speed, steering].");
    }
    const normalized = values.map(Number);
    if (normalized.some((value) => !Number.isFinite(value) || value < -1 || value > 1)) {
        throw new HeadlessEpisodeError("INVALID_REQUEST", "Action values must be finite and within [-1, 1].");
    }
    return new Float32Array(normalized);
}
