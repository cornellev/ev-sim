/**
 * VIS-11 transport contract for external intrinsic-material-model@1 outputs.
 * Provider-response outputs remain acknowledgements of captured inputs; these
 * digests and the resulting VIS-10b proposal set own model pixels.
 */

import {
    canonicalExactStringify,
    sha256ExactBytes,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";
import {
    INTRINSIC_CHANNEL_BY_NAME,
    INTRINSIC_PBR_PROPOSED,
    isIntrinsicProposalConstruction,
} from "./BakeConstructionPolicy.js";
import { bakeCaptureUnitId } from "./BakeReuseContracts.js";

export const BAKE_MODEL_OUTPUT_SET_KIND = "cev-sim.bake-model-output-set";
export const BAKE_MODEL_OUTPUT_SET_VERSION = 1;
export const INTRINSIC_MATERIAL_MODEL_PROVIDER = Object.freeze({
    id: "intrinsic-material-model",
    version: 1,
});
export const INTRINSIC_MATERIAL_MODEL_REVISION = "intrinsic-material-model@1";
export const INTRINSIC_MODEL_OUTPUT_CODEC = "intrinsic-model-output@1";
export const FAKE_INTRINSIC_MODEL = Object.freeze({
    id: "cev-sim.fake-intrinsic-material",
    revision: "fake@1",
});
export const FAKE_INTRINSIC_ALGORITHM = Object.freeze({
    id: "intrinsic-channel-estimator",
    revision: "1",
});
export const FAKE_INTRINSIC_WEIGHTS_SEED = "cev-sim.fake-intrinsic-material:fake@1:weights";
export const FAKE_INTRINSIC_WEIGHTS_DIGEST = sha256ExactUtf8(FAKE_INTRINSIC_WEIGHTS_SEED);
export const FAKE_INTRINSIC_RUNTIME_STACK = Object.freeze({
    kind: "fake-intrinsic-material",
    version: 1,
});
export const MODEL_UPLOAD_RIGHTS = Object.freeze([
    "machine-interpretation",
    "derivatives",
    "ml",
    "worker-access",
    "transient-cache",
]);
export const MODEL_REUSE_RIGHTS = Object.freeze([
    ...MODEL_UPLOAD_RIGHTS,
    "persistent-cache",
    "retention",
]);
export const MODEL_OUTPUT_CHANNELS = Object.freeze([
    "base-color",
    "confidence",
    "emissive",
    "known-mask",
    "metalness",
    "normal",
    "occlusion",
    "roughness",
]);
export const MODEL_VALUE_CHANNELS = Object.freeze([
    "base-color",
    "emissive",
    "metalness",
    "normal",
    "occlusion",
    "roughness",
]);
export const INTRINSIC_MATERIAL_NONDETERMINISM_SCOPES = Object.freeze([
    "none",
    "gpu-model-output",
]);
export const INTRINSIC_MATERIAL_PRECISIONS = Object.freeze(["bf16", "fp16", "fp32"]);
export const INTRINSIC_MATERIAL_RESIZE_MODES = Object.freeze(["declared", "identity"]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();
const TOP_LEVEL_KEYS = Object.freeze(["kind", "version", "requestHash", "samples"]);
const SAMPLE_KEYS = Object.freeze([
    "sampleId", "viewId", "width", "height", "sourceDimensions", "effectiveDimensions", "outputs",
]);
const OUTPUT_KEYS = Object.freeze(["channel", "encoding", "components", "byteSize", "sha256"]);
const DIMENSION_KEYS = Object.freeze(["width", "height"]);
const OPTION_KEYS = Object.freeze([
    "model", "weightsDigest", "algorithm", "prompts", "resizePolicy", "inference", "nondeterminismScope",
]);
const REVISION_KEYS = Object.freeze(["id", "revision"]);
const RESIZE_KEYS = Object.freeze(["mode", "width", "height"]);
const INFERENCE_KEYS = Object.freeze(["steps", "guidance", "precision"]);
const CHANNEL_LAYOUTS = Object.freeze({
    "base-color": Object.freeze({
        ...INTRINSIC_CHANNEL_BY_NAME["base-color"],
        arrayType: "Float32Array",
        bytesPerComponent: 4,
    }),
    emissive: Object.freeze({
        ...INTRINSIC_CHANNEL_BY_NAME.emissive,
        arrayType: "Float32Array",
        bytesPerComponent: 4,
    }),
    metalness: Object.freeze({
        ...INTRINSIC_CHANNEL_BY_NAME.metalness,
        arrayType: "Float32Array",
        bytesPerComponent: 4,
    }),
    normal: Object.freeze({
        ...INTRINSIC_CHANNEL_BY_NAME.normal,
        arrayType: "Float32Array",
        bytesPerComponent: 4,
    }),
    occlusion: Object.freeze({
        ...INTRINSIC_CHANNEL_BY_NAME.occlusion,
        arrayType: "Float32Array",
        bytesPerComponent: 4,
    }),
    roughness: Object.freeze({
        ...INTRINSIC_CHANNEL_BY_NAME.roughness,
        arrayType: "Float32Array",
        bytesPerComponent: 4,
    }),
    confidence: Object.freeze({
        name: "confidence",
        encoding: "float32-le-scalar",
        components: 1,
        arrayType: "Float32Array",
        bytesPerComponent: 4,
    }),
    "known-mask": Object.freeze({
        name: "known-mask",
        encoding: "uint8-scalar",
        components: 1,
        arrayType: "Uint8Array",
        bytesPerComponent: 1,
    }),
});

function modelError(message, code = "BAKE_MODEL_OUTPUT_INVALID") {
    const error = new Error(message);
    error.code = code;
    return error;
}

function fail(path, message, code) {
    throw modelError(`${path}: ${message}`, code);
}

function plainObject(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object");
    return value;
}

function allowedKeys(value, allowed, path) {
    const source = plainObject(value, path);
    const unknown = Object.keys(source).find((key) => !allowed.includes(key));
    if (unknown) fail(`${path}.${unknown}`, "unknown field");
    return source;
}

function denseArray(value, path) {
    if (!Array.isArray(value)) fail(path, "expected an array");
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        fail(path, "sparse or extended arrays are outside the JSON data model");
    }
    return value;
}

function compareUtf8(left, right) {
    const a = textEncoder.encode(String(left));
    const b = textEncoder.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function text(value, path, { allowEmpty = false } = {}) {
    if (typeof value !== "string") fail(path, "expected a string");
    if (!allowEmpty && value.length === 0) fail(path, "expected a non-empty string");
    if (value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
    return value;
}

function finite(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
    return Object.is(value, -0) ? 0 : value;
}

function integer(value, path, { min = 0 } = {}) {
    const number = finite(value, path);
    if (!Number.isSafeInteger(number) || number < min) fail(path, `expected a safe integer >= ${min}`);
    return number;
}

function digest(value, path) {
    const result = text(value, path);
    if (!SHA256_PATTERN.test(result)) fail(path, "expected a lowercase SHA-256 digest");
    return result;
}

function freezeDeep(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) {
        for (const entry of value) freezeDeep(entry);
        return Object.freeze(value);
    }
    for (const key of Object.keys(value)) freezeDeep(value[key]);
    return Object.freeze(value);
}

function revisionRecord(value, path) {
    const source = allowedKeys(value, REVISION_KEYS, path);
    return Object.freeze({
        id: text(source.id, `${path}.id`),
        revision: text(source.revision, `${path}.revision`),
    });
}

function dimensionRecord(value, path) {
    const source = allowedKeys(value ?? {}, DIMENSION_KEYS, path);
    return Object.freeze({
        width: integer(source.width, `${path}.width`, { min: 1 }),
        height: integer(source.height, `${path}.height`, { min: 1 }),
    });
}

function channelLayout(channel, path) {
    const layout = CHANNEL_LAYOUTS[channel];
    if (!layout) fail(path, `unsupported model output channel ${channel}`);
    return layout;
}

function expectedByteSize(layout, width, height) {
    return width * height * layout.components * layout.bytesPerComponent;
}

function normalizeOutput(value, width, height, path) {
    const source = allowedKeys(value, OUTPUT_KEYS, path);
    const channel = text(source.channel, `${path}.channel`);
    const layout = channelLayout(channel, `${path}.channel`);
    const encoding = text(source.encoding, `${path}.encoding`);
    if (encoding !== layout.encoding) fail(`${path}.encoding`, `expected ${layout.encoding}`);
    const components = integer(source.components, `${path}.components`, { min: 1 });
    if (components !== layout.components) fail(`${path}.components`, `expected ${layout.components}`);
    const byteSize = integer(source.byteSize, `${path}.byteSize`, { min: 1 });
    if (byteSize !== expectedByteSize(layout, width, height)) {
        fail(`${path}.byteSize`, `expected ${expectedByteSize(layout, width, height)} bytes at source resolution`);
    }
    return Object.freeze({
        channel,
        encoding,
        components,
        byteSize,
        sha256: digest(source.sha256, `${path}.sha256`),
    });
}

function normalizeSample(value, path) {
    const source = allowedKeys(value, SAMPLE_KEYS, path);
    const sourceDimensions = dimensionRecord(source.sourceDimensions, `${path}.sourceDimensions`);
    const effectiveDimensions = dimensionRecord(source.effectiveDimensions, `${path}.effectiveDimensions`);
    const width = integer(source.width, `${path}.width`, { min: 1 });
    const height = integer(source.height, `${path}.height`, { min: 1 });
    if (width !== sourceDimensions.width || height !== sourceDimensions.height) {
        fail(path, "sample width/height must equal sourceDimensions after restore");
    }
    const outputs = denseArray(source.outputs ?? [], `${path}.outputs`)
        .map((entry, index) => normalizeOutput(entry, width, height, `${path}.outputs.${index}`))
        .sort((left, right) => compareUtf8(left.channel, right.channel));
    if (outputs.length !== MODEL_OUTPUT_CHANNELS.length) {
        fail(`${path}.outputs`, "expected the eight VIS-11 model output buffers");
    }
    const channels = outputs.map((entry) => entry.channel);
    if (channels.some((channel, index) => channel !== MODEL_OUTPUT_CHANNELS[index])) {
        fail(`${path}.outputs`, "expected canonical channel coverage and order");
    }
    return Object.freeze({
        sampleId: text(source.sampleId, `${path}.sampleId`),
        viewId: text(source.viewId, `${path}.viewId`),
        width,
        height,
        sourceDimensions,
        effectiveDimensions,
        outputs: Object.freeze(outputs),
    });
}

export function normalizeBakeModelOutputSet(value = {}) {
    const source = allowedKeys(value, TOP_LEVEL_KEYS, "modelOutputSet");
    if (source.kind !== BAKE_MODEL_OUTPUT_SET_KIND) {
        fail("modelOutputSet.kind", `expected ${BAKE_MODEL_OUTPUT_SET_KIND}`);
    }
    if (source.version !== BAKE_MODEL_OUTPUT_SET_VERSION) {
        fail("modelOutputSet.version", "unsupported bake-model-output-set version");
    }
    const samples = denseArray(source.samples ?? [], "modelOutputSet.samples")
        .map((entry, index) => normalizeSample(entry, `modelOutputSet.samples.${index}`))
        .sort((left, right) => compareUtf8(
            `${left.sampleId}:${left.viewId}`,
            `${right.sampleId}:${right.viewId}`,
        ));
    const keys = samples.map((entry) => `${entry.sampleId}:${entry.viewId}`);
    if (new Set(keys).size !== keys.length) fail("modelOutputSet.samples", "contains duplicate sample/view pairs");
    return Object.freeze({
        kind: BAKE_MODEL_OUTPUT_SET_KIND,
        version: BAKE_MODEL_OUTPUT_SET_VERSION,
        requestHash: digest(source.requestHash, "modelOutputSet.requestHash"),
        samples: Object.freeze(samples),
    });
}

export function assertBakeModelOutputSet(value) {
    const normalized = normalizeBakeModelOutputSet(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("modelOutputSet", "document is not in canonical normalized form");
    }
    return value;
}

export function hashBakeModelOutputSet(value) {
    return sha256ExactUtf8(canonicalExactStringify(normalizeBakeModelOutputSet(value)));
}

export function modelOutputBufferKey(sampleId, viewId, channel) {
    return `${sampleId}:${viewId}:${channel}`;
}

export function channelFromModelBufferKey(key) {
    const matches = MODEL_OUTPUT_CHANNELS.filter((channel) => key.endsWith(`:${channel}`));
    if (matches.length === 0) fail("modelBuffers", `cannot parse channel from ${key}`);
    return matches.sort((left, right) => right.length - left.length)[0];
}

export function isIntrinsicMaterialModelProvider(provider) {
    return provider?.id === INTRINSIC_MATERIAL_MODEL_PROVIDER.id
        && Number(provider.version) === INTRINSIC_MATERIAL_MODEL_PROVIDER.version;
}

export function normalizeIntrinsicMaterialOptions(value = {}) {
    const source = allowedKeys(value, OPTION_KEYS, "providerOptions");
    const resizeSource = allowedKeys(source.resizePolicy ?? { mode: "identity" }, RESIZE_KEYS, "providerOptions.resizePolicy");
    const mode = text(resizeSource.mode ?? "identity", "providerOptions.resizePolicy.mode");
    if (!INTRINSIC_MATERIAL_RESIZE_MODES.includes(mode)) {
        fail("providerOptions.resizePolicy.mode", "expected identity | declared");
    }
    if (mode === "identity") {
        if (resizeSource.width != null || resizeSource.height != null) {
            fail("providerOptions.resizePolicy", "identity resize cannot declare dimensions");
        }
    }
    const inferenceSource = allowedKeys(source.inference ?? {}, INFERENCE_KEYS, "providerOptions.inference");
    const precision = text(inferenceSource.precision ?? "fp32", "providerOptions.inference.precision");
    if (!INTRINSIC_MATERIAL_PRECISIONS.includes(precision)) {
        fail("providerOptions.inference.precision", "expected fp32 | fp16 | bf16");
    }
    const nondeterminismScope = text(
        source.nondeterminismScope ?? "none",
        "providerOptions.nondeterminismScope",
    );
    if (!INTRINSIC_MATERIAL_NONDETERMINISM_SCOPES.includes(nondeterminismScope)) {
        fail("providerOptions.nondeterminismScope", "expected none | gpu-model-output");
    }
    if (source.model == null || source.weightsDigest == null || source.algorithm == null) {
        fail(
            "providerOptions",
            "intrinsic-material-model@1 requires pinned model, algorithm, and weightsDigest",
            "BAKE_PROVIDER_CAPABILITY_MISMATCH",
        );
    }
    if (inferenceSource.steps == null) fail("providerOptions.inference.steps", "required");
    const prompts = source.prompts == null ? null : freezeDeep((() => {
        const promptSource = plainObject(source.prompts, "providerOptions.prompts");
        const normalized = {};
        for (const key of Object.keys(promptSource).sort(compareUtf8)) {
            normalized[key] = text(promptSource[key], `providerOptions.prompts.${key}`, { allowEmpty: true });
        }
        return normalized;
    })());
    const resizePolicy = mode === "identity"
        ? Object.freeze({ mode: "identity" })
        : Object.freeze({
            mode: "declared",
            width: integer(resizeSource.width, "providerOptions.resizePolicy.width", { min: 1 }),
            height: integer(resizeSource.height, "providerOptions.resizePolicy.height", { min: 1 }),
        });
    return Object.freeze({
        model: revisionRecord(source.model, "providerOptions.model"),
        weightsDigest: digest(source.weightsDigest, "providerOptions.weightsDigest"),
        algorithm: revisionRecord(source.algorithm, "providerOptions.algorithm"),
        prompts,
        resizePolicy,
        inference: Object.freeze({
            steps: integer(inferenceSource.steps, "providerOptions.inference.steps", { min: 1 }),
            guidance: finite(inferenceSource.guidance ?? 0, "providerOptions.inference.guidance"),
            precision,
        }),
        nondeterminismScope,
    });
}

export const FAKE_INTRINSIC_MATERIAL_OPTIONS = Object.freeze(normalizeIntrinsicMaterialOptions({
    model: { ...FAKE_INTRINSIC_MODEL },
    weightsDigest: FAKE_INTRINSIC_WEIGHTS_DIGEST,
    algorithm: { ...FAKE_INTRINSIC_ALGORITHM },
    prompts: null,
    resizePolicy: { mode: "identity" },
    inference: { steps: 1, guidance: 0, precision: "fp32" },
    nondeterminismScope: "none",
}));

export function float32LittleEndianBytes(values) {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < values.length; index += 1) view.setFloat32(index * 4, values[index], true);
    return bytes;
}

export function digestModelBuffer(channel, data) {
    const layout = channelLayout(channel, "channel");
    if (layout.arrayType === "Uint8Array") {
        if (!(data instanceof Uint8Array)) fail(channel, "expected Uint8Array");
        return sha256ExactBytes(data);
    }
    if (!(data instanceof Float32Array)) fail(channel, "expected Float32Array");
    return sha256ExactBytes(float32LittleEndianBytes(data));
}

export function commonSourceDimensions(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
        fail("request.inputs", "at least one captured input is required");
    }
    const first = inputs[0];
    const width = integer(first.width, "request.inputs.0.width", { min: 1 });
    const height = integer(first.height, "request.inputs.0.height", { min: 1 });
    for (const [index, entry] of inputs.entries()) {
        if (entry.width !== width || entry.height !== height) {
            fail(`request.inputs.${index}`, "adapter v1 requires a common source resolution");
        }
    }
    return Object.freeze({ width, height });
}

