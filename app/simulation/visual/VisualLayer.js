import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

/**
 * @typedef {object} VisualAssetReference
 * @property {string} sha256 Lowercase exact-byte SHA-256 digest.
 * @property {string} mediaType Approved static visual media type.
 * @property {number} sizeBytes Non-negative safe-integer byte length.
 * @property {string} role Resource role within the closed visual graph.
 */

/**
 * @typedef {object} VisualLayerDescriptor
 * @property {"cev-sim.visual-layer"} kind
 * @property {1} version
 * @property {string} sourceWorldHash
 * @property {{ id: "static-gltf-surface", version: 1 }} assetProfile
 * @property {VisualAssetReference[]} assets
 * @property {Array<object>} materials
 * @property {Array<object>} chunks
 * @property {Array<object>} instances
 * @property {Array<object>} bindings
 * @property {string[]} appearanceDependencies
 */

/**
 * @typedef {object} VisualSourceRecord
 * @property {string} id
 * @property {string} kind
 * @property {"active"|"revoked"|string} status
 * @property {string[]} [ancestorIds]
 * @property {Record<string, boolean>} [permissions]
 * @property {string} [notBefore]
 * @property {string} [expiresAt]
 * @property {{ attribution?: string[], requirements?: string[], retentionUntil?: string }} [obligations]
 */

/**
 * @typedef {object} VisualSourcePolicyDecision
 * @property {boolean} allowed
 * @property {string[]} evaluatedSourceIds
 * @property {string[]} operations
 * @property {Array<{ sourceId: string, operation: string|null, code: string }>} denials
 * @property {{ attribution: string[], requirements: string[], retentionUntil: string|null }} obligations
 */

export const VISUAL_LAYER_KIND = "cev-sim.visual-layer";
export const VISUAL_LAYER_VERSION = 1;
export const VISUAL_ASSET_PROFILE = Object.freeze({ id: "static-gltf-surface", version: 1 });
export const VISUAL_CONTRACT_VERSIONS = Object.freeze({
    runBundle: 1,
    correctedRunManifest: 11,
    identityProfile: Object.freeze({ id: "world-bound", version: 2 }),
    simulationSemantics: 2,
    episodeIdentity: 2,
    worldDescription: 1,
    identityProtocolMinor: 3,
    assetAdmissionProtocolMinor: 4,
});
export const VISUAL_RENDER_PROVIDERS = Object.freeze({
    legacyAnalytic: Object.freeze({ id: "canonical-analytic", version: 1 }),
    correctedAnalytic: Object.freeze({ id: "canonical-analytic", version: 2 }),
    pbrMesh: Object.freeze({ id: "pbr-mesh", version: 1 }),
});
export const VISUAL_CAMERA_PRODUCT_PROFILE = Object.freeze({
    id: "measured-rgba-analytic-oracle",
    version: 1,
    measured: Object.freeze(["rgba", "camera-info"]),
    optionalOracle: Object.freeze(["depth", "semantic", "instance"]),
});
export const VISUAL_CAMERA_BUFFER_CONTRACT = Object.freeze({
    origin: "top-left",
    pixelCenters: "integer",
    measuredRgba: "rgba8-srgb",
    depth: "float32-little-endian-axial-meters",
    normal: "float32-little-endian-geometric-world",
    worldPosition: "float32-little-endian-world-meters",
    confidence: "float32-little-endian",
    ids: "uint32-little-endian",
    invalid: "zero-with-explicit-validity-mask",
    distortionModels: Object.freeze(["none", "brown-conrady-5", "brown-conrady-rational-8"]),
});

export const VISUAL_ASSET_MEDIA_TYPES = Object.freeze([
    "image/jpeg",
    "image/ktx2",
    "image/png",
    "model/gltf+json",
    "model/gltf-binary",
]);
export const VISUAL_ASSET_ROLES = Object.freeze([
    "actor",
    "environment-map",
    "mesh",
    "texture",
]);
export const VISUAL_MATERIAL_MODES = Object.freeze([
    "metallic-roughness",
    "unlit-captured-radiance",
]);
export const VISUAL_ALPHA_MODES = Object.freeze(["MASK", "OPAQUE"]);
export const VISUAL_MATERIAL_EXTENSIONS = Object.freeze([
    "KHR_materials_clearcoat",
    "KHR_materials_emissive_strength",
    "KHR_materials_sheen",
    "KHR_materials_specular",
    "KHR_materials_unlit",
    "KHR_texture_basisu",
    "KHR_texture_transform",
]);
export const VISUAL_TEXTURE_SLOTS = Object.freeze([
    "baseColor",
    "clearcoat",
    "clearcoatNormal",
    "clearcoatRoughness",
    "emissive",
    "metallicRoughness",
    "normal",
    "occlusion",
    "sheenColor",
    "sheenRoughness",
    "specular",
    "specularColor",
]);

