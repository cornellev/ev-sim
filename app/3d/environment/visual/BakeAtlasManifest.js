/**
 * Canonical cev-sim.bake-atlas-manifest@1 metadata. Stored as a visual-layer
 * buffer asset and referenced through appearanceDependencies.
 */

import {
    canonicalExactStringify,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";
import { compareUtf8 } from "./BakeRunCatalog.js";
import { hashBakeConstruction } from "./BakeConstructionPolicy.js";

export const BAKE_ATLAS_MANIFEST_KIND = "cev-sim.bake-atlas-manifest";
export const BAKE_ATLAS_MANIFEST_VERSION = 1;
export const BAKE_ATLAS_MANIFEST_VERSION_V2 = 2;

const SHA256 = /^[a-f0-9]{64}$/;
const MANIFEST_KEYS = Object.freeze([
    "kind", "version", "constructionHash", "appearanceMode", "chunks",
]);
const CHUNK_KEYS = Object.freeze([
    "chunkKey", "chartHash", "outputHash", "coverageCount", "conflictCount", "pages",
]);
const PAGE_KEYS = Object.freeze([
    "pageIndex", "width", "height", "textureSha256", "meshSha256", "confidenceSha256",
    "coverageCount", "conflictCount", "intrinsic",
]);
const INTRINSIC_KEYS = Object.freeze(["name", "present", "unknown", "units", "encoding"]);
const PAGE_V2_KEYS = Object.freeze(["pageIndex", "width", "height", "meshSha256", "channels"]);
const CHANNEL_V2_KEYS = Object.freeze([
    "name", "state", "textureSha256", "confidenceSha256", "knownMaskSha256",
    "units", "encoding", "declaredDefault", "coverageCount", "conflictCount",
    "defaultAppliedCount", "unknownCount",
]);

function fail(path, message) {
    const error = new Error(`${path}: ${message}`);
    error.code = "BAKE_ATLAS_INVALID";
    throw error;
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

function text(value, path, { identifier = false } = {}) {
    if (typeof value !== "string" || !value) fail(path, "expected a non-empty string");
    if (identifier && value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
    return value;
}

function integer(value, path, { min = 0 } = {}) {
    if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < min) {
        fail(path, `expected a safe integer >= ${min}`);
    }
    return value;
}

function digest(value, path) {
    const result = text(value, path);
    if (!SHA256.test(result)) fail(path, "expected a lowercase SHA-256 digest");
    return result;
}

function boolean(value, path) {
    if (typeof value !== "boolean") fail(path, "expected a boolean");
    return value;
}

function finite(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
    return Object.is(value, -0) ? 0 : value;
}

function intrinsicRecord(value, path) {
    const source = allowedKeys(value ?? {}, INTRINSIC_KEYS, path);
    return Object.freeze({
        name: text(source.name, `${path}.name`, { identifier: true }),
        present: boolean(source.present, `${path}.present`),
        unknown: boolean(source.unknown ?? !source.present, `${path}.unknown`),
        units: text(source.units, `${path}.units`, { identifier: true }),
        encoding: text(source.encoding, `${path}.encoding`, { identifier: true }),
    });
}

function pageRecord(value, path) {
    const source = allowedKeys(value ?? {}, PAGE_KEYS, path);
    const intrinsic = Object.freeze(
        denseArray(source.intrinsic ?? [], `${path}.intrinsic`)
            .map((entry, index) => intrinsicRecord(entry, `${path}.intrinsic.${index}`))
            .sort((left, right) => compareUtf8(left.name, right.name)),
    );
    return Object.freeze({
        pageIndex: integer(source.pageIndex, `${path}.pageIndex`),
        width: integer(source.width, `${path}.width`, { min: 1 }),
        height: integer(source.height, `${path}.height`, { min: 1 }),
        textureSha256: digest(source.textureSha256, `${path}.textureSha256`),
        meshSha256: digest(source.meshSha256, `${path}.meshSha256`),
        confidenceSha256: digest(source.confidenceSha256, `${path}.confidenceSha256`),
        coverageCount: integer(source.coverageCount, `${path}.coverageCount`),
        conflictCount: integer(source.conflictCount, `${path}.conflictCount`),
        intrinsic,
    });
}

function chunkRecord(value, path) {
    const source = allowedKeys(value ?? {}, CHUNK_KEYS, path);
    const pages = Object.freeze(
        denseArray(source.pages ?? [], `${path}.pages`)
            .map((entry, index) => pageRecord(entry, `${path}.pages.${index}`))
            .sort((left, right) => left.pageIndex - right.pageIndex),
    );
    const indexes = pages.map((entry) => entry.pageIndex);
    if (new Set(indexes).size !== indexes.length) fail(`${path}.pages`, "contains duplicate page indexes");
    return Object.freeze({
        chunkKey: text(source.chunkKey, `${path}.chunkKey`, { identifier: true }),
        chartHash: digest(source.chartHash, `${path}.chartHash`),
        outputHash: digest(source.outputHash, `${path}.outputHash`),
        coverageCount: integer(source.coverageCount, `${path}.coverageCount`),
        conflictCount: integer(source.conflictCount, `${path}.conflictCount`),
        pages,
    });
}

function channelRecordV2(value, path) {
    const source = allowedKeys(value ?? {}, CHANNEL_V2_KEYS, path);
    const state = text(source.state, `${path}.state`, { identifier: true });
    if (!["supported", "defaulted", "unknown"].includes(state)) {
        fail(`${path}.state`, "expected supported | defaulted | unknown");
    }
    return Object.freeze({
        name: text(source.name, `${path}.name`, { identifier: true }),
        state,
        textureSha256: digest(source.textureSha256, `${path}.textureSha256`),
        confidenceSha256: digest(source.confidenceSha256, `${path}.confidenceSha256`),
        knownMaskSha256: digest(source.knownMaskSha256, `${path}.knownMaskSha256`),
        units: text(source.units, `${path}.units`, { identifier: true }),
        encoding: text(source.encoding, `${path}.encoding`, { identifier: true }),
        declaredDefault: Object.freeze(denseArray(source.declaredDefault, `${path}.declaredDefault`)
            .map((entry, index) => finite(entry, `${path}.declaredDefault.${index}`))),
        coverageCount: integer(source.coverageCount, `${path}.coverageCount`),
        conflictCount: integer(source.conflictCount, `${path}.conflictCount`),
        defaultAppliedCount: integer(source.defaultAppliedCount, `${path}.defaultAppliedCount`),
        unknownCount: integer(source.unknownCount, `${path}.unknownCount`),
    });
}

function pageRecordV2(value, path) {
    const source = allowedKeys(value ?? {}, PAGE_V2_KEYS, path);
    const channels = denseArray(source.channels ?? [], `${path}.channels`)
        .map((entry, index) => channelRecordV2(entry, `${path}.channels.${index}`))
        .sort((left, right) => compareUtf8(left.name, right.name));
    const names = channels.map((entry) => entry.name);
    if (new Set(names).size !== names.length) fail(`${path}.channels`, "contains duplicate channel names");
    return Object.freeze({
        pageIndex: integer(source.pageIndex, `${path}.pageIndex`),
        width: integer(source.width, `${path}.width`, { min: 1 }),
        height: integer(source.height, `${path}.height`, { min: 1 }),
        meshSha256: digest(source.meshSha256, `${path}.meshSha256`),
        channels: Object.freeze(channels),
    });
}

function chunkRecordV2(value, path) {
    const source = allowedKeys(value ?? {}, CHUNK_KEYS, path);
    const pages = denseArray(source.pages ?? [], `${path}.pages`)
        .map((entry, index) => pageRecordV2(entry, `${path}.pages.${index}`))
        .sort((left, right) => left.pageIndex - right.pageIndex);
    const indexes = pages.map((entry) => entry.pageIndex);
    if (new Set(indexes).size !== indexes.length) fail(`${path}.pages`, "contains duplicate page indexes");
    return Object.freeze({
        chunkKey: text(source.chunkKey, `${path}.chunkKey`, { identifier: true }),
        chartHash: digest(source.chartHash, `${path}.chartHash`),
        outputHash: digest(source.outputHash, `${path}.outputHash`),
        coverageCount: integer(source.coverageCount, `${path}.coverageCount`),
        conflictCount: integer(source.conflictCount, `${path}.conflictCount`),
        pages: Object.freeze(pages),
    });
}

export function normalizeBakeAtlasManifest(value = {}) {
    const source = allowedKeys(value, MANIFEST_KEYS, "bakeAtlasManifest");
    if ((source.kind ?? BAKE_ATLAS_MANIFEST_KIND) !== BAKE_ATLAS_MANIFEST_KIND) {
        fail("kind", `expected ${BAKE_ATLAS_MANIFEST_KIND}`);
    }
    const version = source.version ?? BAKE_ATLAS_MANIFEST_VERSION;
    if (![BAKE_ATLAS_MANIFEST_VERSION, BAKE_ATLAS_MANIFEST_VERSION_V2].includes(version)) {
        fail("version", "unsupported bake-atlas-manifest version");
    }
    const chunks = Object.freeze(
        denseArray(source.chunks ?? [], "chunks")
            .map((entry, index) => (
                version === BAKE_ATLAS_MANIFEST_VERSION_V2
                    ? chunkRecordV2(entry, `chunks.${index}`)
                    : chunkRecord(entry, `chunks.${index}`)
            ))
            .sort((left, right) => compareUtf8(left.chunkKey, right.chunkKey)),
    );
    const keys = chunks.map((entry) => entry.chunkKey);
    if (new Set(keys).size !== keys.length) fail("chunks", "contains duplicate chunk keys");
    return Object.freeze({
        kind: BAKE_ATLAS_MANIFEST_KIND,
        version,
        constructionHash: digest(source.constructionHash, "constructionHash"),
        appearanceMode: text(source.appearanceMode, "appearanceMode", { identifier: true }),
        chunks,
    });
}

export function assertBakeAtlasManifest(value) {
    const normalized = normalizeBakeAtlasManifest(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("bakeAtlasManifest", "immutable atlas manifest is not in canonical normalized form");
    }
    return value;
}

export function hashBakeAtlasManifest(value) {
    return sha256ExactUtf8(canonicalExactStringify(normalizeBakeAtlasManifest(value)));
}

export function atlasManifestBytes(value) {
    return new TextEncoder().encode(canonicalExactStringify(normalizeBakeAtlasManifest(value)));
}

export function atlasManifestFromConstruction(construction, chunks) {
    return normalizeBakeAtlasManifest({
        kind: BAKE_ATLAS_MANIFEST_KIND,
        version: construction?.version === 2
            ? BAKE_ATLAS_MANIFEST_VERSION_V2
            : BAKE_ATLAS_MANIFEST_VERSION,
        constructionHash: hashBakeConstruction(construction),
        appearanceMode: construction.appearanceMode,
        chunks,
    });
}