export function effectiveDimensionsForOptions(sourceDimensions, resizePolicy) {
    if ((resizePolicy?.mode ?? "identity") === "identity") {
        return { width: sourceDimensions.width, height: sourceDimensions.height };
    }
    return {
        width: integer(resizePolicy.width, "resizePolicy.width", { min: 1 }),
        height: integer(resizePolicy.height, "resizePolicy.height", { min: 1 }),
    };
}

export function nearestResizeUint8(source, sourceWidth, sourceHeight, destWidth, destHeight, channels) {
    if (sourceWidth === destWidth && sourceHeight === destHeight) return new Uint8Array(source);
    const dest = new Uint8Array(destWidth * destHeight * channels);
    for (let y = 0; y < destHeight; y += 1) {
        const sourceY = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / destHeight));
        for (let x = 0; x < destWidth; x += 1) {
            const sourceX = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / destWidth));
            const sourceIndex = (sourceY * sourceWidth + sourceX) * channels;
            const destIndex = (y * destWidth + x) * channels;
            for (let channel = 0; channel < channels; channel += 1) {
                dest[destIndex + channel] = source[sourceIndex + channel];
            }
        }
    }
    return dest;
}

export function nearestResizeFloat32(source, sourceWidth, sourceHeight, destWidth, destHeight, channels) {
    if (sourceWidth === destWidth && sourceHeight === destHeight) return new Float32Array(source);
    const dest = new Float32Array(destWidth * destHeight * channels);
    for (let y = 0; y < destHeight; y += 1) {
        const sourceY = Math.min(sourceHeight - 1, Math.floor((y * sourceHeight) / destHeight));
        for (let x = 0; x < destWidth; x += 1) {
            const sourceX = Math.min(sourceWidth - 1, Math.floor((x * sourceWidth) / destWidth));
            const sourceIndex = (sourceY * sourceWidth + sourceX) * channels;
            const destIndex = (y * destWidth + x) * channels;
            for (let channel = 0; channel < channels; channel += 1) {
                dest[destIndex + channel] = source[sourceIndex + channel];
            }
        }
    }
    return dest;
}

