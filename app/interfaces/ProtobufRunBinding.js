import { parseMsgDefinition, STD_ALIASES } from "../client/TopicCodec.js";
import { isControlsCommandTopic, schemaClosureForManifest } from "../autonomy/AutonomyContractCatalog.js";
import { canonicalStringify } from "../simulation/canonicalJson.js";
import { normalizeProtobufInterface } from "./ProtobufInterface.js";
import { assertProtobufName, base64ToBytes, loadDescriptorSet, protobufFingerprint } from "./ProtobufSchema.js";
import { compileMapping } from "./ProtobufMapping.js";

const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
const numericTypes = new Set(["double", "float", "float32", "float64", "int8", "uint8", "int16", "uint16", "int32", "uint32", "sint32", "fixed32", "sfixed32", "int64", "uint64", "sint64", "fixed64", "sfixed64", "duration"]);
const metadataTypes = {
    simTimeNs: "uint64", captureTimeNs: "uint64", deliveryTimeNs: "uint64",
    captureStep: "uint64", actualDeliveryStep: "uint64", sequenceId: "uint64", frameId: "string",
};

function invalid(path, message, code = "PROTOBUF_INVALID") {
    throw Object.assign(new Error(`${path}: ${message}`), { path, code });
}

function record(value, keys, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, "must be an object");
    const unknown = Object.keys(value).find((key) => !keys.includes(key));
    if (unknown) invalid(`${path}.${unknown}`, "unknown field");
}

export function normalizeProtobufRunConfig(value = undefined) {
    if (value === undefined) return { mode: "disabled", interfaceHash: null, externalController: false };
    record(value, ["mode", "interfaceHash", "externalController"], "protobuf");
    const { mode = "disabled", interfaceHash = null, externalController = false } = value;
    if (!["disabled", "zenoh"].includes(mode)) invalid("protobuf.mode", "must be disabled or zenoh");
    if (typeof externalController !== "boolean") invalid("protobuf.externalController", "must be a boolean");
    if (mode === "disabled" && (interfaceHash !== null || externalController)) invalid("protobuf", "disabled mode requires no interface or external controller");
    if (mode === "zenoh" && (typeof interfaceHash !== "string" || !SHA256.test(interfaceHash))) invalid("protobuf.interfaceHash", "requires a lowercase SHA-256 pin");
    return { mode, interfaceHash, externalController };
}

export function createProtobufInterfaceResource(input, expectedHash = undefined) {
    let document;
    try { document = normalizeProtobufInterface(input); }
    catch (error) { invalid(`protobuf.${error.path || "interface"}`, error.message); }
    const hash = protobufFingerprint(encoder.encode(canonicalStringify(document)));
    if (expectedHash !== undefined && hash !== expectedHash) invalid("protobuf.interfaceHash", "interface content does not match its pin", "BUNDLE_HASH_MISMATCH");
    return { document, hash };
}

export function assertProtobufInterfaceResource(resource, expectedHash) {
    record(resource, ["document", "hash"], "protobufInterface");
    if (typeof resource.hash !== "string" || !SHA256.test(resource.hash)) invalid("protobufInterface.hash", "requires a lowercase SHA-256 digest");
    const verified = createProtobufInterfaceResource(resource.document, expectedHash ?? resource.hash);
    if (verified.hash !== resource.hash || canonicalStringify(verified.document) !== canonicalStringify(resource.document)) {
        invalid("protobufInterface", "snapshot is not the normalized pinned interface", "BUNDLE_HASH_MISMATCH");
    }
    return verified;
}

function primitive(type) { return { type }; }

function localType(type, definitions, stack = []) {
    if (type === "byte") type = "uint8";
    if (type === "time") return { fields: { sec: primitive("uint32"), nsec: primitive("uint32") } };
    if (numericTypes.has(type) || ["bool", "string", "char"].includes(type)) return primitive(type);
    if (stack.includes(type) || stack.length >= 64 || typeof definitions[type] !== "string") invalid("protobuf.schemas", `unavailable or recursive local type ${type}`);
    return { fields: Object.fromEntries(parseMsgDefinition(type, definitions[type]).map((field) => {
        assertProtobufName(field.name);
        const item = localType(field.typeName, definitions, [...stack, type]);
        return [field.name, field.isArray ? { item, length: field.arrayLen } : item];
    })) };
}

