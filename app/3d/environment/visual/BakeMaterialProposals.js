/**
 * VIS-10b material proposal evidence. VIS-11 may generate inferred proposal
 * buffers from `intrinsic-material-model@1`; caller-supplied and model-generated
 * proposal sets remain mutually exclusive.
 */

import {
    canonicalExactStringify,
    sha256ExactBytes,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";
import {
    INTRINSIC_CHANNEL_BY_NAME,
    MATERIAL_PROPOSAL_ORIGINS,
    isIntrinsicProposalConstruction,
} from "./BakeConstructionPolicy.js";
import { bakeCaptureUnitId } from "./BakeReuseContracts.js";

export const BAKE_MATERIAL_PROPOSAL_SET_KIND = "cev-sim.bake-material-proposal-set";
export const BAKE_MATERIAL_PROPOSAL_SET_VERSION = 1;
export const PROPOSAL_CONFIDENCE_ENCODING = "float32-le-scalar";
export const PROPOSAL_KNOWN_MASK_ENCODING = "uint8-scalar";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();
const TOP_LEVEL_KEYS = Object.freeze([
    "kind", "version", "recipeHash", "snapshotHash", "planHash", "requestHash",
    "responseHash", "sources", "units",
]);
const SOURCE_KEYS = Object.freeze([
    "id", "type", "algorithm", "provider", "model", "weightsDigest",
    "nondeterminismScope", "sourceUseHashes",
]);
const REVISION_KEYS = Object.freeze(["id", "revision"]);
const UNIT_KEYS = Object.freeze(["unitId", "sampleId", "viewId", "width", "height", "outputs"]);
const OUTPUT_KEYS = Object.freeze(["sourceId", "channel", "values", "confidence", "knownMask"]);
const DIGEST_KEYS = Object.freeze(["encoding", "components", "byteSize", "sha256"]);

function proposalError(message, code = "BAKE_MATERIAL_PROPOSAL_INVALID") {
    const error = new Error(message);
    error.code = code;
    return error;
}

function fail(path, message, code) {
    throw proposalError(`${path}: ${message}`, code);
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

function text(value, path) {
    if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
    if (value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
    return value;
}

function digest(value, path, { nullable = false } = {}) {
    if (nullable && value == null) return null;
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(path, "expected a lowercase SHA-256 digest");
    return value;
}

function integer(value, path, { min = 0 } = {}) {
    if (!Number.isSafeInteger(value) || value < min) fail(path, `expected a safe integer >= ${min}`);
    return value;
}

function revisionRecord(value, path, { nullable = false } = {}) {
    if (nullable && value == null) return null;
    const source = allowedKeys(value, REVISION_KEYS, path);
    return Object.freeze({
        id: text(source.id, `${path}.id`),
        revision: text(source.revision, `${path}.revision`),
    });
}

function normalizeSource(value, path) {
    const source = allowedKeys(value, SOURCE_KEYS, path);
    const type = text(source.type, `${path}.type`);
    if (!MATERIAL_PROPOSAL_ORIGINS.includes(type)) fail(`${path}.type`, "expected supplied | inferred");
    const provider = revisionRecord(source.provider ?? null, `${path}.provider`, { nullable: true });
    const model = revisionRecord(source.model ?? null, `${path}.model`, { nullable: true });
    const weightsDigest = digest(source.weightsDigest ?? null, `${path}.weightsDigest`, { nullable: true });
    if (type === "inferred" && (!provider || !model || !weightsDigest)) {
        fail(path, "inferred sources require provider, model, and weightsDigest provenance");
    }
    if (type === "supplied" && (model || weightsDigest)) {
        fail(path, "supplied sources cannot claim model or weights provenance");
    }
    const sourceUseHashes = denseArray(source.sourceUseHashes ?? [], `${path}.sourceUseHashes`)
        .map((entry, index) => digest(entry, `${path}.sourceUseHashes.${index}`))
        .sort(compareUtf8);
    if (new Set(sourceUseHashes).size !== sourceUseHashes.length) {
        fail(`${path}.sourceUseHashes`, "contains duplicate digests");
    }
    return Object.freeze({
        id: text(source.id, `${path}.id`),
        type,
        algorithm: revisionRecord(source.algorithm, `${path}.algorithm`),
        provider,
        model,
        weightsDigest,
        nondeterminismScope: text(source.nondeterminismScope, `${path}.nondeterminismScope`),
        sourceUseHashes: Object.freeze(sourceUseHashes),
    });
}

function normalizeOutputDigest(value, expected, path) {
    const source = allowedKeys(value, DIGEST_KEYS, path);
    const encoding = text(source.encoding, `${path}.encoding`);
    if (encoding !== expected.encoding) fail(`${path}.encoding`, `expected ${expected.encoding}`);
    const components = integer(source.components, `${path}.components`, { min: 1 });
    if (components !== expected.components) fail(`${path}.components`, `expected ${expected.components}`);
    const byteSize = integer(source.byteSize, `${path}.byteSize`);
    if (byteSize !== expected.byteSize) fail(`${path}.byteSize`, `expected ${expected.byteSize}`);
    return Object.freeze({
        encoding,
        components,
        byteSize,
        sha256: digest(source.sha256, `${path}.sha256`),
    });
}

function normalizeOutput(value, pixelCount, path) {
    const source = allowedKeys(value, OUTPUT_KEYS, path);
    const channel = text(source.channel, `${path}.channel`);
    const definition = INTRINSIC_CHANNEL_BY_NAME[channel];
    if (!definition) fail(`${path}.channel`, "unknown intrinsic channel");
    return Object.freeze({
        sourceId: text(source.sourceId, `${path}.sourceId`),
        channel,
        values: normalizeOutputDigest(source.values, {
            encoding: definition.encoding,
            components: definition.components,
            byteSize: pixelCount * definition.components * 4,
        }, `${path}.values`),
        confidence: normalizeOutputDigest(source.confidence, {
            encoding: PROPOSAL_CONFIDENCE_ENCODING,
            components: 1,
            byteSize: pixelCount * 4,
        }, `${path}.confidence`),
        knownMask: normalizeOutputDigest(source.knownMask, {
            encoding: PROPOSAL_KNOWN_MASK_ENCODING,
            components: 1,
            byteSize: pixelCount,
        }, `${path}.knownMask`),
    });
}

function normalizeUnit(value, path) {
    const source = allowedKeys(value, UNIT_KEYS, path);
    const width = integer(source.width, `${path}.width`, { min: 1 });
    const height = integer(source.height, `${path}.height`, { min: 1 });
    const outputs = denseArray(source.outputs ?? [], `${path}.outputs`)
        .map((entry, index) => normalizeOutput(entry, width * height, `${path}.outputs.${index}`))
        .sort((left, right) => compareUtf8(left.sourceId, right.sourceId)
            || compareUtf8(left.channel, right.channel));
    const outputKeys = outputs.map((entry) => `${entry.sourceId}\0${entry.channel}`);
    if (new Set(outputKeys).size !== outputKeys.length) fail(`${path}.outputs`, "contains duplicate source/channel pairs");
    return Object.freeze({
        unitId: text(source.unitId, `${path}.unitId`),
        sampleId: text(source.sampleId, `${path}.sampleId`),
        viewId: text(source.viewId, `${path}.viewId`),
        width,
        height,
        outputs: Object.freeze(outputs),
    });
}

export function normalizeBakeMaterialProposalSet(value = {}) {
    const source = allowedKeys(value, TOP_LEVEL_KEYS, "materialProposalSet");
    if (source.kind !== BAKE_MATERIAL_PROPOSAL_SET_KIND) {
        fail("materialProposalSet.kind", `expected ${BAKE_MATERIAL_PROPOSAL_SET_KIND}`);
    }
    if (source.version !== BAKE_MATERIAL_PROPOSAL_SET_VERSION) {
        fail("materialProposalSet.version", "unsupported material-proposal-set version");
    }
    const sources = denseArray(source.sources ?? [], "materialProposalSet.sources")
        .map((entry, index) => normalizeSource(entry, `materialProposalSet.sources.${index}`))
        .sort((left, right) => compareUtf8(left.id, right.id));
    const sourceIds = sources.map((entry) => entry.id);
    if (new Set(sourceIds).size !== sourceIds.length) fail("materialProposalSet.sources", "contains duplicate IDs");
    const units = denseArray(source.units ?? [], "materialProposalSet.units")
        .map((entry, index) => normalizeUnit(entry, `materialProposalSet.units.${index}`))
        .sort((left, right) => compareUtf8(left.unitId, right.unitId));
    const unitIds = units.map((entry) => entry.unitId);
    if (new Set(unitIds).size !== unitIds.length) fail("materialProposalSet.units", "contains duplicate IDs");
    const knownSources = new Set(sourceIds);
    for (const [unitIndex, unit] of units.entries()) {
        for (const [outputIndex, output] of unit.outputs.entries()) {
            if (!knownSources.has(output.sourceId)) {
                fail(`materialProposalSet.units.${unitIndex}.outputs.${outputIndex}.sourceId`, "unknown proposal source");
            }
        }
    }
    return Object.freeze({
        kind: BAKE_MATERIAL_PROPOSAL_SET_KIND,
        version: BAKE_MATERIAL_PROPOSAL_SET_VERSION,
        recipeHash: digest(source.recipeHash, "materialProposalSet.recipeHash"),
        snapshotHash: digest(source.snapshotHash, "materialProposalSet.snapshotHash"),
        planHash: digest(source.planHash, "materialProposalSet.planHash"),
        requestHash: digest(source.requestHash, "materialProposalSet.requestHash"),
        responseHash: digest(source.responseHash, "materialProposalSet.responseHash"),
        sources: Object.freeze(sources),
        units: Object.freeze(units),
    });
}

export function assertBakeMaterialProposalSet(value) {
    const normalized = normalizeBakeMaterialProposalSet(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("materialProposalSet", "document is not in canonical normalized form");
    }
    return value;
}

export function hashBakeMaterialProposalSet(value) {
    return sha256ExactUtf8(canonicalExactStringify(normalizeBakeMaterialProposalSet(value)));
}

export function materialProposalBufferKey(unitId, sourceId, channel, role) {
    if (!["values", "confidence", "knownMask"].includes(role)) {
        fail("role", "expected values | confidence | knownMask");
    }
    return `${unitId}\0${sourceId}\0${channel}\0${role}`;
}

function lookupBuffer(buffers, key) {
    if (buffers instanceof Map) return buffers.get(key);
    if (buffers && typeof buffers === "object") return buffers[key];
    return undefined;
}

function float32LittleEndianBytes(values) {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < values.length; index += 1) view.setFloat32(index * 4, values[index], true);
    return bytes;
}

function assertOutputBuffers(unit, output, buffers) {
    const definition = INTRINSIC_CHANNEL_BY_NAME[output.channel];
    const prefix = `${unit.unitId}/${output.sourceId}/${output.channel}`;
    const values = lookupBuffer(buffers, materialProposalBufferKey(unit.unitId, output.sourceId, output.channel, "values"));
    const confidence = lookupBuffer(buffers, materialProposalBufferKey(unit.unitId, output.sourceId, output.channel, "confidence"));
    const knownMask = lookupBuffer(buffers, materialProposalBufferKey(unit.unitId, output.sourceId, output.channel, "knownMask"));
    if (!(values instanceof Float32Array)) fail(`${prefix}/values`, "expected Float32Array buffer", "BAKE_MATERIAL_PROPOSAL_BUFFER_MISSING");
    if (!(confidence instanceof Float32Array)) fail(`${prefix}/confidence`, "expected Float32Array buffer", "BAKE_MATERIAL_PROPOSAL_BUFFER_MISSING");
    if (!(knownMask instanceof Uint8Array)) fail(`${prefix}/knownMask`, "expected Uint8Array buffer", "BAKE_MATERIAL_PROPOSAL_BUFFER_MISSING");
    const pixels = unit.width * unit.height;
    if (values.length !== pixels * definition.components) fail(`${prefix}/values`, "buffer dimensions do not match proposal unit");
    if (confidence.length !== pixels) fail(`${prefix}/confidence`, "buffer dimensions do not match proposal unit");
    if (knownMask.length !== pixels) fail(`${prefix}/knownMask`, "buffer dimensions do not match proposal unit");
    const byteRecords = [
        ["values", float32LittleEndianBytes(values), output.values],
        ["confidence", float32LittleEndianBytes(confidence), output.confidence],
        ["knownMask", knownMask, output.knownMask],
    ];
    for (const [role, bytes, record] of byteRecords) {
        if (bytes.byteLength !== record.byteSize || sha256ExactBytes(bytes) !== record.sha256) {
            fail(`${prefix}/${role}`, "buffer digest mismatch", "BAKE_MATERIAL_PROPOSAL_DIGEST_MISMATCH");
        }
    }
    for (let pixel = 0; pixel < pixels; pixel += 1) {
        const known = knownMask[pixel];
        const certainty = confidence[pixel];
        if (known !== 0 && known !== 1) fail(`${prefix}/knownMask.${pixel}`, "expected 0 or 1");
        if (!Number.isFinite(certainty) || certainty < 0 || certainty > 1) {
            fail(`${prefix}/confidence.${pixel}`, "expected finite confidence in [0, 1]");
        }
        const offset = pixel * definition.components;
        const tuple = [];
        for (let component = 0; component < definition.components; component += 1) {
            const entry = values[offset + component];
            if (!Number.isFinite(entry)) fail(`${prefix}/values.${offset + component}`, "expected a finite value");
            if (known && (entry < definition.minimum || entry > definition.maximum)) {
                fail(`${prefix}/values.${offset + component}`, `known value must be in [${definition.minimum}, ${definition.maximum}]`);
            }
            if (!known && entry !== 0) fail(`${prefix}/values.${offset + component}`, "unknown values must be zero");
            tuple.push(entry);
        }
        if (!known && certainty !== 0) fail(`${prefix}/confidence.${pixel}`, "unknown values must have zero confidence");
        if (known && output.channel === "normal" && Math.abs(Math.hypot(...tuple) - 1) > 1e-3) {
            fail(`${prefix}/values.${offset}`, "known tangent-space normal must have unit length");
        }
    }
    return Object.freeze({ values, confidence, knownMask });
}

export function validateBakeMaterialProposals({ proposalSet, buffers, construction, job }) {
    if (!isIntrinsicProposalConstruction(construction)) {
        fail("construction", "material proposals require intrinsic construction v2");
    }
    const normalized = normalizeBakeMaterialProposalSet(proposalSet);
    const bindings = ["recipeHash", "snapshotHash", "planHash", "requestHash", "responseHash"];
    for (const binding of bindings) {
        if (normalized[binding] !== job?.[binding]) {
            fail(`materialProposalSet.${binding}`, "does not match the bake job", "BAKE_MATERIAL_PROPOSAL_BINDING_MISMATCH");
        }
    }
    const snapshotUses = new Set(job?.snapshot?.sourceUseHashes ?? []);
    for (const source of normalized.sources) {
        for (const useHash of source.sourceUseHashes) {
            if (!snapshotUses.has(useHash)) fail(`materialProposalSet.sources.${source.id}.sourceUseHashes`, "use is outside the bake snapshot");
        }
    }
    const samples = new Map((job?.plan?.samples ?? []).map((sample) => [
        bakeCaptureUnitId(sample.pathId, sample.sampleIndex, sample.viewId),
        sample,
    ]));
    const views = new Map((job?.config?.views ?? []).map((view) => [view.id, view]));
    if (normalized.units.length !== samples.size) fail("materialProposalSet.units", "must cover every capture unit exactly once");
    const resolved = new Map();
    for (const unit of normalized.units) {
        const sample = samples.get(unit.unitId);
        if (!sample || sample.sampleId !== unit.sampleId || sample.viewId !== unit.viewId) {
            fail(`materialProposalSet.units.${unit.unitId}`, "does not match the bake capture plan");
        }
        const camera = views.get(unit.viewId)?.camera;
        if (unit.width !== camera?.width || unit.height !== camera?.height) {
            fail(`materialProposalSet.units.${unit.unitId}`, "dimensions do not match the bake camera");
        }
        const coveredChannels = new Set(unit.outputs.map((output) => output.channel));
        for (const channel of construction.intrinsicChannels) {
            if (!coveredChannels.has(channel.name)) {
                fail(`materialProposalSet.units.${unit.unitId}.outputs`, `missing required ${channel.name} proposal evidence`);
            }
        }
        for (const output of unit.outputs) {
            resolved.set(
                `${unit.unitId}\0${output.sourceId}\0${output.channel}\0resolved`,
                assertOutputBuffers(unit, output, buffers),
            );
        }
    }
    return Object.freeze({
        proposalSet: normalized,
        buffers: resolved,
        proposalHash: hashBakeMaterialProposalSet(normalized),
        unitDigests: bakeMaterialProposalUnitDigests(normalized),
    });
}

export function bakeMaterialProposalUnitDigests(value) {
    const proposalSet = normalizeBakeMaterialProposalSet(value);
    const sources = new Map(proposalSet.sources.map((source) => [source.id, source]));
    return new Map(proposalSet.units.map((unit) => [
        unit.unitId,
        sha256ExactUtf8(canonicalExactStringify({
            unit,
            sources: [...new Set(unit.outputs.map((output) => output.sourceId))]
                .sort(compareUtf8)
                .map((sourceId) => sources.get(sourceId)),
        })),
    ]));
}

export function digestProposalFloat32(values) {
    if (!(values instanceof Float32Array)) fail("values", "expected Float32Array");
    return sha256ExactBytes(float32LittleEndianBytes(values));
}