function pixelKnown(validity, index) {
    return validity?.[index] ? 1 : 0;
}

export function inferFakeIntrinsicChannels({
    beauty,
    validity,
    width,
    height,
    seed = 0,
} = {}) {
    const pixels = width * height;
    if (!(beauty instanceof Uint8Array) || beauty.length !== pixels * 4) {
        fail("beauty", "expected RGBA8 buffer at source resolution");
    }
    if (!(validity instanceof Uint8Array) || validity.length !== pixels) {
        fail("validity", "expected uint8 validity buffer at source resolution");
    }
    const baseColor = new Float32Array(pixels * 3);
    const normal = new Float32Array(pixels * 3);
    const roughness = new Float32Array(pixels);
    const metalness = new Float32Array(pixels);
    const emissive = new Float32Array(pixels * 3);
    const occlusion = new Float32Array(pixels);
    const confidence = new Float32Array(pixels);
    const knownMask = new Uint8Array(pixels);
    const seedInt = Number.isSafeInteger(seed) ? seed : 0;
    for (let pixel = 0; pixel < pixels; pixel += 1) {
        const known = pixelKnown(validity, pixel);
        knownMask[pixel] = known;
        if (!known) continue;
        const red = beauty[pixel * 4] / 255;
        const green = beauty[pixel * 4 + 1] / 255;
        const blue = beauty[pixel * 4 + 2] / 255;
        baseColor[pixel * 3] = red;
        baseColor[pixel * 3 + 1] = green;
        baseColor[pixel * 3 + 2] = blue;
        normal[pixel * 3] = 0;
        normal[pixel * 3 + 1] = 0;
        normal[pixel * 3 + 2] = 1;
        roughness[pixel] = ((seedInt + pixel) % 251) / 250;
        metalness[pixel] = blue * 0.25;
        occlusion[pixel] = 1;
        confidence[pixel] = 1;
    }
    return {
        "base-color": baseColor,
        normal,
        roughness,
        metalness,
        emissive,
        occlusion,
        confidence,
        "known-mask": knownMask,
    };
}