function protobufType(type, stack = []) {
    if (!type.fields) return primitive(type.values ? "enum" : type.name);
    if (stack.includes(type) || stack.length >= 64) return { recursive: true };
    return { fields: Object.fromEntries(type.fieldsArray.map((field) => {
        const item = field.resolvedType ? protobufType(field.resolvedType, [...stack, type]) : primitive(field.type);
        return [field.name, field.map ? { map: item } : field.repeated ? { item, length: null } : item];
    })) };
}

function at(shape, path, label) {
    if (!path) return shape;
    for (const name of path.split(".")) {
        assertProtobufName(name);
        if (!shape?.fields || !Object.hasOwn(shape.fields, name)) invalid(label, "field is absent or descends through a scalar, array, or map");
        shape = shape.fields[name];
    }
    return shape;
}

function runValue(resolvedRun, path, label) {
    const parts = path.split(".");
    if (parts[0] !== "run" || parts.length < 2 || ["resolvedHash", "simulationSemanticHash"].includes(parts[1])) invalid(label, "requires a frozen run field, not execution identity");
    if (path === "run.runId") return "run";
    let value = resolvedRun;
    for (const part of parts.slice(1)) {
        assertProtobufName(part);
        if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, part)) invalid(label, "frozen run field is unavailable");
        value = value[part];
    }
    return value;
}

function compatible(source, destination, depth = 0) {
    if (depth >= 64 || source.recursive || destination.recursive || source.map || destination.map) return false;
    if (source.item || destination.item) {
        if (source.type === "bytes" && destination.item?.type === "uint8") return true;
        if (destination.type === "bytes" && source.item?.type === "uint8") return true;
        return !!source.item && !!destination.item
            && (destination.length == null || source.length === destination.length)
            && compatible(source.item, destination.item, depth + 1);
    }
    if (source.fields || destination.fields) return !!source.fields && !!destination.fields
        && Object.entries(source.fields).every(([key, field]) => destination.fields[key] && compatible(field, destination.fields[key], depth + 1));
    return source.type === destination.type
        || (numericTypes.has(source.type) && numericTypes.has(destination.type))
        || (source.type === "enum" && numericTypes.has(destination.type))
        || (destination.type === "enum" && numericTypes.has(source.type))
        || ([source.type, destination.type].every((type) => ["string", "char"].includes(type)));
}

function validateLiteral(value, shape, label) {
    if (shape.item) {
        if (!Array.isArray(value) || (shape.length != null && value.length !== shape.length)) invalid(label, "requires an array of the declared length");
        value.forEach((item) => validateLiteral(item, shape.item, label));
    } else if (shape.fields) {
        record(value, Object.keys(shape.fields), label);
        for (const [key, item] of Object.entries(value)) validateLiteral(item, shape.fields[key], `${label}.${key}`);
    } else if (shape.type === "bytes") {
        if (!Array.isArray(value)) invalid(label, "requires byte values");
        value.forEach((item) => validateLiteral(item, primitive("uint8"), label));
    } else if (["string", "char"].includes(shape.type)) {
        if (typeof value !== "string" || (shape.type === "char" && (value.length !== 1 || value.charCodeAt(0) > 127))) invalid(label, "requires a string of the declared type");
    } else if (shape.type === "bool") {
        if (typeof value !== "boolean") invalid(label, "requires a boolean");
    } else if (numericTypes.has(shape.type) || shape.type === "enum") {
        if (/(?:int|fixed)64$/.test(shape.type)) {
            if (!(typeof value === "number" && Number.isSafeInteger(value)) && !(typeof value === "string" && /^-?(0|[1-9]\d*)$/.test(value))) invalid(label, "requires an exact 64-bit integer");
            const number = BigInt(value);
            const unsigned = /^(?:u|fixed)/.test(shape.type);
            if (number < (unsigned ? 0n : -(1n << 63n)) || number >= (unsigned ? 1n << 64n : 1n << 63n)) invalid(label, "integer is out of range");
        } else {
            if (typeof value !== "number" || !Number.isFinite(value)) invalid(label, "requires a finite number");
            if (!/^(double|float|float32|float64|duration)$/.test(shape.type)) {
                const bits = Number(shape.type.match(/\d+$/)?.[0] ?? 32);
                const unsigned = /^(u|fixed)/.test(shape.type);
                if (!Number.isInteger(value) || value < (unsigned ? 0 : -(2 ** (bits - 1))) || value >= 2 ** (unsigned ? bits : bits - 1)) invalid(label, "integer is out of range");
            }
            if (["float", "float32"].includes(shape.type) && !Number.isFinite(Math.fround(value))) invalid(label, "float32 is out of range");
        }
    } else invalid(label, "requires an adapter for this field shape");
}

