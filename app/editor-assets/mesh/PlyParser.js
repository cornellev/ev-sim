/** ASCII and little-endian binary PLY parser. Polygon faces are triangulated. */

import { createMeshDocument } from "./MeshDocument.js";
import { triangulatePolygon } from "./triangulate.js";

const TYPE_SIZE = Object.freeze({
    char: 1, int8: 1, uchar: 1, uint8: 1,
    short: 2, int16: 2, ushort: 2, uint16: 2,
    int: 4, int32: 4, uint: 4, uint32: 4, float: 4, float32: 4,
    double: 8, float64: 8,
});

function bytesOf(value) {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return new Uint8Array(value);
    throw new TypeError("PLY bytes are required.");
}

function slug(name) {
    const cleaned = String(name ?? "").trim().replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
    return cleaned || "object";
}

function typeSize(type) {
    const size = TYPE_SIZE[type];
    if (!size) throw new Error(`PLY property type ${type} is unsupported.`);
    return size;
}

function splitHeader(bytes) {
    const decoded = new TextDecoder("iso-8859-1").decode(bytes);
    const marker = decoded.indexOf("end_header");
    if (marker < 0) throw new Error("PLY header is missing end_header.");
    let end = marker + "end_header".length;
    if (decoded[end] === "\r") end += 1;
    if (decoded[end] !== "\n") throw new Error("PLY header is missing end_header.");
    return { header: decoded.slice(0, marker), bodyOffset: end + 1 };
}

function parseHeader(header) {
    const lines = header.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line && !line.startsWith("comment") && !line.startsWith("obj_info"));
    if (lines[0] !== "ply") throw new Error("PLY file must start with ply.");
    const format = lines.find((line) => line.startsWith("format "));
    if (!format) throw new Error("PLY header is missing a format.");
    const [, encoding, version] = format.split(/\s+/u);
    if (version !== "1.0") throw new Error(`PLY version ${version} is unsupported.`);
    if (encoding === "binary_big_endian") throw new Error("PLY binary_big_endian is not imported.");
    if (encoding !== "ascii" && encoding !== "binary_little_endian") throw new Error(`PLY format ${encoding} is unsupported.`);
    const elements = [];
    let current = null;
    for (const line of lines.slice(1)) {
        if (line.startsWith("format ")) continue;
        if (line.startsWith("element ")) {
            const [, name, count] = line.split(/\s+/u);
            const parsedCount = Number(count);
            if (!name || !Number.isInteger(parsedCount) || parsedCount < 0) throw new Error(`PLY element ${line} is invalid.`);
            current = { name, count: parsedCount, properties: [] };
            elements.push(current);
            continue;
        }
        if (!current) throw new Error(`PLY header statement ${JSON.stringify(line)} is outside an element.`);
        const list = line.match(/^property list (\S+) (\S+) (\S+)$/u);
        if (list) {
            typeSize(list[1]);
            typeSize(list[2]);
            current.properties.push({ kind: "list", countType: list[1], valueType: list[2], name: list[3] });
            continue;
        }
        const scalar = line.match(/^property (\S+) (\S+)$/u);
        if (!scalar) throw new Error(`PLY property ${JSON.stringify(line)} is unsupported.`);
        typeSize(scalar[1]);
        current.properties.push({ kind: "scalar", type: scalar[1], name: scalar[2] });
    }
    return { encoding, elements };
}

function readScalar(view, offset, type) {
    switch (type) {
        case "char": case "int8": return view.getInt8(offset);
        case "uchar": case "uint8": return view.getUint8(offset);
        case "short": case "int16": return view.getInt16(offset, true);
        case "ushort": case "uint16": return view.getUint16(offset, true);
        case "int": case "int32": return view.getInt32(offset, true);
        case "uint": case "uint32": return view.getUint32(offset, true);
        case "float": case "float32": return view.getFloat32(offset, true);
        case "double": case "float64": return view.getFloat64(offset, true);
        default: throw new Error(`PLY property type ${type} is unsupported.`);
    }
}

