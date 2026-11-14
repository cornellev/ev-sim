import { isControlsCommandTopic } from "../simulation/NativeTopicCatalog.js";
import { canonicalStringify } from "../simulation/canonicalJson.js";
import { normalizeProtobufInterface } from "./ProtobufInterface.js";
import { assertProtobufName, base64ToBytes, loadDescriptorSet, protobufFingerprint } from "./ProtobufSchema.js";
import { compileMapping } from "./ProtobufMapping.js";

const SHA256 = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();


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

export function planProtobufRouteAdmission({ manifest, interfaceResource, resolvedRun = { manifest } }) {
    if (manifest.version !== 13) invalid("version", "Historical runs require inspected native adoption", "UNSUPPORTED_CAPABILITY");
    const config = normalizeProtobufRunConfig(manifest.protobuf);
    if (config.mode === "disabled") {
        if (interfaceResource !== undefined && interfaceResource !== null) invalid("protobufInterface", "disabled runs cannot carry an interface");
        return { schemas: new Map(), topics: new Map(), routes: [] };
    }
    const resource = assertProtobufInterfaceResource(interfaceResource, config.interfaceHash);
    if (resource.document.version !== 2) invalid("protobufInterface.version", "run-manifest v13 requires interface@2");
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
        const admitted = { route, messageType: type, topicContract: topic };
        try { admitted.compiled = compileMapping(admitted, { resolvedRun }); }
        catch (error) { invalid(`protobuf.routes.${route.id}.mapping`, error.message); }
        return admitted;
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
        for (const key of ["from", "equalsFrom", "offsetFrom", "fromFrame", "toFrame"]) if (entry[key]?.startsWith("run.") && entry[key] !== "run.runId") sources.push(entry[key]);
        if (entry.each) { collect(entry.each); entry.each.fields.forEach(collect); }
    };
    routes.forEach((route) => { route.mapping.fields?.forEach(collect); route.mapping.derived?.forEach(collect); route.mapping.metadata?.forEach(collect); route.mapping.checks?.forEach(collect); });
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

export function assertProtobufExecutionCapabilities(resolved, { target = "headless", transport = null, controlOwnership } = {}) {
    const config = normalizeProtobufRunConfig(resolved?.manifest?.protobuf);
    if (resolved?.version === 13) {
        const bindings = resolved.bindings?.entries ?? resolved.manifest.scripts?.embeddedBindings ?? [];
        if (controlOwnership === false && resolved.manifest.topics.some((topic) => topic.direction === "input" && topic.valueContract?.id === "cev.control-command" && topic.valueContract.version === 2)) invalid("controls", "Control-command@2 requires an installed ownership guard", "UNSUPPORTED_CAPABILITY");
        if (resolved.manifest.scenario && resolved.scenario?.scenario?.version !== 2) invalid("scenario", "Native runs require a reviewed scenario v2", "UNSUPPORTED_CAPABILITY");
        for (const binding of bindings) {
            if ((binding.inputs ?? []).some((input) => !["constant", "sim", "signal", "message", "message-metadata"].includes(input.source))) invalid(`bindings.${binding.id}`, "Unsupported native input source", "UNSUPPORTED_CAPABILITY");
            for (const output of binding.outputs ?? []) if (output.sink === "publish") {
                const topic = resolved.manifest.topics.find((topic) => topic.id === output.topic || topic.name === output.topic);
                if (topic?.direction !== "output" || output.type || output.valueContract?.id !== topic.valueContract?.id || output.valueContract?.version !== topic.valueContract?.version) invalid(`bindings.${binding.id}`, "Native publication requires the declared output valueContract", "UNSUPPORTED_CAPABILITY");
            }
        }
        if (config.mode !== "zenoh" || (target === "browser" && transport === "zenoh-browser") || (target === "headless" && transport === "zenoh-native")) return;
    }
    if (config.mode === "zenoh") invalid("protobuf.mode", "Zenoh execution requires a native run and its configured transport", "UNSUPPORTED_CAPABILITY");
}