export const VISUAL_SOURCE_OPERATIONS = Object.freeze([
    "display",
    "transient-cache",
    "persistent-cache",
    "derivatives",
    "machine-interpretation",
    "ml",
    "worker-access",
    "export",
    "retention",
    "attribution",
    "live-preview-display",
]);

export const RUN_PACKAGE_PROFILE = Object.freeze({
    kind: "cev-sim.run-package",
    version: 1,
    container: "ustar",
    compression: "none",
    entryOrder: Object.freeze(["manifest.json", "bundle.json", "assets/sha256/<digest> (UTF-8 sorted)"]),
    header: Object.freeze({
        type: "regular-file",
        mode: 0o644,
        uid: 0,
        gid: 0,
        mtime: 0,
        ownerName: "",
        groupName: "",
        terminalZeroBlocks: 2,
        trailingContent: false,
    }),
    limits: Object.freeze({
        archiveBytes: 8 * 1024 ** 3,
        assetBytes: 1024 ** 3,
        bundleBytes: 32 * 1024 ** 2,
        manifestBytes: 4 * 1024 ** 2,
        assetEntries: 16_384,
        graphDepth: 64,
        nodesPerMesh: 100_000,
        trianglesPerMesh: 4_000_000,
        textureDimension: 8_192,
        textureMipLevels: 14,
    }),
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_URI_PATTERN = /^sha256:([a-f0-9]{64})$/;
const textEncoder = new TextEncoder();

function fail(path, message) {
    throw new TypeError(`${path}: ${message}`);
}

function plainObject(value, path) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
        fail(path, "expected an object");
    }
    return value;
}

function assertKeys(value, allowed, path) {
    const unknown = Object.keys(value).find((key) => !allowed.includes(key));
    if (unknown) fail(`${path}.${unknown}`, "unknown field");
}

function assertNoLoneSurrogates(value, path) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail(path, "contains a lone surrogate");
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            fail(path, "contains a lone surrogate");
        }
    }
}

function string(value, path, { identifier = false } = {}) {
    if (typeof value !== "string") fail(path, "expected a string");
    assertNoLoneSurrogates(value, path);
    if (identifier && (!value || value !== value.normalize("NFC"))) {
        fail(path, "identifier must be non-empty NFC text");
    }
    return value;
}

function number(value, path) {
    if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected a finite number");
    return Object.is(value, -0) ? 0 : value;
}

function boundedNumber(value, minimum, maximum, path) {
    const result = number(value, path);
    if (result < minimum || result > maximum) fail(path, `expected a number in [${minimum}, ${maximum}]`);
    return result;
}

function nonNegativeNumber(value, path) {
    const result = number(value, path);
    if (result < 0) fail(path, "expected a non-negative number");
    return result;
}

function integer(value, path) {
    const result = number(value, path);
    if (!Number.isSafeInteger(result) || result < 0) fail(path, "expected a non-negative safe integer");
    return result;
}

function boolean(value, path) {
    if (typeof value !== "boolean") fail(path, "expected a boolean");
    return value;
}

function digest(value, path) {
    const result = string(value, path);
    if (!SHA256_PATTERN.test(result)) fail(path, "expected a lowercase SHA-256 digest");
    return result;
}

function digestUri(value, path) {
    const result = string(value, path);
    if (!SHA256_URI_PATTERN.test(result)) fail(path, "expected sha256:<lowercase-digest>");
    return result;
}

function enumValue(value, values, path) {
    const result = string(value, path);
    if (!values.includes(result)) fail(path, `unsupported value ${JSON.stringify(result)}`);
    return result;
}