export function restoreFakeIntrinsicChannels(channels, sourceDimensions, effectiveDimensions) {
    if (
        sourceDimensions.width === effectiveDimensions.width
        && sourceDimensions.height === effectiveDimensions.height
    ) {
        return channels;
    }
    const restored = {};
    for (const channel of MODEL_VALUE_CHANNELS) {
        const layout = CHANNEL_LAYOUTS[channel];
        restored[channel] = nearestResizeFloat32(
            channels[channel],
            effectiveDimensions.width,
            effectiveDimensions.height,
            sourceDimensions.width,
            sourceDimensions.height,
            layout.components,
        );
    }
    restored.confidence = nearestResizeFloat32(
        channels.confidence,
        effectiveDimensions.width,
        effectiveDimensions.height,
        sourceDimensions.width,
        sourceDimensions.height,
        1,
    );
    restored["known-mask"] = nearestResizeUint8(
        channels["known-mask"],
        effectiveDimensions.width,
        effectiveDimensions.height,
        sourceDimensions.width,
        sourceDimensions.height,
        1,
    );
    return restored;
}

export function runFakeIntrinsicInference({
    beauty,
    validity,
    sourceDimensions,
    resizePolicy,
    seed = 0,
} = {}) {
    const effective = effectiveDimensionsForOptions(sourceDimensions, resizePolicy);
    const workingBeauty = nearestResizeUint8(
        beauty,
        sourceDimensions.width,
        sourceDimensions.height,
        effective.width,
        effective.height,
        4,
    );
    const workingValidity = nearestResizeUint8(
        validity,
        sourceDimensions.width,
        sourceDimensions.height,
        effective.width,
        effective.height,
        1,
    );
    const inferred = inferFakeIntrinsicChannels({
        beauty: workingBeauty,
        validity: workingValidity,
        width: effective.width,
        height: effective.height,
        seed,
    });
    return {
        channels: restoreFakeIntrinsicChannels(inferred, sourceDimensions, effective),
        sourceDimensions,
        effectiveDimensions: effective,
    };
}

