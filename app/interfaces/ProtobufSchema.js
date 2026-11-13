import protobuf from "protobufjs";
import descriptor from "protobufjs/ext/descriptor/index.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const PROTOBUF_LIMITS = Object.freeze({
    descriptorBytes: 700_000,
    files: 128,
    definitions: 16_384,
    depth: 64,
    payloadBytes: 16 * 1024 * 1024,
    valueNodes: 1_100_000,
});

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const UNSAFE_NAMES = new Set(["__proto__", "prototype", "constructor"]);
const encoder = new TextEncoder();

export function assertProtobufName(value, label = "Protobuf name") {
    if (typeof value !== "string" || !NAME.test(value) || UNSAFE_NAMES.has(value)) {
        throw new Error(`${label} is invalid.`);
    }
    return value;
}

export function assertProtoPath(value) {
    if (typeof value !== "string" || value.length > 1024 || !value.endsWith(".proto") || value.includes("\\")
        || value.includes(":") || value.includes("\0")
        || value.split("/").some((part) => !part || part === "." || part === "..")) {
        throw new Error(`Unsafe protobuf import path "${value}".`);
    }
    return value;
}

export function protobufFingerprint(bytes) {
    return bytesToHex(sha256(bytes));
}

export function bytesToBase64(bytes) {
    return protobuf.util.base64.encode(bytes, 0, bytes.length);
}