function validateMapping(route, wireShape, topicShape, resolvedRun) {
    const publish = route.direction === "publish";
    const metadata = { fields: Object.fromEntries(Object.entries(metadataTypes).map(([key, type]) => [key, primitive(type)])) };
    for (const [index, field] of route.mapping.fields.entries()) {
        const label = `protobuf.routes.${route.id}.mapping.fields.${index}`;
        const destination = at(publish ? wireShape : topicShape, field.to, `${label}.to`);
        const converts = field.scale !== undefined || field.offset !== undefined;
        if (converts && !numericTypes.has(destination.type)) invalid(label, "conversion requires a numeric scalar destination");
        if (Object.hasOwn(field, "value")) {
            if (!publish) validateLiteral(field.value, destination, `${label}.value`);
            continue;
        }
        const [root, ...path] = field.from.split(".");
        if (root === "run") {
            const value = runValue(resolvedRun, field.from, `${label}.from`);
            if (converts && (typeof value !== "number" || !Number.isFinite(value))) invalid(label, "conversion requires a numeric source");
            validateLiteral(converts ? value * (field.scale ?? 1) + (field.offset ?? 0) : value, destination, label);
            continue;
        }
        const source = at(root === "metadata" ? metadata : publish ? topicShape : wireShape, path.join("."), `${label}.from`);
        if (!compatible(source, destination) || (converts && !numericTypes.has(source.type))) invalid(label, "source and destination field shapes are incompatible");
    }
}

export function planProtobufRouteAdmission({ manifest, interfaceResource, schemas, adapters = new Map(), resolvedRun = { manifest } }) {
    const config = normalizeProtobufRunConfig(manifest.protobuf);
    if (config.mode === "disabled") {
        if (interfaceResource !== undefined && interfaceResource !== null) invalid("protobufInterface", "disabled runs cannot carry an interface");
        return { schemas: new Map(), topics: new Map(), routes: [] };
    }
    const resource = assertProtobufInterfaceResource(interfaceResource, config.interfaceHash);
    const native = manifest.version === 13;
    if (resource.document.version !== (native ? 2 : 1)) invalid("protobufInterface.version", `run-manifest v${manifest.version} requires interface@${native ? 2 : 1}`);
    schemas ??= native ? {} : schemaClosureForManifest(manifest);
    const loaded = new Map(resource.document.schemas.map((schema) => [schema.id, loadDescriptorSet(base64ToBytes(schema.descriptorBase64), schema.fingerprint)]));
    const topics = new Map();
    for (const topic of manifest.topics ?? []) {
        if (topics.has(topic.id)) invalid("protobuf.topics", `duplicate topic ${topic.id}`);
        topics.set(topic.id, topic);
    }
    const controls = [];
    const subscriptions = new Set();
    const routes = resource.document.routes.map((route) => {
        const type = loaded.get(route.schemaId).root.lookupType(route.messageType);
        const bootstrap = route.source?.bootstrapId;
        const topicId = route.source?.topicId ?? route.target?.topicId;
        const topic = bootstrap ? null : topics.get(topicId);
        if (!bootstrap && !topic) invalid(`protobuf.routes.${route.id}`, `unknown topic id ${topicId}`);
        if (topic && topic.direction !== (route.direction === "publish" ? "output" : "input")) invalid(`protobuf.routes.${route.id}`, "topic direction does not match the route");
        if (route.direction === "subscribe") {
            if (subscriptions.has(topicId)) invalid(`protobuf.routes.${route.id}`, "multiple subscriptions cannot own one local input");
            subscriptions.add(topicId);
            if (isControlsCommandTopic(topic)) controls.push(topic);
        }
        if (native) {
            const admitted = { route, messageType: type, topicContract: topic };
            try { admitted.compiled = compileMapping(admitted, { resolvedRun }); }
            catch (error) { invalid(`protobuf.routes.${route.id}.mapping`, error.message); }
            return admitted;
        }
        const localName = topic?.schema?.type || topic?.type;
        const topicShape = bootstrap ? protobufType(type)
            : localName === "std_msgs/Byte" ? { item: primitive("uint8"), length: null }
            : localName === "std_msgs/ColorRGBA" ? { item: primitive("float32"), length: 4 }
            : localType(STD_ALIASES[localName] ?? localName, schemas);
        if (route.mapping.adapter) {
            const adapter = adapters.get(route.mapping.adapter);
            if (!adapter || adapter.direction !== route.direction || adapter.localType !== localName || adapter.messageType !== route.messageType
                || typeof adapter.validateConfig !== "function") invalid(`protobuf.routes.${route.id}.mapping.adapter`, "adapter contract is unavailable or incompatible");
            adapter.validateConfig(route.mapping.config ?? {});
        } else validateMapping(route, protobufType(type), topicShape, resolvedRun);
        return { route, messageType: type, topicContract: topic };
    });
    if (controls.length && !config.externalController) invalid("protobuf.externalController", "controls subscriptions require explicit external-controller selection");
    if (config.externalController && (controls.length !== 1 || manifest.controls?.authority !== "candidate"
        || controls[0].producer !== "candidate" || controls[0].authority !== "candidate" || controls[0].routeDownstream !== true)) {
        invalid("protobuf.externalController", "requires one candidate controls-command subscription and matching candidate control authority");
    }
    return { schemas: loaded, topics, routes };
}

