/**
 * VIS-10a hashed bake construction policy. Bake-run-config v2 carries this
 * document inside recipeHash. Version-1 configs keep implicit projected
 * captured-radiance behavior and never accept a construction field.
 */

import {
    canonicalExactStringify,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";

const textEncoder = new TextEncoder();

function compareUtf8(left, right) {
    const a = textEncoder.encode(String(left));
    const b = textEncoder.encode(String(right));
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

export const BAKE_CONSTRUCTION_KIND = "cev-sim.bake-construction";
export const BAKE_CONSTRUCTION_VERSION = 1;
export const CHUNK_ATLAS_OUTPUT_MODE = "chunk-atlas@1";
export const PROJECTED_CAPTURED_RADIANCE_OUTPUT_MODE = "projected-captured-radiance@1";
export const CAPTURED_RADIANCE_UNLIT = "captured-radiance-unlit";
export const INTRINSIC_PBR_SUPPLIED = "intrinsic-pbr-supplied";
export const STABLE_CHART_UV_ALGORITHM = "stable-chart@1";
export const CONFIDENCE_CAMERA_DISTANCE_FUSION = "confidence-camera-distance@1";
export const ATLAS_ENCODER_REVISION = "png-filter0-stored-zlib+glb-gltf2@1";
export const FAIL_CLOSED_OVERFLOW = "fail-closed";
export const UNKNOWN_ABSENT_POLICY = "unknown";

export const CHUNK_ATLAS_WRITER = Object.freeze({
    id: "chunk-atlas",
    version: 1,
});

export const DEFAULT_ATLAS_CONSTRUCTION = Object.freeze({
    kind: BAKE_CONSTRUCTION_KIND,
    version: BAKE_CONSTRUCTION_VERSION,
    outputMode: CHUNK_ATLAS_OUTPUT_MODE,
    appearanceMode: CAPTURED_RADIANCE_UNLIT,
    uvAlgorithm: STABLE_CHART_UV_ALGORITHM,
    fusionPolicy: CONFIDENCE_CAMERA_DISTANCE_FUSION,
    encoderRevision: ATLAS_ENCODER_REVISION,
    pageSizePx: 512,
    paddingPx: 2,
    texelDensityPerMeter: 16,
    maxPagesPerChunk: 8,
    seamAngleDeg: 60,
    overflowPolicy: FAIL_CLOSED_OVERFLOW,
    chunkSizeMeters: 20,
    intrinsicChannels: Object.freeze([]),
});

export const DEFAULT_PROJECTED_CONSTRUCTION = Object.freeze({
    kind: BAKE_CONSTRUCTION_KIND,
    version: BAKE_CONSTRUCTION_VERSION,
    outputMode: PROJECTED_CAPTURED_RADIANCE_OUTPUT_MODE,
    appearanceMode: CAPTURED_RADIANCE_UNLIT,
    uvAlgorithm: STABLE_CHART_UV_ALGORITHM,
    fusionPolicy: CONFIDENCE_CAMERA_DISTANCE_FUSION,
    encoderRevision: ATLAS_ENCODER_REVISION,
    pageSizePx: 512,
    paddingPx: 2,
    texelDensityPerMeter: 16,
    maxPagesPerChunk: 8,
    seamAngleDeg: 60,
    overflowPolicy: FAIL_CLOSED_OVERFLOW,
    chunkSizeMeters: 20,
    intrinsicChannels: Object.freeze([]),
});

export const ATLAS_PERSISTENT_BAKE_OUTPUT_ROLES = Object.freeze([
    "beauty",
    "world-position",
    "geometric-normal",
    "confidence",
    "validity",
]);

export const PROJECTED_PERSISTENT_BAKE_OUTPUT_ROLES = Object.freeze([
    "beauty",
    "world-position",
    "validity",
]);

const CONSTRUCTION_KEYS = Object.freeze([
    "kind", "version", "outputMode", "appearanceMode", "uvAlgorithm", "fusionPolicy",
    "encoderRevision", "pageSizePx", "paddingPx", "texelDensityPerMeter",
    "maxPagesPerChunk", "seamAngleDeg", "overflowPolicy", "chunkSizeMeters",
    "intrinsicChannels",
]);
const CHANNEL_KEYS = Object.freeze([
    "name", "units", "encoding", "confidenceEncoding", "knownMaskEncoding",
    "declaredDefault", "absentPolicy",
]);
const OUTPUT_MODES = Object.freeze([
    CHUNK_ATLAS_OUTPUT_MODE,
    PROJECTED_CAPTURED_RADIANCE_OUTPUT_MODE,
]);
const APPEARANCE_MODES = Object.freeze([
    CAPTURED_RADIANCE_UNLIT,
    INTRINSIC_PBR_SUPPLIED,
]);

function constructionError(message) {
    const error = new Error(message);
    error.code = "BAKE_CONTRACT_INVALID";
    return error;
}

function fail(path, message) {
    throw constructionError(`${path}: ${message}`);
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
    if (typeof value !== "string" || value.length === 0) fail(path, "expected a non-empty string");
    if (identifier && value !== value.normalize("NFC")) fail(path, "identifier must be NFC text");
    return value;
}

function finite(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
    return Object.is(value, -0) ? 0 : value;
}

function integer(value, path, { min = 0 } = {}) {
    const number = finite(value, path);
    if (!Number.isSafeInteger(number) || number < min) {
        fail(path, `expected a safe integer >= ${min}`);
    }
    return number;
}

function enumValue(value, allowed, path) {
    const result = text(value, path);
    if (!allowed.includes(result)) fail(path, `expected ${allowed.join(" | ")}`);
    return result;
}

function defaultVector(value, path) {
    if (value == null) return null;
    const list = denseArray(value, path);
    if (list.length !== 4) fail(path, "expected four finite components or null");
    return Object.freeze(list.map((entry, index) => finite(entry, `${path}.${index}`)));
}

function intrinsicChannel(value, path) {
    const source = allowedKeys(value ?? {}, CHANNEL_KEYS, path);
    return Object.freeze({
        name: text(source.name, `${path}.name`, { identifier: true }),
        units: text(source.units, `${path}.units`, { identifier: true }),
        encoding: text(source.encoding, `${path}.encoding`, { identifier: true }),
        confidenceEncoding: text(source.confidenceEncoding, `${path}.confidenceEncoding`, { identifier: true }),
        knownMaskEncoding: text(source.knownMaskEncoding, `${path}.knownMaskEncoding`, { identifier: true }),
        declaredDefault: defaultVector(source.declaredDefault ?? null, `${path}.declaredDefault`),
        absentPolicy: enumValue(
            source.absentPolicy ?? UNKNOWN_ABSENT_POLICY,
            [UNKNOWN_ABSENT_POLICY],
            `${path}.absentPolicy`,
        ),
    });
}

export function normalizeBakeConstruction(value = {}, { implicitProjected = false } = {}) {
    const source = value && typeof value === "object" ? value : {};
    if (implicitProjected && Object.keys(source).length === 0) {
        return DEFAULT_PROJECTED_CONSTRUCTION;
    }
    allowedKeys(source, CONSTRUCTION_KEYS, "construction");
    if ((source.kind ?? BAKE_CONSTRUCTION_KIND) !== BAKE_CONSTRUCTION_KIND) {
        fail("construction.kind", `expected ${BAKE_CONSTRUCTION_KIND}`);
    }
    if ((source.version ?? BAKE_CONSTRUCTION_VERSION) !== BAKE_CONSTRUCTION_VERSION) {
        fail("construction.version", "unsupported bake-construction version");
    }
    const defaults = (source.outputMode ?? CHUNK_ATLAS_OUTPUT_MODE) === PROJECTED_CAPTURED_RADIANCE_OUTPUT_MODE
        ? DEFAULT_PROJECTED_CONSTRUCTION
        : DEFAULT_ATLAS_CONSTRUCTION;
    const channels = Object.freeze(
        denseArray(source.intrinsicChannels ?? [], "construction.intrinsicChannels")
            .map((entry, index) => intrinsicChannel(entry, `construction.intrinsicChannels.${index}`))
            .sort((left, right) => compareUtf8(left.name, right.name)),
    );
    const names = channels.map((entry) => entry.name);
    if (new Set(names).size !== names.length) {
        fail("construction.intrinsicChannels", "contains duplicate channel names");
    }
    const appearanceMode = enumValue(
        source.appearanceMode ?? defaults.appearanceMode,
        APPEARANCE_MODES,
        "construction.appearanceMode",
    );
    if (appearanceMode === CAPTURED_RADIANCE_UNLIT && channels.length) {
        fail("construction.intrinsicChannels", "captured-radiance-unlit cannot carry intrinsic PBR channels");
    }
    const overflowPolicy = enumValue(
        source.overflowPolicy ?? defaults.overflowPolicy,
        [FAIL_CLOSED_OVERFLOW],
        "construction.overflowPolicy",
    );
    return Object.freeze({
        kind: BAKE_CONSTRUCTION_KIND,
        version: BAKE_CONSTRUCTION_VERSION,
        outputMode: enumValue(source.outputMode ?? defaults.outputMode, OUTPUT_MODES, "construction.outputMode"),
        appearanceMode,
        uvAlgorithm: enumValue(
            source.uvAlgorithm ?? defaults.uvAlgorithm,
            [STABLE_CHART_UV_ALGORITHM],
            "construction.uvAlgorithm",
        ),
        fusionPolicy: enumValue(
            source.fusionPolicy ?? defaults.fusionPolicy,
            [CONFIDENCE_CAMERA_DISTANCE_FUSION],
            "construction.fusionPolicy",
        ),
        encoderRevision: enumValue(
            source.encoderRevision ?? defaults.encoderRevision,
            [ATLAS_ENCODER_REVISION],
            "construction.encoderRevision",
        ),
        pageSizePx: integer(source.pageSizePx ?? defaults.pageSizePx, "construction.pageSizePx", { min: 8 }),
        paddingPx: integer(source.paddingPx ?? defaults.paddingPx, "construction.paddingPx", { min: 0 }),
        texelDensityPerMeter: (() => {
            const density = finite(
                source.texelDensityPerMeter ?? defaults.texelDensityPerMeter,
                "construction.texelDensityPerMeter",
            );
            if (!(density > 0)) fail("construction.texelDensityPerMeter", "expected a number > 0");
            return density;
        })(),
        maxPagesPerChunk: integer(
            source.maxPagesPerChunk ?? defaults.maxPagesPerChunk,
            "construction.maxPagesPerChunk",
            { min: 1 },
        ),
        seamAngleDeg: finite(source.seamAngleDeg ?? defaults.seamAngleDeg, "construction.seamAngleDeg"),
        overflowPolicy,
        chunkSizeMeters: (() => {
            const size = finite(
                source.chunkSizeMeters ?? defaults.chunkSizeMeters,
                "construction.chunkSizeMeters",
            );
            if (!(size > 0)) fail("construction.chunkSizeMeters", "expected a number > 0");
            return size;
        })(),
        intrinsicChannels: channels,
    });
}

export function assertBakeConstruction(value) {
    const normalized = normalizeBakeConstruction(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("construction", "immutable construction policy is not in canonical normalized form");
    }
    return value;
}

export function hashBakeConstruction(value) {
    return sha256ExactUtf8(canonicalExactStringify(normalizeBakeConstruction(value)));
}

export function isChunkAtlasConstruction(construction) {
    return construction?.outputMode === CHUNK_ATLAS_OUTPUT_MODE;
}

export function constructionFromConfig(config) {
    if (config?.version === 2 && config.construction) {
        return normalizeBakeConstruction(config.construction);
    }
    return DEFAULT_PROJECTED_CONSTRUCTION;
}

export function persistentRolesForConstruction(construction) {
    return isChunkAtlasConstruction(construction)
        ? [...ATLAS_PERSISTENT_BAKE_OUTPUT_ROLES]
        : [...PROJECTED_PERSISTENT_BAKE_OUTPUT_ROLES];
}

export function writerForConstruction(construction) {
    if (isChunkAtlasConstruction(construction)) {
        return Object.freeze({
            id: CHUNK_ATLAS_WRITER.id,
            version: CHUNK_ATLAS_WRITER.version,
            constructionHash: hashBakeConstruction(construction),
        });
    }
    return Object.freeze({
        id: "projected-captured-radiance",
        version: 1,
    });
}

export function seamCosine(construction) {
    const degrees = Number(construction?.seamAngleDeg ?? DEFAULT_ATLAS_CONSTRUCTION.seamAngleDeg);
    return Math.cos((degrees * Math.PI) / 180);
}
