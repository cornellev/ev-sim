import { canonicalStringify } from "../simulation/canonicalJson.js";
import { compareUtf8 } from "../math/compareUtf8.js";
import {
    assertProtobufName,
    base64ToBytes,
    encodeMessage,
    loadDescriptorSet,
    protobufFingerprint,
    PROTOBUF_LIMITS,
} from "./ProtobufSchema.js";

export const PROTOBUF_INTERFACE_KIND = "cev-sim.protobuf-interface";
export const PROTOBUF_INTERFACE_VERSION = 1;
export const PROTOBUF_INTERFACE_LIMITS = Object.freeze({ schemas: 16, routes: 64, bootstrap: 64 });

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const encoder = new TextEncoder();

function invalid(path, message) {
    throw Object.assign(new Error(`${path}: ${message}`), { path });
}

function record(value, allowed, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, "must be an object");
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) invalid(`${path}.${unknown}`, "unknown field");
    return value;
}

function text(value, path) {
    if (typeof value !== "string" || !value.trim() || value.length > 1024) invalid(path, "must be a bounded nonempty string");
    return value.trim();
}

function id(value, path) {
    const result = text(value, path);
    if (!ID.test(result)) invalid(path, "invalid identifier");
    return result;
}

function json(value, path, depth = 0, budget = { nodes: PROTOBUF_LIMITS.valueNodes, bytes: 0 }) {
    if (depth > PROTOBUF_LIMITS.depth || --budget.nodes < 0) invalid(path, "JSON value is too complex");
    const claim = (text) => {
        if (text.length > PROTOBUF_LIMITS.payloadBytes
            || (budget.bytes += encoder.encode(text).length) > PROTOBUF_LIMITS.payloadBytes) invalid(path, "JSON values are too large");
    };
    if (typeof value === "string") { claim(value); return value; }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) invalid(path, "sparse arrays are invalid");
        return value.map((entry, index) => json(entry, `${path}.${index}`, depth + 1, budget));
    }
    if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
            if (["__proto__", "constructor", "prototype"].includes(key)) invalid(path, "unsafe JSON key");
            claim(key);
            return [key, json(entry, `${path}.${key}`, depth + 1, budget)];
        }));
    }
    invalid(path, "must contain only finite JSON values; use strings for 64-bit integers");
}

function fieldPath(value, path) {
    const result = text(value, path);
    try { result.split(".").forEach((part) => assertProtobufName(part)); }
    catch { invalid(path, "must be a safe dotted field path"); }
    return result;
}

function messageType(schema, value, path) {
    const name = fieldPath(value, path);
    try { return schema.root.lookupType(name); }
    catch { invalid(path, `message "${name}" is absent from the selected schema`); }
}

function fieldAt(type, path, label) {
    const parts = path.split(".");
    let field;
    for (const [index, part] of parts.entries()) {
        if (!type?.fields || !Object.hasOwn(type.fields, part)) invalid(label, "field is absent from the message");
        field = type.fields[part];
        if (index < parts.length - 1) {
            if (field.repeated || field.map || !field.resolvedType?.fields) invalid(label, "cannot descend into a scalar, map, or repeated field");
            type = field.resolvedType;
        }
    }
    return field;
}