export function digestRecordForChannel(sampleId, viewId, channel, data, width, height) {
    const layout = channelLayout(channel, "channel");
    const bytes = layout.arrayType === "Uint8Array" ? data : float32LittleEndianBytes(data);
    if (bytes.byteLength !== expectedByteSize(layout, width, height)) {
        fail(channel, "buffer byte size does not match source resolution");
    }
    return Object.freeze({
        channel,
        encoding: layout.encoding,
        components: layout.components,
        byteSize: bytes.byteLength,
        sha256: sha256ExactBytes(layout.arrayType === "Uint8Array" ? data : float32LittleEndianBytes(data)),
    });
}

export function buildBakeModelOutputSet({ requestHash, samples }) {
    return normalizeBakeModelOutputSet({
        kind: BAKE_MODEL_OUTPUT_SET_KIND,
        version: BAKE_MODEL_OUTPUT_SET_VERSION,
        requestHash,
        samples,
    });
}

export function createFakeCapability({
    maxWidth = 4096,
    maxHeight = 4096,
    maxUploadBytes = 32 * 1024 * 1024,
    maxQueueJobs = 4,
    maxStorageBytes = 256 * 1024 * 1024,
    maxProcessingMs = 300000,
    workerPoolSize = 1,
} = {}) {
    return freezeDeep({
        kind: "cev-sim.bake-model-capability",
        version: 1,
        provider: { ...INTRINSIC_MATERIAL_MODEL_PROVIDER },
        model: { ...FAKE_INTRINSIC_MODEL },
        weightsDigest: FAKE_INTRINSIC_WEIGHTS_DIGEST,
        algorithm: { ...FAKE_INTRINSIC_ALGORITHM },
        requiredChannels: [...MODEL_VALUE_CHANNELS],
        constructionModes: [INTRINSIC_PBR_PROPOSED],
        maxWidth,
        maxHeight,
        maxUploadBytes,
        maxQueueJobs,
        maxStorageBytes,
        maxProcessingMs,
        workerPoolSize,
        cacheModes: Object.freeze(["none", "reuse-request"]),
        nondeterminismScope: "none",
        runtimeStack: { ...FAKE_INTRINSIC_RUNTIME_STACK },
        codecRevision: INTRINSIC_MODEL_OUTPUT_CODEC,
    });
}

