/**
 * VIS-09 bake reuse contracts. Manifests authorize blob reuse; reports are
 * audit evidence and never enter visualLayerHash, worldHash, or episode identity.
 */

import {
    canonicalExactStringify,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";
import { compareUtf8 } from "./BakeRunCatalog.js";
import {
    PROJECTED_CAPTURED_RADIANCE_WRITER,
} from "./BakeDeterministicMedia.js";
import { CHUNK_ATLAS_WRITER } from "./BakeConstructionPolicy.js";

export const BAKE_REUSE_MANIFEST_KIND = "cev-sim.bake-reuse-manifest";
export const BAKE_REUSE_MANIFEST_VERSION = 1;
export const BAKE_REUSE_MANIFEST_VERSION_V2 = 2;
export const BAKE_REUSE_REPORT_KIND = "cev-sim.bake-reuse-report";
export const BAKE_REUSE_REPORT_VERSION = 1;
export const BAKE_REUSE_KEY_VERSION = 1;
export const BAKE_REUSE_COMMIT_MODES = Object.freeze(["promote", "noop"]);

export const BAKE_REUSE_REASONS = Object.freeze({
    KEYS_UNCHANGED: "keys-unchanged",
    INSERTION: "insertion",
    DELETION: "deletion",
    MOVE: "move",
    MATERIAL: "material",
    VISIBILITY: "visibility",
    ENTITY_ID: "entity-id",
    GEOMETRY: "geometry",
    TRANSFORM: "transform",
    CALIBRATION: "calibration",
    PATH_SAMPLE_POLICY: "path-sample-policy",
    SEED: "seed",
    ALGORITHM: "algorithm",
    WRITER: "writer",
    OUTPUT_MODE: "output-mode",
    GLOBAL_SKY_IBL: "global-sky-ibl",
    GLOBAL_LIGHTING: "global-lighting",
    UNBOUNDED_SHADOW: "unbounded-shadow",
    UNBOUNDED_OCCLUSION: "unbounded-occlusion",
    UNASSIGNED_OBJECT: "unassigned-object",
    GLOBAL_KEY_CHANGED: "global-key-changed",
    UNIT_ADDED: "unit-added",
    UNIT_REMOVED: "unit-removed",
    KEY_MISMATCH: "key-mismatch",
    MISSING_PROVENANCE: "missing-provenance",
    LEGACY_REBUILD: "legacy-rebuild",
    REUSE_DISABLED: "reuse-disabled",
    CAPTURED: "captured",
    UPLOADED: "uploaded",
    ALREADY_PUBLISHED: "already-published",
});

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATED_ID = /^bake-[a-f0-9]{64}$/;
const MANIFEST_KEYS = Object.freeze([
    "kind", "version", "sourceWorldHash", "keyVersion", "globalKey",
    "chunkKeys", "units", "writer", "descriptorHash", "accessHash",
]);
const MANIFEST_KEYS_V2 = Object.freeze([
    ...MANIFEST_KEYS,
    "constructionHash", "atlasManifestDigest", "chunks",
]);
const CHUNK_KEY_KEYS = Object.freeze(["chunkKey", "dependencyKey"]);
const UNIT_KEYS = Object.freeze([
    "unitId", "pathId", "sampleIndex", "viewId", "dependencyKey", "chunkKeys", "fragments",
]);
const UNIT_KEYS_V2 = Object.freeze([
    "unitId", "pathId", "sampleIndex", "viewId", "dependencyKey", "chunkKeys", "contribution",
]);
const CHUNK_OUTPUT_KEYS = Object.freeze([
    "chunkKey", "dependencyKey", "chartHash", "outputHash", "pages",
]);
const PAGE_ASSET_KEYS = Object.freeze([
    "pageIndex", "texture", "mesh", "confidence",
]);
const FRAGMENT_KEYS = Object.freeze([
    "materialId", "instanceId", "chunkId", "texture", "mesh", "matrix",
]);
const ASSET_KEYS = Object.freeze([
    "sha256", "mediaType", "sizeBytes", "useHash", "role",
]);
const WRITER_KEYS = Object.freeze(["id", "version"]);
const WRITER_KEYS_V2 = Object.freeze(["id", "version", "constructionHash"]);
const REPORT_KEYS = Object.freeze([
    "kind", "version", "sourceWorldHash", "previousManifestHash", "mode",
    "reused", "invalidated", "removed", "captured", "uploaded", "globalReasons",
]);
const UNIT_REASON_KEYS = Object.freeze(["unitId", "reason"]);
const REASON_VALUES = new Set(Object.values(BAKE_REUSE_REASONS));

function reuseError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function fail(path, message) {
    throw reuseError("BAKE_REUSE_INVALID", `${path}: ${message}`);
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

function text(value, path, { identifier = false, allowEmpty = false } = {}) {
    if (typeof value !== "string") fail(path, "expected a string");
    if (!allowEmpty && value.length === 0) fail(path, "expected a non-empty string");
    if (identifier && value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
    return value;
}

function integer(value, path, { min = 0 } = {}) {
    const number = Object.is(value, -0) ? 0 : value;
    if (typeof number !== "number" || !Number.isFinite(number) || !Number.isSafeInteger(number) || number < min) {
        fail(path, `expected a safe integer >= ${min}`);
    }
    return number;
}

function digest(value, path) {
    const result = text(value, path);
    if (!SHA256.test(result)) fail(path, "expected a lowercase SHA-256 digest");
    return result;
}

function digestOrNull(value, path) {
    if (value == null) return null;
    return digest(value, path);
}

function uniqueSorted(values, path, normalizeEntry) {
    const list = denseArray(values, path).map((entry, index) => normalizeEntry(entry, `${path}.${index}`));
    const seen = new Set(list);
    if (seen.size !== list.length) fail(path, "contains duplicate entries");
    return [...list].sort(compareUtf8);
}

export function bakeCaptureUnitId(pathId, sampleIndex, viewId) {
    const path = text(pathId, "pathId", { identifier: true });
    const index = integer(sampleIndex, "sampleIndex");
    const view = text(viewId, "viewId", { identifier: true });
    return `capture-unit:${path}:${index}:${view}`;
}

export function bakeGeneratedRecordId(unitId, contentDigest, kind) {
    return `bake-${sha256ExactUtf8(`${unitId}:${contentDigest}:${kind}`)}`;
}

export function isBakeGeneratedId(id) {
    return typeof id === "string" && GENERATED_ID.test(id);
}

export function hashBakeDependencyRecord(value) {
    return sha256ExactUtf8(canonicalExactStringify(value));
}

function assetRecord(value, path) {
    const source = allowedKeys(value ?? {}, ASSET_KEYS, path);
    return Object.freeze({
        sha256: digest(source.sha256, `${path}.sha256`),
        mediaType: text(source.mediaType, `${path}.mediaType`),
        sizeBytes: integer(source.sizeBytes, `${path}.sizeBytes`),
        useHash: digest(source.useHash, `${path}.useHash`),
        role: text(source.role, `${path}.role`),
    });
}

function fragmentRecord(value, path) {
    const source = allowedKeys(value ?? {}, FRAGMENT_KEYS, path);
    return Object.freeze({
        materialId: text(source.materialId, `${path}.materialId`, { identifier: true }),
        instanceId: text(source.instanceId, `${path}.instanceId`, { identifier: true }),
        chunkId: text(source.chunkId, `${path}.chunkId`, { identifier: true }),
        texture: assetRecord(source.texture, `${path}.texture`),
        mesh: assetRecord(source.mesh, `${path}.mesh`),
        matrix: Object.freeze(denseArray(source.matrix, `${path}.matrix`).map((entry, index) => {
            const number = Object.is(entry, -0) ? 0 : entry;
            if (typeof number !== "number" || !Number.isFinite(number)) {
                fail(`${path}.matrix.${index}`, "expected a finite number");
            }
            return number;
        })),
    });
}

function unitRecord(value, path) {
    const source = allowedKeys(value ?? {}, UNIT_KEYS, path);
    const unitId = text(source.unitId, `${path}.unitId`, { identifier: true });
    const pathId = text(source.pathId, `${path}.pathId`, { identifier: true });
    const sampleIndex = integer(source.sampleIndex, `${path}.sampleIndex`);
    const viewId = text(source.viewId, `${path}.viewId`, { identifier: true });
    const expected = bakeCaptureUnitId(pathId, sampleIndex, viewId);
    if (unitId !== expected) fail(`${path}.unitId`, `expected ${expected}`);
    return Object.freeze({
        unitId,
        pathId,
        sampleIndex,
        viewId,
        dependencyKey: digest(source.dependencyKey, `${path}.dependencyKey`),
        chunkKeys: Object.freeze(uniqueSorted(source.chunkKeys ?? [], `${path}.chunkKeys`, (entry, itemPath) => (
            text(entry, itemPath, { identifier: true })
        ))),
        fragments: fragmentRecord(source.fragments, `${path}.fragments`),
    });
}

function chunkKeyRecord(value, path) {
    const source = allowedKeys(value ?? {}, CHUNK_KEY_KEYS, path);
    return Object.freeze({
        chunkKey: text(source.chunkKey, `${path}.chunkKey`, { identifier: true }),
        dependencyKey: digest(source.dependencyKey, `${path}.dependencyKey`),
    });
}

function writerRecord(value, path, { version = 1 } = {}) {
    const keys = version >= 2 ? WRITER_KEYS_V2 : WRITER_KEYS;
    const source = allowedKeys(value ?? {}, keys, path);
    const record = {
        id: text(source.id ?? PROJECTED_CAPTURED_RADIANCE_WRITER.id, `${path}.id`),
        version: integer(source.version ?? PROJECTED_CAPTURED_RADIANCE_WRITER.version, `${path}.version`, { min: 1 }),
    };
    if (version >= 2 && source.constructionHash != null) {
        record.constructionHash = digest(source.constructionHash, `${path}.constructionHash`);
    }
    return Object.freeze(record);
}

function pageAssetRecord(value, path) {
    const source = allowedKeys(value ?? {}, PAGE_ASSET_KEYS, path);
    return Object.freeze({
        pageIndex: integer(source.pageIndex, `${path}.pageIndex`),
        texture: assetRecord(source.texture, `${path}.texture`),
        mesh: assetRecord(source.mesh, `${path}.mesh`),
        confidence: assetRecord(source.confidence, `${path}.confidence`),
    });
}

function chunkOutputRecord(value, path) {
    const source = allowedKeys(value ?? {}, CHUNK_OUTPUT_KEYS, path);
    const pages = Object.freeze(
        denseArray(source.pages ?? [], `${path}.pages`)
            .map((entry, index) => pageAssetRecord(entry, `${path}.pages.${index}`))
            .sort((left, right) => left.pageIndex - right.pageIndex),
    );
    return Object.freeze({
        chunkKey: text(source.chunkKey, `${path}.chunkKey`, { identifier: true }),
        dependencyKey: digest(source.dependencyKey, `${path}.dependencyKey`),
        chartHash: digest(source.chartHash, `${path}.chartHash`),
        outputHash: digest(source.outputHash, `${path}.outputHash`),
        pages,
    });
}

function unitRecordV2(value, path) {
    const source = allowedKeys(value ?? {}, UNIT_KEYS_V2, path);
    const unitId = text(source.unitId, `${path}.unitId`, { identifier: true });
    const pathId = text(source.pathId, `${path}.pathId`, { identifier: true });
    const sampleIndex = integer(source.sampleIndex, `${path}.sampleIndex`);
    const viewId = text(source.viewId, `${path}.viewId`, { identifier: true });
    const expected = bakeCaptureUnitId(pathId, sampleIndex, viewId);
    if (unitId !== expected) fail(`${path}.unitId`, `expected ${expected}`);
    return Object.freeze({
        unitId,
        pathId,
        sampleIndex,
        viewId,
        dependencyKey: digest(source.dependencyKey, `${path}.dependencyKey`),
        chunkKeys: Object.freeze(uniqueSorted(source.chunkKeys ?? [], `${path}.chunkKeys`, (entry, itemPath) => (
            text(entry, itemPath, { identifier: true })
        ))),
        contribution: assetRecord(source.contribution, `${path}.contribution`),
    });
}

export function normalizeBakeReuseManifest(value = {}) {
    if ((value.kind ?? BAKE_REUSE_MANIFEST_KIND) !== BAKE_REUSE_MANIFEST_KIND) {
        fail("kind", `expected ${BAKE_REUSE_MANIFEST_KIND}`);
    }
    const version = integer(value.version ?? BAKE_REUSE_MANIFEST_VERSION, "version", { min: 1 });
    if (version !== BAKE_REUSE_MANIFEST_VERSION && version !== BAKE_REUSE_MANIFEST_VERSION_V2) {
        fail("version", "unsupported bake-reuse-manifest version");
    }
    allowedKeys(value, version >= 2 ? MANIFEST_KEYS_V2 : MANIFEST_KEYS, "bakeReuseManifest");
    const units = Object.freeze(
        denseArray(value.units ?? [], "units")
            .map((entry, index) => (
                version >= 2
                    ? unitRecordV2(entry, `units.${index}`)
                    : unitRecord(entry, `units.${index}`)
            ))
            .sort((left, right) => compareUtf8(left.unitId, right.unitId)),
    );
    const unitIds = units.map((entry) => entry.unitId);
    if (new Set(unitIds).size !== unitIds.length) fail("units", "contains duplicate unit IDs");
    const chunkKeys = Object.freeze(
        denseArray(value.chunkKeys ?? [], "chunkKeys")
            .map((entry, index) => chunkKeyRecord(entry, `chunkKeys.${index}`))
            .sort((left, right) => compareUtf8(left.chunkKey, right.chunkKey)),
    );
    const chunkIds = chunkKeys.map((entry) => entry.chunkKey);
    if (new Set(chunkIds).size !== chunkIds.length) fail("chunkKeys", "contains duplicate chunk keys");
    const chunks = version >= 2
        ? Object.freeze(
            denseArray(value.chunks ?? [], "chunks")
                .map((entry, index) => chunkOutputRecord(entry, `chunks.${index}`))
                .sort((left, right) => compareUtf8(left.chunkKey, right.chunkKey)),
        )
        : Object.freeze([]);
    if (version >= 2) {
        const outputIds = chunks.map((entry) => entry.chunkKey);
        if (new Set(outputIds).size !== outputIds.length) fail("chunks", "contains duplicate chunk keys");
    }
    const manifest = {
        kind: BAKE_REUSE_MANIFEST_KIND,
        version,
        sourceWorldHash: digest(value.sourceWorldHash, "sourceWorldHash"),
        keyVersion: integer(value.keyVersion ?? BAKE_REUSE_KEY_VERSION, "keyVersion", { min: 1 }),
        globalKey: digest(value.globalKey, "globalKey"),
        chunkKeys,
        units,
        writer: writerRecord(
            value.writer ?? (version >= 2 ? CHUNK_ATLAS_WRITER : PROJECTED_CAPTURED_RADIANCE_WRITER),
            "writer",
            { version },
        ),
        descriptorHash: digest(value.descriptorHash, "descriptorHash"),
        accessHash: digest(value.accessHash, "accessHash"),
    };
    if (version >= 2) {
        manifest.constructionHash = digest(value.constructionHash, "constructionHash");
        manifest.atlasManifestDigest = digest(value.atlasManifestDigest, "atlasManifestDigest");
        manifest.chunks = chunks;
    }
    return Object.freeze(manifest);
}

export function assertBakeReuseManifest(value) {
    const normalized = normalizeBakeReuseManifest(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("bakeReuseManifest", "immutable manifest is not in canonical normalized form");
    }
    return value;
}

export function hashBakeReuseManifest(value) {
    return sha256ExactUtf8(canonicalExactStringify(normalizeBakeReuseManifest(value)));
}

function reasonCode(value, path) {
    const reason = text(value, path, { identifier: true });
    if (!REASON_VALUES.has(reason)) fail(path, `unsupported reason ${reason}`);
    return reason;
}

function unitReason(value, path) {
    const source = allowedKeys(value ?? {}, UNIT_REASON_KEYS, path);
    return Object.freeze({
        unitId: text(source.unitId, `${path}.unitId`, { identifier: true }),
        reason: reasonCode(source.reason, `${path}.reason`),
    });
}

function sortUnitReasons(values, path) {
    const list = denseArray(values ?? [], path).map((entry, index) => unitReason(entry, `${path}.${index}`));
    const ids = list.map((entry) => entry.unitId);
    if (new Set(ids).size !== ids.length) fail(path, "contains duplicate unit IDs");
    return Object.freeze([...list].sort((left, right) => compareUtf8(left.unitId, right.unitId)));
}

export function normalizeBakeReuseReport(value = {}) {
    if ((value.kind ?? BAKE_REUSE_REPORT_KIND) !== BAKE_REUSE_REPORT_KIND) {
        fail("kind", `expected ${BAKE_REUSE_REPORT_KIND}`);
    }
    if ((value.version ?? BAKE_REUSE_REPORT_VERSION) !== BAKE_REUSE_REPORT_VERSION) {
        fail("version", "unsupported bake-reuse-report version");
    }
    allowedKeys(value, REPORT_KEYS, "bakeReuseReport");
    const mode = text(value.mode ?? "promote", "mode");
    if (!BAKE_REUSE_COMMIT_MODES.includes(mode)) fail("mode", `expected ${BAKE_REUSE_COMMIT_MODES.join(" | ")}`);
    return Object.freeze({
        kind: BAKE_REUSE_REPORT_KIND,
        version: BAKE_REUSE_REPORT_VERSION,
        sourceWorldHash: digest(value.sourceWorldHash, "sourceWorldHash"),
        previousManifestHash: digestOrNull(value.previousManifestHash ?? null, "previousManifestHash"),
        mode,
        reused: sortUnitReasons(value.reused, "reused"),
        invalidated: sortUnitReasons(value.invalidated, "invalidated"),
        removed: sortUnitReasons(value.removed, "removed"),
        captured: sortUnitReasons(value.captured, "captured"),
        uploaded: sortUnitReasons(value.uploaded, "uploaded"),
        globalReasons: Object.freeze(uniqueSorted(
            value.globalReasons ?? [],
            "globalReasons",
            (entry, path) => reasonCode(entry, path),
        )),
    });
}

export function assertBakeReuseReport(value) {
    const normalized = normalizeBakeReuseReport(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("bakeReuseReport", "immutable report is not in canonical normalized form");
    }
    return value;
}

export function hashBakeReuseReport(value) {
    return sha256ExactUtf8(canonicalExactStringify(normalizeBakeReuseReport(value)));
}

export function emptyBakeReuseReport({
    sourceWorldHash,
    previousManifestHash = null,
    mode = "promote",
} = {}) {
    return normalizeBakeReuseReport({
        kind: BAKE_REUSE_REPORT_KIND,
        version: BAKE_REUSE_REPORT_VERSION,
        sourceWorldHash,
        previousManifestHash,
        mode,
        reused: [],
        invalidated: [],
        removed: [],
        captured: [],
        uploaded: [],
        globalReasons: [],
    });
}

export function isBakeReuseManifestV2(manifest) {
    return manifest?.version === BAKE_REUSE_MANIFEST_VERSION_V2;
}

export function contributionMapFromManifest(manifest) {
    const map = new Map();
    if (!isBakeReuseManifestV2(manifest)) return map;
    for (const unit of manifest.units ?? []) {
        map.set(unit.unitId, unit.contribution);
    }
    return map;
}

export function reuseContributionUseHashes(manifest) {
    if (!isBakeReuseManifestV2(manifest)) return [];
    return [...new Set((manifest.units ?? []).map((unit) => unit.contribution.useHash))].sort(compareUtf8);
}
