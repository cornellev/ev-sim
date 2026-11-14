import { HeadlessRunnerError } from "../headless/HeadlessRunnerErrors.js";
import { calculateSharedTensorArenaBytes } from "../headless/SharedTensorTransport.js";
import { planProtobufRouteAdmission, bindProtobufRunKeys } from "../../app/interfaces/ProtobufRunBinding.js";
import { applyMapping, compileMapping } from "../../app/interfaces/ProtobufMapping.js";
import { PROTOBUF_LIMITS } from "../../app/interfaces/ProtobufSchema.js";

export const ZENOH_HOST_CONFIG_KIND = "cev-sim.zenoh-transport-host-config";
export const ZENOH_VERSION = "1.10.2";
export const ZENOH_SHM_OVERHEAD_BYTES = 4 * 1024 * 1024;
const MiB = 1024 * 1024;
const imageBytes = Symbol("image byte length");

function fail(code, message, details = null) { throw new HeadlessRunnerError(code, message, details); }
function keys(value, allowed, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !allowed.includes(key))) fail("INVALID_REQUEST", `${label} contains an unknown field or is not an object.`);
}
function integer(value, fallback, label, maximum = Number.MAX_SAFE_INTEGER) {
    const n = value === undefined ? fallback : value;
    if (!Number.isSafeInteger(n) || n < 1 || n > maximum) fail("INVALID_REQUEST", `${label} must be a positive bounded integer.`);
    return n;
}

export function resolveZenohTransportHostConfig(value) {
    if (value == null) return null;
    keys(value, ["kind", "version", "connect", "shm", "queue", "connectTimeoutMs", "publishTimeoutMs", "closeTimeoutMs"], "zenohTransport");
    if (value.kind !== ZENOH_HOST_CONFIG_KIND || value.version !== 1) fail("INVALID_REQUEST", `zenohTransport requires ${ZENOH_HOST_CONFIG_KIND}@1.`);
    if (!Array.isArray(value.connect) || !value.connect.length || value.connect.length > 16
        || new Set(value.connect).size !== value.connect.length
        || value.connect.some((endpoint) => typeof endpoint !== "string" || endpoint.length > 1024
            || !/^tcp\/(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\]):[1-9]\d{0,4}$/.test(endpoint)
            || Number(endpoint.slice(endpoint.lastIndexOf(":") + 1)) > 65535)) fail("INVALID_REQUEST", "zenohTransport.connect requires 1–16 unique TCP endpoints with valid ports.");
    const shm = value.shm ?? {}, queue = value.queue ?? {};
    keys(shm, ["mode", "thresholdBytes", "poolBytes"], "zenohTransport.shm");
    keys(queue, ["maxEntries", "maxBytes"], "zenohTransport.queue");
    const mode = shm.mode ?? "preferred";
    if (!["disabled", "preferred", "required"].includes(mode)) fail("INVALID_REQUEST", "zenohTransport.shm.mode must be disabled, preferred or required.");
    const thresholdBytes = integer(shm.thresholdBytes, 64 * 1024, "shm.thresholdBytes", PROTOBUF_LIMITS.payloadBytes);
    if (thresholdBytes < 64 * 1024) fail("INVALID_REQUEST", "SHM threshold must be at least 64 KiB to bound SDK metadata allocations.");
    const poolBytes = integer(shm.poolBytes, 64 * MiB, "shm.poolBytes", 128 * MiB);
    if (poolBytes < thresholdBytes) fail("INVALID_REQUEST", "SHM pool must hold at least one threshold-sized payload.");
    return Object.freeze({
        kind: ZENOH_HOST_CONFIG_KIND, version: 1, connect: Object.freeze([...value.connect]),
        shm: Object.freeze({ mode, thresholdBytes, poolBytes }),
        queue: Object.freeze({ maxEntries: integer(queue.maxEntries, 256, "queue.maxEntries", 65536), maxBytes: integer(queue.maxBytes, 16 * MiB, "queue.maxBytes", 128 * MiB) }),
        connectTimeoutMs: integer(value.connectTimeoutMs, 5000, "connectTimeoutMs", 60000),
        publishTimeoutMs: integer(value.publishTimeoutMs, 5000, "publishTimeoutMs", 60000),
        closeTimeoutMs: integer(value.closeTimeoutMs, 5000, "closeTimeoutMs", 60000),
    });
}