function compareUtf8(left, right) {
    const a = textEncoder.encode(left);
    const b = textEncoder.encode(right);
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
        if (a[index] !== b[index]) return a[index] - b[index];
    }
    return a.length - b.length;
}

function assertDenseJsonArray(value, path) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        fail(path, "sparse or extended arrays are outside the JSON data model");
    }
}

function uniqueSorted(values, path, normalize = (entry, itemPath) => string(entry, itemPath, { identifier: true })) {
    if (!Array.isArray(values)) fail(path, "expected an array");
    assertDenseJsonArray(values, path);
    const result = Array.from(values, (entry, index) => normalize(entry, `${path}.${index}`));
    const entryKey = (entry) => {
        if (typeof entry === "string") return entry;
        return entry.id ?? entry.slot ?? entry.sha256;
    };
    const unique = new Set(result.map(entryKey));
    if (unique.size !== result.length) fail(path, "contains duplicate entries");
    return result.sort((left, right) => compareUtf8(
        entryKey(left),
        entryKey(right),
    ));
}

function exactTree(value, path = "$", seen = new WeakSet()) {
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
        assertNoLoneSurrogates(value, path);
        return value;
    }
    if (typeof value === "number") return number(value, path);
    if (!value || typeof value !== "object" || typeof value === "bigint") {
        fail(path, "value is outside the JSON data model");
    }
    if (seen.has(value)) fail(path, "circular value");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            assertDenseJsonArray(value, path);
            return Array.from(value, (entry, index) => exactTree(entry, `${path}.${index}`, seen));
        }
        plainObject(value, path);
        if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "symbol keys are outside the JSON data model");
        const result = {};
        // RFC 8785/JCS uses the JSON string ordering implemented by UTF-16 property comparison.
        for (const key of Object.keys(value).sort()) {
            assertNoLoneSurrogates(key, `${path} key`);
            result[key] = exactTree(value[key], `${path}.${key}`, seen);
        }
        return result;
    } finally {
        seen.delete(value);
    }
}

function canonicalExactValue(value, path = "$", seen = new WeakSet()) {
    if (value === null) return "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") {
        assertNoLoneSurrogates(value, path);
        return JSON.stringify(value);
    }
    if (typeof value === "number") return JSON.stringify(number(value, path));
    if (!value || typeof value !== "object" || typeof value === "bigint") {
        fail(path, "value is outside the JSON data model");
    }
    if (seen.has(value)) fail(path, "circular value");
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            assertDenseJsonArray(value, path);
            return `[${Array.from(value, (entry, index) => canonicalExactValue(entry, `${path}.${index}`, seen)).join(",")}]`;
        }
        plainObject(value, path);
        if (Object.getOwnPropertySymbols(value).length > 0) fail(path, "symbol keys are outside the JSON data model");
        const fields = Object.keys(value).sort().map((key) => {
            assertNoLoneSurrogates(key, `${path} key`);
            return `${JSON.stringify(key)}:${canonicalExactValue(value[key], `${path}.${key}`, seen)}`;
        });
        return `{${fields.join(",")}}`;
    } finally {
        seen.delete(value);
    }
}

/** RFC 8785-compatible JSON for I-JSON values supported by the visual contracts. */
export function canonicalExactStringify(value) {
    return canonicalExactValue(value);
}

export function sha256ExactBytes(value) {
    let bytes;
    if (value instanceof Uint8Array) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    else throw new TypeError("Exact byte hashing requires an ArrayBuffer or typed-array view.");
    return bytesToHex(sha256(bytes));
}

export function sha256ExactUtf8(value) {
    return sha256ExactBytes(textEncoder.encode(string(value, "text")));
}