function mapping(value, path, destinationType, sourceType, budget) {
    record(value, ["fields", "adapter", "config"], path);
    if (value.adapter !== undefined) {
        if (value.fields !== undefined) invalid(path, "choose field assignments or an adapter");
        return {
            adapter: id(value.adapter, `${path}.adapter`),
            ...(value.config === undefined ? {} : { config: json(value.config, `${path}.config`, 0, budget) }),
        };
    }
    if (value.config !== undefined || !Array.isArray(value.fields) || value.fields.length > 1024
        || Object.keys(value.fields).length !== value.fields.length) {
        invalid(path, "requires a bounded fields array");
    }
    const assigned = [];
    const fields = value.fields.map((entry, index) => {
        const label = `${path}.fields.${index}`;
        record(entry, ["to", "from", "value", "scale", "offset"], label);
        const to = fieldPath(entry.to, `${label}.to`);
        if (assigned.some((prior) => prior === to || prior.startsWith(`${to}.`) || to.startsWith(`${prior}.`))) {
            invalid(label, "destination overlaps another assignment");
        }
        assigned.push(to);
        const destination = destinationType ? fieldAt(destinationType, to, `${label}.to`) : null;
        if (Object.hasOwn(entry, "value")) {
            if (["from", "scale", "offset"].some((key) => Object.hasOwn(entry, key))) invalid(label, "literal assignments cannot have a source or conversion");
            const value = json(entry.value, `${label}.value`, 0, budget);
            if (destinationType) {
                const partial = to.split(".").reverse().reduce((nested, part) => ({ [part]: nested }), value);
                try { encodeMessage(destinationType, partial); }
                catch (error) { invalid(`${label}.value`, error.message); }
            }
            return { to, value };
        }
        const from = fieldPath(entry.from, `${label}.from`);
        if (!["value", "metadata", "run"].includes(from.split(".")[0])) invalid(`${label}.from`, "source must start with value, metadata, or run");
        if (sourceType && from.startsWith("value.")) fieldAt(sourceType, from.slice(6), `${label}.from`);
        const result = { to, from };
        for (const key of ["scale", "offset"]) {
            if (entry[key] !== undefined) {
                if (typeof entry[key] !== "number" || !Number.isFinite(entry[key])) invalid(`${label}.${key}`, "must be finite");
                if (destination && (destination.repeated || destination.map || destination.resolvedType
                    || ["string", "bytes", "bool"].includes(destination.type))) invalid(label, "conversion requires a numeric scalar destination");
                result[key] = entry[key];
            }
        }
        return result;
    });
    return { fields };
}

function list(value, max, path) {
    if (!Array.isArray(value) || value.length > max || Object.keys(value).length !== value.length) invalid(path, `must be a dense array with at most ${max} entries`);
    const seen = new Set();
    return value.map((entry, index) => {
        const name = id(entry?.id, `${path}.${index}.id`);
        if (seen.has(name)) invalid(path, `duplicate identifier "${name}"`);
        seen.add(name);
        return { entry, name, path: `${path}.${index}` };
    });
}