export function bindProtobufRunKeys(interfaceResource, runId) {
    if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(runId) || [".", ".."].includes(runId)) invalid("protobuf.runId", "requires a safe concrete run identifier");
    const { document } = assertProtobufInterfaceResource(interfaceResource);
    const keys = new Map();
    const owners = new Map();
    for (const route of document.routes) {
        const key = route.key.replaceAll("{run_id}", runId);
        if (owners.has(key)) invalid(`protobuf.routes.${route.id}.key`, `concrete run key collides with ${owners.get(key)}`);
        owners.set(key, route.id);
        keys.set(route.id, key);
    }
    return keys;
}

export function protobufInputContractHash(resolved) {
    if (![12, 13].includes(resolved.version) || resolved.manifest?.protobuf?.mode !== "zenoh") return null;
    const { document } = assertProtobufInterfaceResource(resolved.protobufInterface, resolved.manifest.protobuf.interfaceHash);
    const routes = document.routes.filter((route) => route.direction === "subscribe");
    if (!routes.length) return null;
    const used = new Set(routes.map((route) => route.schemaId));
    const sources = [];
    const collect = (entry) => {
        for (const key of ["from", "offsetFrom", "fromFrame", "toFrame"]) if (entry[key]?.startsWith("run.") && entry[key] !== "run.runId") sources.push(entry[key]);
        if (entry.each) { collect(entry.each); entry.each.fields.forEach(collect); }
    };
    routes.forEach((route) => { route.mapping.fields?.forEach(collect); route.mapping.derived?.forEach(collect); });
    const runValues = Object.fromEntries(sources.map((path) => [path, runValue(resolved, path, "protobuf.inputContract")]));
    const nativeBindings = resolved.version === 13 ? routes.map((route) => {
        const schema = document.schemas.find((schema) => schema.id === route.schemaId);
        const messageType = loadDescriptorSet(base64ToBytes(schema.descriptorBase64), schema.fingerprint).root.lookupType(route.messageType);
        const topicContract = resolved.manifest.topics.find((topic) => topic.id === route.target.topicId);
        return compileMapping({ route, messageType, topicContract }, { resolvedRun: resolved }).bindings;
    }) : null;
    return protobufFingerprint(encoder.encode(canonicalStringify({
        version: resolved.version === 13 ? 2 : 1, externalController: resolved.manifest.protobuf.externalController,
        schemas: document.schemas.filter((schema) => used.has(schema.id)).map(({ id, fingerprint }) => ({ id, fingerprint })),
        routes, runValues,
        ...(nativeBindings ? { nativeContracts: resolved.nativeTopicContracts.hash, bindings: nativeBindings } : {}),
    })));
}

export function assertProtobufExecutionCapabilities(resolved) {
    if ([12, 13].includes(resolved?.version) && normalizeProtobufRunConfig(resolved.manifest?.protobuf).mode === "zenoh") {
        invalid("protobuf.mode", "Zenoh execution is unavailable until the ZPB transport runtime is implemented", "UNSUPPORTED_CAPABILITY");
    }
}