export function base64ToBytes(value) {
    if (typeof value !== "string" || !value.length
        || value.length > Math.ceil(PROTOBUF_LIMITS.descriptorBytes / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error("Descriptor must be bounded canonical base64.");
    }
    const bytes = new Uint8Array(protobuf.util.base64.length(value));
    protobuf.util.base64.decode(value, bytes, 0);
    if (bytesToBase64(bytes) !== value) throw new Error("Descriptor base64 is not canonical.");
    return bytes;
}

function validateDescriptorSet(set) {
    if (!set.file?.length || set.file.length > PROTOBUF_LIMITS.files) {
        throw new Error("Descriptor file count is invalid.");
    }
    const files = new Map();
    const symbols = new Set();
    const owners = new Map();
    const mapEntries = new Set();
    let currentFile;
    let definitions = 0;
    const count = () => {
        if (++definitions > PROTOBUF_LIMITS.definitions) throw new Error("Descriptor has too many definitions.");
    };
    const symbol = (name, parent) => {
        assertProtobufName(name);
        count();
        const fullName = parent ? `${parent}.${name}` : name;
        if (symbols.has(fullName)) throw new Error(`Duplicate protobuf definition "${fullName}".`);
        symbols.add(fullName);
        owners.set(`.${fullName}`, currentFile);
        return fullName;
    };
    const enums = (entries, parent) => {
        for (const entry of entries || []) {
            symbol(entry.name, parent);
            if (!entry.value?.length || entry.value[0].number !== 0) throw new Error("Proto3 enums must start with zero.");
            const names = new Set();
            for (const value of entry.value || []) {
                assertProtobufName(value.name);
                count();
                if (names.has(value.name)) throw new Error("Duplicate protobuf enum value.");
                names.add(value.name);
            }
        }
    };
    const messages = (entries, parent, depth) => {
        if (depth > PROTOBUF_LIMITS.depth) throw new Error("Descriptor nesting is too deep.");
        for (const entry of entries || []) {
            const fullName = symbol(entry.name, parent);
            if (entry.options?.mapEntry) mapEntries.add(`.${fullName}`);
            if (entry.extension?.length || entry.extensionRange?.length) throw new Error("Protobuf extensions are unsupported.");
            if (entry.options?.mapEntry && (entry.field?.length !== 2
                || entry.field[0].name !== "key" || entry.field[0].number !== 1 || entry.field[0].label !== 1
                || ![3, 4, 5, 6, 7, 8, 9, 13, 15, 16, 17, 18].includes(entry.field[0].type)
                || entry.field[1].name !== "value" || entry.field[1].number !== 2 || entry.field[1].label !== 1)) {
                throw new Error("Invalid protobuf map entry.");
            }
            const numbers = new Set();
            const names = new Set();
            for (const oneof of entry.oneofDecl || []) {
                assertProtobufName(oneof.name);
                if (names.has(oneof.name)) throw new Error("Duplicate protobuf oneof name.");
                names.add(oneof.name);
            }
            for (const field of entry.field || []) {
                assertProtobufName(field.name);
                count();
                if (names.has(field.name) || numbers.has(field.number)) throw new Error("Duplicate protobuf field name or number.");
                names.add(field.name);
                numbers.add(field.number);
                if (!Number.isInteger(field.number) || field.number < 1 || field.number > 536_870_911
                    || (field.number >= 19_000 && field.number <= 19_999)) throw new Error("Invalid protobuf field number.");
                if (![1, 3].includes(field.label) || field.type === 10 || field.extendee || Object.hasOwn(field, "defaultValue")) {
                    throw new Error("Required fields, groups, and extensions are unsupported.");
                }
                if (!Number.isInteger(field.type) || field.type < 1 || field.type > 18
                    || ([11, 14].includes(field.type) ? !field.typeName : !!field.typeName)) throw new Error("Invalid protobuf field type.");
                if (field.typeName) field.typeName.replace(/^\./, "").split(".").forEach((part) => assertProtobufName(part));
                if (Object.hasOwn(field, "oneofIndex") && (!Number.isInteger(field.oneofIndex)
                    || field.oneofIndex < 0 || field.oneofIndex >= (entry.oneofDecl?.length || 0)
                    || field.label !== 1)) throw new Error("Invalid protobuf oneof membership.");
                if (field.proto3Optional && !Object.hasOwn(field, "oneofIndex")) throw new Error("Optional field lacks its presence oneof.");
                if (field.proto3Optional && entry.field.filter((other) => Object.hasOwn(other, "oneofIndex") && other.oneofIndex === field.oneofIndex).length !== 1) {
                    throw new Error("Optional presence oneof must have one member.");
                }
            }
            enums(entry.enumType, fullName);
            messages(entry.nestedType, fullName, depth + 1);
        }
    };
    for (const file of set.file) {
        currentFile = file.name;
        assertProtoPath(file.name);
        if (files.has(file.name)) throw new Error(`Duplicate descriptor file "${file.name}".`);
        if (file.syntax !== "proto3" || Object.hasOwn(file, "edition") || file.extension?.length || file.weakDependency?.length) {
            throw new Error("Only proto3 without extensions or weak imports is supported.");
        }
        if (file.package) for (const part of file.package.split(".")) assertProtobufName(part);
        files.set(file.name, file);
        enums(file.enumType, file.package || "");
        messages(file.messageType, file.package || "", 0);
        for (const service of file.service || []) {
            const fullName = symbol(service.name, file.package || "");
            for (const method of service.method || []) symbol(method.name, fullName);
        }
    }
    const visiting = new Set();
    const visited = new Set();
    const visit = (name) => {
        if (visited.has(name)) return;
        if (visiting.has(name)) throw new Error("Protobuf imports contain a cycle.");
        const file = files.get(name);
        if (!file) throw new Error(`Unresolved protobuf import "${name}".`);
        visiting.add(name);
        for (const dependency of file.dependency || []) visit(assertProtoPath(dependency));
        for (const index of file.publicDependency || []) {
            if (!Number.isInteger(index) || index < 0 || index >= file.dependency.length) throw new Error("Invalid public import index.");
        }
        visiting.delete(name);
        visited.add(name);
    };
    for (const name of files.keys()) visit(name);
    return { files, owners, mapEntries };
}

function validateTypeImports(root, files, owners) {
    const allowed = new Map();
    for (const [name, file] of files) {
        const visible = new Set([name]);
        const include = (dependency) => {
            if (visible.has(dependency)) return;
            visible.add(dependency);
            const imported = files.get(dependency);
            for (const index of imported.publicDependency || []) include(imported.dependency[index]);
        };
        for (const dependency of file.dependency || []) include(dependency);
        allowed.set(name, visible);
    }
    for (const [name, owner] of owners) {
        const symbol = root.lookup(name);
        const references = symbol instanceof protobuf.Type ? symbol.fieldsArray.map((field) => field.resolvedType)
            : symbol instanceof protobuf.Service ? symbol.methodsArray.flatMap((method) => [method.resolvedRequestType, method.resolvedResponseType]) : [];
        for (const reference of references) {
            if (reference && !allowed.get(owner).has(owners.get(reference.fullName))) {
                throw new Error(`Type "${reference.fullName}" requires an explicit protobuf import in "${owner}".`);
            }
        }
    }
}

// protobufjs's descriptor extension loses map fields, optional metadata, and packed defaults.
function restoreDescriptorFields(root, entries, parent, mapEntries) {
    for (const entry of entries || []) {
        const name = parent ? `${parent}.${entry.name}` : entry.name;
        const type = root.lookupType(name);
        if (!entry.options?.mapEntry && type.options) delete type.options.map_entry;
        for (const raw of entry.field || []) {
            let field = type.fields[raw.name];
            if ((raw.type === 11 && !(field.resolvedType instanceof protobuf.Type))
                || (raw.type === 14 && !(field.resolvedType instanceof protobuf.Enum))) throw new Error("Descriptor field type does not match its definition.");
            if (field.repeated && mapEntries.has(field.resolvedType?.fullName)) {
                const key = field.resolvedType.fields.key;
                const value = field.resolvedType.fields.value;
                const map = new protobuf.MapField(field.name, field.id, key.type, value.resolvedType?.fullName || value.type, field.options);
                type.remove(field).add(map);
                field = map.resolve();
            }
            if (raw.proto3Optional) field.setOption("proto3_optional", true);
            if (field.options && !Object.hasOwn(raw.options || {}, "packed")) delete field.options.packed;
        }
        restoreDescriptorFields(root, entry.nestedType, name, mapEntries);
    }
}

export function loadDescriptorSet(input, expectedFingerprint = null) {
    if (!(input instanceof Uint8Array) || !input.byteLength || input.byteLength > PROTOBUF_LIMITS.descriptorBytes) {
        throw new Error("Descriptor must contain 1..700000 bytes.");
    }
    const bytes = new Uint8Array(input);
    const fingerprint = protobufFingerprint(bytes);
    if (expectedFingerprint !== null && expectedFingerprint !== fingerprint) throw new Error("Descriptor fingerprint mismatch.");
    const set = descriptor.FileDescriptorSet.decode(bytes);
    const { files, owners, mapEntries } = validateDescriptorSet(set);
    const root = protobuf.Root.fromDescriptor(set);
    validateTypeImports(root, files, owners);
    for (const file of set.file) restoreDescriptorFields(root, file.messageType, file.package || "", mapEntries);
    return { fingerprint, descriptorBase64: bytesToBase64(bytes), root };
}

function integer(value, type, label) {
    const unsigned = type.startsWith("u") || type.startsWith("fixed");
    const bits = type.endsWith("64") ? 64 : 32;
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`${label} must be an exact integer.`);
    if (!["number", "bigint", "string"].includes(typeof value)
        || (typeof value === "string" && !/^(0|-?[1-9][0-9]*)$/.test(value))) throw new Error(`${label} must be an integer.`);
    const n = BigInt(value);
    const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
    const max = unsigned ? (1n << BigInt(bits)) - 1n : (1n << BigInt(bits - 1)) - 1n;
    if (n < min || n > max) throw new Error(`${label} is outside ${type} range.`);
    return bits === 64 ? n.toString() : Number(n);
}