export function normalizeProtobufInterface(input) {
    record(input, ["kind", "version", "schemas", "routes", "bootstrap"], "interface");
    if (input.kind !== PROTOBUF_INTERFACE_KIND || input.version !== PROTOBUF_INTERFACE_VERSION) invalid("interface", "unsupported kind or version");
    const budget = { nodes: PROTOBUF_LIMITS.valueNodes, bytes: 0 };
    const loaded = new Map();
    const schemas = list(input.schemas, PROTOBUF_INTERFACE_LIMITS.schemas, "schemas").map(({ entry, name, path }) => {
        record(entry, ["id", "fingerprint", "descriptorBase64"], path);
        if (typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) invalid(`${path}.fingerprint`, "must be a lowercase SHA-256 digest");
        let schema;
        try { schema = loadDescriptorSet(base64ToBytes(entry.descriptorBase64), entry.fingerprint); }
        catch (error) { invalid(path, error.message); }
        loaded.set(name, schema);
        return { id: name, fingerprint: schema.fingerprint, descriptorBase64: schema.descriptorBase64 };
    });
    if (!schemas.length) invalid("schemas", "at least one schema is required");
    const selectedType = (entry, path) => {
        const schemaId = id(entry.schemaId, `${path}.schemaId`);
        const schema = loaded.get(schemaId);
        if (!schema) invalid(`${path}.schemaId`, "schema is absent");
        return { schemaId, type: messageType(schema, entry.messageType, `${path}.messageType`) };
    };
    const bootstrap = list(input.bootstrap ?? [], PROTOBUF_INTERFACE_LIMITS.bootstrap, "bootstrap").map(({ entry, name, path }) => {
        record(entry, ["id", "schemaId", "messageType", "value", "repeatMs"], path);
        const { schemaId, type } = selectedType(entry, path);
        const value = json(entry.value, `${path}.value`, 0, budget);
        try { encodeMessage(type, value); }
        catch (error) { invalid(`${path}.value`, error.message); }
        const repeatMs = entry.repeatMs ?? 0;
        if (!Number.isSafeInteger(repeatMs) || repeatMs < 0 || repeatMs > 86_400_000) invalid(`${path}.repeatMs`, "must be an integer from 0 to 86400000");
        return { id: name, schemaId, messageType: type.fullName.slice(1), value, repeatMs };
    });
    const bootstrapById = new Map(bootstrap.map((entry) => [entry.id, entry]));
    const keys = new Set();
    const routes = list(input.routes, PROTOBUF_INTERFACE_LIMITS.routes, "routes").map(({ entry, name, path }) => {
        record(entry, ["id", "schemaId", "messageType", "direction", "key", "source", "target", "mapping"], path);
        const { schemaId, type } = selectedType(entry, path);
        const key = text(entry.key, `${path}.key`);
        const normalizedKey = key.replaceAll("{run_id}", "run");
        if (/[\s*?#{}\\]/.test(normalizedKey) || normalizedKey.split("/").some((part) => !part || part === "." || part === "..")) invalid(`${path}.key`, "must be a literal Zenoh key or a {run_id} template");
        if (keys.has(normalizedKey)) invalid(`${path}.key`, "duplicate or colliding route key");
        keys.add(normalizedKey);
        const result = { id: name, schemaId, messageType: type.fullName.slice(1), direction: entry.direction, key };
        if (entry.direction === "publish") {
            if (entry.target !== undefined) invalid(path, "publication cannot have a target");
            record(entry.source, ["topicId", "bootstrapId"], `${path}.source`);
            if (Object.keys(entry.source).length !== 1) invalid(`${path}.source`, "choose one topic or bootstrap value");
            if (entry.source.bootstrapId !== undefined) {
                const bootstrapId = id(entry.source.bootstrapId, `${path}.source.bootstrapId`);
                const source = bootstrapById.get(bootstrapId);
                if (!source || source.schemaId !== schemaId || source.messageType !== result.messageType) invalid(`${path}.source`, "bootstrap value is absent or has a different type");
                result.source = { bootstrapId };
            } else result.source = { topicId: id(entry.source.topicId, `${path}.source.topicId`) };
        } else if (entry.direction === "subscribe") {
            if (entry.source !== undefined) invalid(path, "subscription cannot have a source");
            record(entry.target, ["topicId"], `${path}.target`);
            result.target = { topicId: id(entry.target.topicId, `${path}.target.topicId`) };
        } else invalid(`${path}.direction`, "must be publish or subscribe");
        result.mapping = mapping(entry.mapping, `${path}.mapping`, entry.direction === "publish" ? type : null, entry.direction === "subscribe" ? type : null, budget);
        return result;
    });
    const sort = (entries) => entries.sort((left, right) => compareUtf8(left.id, right.id));
    const document = { kind: PROTOBUF_INTERFACE_KIND, version: PROTOBUF_INTERFACE_VERSION, schemas: sort(schemas), routes: sort(routes), bootstrap: sort(bootstrap) };
    if (encoder.encode(canonicalStringify(document)).byteLength > PROTOBUF_LIMITS.payloadBytes) invalid("interface", "document is too large");
    return document;
}

export function validateProtobufInterface(value) {
    try { return { ok: true, document: normalizeProtobufInterface(value), issues: [] }; }
    catch (error) { return { ok: false, document: null, issues: [{ path: error.path || "interface", message: error.message }] }; }
}

export function hashProtobufInterface(value) {
    return protobufFingerprint(encoder.encode(canonicalStringify(normalizeProtobufInterface(value))));
}