function scanJsonKeys(source) {
    let index = 0;
    const whitespace = () => {
        while (/\s/u.test(source[index] || "")) index += 1;
    };
    const tokenString = () => {
        const start = index;
        index += 1;
        while (index < source.length) {
            const character = source[index];
            if (character === "\\") {
                index += 2;
                continue;
            }
            index += 1;
            if (character === "\"") return JSON.parse(source.slice(start, index));
        }
        throw new SyntaxError("Unterminated JSON string.");
    };
    const value = () => {
        whitespace();
        if (source[index] === "{") {
            index += 1;
            whitespace();
            const keys = new Set();
            if (source[index] === "}") { index += 1; return; }
            while (index < source.length) {
                if (source[index] !== "\"") throw new SyntaxError("Expected a JSON object key.");
                const key = tokenString();
                if (keys.has(key)) throw new SyntaxError(`Duplicate JSON object key ${JSON.stringify(key)}.`);
                keys.add(key);
                whitespace();
                if (source[index] !== ":") throw new SyntaxError("Expected ':' after a JSON object key.");
                index += 1;
                value();
                whitespace();
                if (source[index] === "}") { index += 1; return; }
                if (source[index] !== ",") throw new SyntaxError("Expected ',' in a JSON object.");
                index += 1;
                whitespace();
            }
        } else if (source[index] === "[") {
            index += 1;
            whitespace();
            if (source[index] === "]") { index += 1; return; }
            while (index < source.length) {
                value();
                whitespace();
                if (source[index] === "]") { index += 1; return; }
                if (source[index] !== ",") throw new SyntaxError("Expected ',' in a JSON array.");
                index += 1;
            }
        } else if (source[index] === "\"") {
            tokenString();
        } else {
            const match = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
            if (!match) throw new SyntaxError("Invalid JSON value.");
            index += match[0].length;
        }
    };
    whitespace();
    value();
    whitespace();
    if (index !== source.length) throw new SyntaxError("Trailing data after JSON value.");
}

/** Parse JSON while rejecting duplicate keys before JSON.parse can discard them. */
export function parseExactJson(value) {
    const source = string(value, "json");
    if (source.charCodeAt(0) === 0xfeff) throw new SyntaxError("JSON must not contain a byte-order mark.");
    scanJsonKeys(source);
    return exactTree(JSON.parse(source));
}

function vector(value, size, path, fallback) {
    const source = value === undefined ? fallback : value;
    if (!Array.isArray(source) || source.length !== size) fail(path, `expected ${size} numbers`);
    assertDenseJsonArray(source, path);
    return Array.from(source, (entry, index) => number(entry, `${path}.${index}`));
}

function boundedVector(value, size, path, fallback) {
    return vector(value, size, path, fallback)
        .map((entry, index) => boundedNumber(entry, 0, 1, `${path}.${index}`));
}

function matrix(value, path) {
    const result = vector(value, 16, path);
    if (result[3] !== 0 || result[7] !== 0 || result[11] !== 0 || result[15] !== 1) {
        fail(path, "expected a column-major affine matrix");
    }
    const determinant = result[0] * (result[5] * result[10] - result[9] * result[6])
        - result[4] * (result[1] * result[10] - result[9] * result[2])
        + result[8] * (result[1] * result[6] - result[5] * result[2]);
    if (determinant === 0) fail(path, "matrix must be nonsingular");
    return result;
}

function normalizeAsset(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["sha256", "mediaType", "sizeBytes", "role"], path);
    return {
        sha256: digest(source.sha256, `${path}.sha256`),
        mediaType: enumValue(source.mediaType, VISUAL_ASSET_MEDIA_TYPES, `${path}.mediaType`),
        sizeBytes: integer(source.sizeBytes, `${path}.sizeBytes`),
        role: enumValue(source.role, VISUAL_ASSET_ROLES, `${path}.role`),
    };
}

const PARAMETER_DEFAULTS = Object.freeze({
    baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1,
    emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1,
    occlusionStrength: 1, clearcoatFactor: 0, clearcoatRoughnessFactor: 0,
    sheenColorFactor: [0, 0, 0], sheenRoughnessFactor: 0,
    specularFactor: 1, specularColorFactor: [1, 1, 1],
});