function varintBytes(n) { let size = 1; while (n >= 128) { n = Math.floor(n / 128); size++; } return size; }
function pathValue(value, path) { return path.reduce((current, key) => current?.[key], value); }
function assign(value, path, child) {
    if (!path.length) return child;
    let current = value;
    for (const key of path.slice(0, -1)) current = current[key] ??= {};
    current[path.at(-1)] = child;
    return value;
}

// Count bytes without allocating an image. Numeric fields use their maximum wire width.
function messageBytes(type, value) {
    let total = 0;
    function scalarBytes(field, child) {
        if (field.resolvedType?.fields) {
            const size = messageBytes(field.resolvedType, child);
            return varintBytes(size) + size;
        }
        if (field.type === "bytes" || field.type === "string") {
            const size = field.type === "string" ? Buffer.byteLength(child) : child[imageBytes] ?? child.byteLength;
            return varintBytes(size) + size;
        }
        return ({ double: 8, fixed64: 8, sfixed64: 8, float: 4, fixed32: 4, sfixed32: 4, bool: 1,
            uint32: 5, sint32: 5 })[field.type] ?? 10;
    }
    for (const [name, child] of Object.entries(value)) {
        const field = type.fields[name], tag = varintBytes(field.id * 8);
        if (field.map) {
            for (const [key, item] of Object.entries(child)) {
                const size = 1 + scalarBytes({ type: field.keyType }, key) + 1 + scalarBytes(field, item);
                total += tag + varintBytes(size) + size;
            }
        } else if (field.repeated) {
            const size = child.reduce((n, item) => n + scalarBytes(field, item), 0);
            total += field.packed ? (child.length ? tag + varintBytes(size) + size : 0) : size + child.length * tag;
        } else total += tag + scalarBytes(field, child);
    }
    return total;
}

export function estimateZenohImagePublicationBytes(admittedRoute, sensorLayout) {
    const { width, height, pixelFormat } = sensorLayout;
    const pixelBytes = { rgba8: 4, "depth-f32-le": 4, "semantic-u16-le": 2, "instance-u32-le": 4 }[pixelFormat];
    if (!pixelBytes || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
        || !Number.isSafeInteger(width * height * pixelBytes)) fail("INVALID_REQUEST", "Invalid admitted image layout.");
    const compiled = admittedRoute.compiled;
    const image = { data: { [imageBytes]: width * height * pixelBytes }, width, height, pixelFormat, strideBytes: width * pixelBytes };
    const tiny = { data: new Uint8Array(pixelBytes), width: 1, height: 1, pixelFormat, strideBytes: pixelBytes };
    let mapped = applyMapping(compiled, { value: tiny, metadata: { simTimeNs: 0, captureTimeNs: 0, deliveryTimeNs: 0,
        captureStep: 0, actualDeliveryStep: 0, sequenceId: 0, frameId: sensorLayout.frameId ?? "base_link", runId: compiled.run.runId } });
    const derived = {};
    const dynamicValue = (source) => source?.root === "value" ? pathValue(image, source.parts)
        : source?.root === "derived" ? pathValue(derived, source.parts) : undefined;
    for (const entry of compiled.derived) {
        const value = dynamicValue(entry.from);
        if (value !== undefined) derived[entry.id] = value;
    }
    for (const field of compiled.fields) {
        let value = dynamicValue(field.from);
        if (value === undefined) continue;
        if (field.scale !== undefined || field.offset !== undefined) value = value * (field.scale ?? 1) + (field.offset ?? 0);
        mapped = assign(mapped, field.to, value);
    }
    return messageBytes(admittedRoute.messageType, mapped);
}

