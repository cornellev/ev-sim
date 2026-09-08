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

export function normalizeBakeAtlasManifest(value = {}) {
    const source = allowedKeys(value, MANIFEST_KEYS, "bakeAtlasManifest");
    if ((source.kind ?? BAKE_ATLAS_MANIFEST_KIND) !== BAKE_ATLAS_MANIFEST_KIND) {
        fail("kind", `expected ${BAKE_ATLAS_MANIFEST_KIND}`);
    }
    if ((source.version ?? BAKE_ATLAS_MANIFEST_VERSION) !== BAKE_ATLAS_MANIFEST_VERSION) {
        fail("version", "unsupported bake-atlas-manifest version");
    }
    const chunks = Object.freeze(
        denseArray(source.chunks ?? [], "chunks")
            .map((entry, index) => chunkRecord(entry, `chunks.${index}`))
            .sort((left, right) => compareUtf8(left.chunkKey, right.chunkKey)),
    );
    const keys = chunks.map((entry) => entry.chunkKey);
    if (new Set(keys).size !== keys.length) fail("chunks", "contains duplicate chunk keys");
    return Object.freeze({
        kind: BAKE_ATLAS_MANIFEST_KIND,
        version: BAKE_ATLAS_MANIFEST_VERSION,
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
        version: BAKE_ATLAS_MANIFEST_VERSION,
        constructionHash: hashBakeConstruction(construction),
        appearanceMode: construction.appearanceMode,
        chunks,
    });
}