function normalizeParameters(value, path) {
    const source = plainObject(value ?? {}, path);
    assertKeys(source, Object.keys(PARAMETER_DEFAULTS), path);
    return {
        baseColorFactor: boundedVector(source.baseColorFactor, 4, `${path}.baseColorFactor`, PARAMETER_DEFAULTS.baseColorFactor),
        metallicFactor: boundedNumber(source.metallicFactor ?? 1, 0, 1, `${path}.metallicFactor`),
        roughnessFactor: boundedNumber(source.roughnessFactor ?? 1, 0, 1, `${path}.roughnessFactor`),
        emissiveFactor: boundedVector(source.emissiveFactor, 3, `${path}.emissiveFactor`, PARAMETER_DEFAULTS.emissiveFactor),
        emissiveStrength: nonNegativeNumber(source.emissiveStrength ?? 1, `${path}.emissiveStrength`),
        normalScale: number(source.normalScale ?? 1, `${path}.normalScale`),
        occlusionStrength: boundedNumber(source.occlusionStrength ?? 1, 0, 1, `${path}.occlusionStrength`),
        clearcoatFactor: boundedNumber(source.clearcoatFactor ?? 0, 0, 1, `${path}.clearcoatFactor`),
        clearcoatRoughnessFactor: boundedNumber(source.clearcoatRoughnessFactor ?? 0, 0, 1, `${path}.clearcoatRoughnessFactor`),
        sheenColorFactor: boundedVector(source.sheenColorFactor, 3, `${path}.sheenColorFactor`, PARAMETER_DEFAULTS.sheenColorFactor),
        sheenRoughnessFactor: boundedNumber(source.sheenRoughnessFactor ?? 0, 0, 1, `${path}.sheenRoughnessFactor`),
        specularFactor: boundedNumber(source.specularFactor ?? 1, 0, 1, `${path}.specularFactor`),
        specularColorFactor: boundedVector(source.specularColorFactor, 3, `${path}.specularColorFactor`, PARAMETER_DEFAULTS.specularColorFactor),
    };
}

function normalizeTexture(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["slot", "assetUri", "texCoord", "transform"], path);
    const transform = plainObject(source.transform ?? {}, `${path}.transform`);
    assertKeys(transform, ["offset", "rotation", "scale"], `${path}.transform`);
    return {
        slot: enumValue(source.slot, VISUAL_TEXTURE_SLOTS, `${path}.slot`),
        assetUri: digestUri(source.assetUri, `${path}.assetUri`),
        texCoord: integer(source.texCoord ?? 0, `${path}.texCoord`),
        transform: {
            offset: vector(transform.offset, 2, `${path}.transform.offset`, [0, 0]),
            rotation: number(transform.rotation ?? 0, `${path}.transform.rotation`),
            scale: vector(transform.scale, 2, `${path}.transform.scale`, [1, 1]),
        },
    };
}

function normalizeMaterial(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["id", "mode", "alphaMode", "alphaCutoff", "doubleSided", "parameters", "textures", "extensions"], path);
    const textures = uniqueSorted(source.textures ?? [], `${path}.textures`, normalizeTexture);
    const slots = textures.map((entry) => entry.slot);
    if (new Set(slots).size !== slots.length) fail(`${path}.textures`, "contains duplicate texture slots");
    const extensions = uniqueSorted(source.extensions ?? [], `${path}.extensions`, (entry, itemPath) => (
        enumValue(entry, VISUAL_MATERIAL_EXTENSIONS, itemPath)
    ));
    const mode = enumValue(source.mode ?? "metallic-roughness", VISUAL_MATERIAL_MODES, `${path}.mode`);
    if (mode === "unlit-captured-radiance" && !extensions.includes("KHR_materials_unlit")) {
        fail(`${path}.extensions`, "captured radiance requires KHR_materials_unlit");
    }
    return {
        id: string(source.id, `${path}.id`, { identifier: true }),
        mode,
        alphaMode: enumValue(source.alphaMode ?? "OPAQUE", VISUAL_ALPHA_MODES, `${path}.alphaMode`),
        alphaCutoff: boundedNumber(source.alphaCutoff ?? 0.5, 0, 1, `${path}.alphaCutoff`),
        doubleSided: boolean(source.doubleSided ?? false, `${path}.doubleSided`),
        parameters: normalizeParameters(source.parameters, `${path}.parameters`),
        textures,
        extensions,
    };
}