export function validateZenohTransportAdmission({ resolvedRun, episodeSpec = {}, resourceLimits = {}, capabilities = null,
    runId = resolvedRun?.manifest?.id, config } = {}) {
    const host = resolveZenohTransportHostConfig(config);
    if (!host) fail("UNSUPPORTED_CAPABILITY", "Zenoh requires an explicit host configuration.");
    if (resolvedRun?.version !== 13 || resolvedRun?.manifest?.protobuf?.mode !== "zenoh") fail("UNSUPPORTED_CAPABILITY", "Native Zenoh admission requires an opt-in v13 Zenoh run.");
    const admitted = planProtobufRouteAdmission({ manifest: resolvedRun.manifest, interfaceResource: resolvedRun.protobufInterface, resolvedRun });
    const bound = bindProtobufRunKeys(resolvedRun.protobufInterface, runId);
    const maxQueueBytes = Math.min(host.queue.maxBytes, integer(resourceLimits.maxQueueBytes, 16 * MiB, "resourceLimits.maxQueueBytes"));
    const reservedSharedMemoryBytes = host.shm.mode === "disabled" ? 0 : host.shm.poolBytes + ZENOH_SHM_OVERHEAD_BYTES;
    const tensorArenaBytes = calculateSharedTensorArenaBytes(resolvedRun, episodeSpec);
    const sharedLimit = integer(resourceLimits.maxSharedMemoryBytesPerEnvironment, 128 * MiB, "resourceLimits.maxSharedMemoryBytesPerEnvironment");
    if (tensorArenaBytes + reservedSharedMemoryBytes > sharedLimit) fail("RESOURCE_LIMIT", "Tensor and Zenoh SHM reservations exceed the environment limit.", { tensorArenaBytes, reservedSharedMemoryBytes, limit: sharedLimit });
    const routesById = new Map(), imagePayloadBounds = new Map();
    for (const entry of admitted.routes) {
        entry.compiled = compileMapping(entry, { resolvedRun, runId });
        const routeId = entry.route.id;
        routesById.set(routeId, Object.freeze({ key: bound.get(routeId), direction: entry.route.direction,
            topicId: entry.topicContract?.id ?? null, required: entry.topicContract?.required === true || Boolean(entry.route.source?.bootstrapId)
                || entry.topicContract?.valueContract?.id === "cev.control-command" }));
        if (entry.route.direction !== "publish" || entry.topicContract?.valueContract?.id !== "cev.image") continue;
        const layouts = [];
        for (const sensor of resolvedRun.manifest.sensorRig?.sensors ?? []) {
            if (sensor.enabled === false || sensor.type !== "camera") continue;
            const products = sensor.calibration?.products ?? {};
            for (const [key, product, pixelFormat] of [["imageTopicId", "rgb", "rgba8"], ["depthTopicId", "depth", "depth-f32-le"],
                ["semanticTopicId", "semantic", "semantic-u16-le"], ["instanceTopicId", "instance", "instance-u32-le"]]) {
                if (sensor.outputs?.[key] === entry.topicContract.id && products[product] === true) layouts.push({ ...sensor.calibration, pixelFormat,
                    frameId: sensor.measurementFrameId ?? sensor.frameId ?? resolvedRun.manifest.sensorRig.rootFrameId });
            }
        }
        const maximum = Math.max(0, ...layouts.map((layout) => estimateZenohImagePublicationBytes(entry, layout)));
        if (maximum > PROTOBUF_LIMITS.payloadBytes || maximum > maxQueueBytes || (host.shm.mode !== "disabled"
            && maximum >= host.shm.thresholdBytes && maximum > host.shm.poolBytes)) fail("UNSUPPORTED_CAPABILITY", `Image route ${routeId} exceeds an admitted payload, queue or SHM allocation limit.`, { routeId, maximumEncodedBytes: maximum });
        imagePayloadBounds.set(routeId, maximum);
    }
    if (capabilities) {
        if (capabilities.zenohVersion !== ZENOH_VERSION || capabilities.available !== true) fail("UNSUPPORTED_CAPABILITY", "Pinned native Zenoh addon is unavailable.");
        if (host.shm.mode === "required" && (capabilities.shmProviderAvailable !== true || !capabilities.transports?.length
            || capabilities.transports.some((entry) => entry.shm !== true))) fail("UNSUPPORTED_CAPABILITY", "Required SHM negotiation is unavailable on a direct connection.");
    }
    return { config: host, routesById, imagePayloadBounds, reservedSharedMemoryBytes, tensorArenaBytes, maxQueueBytes };
}