function readBinaryRecords(bytes, bodyOffset, element) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = bodyOffset;
    const records = [];
    for (let index = 0; index < element.count; index += 1) {
        const record = {};
        for (const property of element.properties) {
            if (offset >= bytes.length) throw new Error("PLY body ended before all elements were read.");
            if (property.kind === "scalar") {
                record[property.name] = readScalar(view, offset, property.type);
                offset += typeSize(property.type);
            } else {
                const count = readScalar(view, offset, property.countType);
                offset += typeSize(property.countType);
                if (!Number.isInteger(count) || count < 0) throw new Error(`PLY list ${property.name} has an invalid count.`);
                const values = [];
                for (let item = 0; item < count; item += 1) {
                    if (offset >= bytes.length) throw new Error("PLY body ended before all elements were read.");
                    values.push(readScalar(view, offset, property.valueType));
                    offset += typeSize(property.valueType);
                }
                record[property.name] = values;
            }
        }
        records.push(record);
    }
    return { records, offset };
}

function readAsciiRecords(tokens, cursor, element) {
    const records = [];
    let index = cursor;
    const next = () => {
        if (index >= tokens.length) throw new Error("PLY body ended before all elements were read.");
        const value = Number(tokens[index]);
        index += 1;
        if (!Number.isFinite(value)) throw new Error(`PLY value ${JSON.stringify(tokens[index - 1])} is not finite.`);
        return value;
    };
    for (let recordIndex = 0; recordIndex < element.count; recordIndex += 1) {
        const record = {};
        for (const property of element.properties) {
            if (property.kind === "scalar") record[property.name] = next();
            else {
                const count = next();
                if (!Number.isInteger(count) || count < 0) throw new Error(`PLY list ${property.name} has an invalid count.`);
                record[property.name] = Array.from({ length: count }, next);
            }
        }
        records.push(record);
    }
    return { records, cursor: index };
}

function faceIndices(record) {
    const values = record.vertex_indices ?? record.vertex_index;
    if (!Array.isArray(values)) throw new Error("PLY face is missing vertex_indices.");
    return values;
}

export function parsePly(bytes, name = "object") {
    const source = bytesOf(bytes);
    const { header, bodyOffset } = splitHeader(source);
    const { encoding, elements } = parseHeader(header);
    const vertexElement = elements.find((element) => element.name === "vertex");
    const faceElement = elements.find((element) => element.name === "face");
    if (!vertexElement || !faceElement) throw new Error("PLY file requires vertex and face elements.");
    for (const axis of ["x", "y", "z"]) {
        if (!vertexElement.properties.some((property) => property.name === axis && property.kind === "scalar")) {
            throw new Error(`PLY vertices require a ${axis} property.`);
        }
    }
    if (!faceElement.properties.some((property) => property.kind === "list" && (property.name === "vertex_indices" || property.name === "vertex_index"))) {
        throw new Error("PLY faces require a vertex_indices list.");
    }
    const collected = new Map();
    if (encoding === "ascii") {
        const tokens = new TextDecoder().decode(source.subarray(bodyOffset)).trim().split(/\s+/u).filter(Boolean);
        let cursor = 0;
        for (const element of elements) {
            const read = readAsciiRecords(tokens, cursor, element);
            collected.set(element.name, read.records);
            cursor = read.cursor;
        }
    } else {
        let offset = bodyOffset;
        for (const element of elements) {
            const read = readBinaryRecords(source, offset, element);
            collected.set(element.name, read.records);
            offset = read.offset;
        }
    }
    const vertices = collected.get("vertex");
    const hasNormals = ["nx", "ny", "nz"].every((axis) => vertexElement.properties.some((property) => property.name === axis));
    const positions = vertices.map((vertex) => [vertex.x, vertex.y, vertex.z].map((value) => (Object.is(value, -0) ? 0 : value)));
    const normals = hasNormals ? vertices.map((vertex) => [vertex.nx, vertex.ny, vertex.nz]) : null;
    const indices = [];
    for (const face of collected.get("face")) {
        const polygon = faceIndices(face).map((index) => {
            if (!Number.isInteger(index) || index < 0 || index >= positions.length) throw new Error(`PLY face index ${index} is out of range.`);
            return index;
        });
        for (const triangle of triangulatePolygon(polygon)) indices.push(...triangle);
    }
    if (indices.length === 0) throw new Error("PLY file has no triangle faces.");
    const id = slug(name);
    return createMeshDocument({
        nodes: [{
            id,
            name: String(name ?? "").trim() || id,
            parentId: null,
            primitives: [{ positions, normals, uvs: null, indices, materialId: null }],
        }],
    });
}