function normalizeInstance(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["id", "assetUri", "lodLevels", "matrix", "chunkIds", "materialIds"], path);
    const assetUri = digestUri(source.assetUri, `${path}.assetUri`);
    let lodLevels;
    if (source.lodLevels === undefined) {
        lodLevels = [assetUri];
    } else {
        if (!Array.isArray(source.lodLevels) || source.lodLevels.length === 0) {
            fail(`${path}.lodLevels`, "expected a non-empty ordered array");
        }
        assertDenseJsonArray(source.lodLevels, `${path}.lodLevels`);
        lodLevels = source.lodLevels.map((entry, index) => digestUri(entry, `${path}.lodLevels.${index}`));
        if (new Set(lodLevels).size !== lodLevels.length) fail(`${path}.lodLevels`, "contains duplicate entries");
    }
    if (lodLevels[0] !== assetUri) fail(`${path}.lodLevels.0`, "must match the primary assetUri");
    return {
        id: string(source.id, `${path}.id`, { identifier: true }),
        assetUri,
        lodLevels,
        matrix: matrix(source.matrix, `${path}.matrix`),
        chunkIds: uniqueSorted(source.chunkIds ?? [], `${path}.chunkIds`),
        materialIds: uniqueSorted(source.materialIds ?? [], `${path}.materialIds`),
    };
}

function normalizeChunk(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["id", "instanceIds", "dependencyUris"], path);
    return {
        id: string(source.id, `${path}.id`, { identifier: true }),
        instanceIds: uniqueSorted(source.instanceIds ?? [], `${path}.instanceIds`),
        dependencyUris: uniqueSorted(source.dependencyUris ?? [], `${path}.dependencyUris`, digestUri),
    };
}

function normalizeBinding(value, path) {
    const source = plainObject(value, path);
    assertKeys(source, ["id", "instanceId", "truthEntityId"], path);
    return {
        id: string(source.id, `${path}.id`, { identifier: true }),
        instanceId: string(source.instanceId, `${path}.instanceId`, { identifier: true }),
        truthEntityId: string(source.truthEntityId, `${path}.truthEntityId`, { identifier: true }),
    };
}

/**
 * Normalize mutable authoring input into the immutable visual-layer v1 shape.
 * @param {unknown} value
 * @returns {VisualLayerDescriptor}
 */
export function normalizeVisualLayer(value) {
    const source = plainObject(value, "visualLayer");
    assertKeys(source, ["kind", "version", "sourceWorldHash", "assetProfile", "assets", "materials", "chunks", "instances", "bindings", "appearanceDependencies"], "visualLayer");
    const profile = plainObject(source.assetProfile ?? VISUAL_ASSET_PROFILE, "visualLayer.assetProfile");
    assertKeys(profile, ["id", "version"], "visualLayer.assetProfile");
    const normalizedProfile = {
        id: string(profile.id, "visualLayer.assetProfile.id", { identifier: true }),
        version: integer(profile.version, "visualLayer.assetProfile.version"),
    };
    if (normalizedProfile.id !== VISUAL_ASSET_PROFILE.id || normalizedProfile.version !== VISUAL_ASSET_PROFILE.version) {
        fail("visualLayer.assetProfile", "unsupported asset profile");
    }
    const assets = uniqueSorted(source.assets ?? [], "visualLayer.assets", normalizeAsset)
        .sort((left, right) => compareUtf8(left.sha256, right.sha256));
    if (new Set(assets.map((entry) => entry.sha256)).size !== assets.length) fail("visualLayer.assets", "contains duplicate digests");
    const result = {
        kind: source.kind ?? VISUAL_LAYER_KIND,
        version: source.version ?? VISUAL_LAYER_VERSION,
        sourceWorldHash: digest(source.sourceWorldHash, "visualLayer.sourceWorldHash"),
        assetProfile: normalizedProfile,
        assets,
        materials: uniqueSorted(source.materials ?? [], "visualLayer.materials", normalizeMaterial),
        chunks: uniqueSorted(source.chunks ?? [], "visualLayer.chunks", normalizeChunk),
        instances: uniqueSorted(source.instances ?? [], "visualLayer.instances", normalizeInstance),
        bindings: uniqueSorted(source.bindings ?? [], "visualLayer.bindings", normalizeBinding),
        appearanceDependencies: uniqueSorted(source.appearanceDependencies ?? [], "visualLayer.appearanceDependencies", digestUri),
    };
    if (result.kind !== VISUAL_LAYER_KIND || result.version !== VISUAL_LAYER_VERSION) {
        fail("visualLayer", `expected ${VISUAL_LAYER_KIND} version ${VISUAL_LAYER_VERSION}`);
    }
    validateReferences(result);
    return result;
}