export function assertIntrinsicModelSelection({ config, capability = null } = {}) {
    const provider = config?.provider;
    if (!isIntrinsicMaterialModelProvider(provider)) {
        fail("provider", "expected intrinsic-material-model@1", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
    }
    const construction = config?.construction;
    if (!isIntrinsicProposalConstruction(construction) || construction.appearanceMode !== INTRINSIC_PBR_PROPOSED) {
        fail(
            "construction",
            "intrinsic-material-model@1 requires bake-construction@2 intrinsic-pbr-proposed",
            "BAKE_PROVIDER_CAPABILITY_MISMATCH",
        );
    }
    const names = new Set((construction.intrinsicChannels ?? []).map((entry) => entry.name));
    for (const channel of MODEL_VALUE_CHANNELS) {
        if (!names.has(channel)) {
            fail("construction.intrinsicChannels", `missing required ${channel}`, "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
    }
    const views = config?.views ?? [];
    if (views.length === 0) fail("views", "at least one view is required", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
    const width = views[0].camera.width;
    const height = views[0].camera.height;
    for (const view of views) {
        if (view.camera.width !== width || view.camera.height !== height) {
            fail("views", "adapter v1 requires a common source resolution", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
    }
    const options = normalizeIntrinsicMaterialOptions(config.providerOptions);
    if (capability) {
        if (capability.provider?.id !== provider.id || capability.provider?.version !== provider.version) {
            fail("capability.provider", "service provider identity does not match", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if (capability.model?.id !== options.model.id || capability.model?.revision !== options.model.revision) {
            fail("capability.model", "service model identity does not match", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if (capability.weightsDigest !== options.weightsDigest) {
            fail("capability.weightsDigest", "service weights digest does not match", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if (capability.algorithm?.id !== options.algorithm.id || capability.algorithm?.revision !== options.algorithm.revision) {
            fail("capability.algorithm", "service algorithm revision does not match", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if (!(capability.constructionModes ?? []).includes(construction.appearanceMode)) {
            fail("capability.constructionModes", "service does not support the selected construction", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if (width > (capability.maxWidth ?? width) || height > (capability.maxHeight ?? height)) {
            fail("views", "source dimensions exceed service limits", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        const operational = config.operational?.roundTrip ?? {};
        if (operational.maxUploadBytes != null && capability.maxUploadBytes < operational.maxUploadBytes) {
            fail("operational.roundTrip.maxUploadBytes", "configured upload limit exceeds the service", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if (operational.maxQueueJobs != null && capability.maxQueueJobs < operational.maxQueueJobs) {
            fail("operational.roundTrip.maxQueueJobs", "configured queue limit exceeds the service", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if (operational.maxStorageBytes != null && capability.maxStorageBytes < operational.maxStorageBytes) {
            fail("operational.roundTrip.maxStorageBytes", "configured storage limit exceeds the service", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if (operational.maxProcessingMs != null && capability.maxProcessingMs < operational.maxProcessingMs) {
            fail("operational.roundTrip.maxProcessingMs", "configured processing limit exceeds the service", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
        if ((capability.cacheModes ?? []).includes("reuse-request") === false && config.cachePolicy?.mode === "reuse-request") {
            fail("cachePolicy.mode", "service does not support reuse-request", "BAKE_PROVIDER_CAPABILITY_MISMATCH");
        }
    }
    return { options, width, height };
}

export function modelRightsForCachePolicy(cachePolicy) {
    return cachePolicy?.mode === "reuse-request" ? [...MODEL_REUSE_RIGHTS] : [...MODEL_UPLOAD_RIGHTS];
}

export function lookupCaptureBuffer(buffers, sampleId, viewId, role) {
    if (!buffers) return undefined;
    const key = `${sampleId}:${viewId}:${role}`;
    if (buffers instanceof Map) return buffers.get(key);
    return buffers[key];
}

export function buildProposalArtifactsFromModelOutput({
    job,
    modelOutputSet,
    buffers,
    options,
    sourceUseHashes = [],
    response,
} = {}) {
    const normalized = normalizeBakeModelOutputSet(modelOutputSet);
    if (normalized.requestHash !== job.requestHash) {
        fail("modelOutputSet.requestHash", "does not match the bake request", "BAKE_MODEL_OUTPUT_INVALID");
    }
    const samples = job.plan?.samples ?? [];
    if (normalized.samples.length !== samples.length) {
        fail("modelOutputSet.samples", "must cover every capture unit exactly once");
    }
    const byKey = new Map(normalized.samples.map((entry) => [`${entry.sampleId}:${entry.viewId}`, entry]));
    const sourceId = INTRINSIC_MATERIAL_MODEL_REVISION;
    const source = Object.freeze({
        id: sourceId,
        type: "inferred",
        algorithm: {
            id: options.algorithm.id,
            revision: response?.configuration?.algorithmRevision ?? options.algorithm.revision,
        },
        provider: {
            id: INTRINSIC_MATERIAL_MODEL_PROVIDER.id,
            revision: response?.providerRevision ?? INTRINSIC_MATERIAL_MODEL_REVISION,
        },
        model: {
            id: options.model.id,
            revision: response?.modelRevision ?? options.model.revision,
        },
        weightsDigest: response?.weightsDigest ?? options.weightsDigest,
        nondeterminismScope: response?.nondeterminismScope ?? options.nondeterminismScope,
        sourceUseHashes: [...sourceUseHashes].sort(compareUtf8),
    });
    const proposalBuffers = new Map();
    const units = samples.map((sample) => {
        const key = `${sample.sampleId}:${sample.viewId}`;
        const modelSample = byKey.get(key);
        if (!modelSample) fail("modelOutputSet.samples", `missing ${key}`);
        const view = job.config.views.find((entry) => entry.id === sample.viewId);
        if (modelSample.width !== view.camera.width || modelSample.height !== view.camera.height) {
            fail(`modelOutputSet.samples.${key}`, "dimensions do not match the bake camera");
        }
        const unitId = bakeCaptureUnitId(sample.pathId, sample.sampleIndex, sample.viewId);
        const confidenceRecord = modelSample.outputs.find((entry) => entry.channel === "confidence");
        const maskRecord = modelSample.outputs.find((entry) => entry.channel === "known-mask");
        const confidence = lookupModelBuffer(buffers, sample.sampleId, sample.viewId, "confidence");
        const knownMask = lookupModelBuffer(buffers, sample.sampleId, sample.viewId, "known-mask");
        if (!(confidence instanceof Float32Array) || !(knownMask instanceof Uint8Array)) {
            fail(key, "missing confidence or known-mask buffer", "BAKE_MODEL_INCOMPLETE");
        }
        if (digestModelBuffer("confidence", confidence) !== confidenceRecord.sha256) {
            fail(`${key}/confidence`, "buffer digest mismatch", "BAKE_TRANSFER_DIGEST_MISMATCH");
        }
        if (digestModelBuffer("known-mask", knownMask) !== maskRecord.sha256) {
            fail(`${key}/known-mask`, "buffer digest mismatch", "BAKE_TRANSFER_DIGEST_MISMATCH");
        }
        const outputs = MODEL_VALUE_CHANNELS.map((channel) => {
            const record = modelSample.outputs.find((entry) => entry.channel === channel);
            const values = lookupModelBuffer(buffers, sample.sampleId, sample.viewId, channel);
            if (!(values instanceof Float32Array)) fail(`${key}/${channel}`, "missing values buffer", "BAKE_MODEL_INCOMPLETE");
            if (digestModelBuffer(channel, values) !== record.sha256) {
                fail(`${key}/${channel}`, "buffer digest mismatch", "BAKE_TRANSFER_DIGEST_MISMATCH");
            }
            proposalBuffers.set(proposalBufferKey(unitId, sourceId, channel, "values"), values);
            proposalBuffers.set(proposalBufferKey(unitId, sourceId, channel, "confidence"), confidence);
            proposalBuffers.set(proposalBufferKey(unitId, sourceId, channel, "knownMask"), knownMask);
            const layout = INTRINSIC_CHANNEL_BY_NAME[channel];
            return {
                sourceId,
                channel,
                values: {
                    encoding: layout.encoding,
                    components: layout.components,
                    byteSize: values.byteLength,
                    sha256: record.sha256,
                },
                confidence: {
                    encoding: "float32-le-scalar",
                    components: 1,
                    byteSize: confidence.byteLength,
                    sha256: confidenceRecord.sha256,
                },
                knownMask: {
                    encoding: "uint8-scalar",
                    components: 1,
                    byteSize: knownMask.byteLength,
                    sha256: maskRecord.sha256,
                },
            };
        });
        return {
            unitId,
            sampleId: sample.sampleId,
            viewId: sample.viewId,
            width: modelSample.width,
            height: modelSample.height,
            outputs,
        };
    });
    const proposalSet = {
        kind: "cev-sim.bake-material-proposal-set",
        version: 1,
        recipeHash: job.recipeHash,
        snapshotHash: job.snapshotHash,
        planHash: job.planHash,
        requestHash: job.requestHash,
        responseHash: job.responseHash,
        sources: [source],
        units,
    };
    return { proposalSet, buffers: proposalBuffers };
}

function proposalBufferKey(unitId, sourceId, channel, role) {
    return `${unitId}\0${sourceId}\0${channel}\0${role}`;
}

function lookupModelBuffer(buffers, sampleId, viewId, channel) {
    const key = modelOutputBufferKey(sampleId, viewId, channel);
    if (buffers instanceof Map) return buffers.get(key);
    return buffers?.[key];
}