function normalizeMessage(type, value, budget, depth = 0, decoded = false) {
    if (depth > PROTOBUF_LIMITS.depth || --budget.nodes < 0) throw new Error("Protobuf value is too complex.");
    if (!value || typeof value !== "object" || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${type.fullName} must be an object.`);
    const result = {};
    const claimBytes = (length) => {
        if ((budget.bytes += length) > PROTOBUF_LIMITS.payloadBytes) throw new Error("Protobuf payload is too large.");
    };
    for (const name of Object.keys(value)) {
        if (!Object.hasOwn(type.fields, name)) throw new Error(`Unknown protobuf field "${name}".`);
        const field = type.fields[name];
        const input = value[name];
        if (input === null || input === undefined) continue;
        const scalar = (entry) => {
            if (--budget.nodes < 0) throw new Error("Protobuf value is too complex.");
            if (field.resolvedType instanceof protobuf.Type) return normalizeMessage(field.resolvedType, entry, budget, depth + 1, decoded);
            if (field.resolvedType instanceof protobuf.Enum) {
                if (typeof entry === "string") {
                    if (!Object.hasOwn(field.resolvedType.values, entry)) throw new Error(`Unknown enum value "${entry}".`);
                    return field.resolvedType.values[entry];
                }
                return integer(entry, "int32", name);
            }
            if (field.type === "bytes") {
                if (typeof entry === "string") {
                    if (!protobuf.util.base64.test(entry)) throw new Error(`${name} must contain base64 bytes.`);
                    const length = protobuf.util.base64.length(entry);
                    claimBytes(length);
                    const bytes = new Uint8Array(length);
                    protobuf.util.base64.decode(entry, bytes, 0);
                    return bytes;
                }
                if (!(entry instanceof Uint8Array) || entry.byteLength > PROTOBUF_LIMITS.payloadBytes) throw new Error(`${name} must contain bounded bytes.`);
                claimBytes(entry.byteLength);
                return new Uint8Array(entry);
            }
            if (field.type === "string") {
                if (typeof entry !== "string" || entry.length > PROTOBUF_LIMITS.payloadBytes) throw new Error(`${name} must be a bounded string.`);
                claimBytes(encoder.encode(entry).length);
                return entry;
            }
            if (field.type === "bool") {
                if (typeof entry !== "boolean") throw new Error(`${name} must be a boolean.`);
                return entry;
            }
            if (field.type === "float" || field.type === "double") {
                if (typeof entry !== "number" || !Number.isFinite(entry)
                    || (field.type === "float" && !Number.isFinite(Math.fround(entry)))) throw new Error(`${name} must be finite.`);
                return entry;
            }
            return integer(entry, field.type, name);
        };
        if (field.map) {
            if (!input || typeof input !== "object" || Array.isArray(input)
                || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error(`${name} must be a map.`);
            result[name] = Object.fromEntries(Object.entries(input).map(([key, entry]) => {
                if (decoded && field.keyType.endsWith("64")) {
                    key = protobuf.util.LongBits.fromHash(key).toLong(field.keyType.startsWith("u") || field.keyType === "fixed64").toString();
                }
                if (UNSAFE_NAMES.has(key)) throw new Error("Unsafe protobuf map key.");
                if (key.length > PROTOBUF_LIMITS.payloadBytes) throw new Error("Protobuf map key is too large.");
                claimBytes(encoder.encode(key).length);
                if (field.keyType === "bool" && !["true", "false"].includes(key)) throw new Error("Invalid boolean map key.");
                if (!["string", "bool"].includes(field.keyType)) key = String(integer(key, field.keyType, name));
                return [key, scalar(entry)];
            }));
        } else if (field.repeated) {
            if (!Array.isArray(input) || input.length > budget.nodes) throw new Error(`${name} must be a bounded array.`);
            result[name] = input.map(scalar);
            if (Object.keys(result[name]).length !== input.length) throw new Error("Sparse protobuf arrays are invalid.");
        } else result[name] = scalar(input);
    }
    for (const oneof of type.oneofsArray) {
        if (oneof.oneof.filter((name) => Object.hasOwn(result, name)).length > 1) throw new Error(`Multiple fields supplied for oneof "${oneof.name}".`);
    }
    return result;
}

export function encodeMessage(type, value) {
    const normalized = normalizeMessage(type, value, { nodes: PROTOBUF_LIMITS.valueNodes, bytes: 0 });
    const message = type.fromObject(normalized);
    const writer = protobuf.Writer.create();
    // protobufjs otherwise treats the map key string "false" as true.
    writer.bool = (value) => writer.uint32(value === true || value === "true" ? 1 : 0);
    const bytes = type.encode(message, writer).finish();
    if (bytes.byteLength > PROTOBUF_LIMITS.payloadBytes) throw new Error("Protobuf payload is too large.");
    return new Uint8Array(bytes);
}

export function decodeMessage(type, bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > PROTOBUF_LIMITS.payloadBytes) throw new Error("Protobuf payload must contain bounded bytes.");
    const value = type.toObject(type.decode(bytes), { longs: String, enums: Number });
    return normalizeMessage(type, value, { nodes: PROTOBUF_LIMITS.valueNodes, bytes: 0 }, 0, true);
}