function validateReferences(layer) {
    const assets = new Set(layer.assets.map((entry) => entry.sha256));
    const assetForUri = (uri, path) => {
        const match = SHA256_URI_PATTERN.exec(uri);
        if (!match || !assets.has(match[1])) fail(path, `references missing asset ${uri}`);
    };
    layer.appearanceDependencies.forEach((uri, index) => assetForUri(uri, `visualLayer.appearanceDependencies.${index}`));
    const materials = new Set(layer.materials.map((entry) => entry.id));
    for (const [index, material] of layer.materials.entries()) {
        material.textures.forEach((texture, textureIndex) => assetForUri(texture.assetUri, `visualLayer.materials.${index}.textures.${textureIndex}.assetUri`));
    }
    const chunks = new Map(layer.chunks.map((entry) => [entry.id, entry]));
    const instances = new Map(layer.instances.map((entry) => [entry.id, entry]));
    for (const [index, chunk] of layer.chunks.entries()) {
        chunk.dependencyUris.forEach((uri, dependencyIndex) => assetForUri(uri, `visualLayer.chunks.${index}.dependencyUris.${dependencyIndex}`));
        for (const instanceId of chunk.instanceIds) {
            const instance = instances.get(instanceId);
            if (!instance) fail(`visualLayer.chunks.${index}.instanceIds`, `references missing instance ${instanceId}`);
            if (!instance.chunkIds.includes(chunk.id)) fail(`visualLayer.chunks.${index}.instanceIds`, `instance ${instanceId} does not bind back to chunk ${chunk.id}`);
        }
    }
    for (const [index, instance] of layer.instances.entries()) {
        assetForUri(instance.assetUri, `visualLayer.instances.${index}.assetUri`);
        instance.lodLevels.forEach((uri, lodIndex) => assetForUri(uri, `visualLayer.instances.${index}.lodLevels.${lodIndex}`));
        for (const chunkId of instance.chunkIds) {
            const chunk = chunks.get(chunkId);
            if (!chunk) fail(`visualLayer.instances.${index}.chunkIds`, `references missing chunk ${chunkId}`);
            if (!chunk.instanceIds.includes(instance.id)) fail(`visualLayer.instances.${index}.chunkIds`, `chunk ${chunkId} does not bind back to instance ${instance.id}`);
        }
        for (const materialId of instance.materialIds) {
            if (!materials.has(materialId)) fail(`visualLayer.instances.${index}.materialIds`, `references missing material ${materialId}`);
        }
    }
    for (const [index, binding] of layer.bindings.entries()) {
        if (!instances.has(binding.instanceId)) fail(`visualLayer.bindings.${index}.instanceId`, `references missing instance ${binding.instanceId}`);
    }
}

/**
 * Validate immutable input without accepting normalization or reordered collections.
 * @param {unknown} value
 * @returns {VisualLayerDescriptor}
 */
export function assertVisualLayer(value) {
    const normalized = normalizeVisualLayer(value);
    if (canonicalExactStringify(normalized) !== canonicalExactStringify(value)) {
        fail("visualLayer", "immutable descriptor is not in canonical normalized form");
    }
    return value;
}

/** @param {string} value @returns {VisualLayerDescriptor} */
export function parseVisualLayerJson(value) {
    const parsed = parseExactJson(value);
    assertVisualLayer(parsed);
    return parsed;
}

/** @param {VisualLayerDescriptor} value @returns {string} */
export function hashVisualLayer(value) {
    assertVisualLayer(value);
    return sha256ExactUtf8(canonicalExactStringify(value));
}

function registryEntry(registry, id) {
    if (registry instanceof Map) return registry.get(id);
    if (typeof registry?.getSource === "function") return registry.getSource(id);
    return registry?.[id];
}

function trustedTime(value, path) {
    if (value === undefined || value === null || value === "") return null;
    const result = new Date(value);
    if (!Number.isFinite(result.getTime())) fail(path, "expected an ISO-compatible time");
    return result;
}

/**
 * Evaluate selected sources and every ancestor against a trusted operator registry.
 * Imported asset metadata is deliberately absent from this interface.
 * @param {{ sourceIds?: string[], operations?: string[], registry?: Map<string, VisualSourceRecord>|Record<string, VisualSourceRecord>|{ getSource(id: string): VisualSourceRecord|undefined }, atTime: Date|string|number }} [request]
 * @returns {VisualSourcePolicyDecision}
 */
export function evaluateVisualSourcePolicy({ sourceIds = [], operations = [], registry, atTime } = {}) {
    const requestedSources = uniqueSorted(sourceIds, "sourceIds");
    const requestedOperations = uniqueSorted(operations, "operations", (entry, path) => (
        enumValue(entry, VISUAL_SOURCE_OPERATIONS, path)
    ));
    if (atTime === undefined) fail("atTime", "is required for deterministic policy evaluation");
    const timestamp = atTime instanceof Date ? atTime : new Date(atTime);
    if (!Number.isFinite(timestamp.getTime())) fail("atTime", "expected a valid time");
    const denials = [];
    const evaluated = new Set();
    const attribution = new Set();
    const requirements = new Set();
    let retentionUntil = null;

    const visit = (id, lineage) => {
        if (lineage.includes(id)) {
            denials.push({ sourceId: id, operation: null, code: "SOURCE_CYCLE" });
            return;
        }
        if (evaluated.has(id)) return;
        const record = registryEntry(registry, id);
        if (!record) {
            denials.push({ sourceId: id, operation: null, code: "SOURCE_NOT_TRUSTED" });
            evaluated.add(id);
            return;
        }
        const source = plainObject(record, `registry.${id}`);
        const trustedId = string(source.id, `registry.${id}.id`, { identifier: true });
        if (trustedId !== id) fail(`registry.${id}.id`, "does not match registry key");
        if (!Array.isArray(source.ancestorIds ?? [])) fail(`registry.${id}.ancestorIds`, "expected an array");
        for (const ancestorId of source.ancestorIds ?? []) {
            visit(string(ancestorId, `registry.${id}.ancestorIds`, { identifier: true }), [...lineage, id]);
        }
        if (source.status === "revoked") {
            denials.push({ sourceId: id, operation: null, code: "SOURCE_REVOKED" });
        } else if (source.status !== "active") {
            denials.push({ sourceId: id, operation: null, code: "SOURCE_INACTIVE" });
        }
        const notBefore = trustedTime(source.notBefore, `registry.${id}.notBefore`);
        const expiresAt = trustedTime(source.expiresAt, `registry.${id}.expiresAt`);
        if (notBefore && timestamp < notBefore) {
            denials.push({ sourceId: id, operation: null, code: "SOURCE_NOT_YET_VALID" });
        }
        if (expiresAt && timestamp >= expiresAt) {
            denials.push({ sourceId: id, operation: null, code: "SOURCE_EXPIRED" });
        }
        for (const operation of requestedOperations) {
            if (source.permissions?.[operation] !== true) {
                denials.push({
                    sourceId: id,
                    operation,
                    code: source.kind === "google-derived" && operation !== "live-preview-display"
                        ? "GOOGLE_GRANT_REQUIRED"
                        : "OPERATION_NOT_GRANTED",
                });
            }
        }
        for (const entry of source.obligations?.attribution ?? []) {
            attribution.add(string(entry, `registry.${id}.obligations.attribution`));
        }
        for (const entry of source.obligations?.requirements ?? []) {
            requirements.add(string(entry, `registry.${id}.obligations.requirements`));
        }
        if (source.obligations?.retentionUntil) {
            const candidate = trustedTime(source.obligations.retentionUntil, `registry.${id}.obligations.retentionUntil`);
            if (!retentionUntil || candidate > retentionUntil) retentionUntil = candidate;
        }
        evaluated.add(id);
    };
    requestedSources.forEach((id) => visit(id, []));
    denials.sort((left, right) => compareUtf8(
        `${left.sourceId}\0${left.operation ?? ""}\0${left.code}`,
        `${right.sourceId}\0${right.operation ?? ""}\0${right.code}`,
    ));
    return {
        allowed: denials.length === 0,
        evaluatedSourceIds: [...evaluated].sort(compareUtf8),
        operations: requestedOperations,
        denials,
        obligations: {
            attribution: [...attribution].sort(compareUtf8),
            requirements: [...requirements].sort(compareUtf8),
            retentionUntil: retentionUntil?.toISOString() ?? null,
        },
    };
}
