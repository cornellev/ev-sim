/**
 * VIS-08 bake artifact set: deterministic projected captured-radiance PNG/GLB
 * outputs merged into the current visual-layer descriptor/access closure.
 */

import {
    VISUAL_ASSET_PROFILE,
    VISUAL_ASSET_USE_KIND,
    VISUAL_ASSET_USE_VERSION,
    VISUAL_LAYER_KIND,
    VISUAL_LAYER_VERSION,
    canonicalExactStringify,
    hashVisualAssetUse,
    hashVisualLayer,
    hashVisualLayerAccess,
    normalizeVisualAssetUse,
    normalizeVisualLayer,
    normalizeVisualLayerAccess,
    sha256ExactBytes,
    sha256ExactUtf8,
} from "../../../simulation/visual/VisualLayer.js";
import {
    hashBakeCapturePlan,
    hashBakeProviderRequest,
    hashBakeProviderResponse,
    hashBakeRunConfig,
    hashBakeSourceSnapshot,
    hashCaptureProductBuffer,
    normalizeBakeCapturePlan,
    normalizeBakeProviderRequest,
    normalizeBakeProviderResponse,
    normalizeBakeRunConfig,
    normalizeBakeSourceSnapshot,
} from "./BakeRunCatalog.js";
import {
    bakeCaptureUnitId,
    bakeGeneratedRecordId,
    isBakeGeneratedId,
    normalizeBakeReuseManifest,
} from "./BakeReuseContracts.js";
import {
    encodeDeterministicRgbaPng,
    encodeProjectedCaptureGlb,
    PROJECTED_CAPTURED_RADIANCE_OPTIONS,
    PROJECTED_CAPTURED_RADIANCE_WRITER,
} from "./BakeDeterministicMedia.js";
import {
    buildProjectedCaptureGeometry,
    maskedBeautyRgba,
} from "./ProjectedCaptureGeometry.js";
import {
    ATLAS_PERSISTENT_BAKE_OUTPUT_ROLES,
    PROJECTED_PERSISTENT_BAKE_OUTPUT_ROLES,
    constructionFromConfig,
    isChunkAtlasConstruction,
} from "./BakeConstructionPolicy.js";
import { writeAtlasArtifacts } from "./BakeAtlasArtifactWriter.js";

export const BAKE_ARTIFACT_SET_KIND = "cev-sim.bake-artifact-set";
export const BAKE_ARTIFACT_SET_VERSION = 1;
export const BAKE_ARTIFACT_SET_VERSION_V2 = 2;
export const BAKE_ARTIFACT_SET_VERSION_V3 = 3;
export const PERSISTENT_BAKE_OUTPUT_ROLES = ATLAS_PERSISTENT_BAKE_OUTPUT_ROLES;
export { PROJECTED_PERSISTENT_BAKE_OUTPUT_ROLES, ATLAS_PERSISTENT_BAKE_OUTPUT_ROLES };

const ARTIFACT_IDENTITY_KEYS = Object.freeze([
    "kind", "version", "environmentId", "worldHash", "environmentRevision",
    "bakeGeneration", "recipeHash", "snapshotHash", "planHash", "requestHash",
    "responseHash", "providerOutputDigests", "writer", "assets",
    "descriptorHash", "accessHash",
]);
const ARTIFACT_IDENTITY_KEYS_V2 = Object.freeze([
    ...ARTIFACT_IDENTITY_KEYS,
    "constructionHash", "atlasManifestDigest",
]);
const ARTIFACT_IDENTITY_KEYS_V3 = Object.freeze([
    ...ARTIFACT_IDENTITY_KEYS_V2,
    "materialProposalHash",
]);
const ARTIFACT_DOCUMENT_KEYS = Object.freeze([
    ...ARTIFACT_IDENTITY_KEYS,
    "jobId", "timestamps", "progress", "logs",
]);
const ARTIFACT_DOCUMENT_KEYS_V2 = Object.freeze([
    ...ARTIFACT_IDENTITY_KEYS_V2,
    "jobId", "timestamps", "progress", "logs",
]);
const ARTIFACT_DOCUMENT_KEYS_V3 = Object.freeze([
    ...ARTIFACT_IDENTITY_KEYS_V3,
    "jobId", "timestamps", "progress", "logs",
]);
const WRITER_KEYS = Object.freeze(["id", "version", "options"]);
const GENERATED_ASSET_KEYS = Object.freeze([
    "sampleId", "viewId", "role", "sha256", "mediaType", "sizeBytes", "useHash",
]);
const GENERATED_ASSET_KEYS_V2 = Object.freeze([
    "chunkKey", "pageIndex", "role", "sha256", "mediaType", "sizeBytes", "useHash",
]);
const SHA256 = /^[a-f0-9]{64}$/;

function artifactError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function fail(path, message) {
    throw artifactError("BAKE_ARTIFACT_INVALID", `${path}: ${message}`);
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

function digest(value, path) {
    if (typeof value !== "string" || !SHA256.test(value)) fail(path, "expected a lowercase SHA-256 digest");
    return value;
}

function digestOrNull(value, path) {
    if (value == null) return null;
    return digest(value, path);
}

function text(value, path) {
    if (typeof value !== "string" || !value) fail(path, "expected a non-empty string");
    return value;
}

function integer(value, path, { min = 0 } = {}) {
    if (!Number.isSafeInteger(value) || value < min) fail(path, `expected an integer >= ${min}`);
    return value;
}

function copyTyped(data) {
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (data instanceof Uint8ClampedArray) return new Uint8Array(data);
    if (data instanceof Float32Array) return new Float32Array(data);
    if (data instanceof Uint32Array) return new Uint32Array(data);
    throw artifactError("BAKE_ARTIFACT_INVALID", "Unsupported capture buffer type.");
}

function productKey(sampleId, viewId, role) {
    return `${sampleId}:${viewId}:${role}`;
}

function generatedId(unitId, contentDigest, kind) {
    return bakeGeneratedRecordId(unitId, contentDigest, kind);
}

function unitIdForSample(sample) {
    return bakeCaptureUnitId(sample.pathId, sample.sampleIndex, sample.viewId);
}

function identityRecord(value) {
    const keys = value.version >= 3
        ? ARTIFACT_IDENTITY_KEYS_V3
        : (value.version >= 2 ? ARTIFACT_IDENTITY_KEYS_V2 : ARTIFACT_IDENTITY_KEYS);
    const identity = {};
    for (const key of keys) identity[key] = value[key];
    return identity;
}

function sortDigests(records, version = 1) {
    return [...records].sort((left, right) => {
        const leftKey = version >= 2
            ? `${left.chunkKey}:${left.pageIndex}:${left.role}:${left.sha256}:${left.useHash}`
            : `${left.sampleId}:${left.viewId}:${left.role}:${left.sha256}:${left.useHash}`;
        const rightKey = version >= 2
            ? `${right.chunkKey}:${right.pageIndex}:${right.role}:${right.sha256}:${right.useHash}`
            : `${right.sampleId}:${right.viewId}:${right.role}:${right.sha256}:${right.useHash}`;
        if (leftKey < rightKey) return -1;
        if (leftKey > rightKey) return 1;
        return 0;
    });
}

function defaultWriter(options = {}) {
    return {
        id: PROJECTED_CAPTURED_RADIANCE_WRITER.id,
        version: PROJECTED_CAPTURED_RADIANCE_WRITER.version,
        options: closedWriterOptions(options),
    };
}

export { defaultWriter as createBakeArtifactWriter };

function closedWriterOptions(options = {}) {
    const cellSizePx = integer(
        options.cellSizePx ?? PROJECTED_CAPTURED_RADIANCE_OPTIONS.cellSizePx,
        "writer.options.cellSizePx",
        { min: 1 },
    );
    const maxTriangleDepthDelta = Number(
        options.maxTriangleDepthDelta ?? PROJECTED_CAPTURED_RADIANCE_OPTIONS.maxTriangleDepthDelta,
    );
    const surfaceOffset = Number(options.surfaceOffset ?? PROJECTED_CAPTURED_RADIANCE_OPTIONS.surfaceOffset);
    if (!Number.isFinite(maxTriangleDepthDelta) || maxTriangleDepthDelta < 0) {
        fail("writer.options.maxTriangleDepthDelta", "expected a finite number >= 0");
    }
    if (!Number.isFinite(surfaceOffset) || surfaceOffset < 0) {
        fail("writer.options.surfaceOffset", "expected a finite number >= 0");
    }
    return {
        cellSizePx,
        maxTriangleDepthDelta,
        surfaceOffset,
        pngFilter: text(options.pngFilter ?? PROJECTED_CAPTURED_RADIANCE_OPTIONS.pngFilter, "writer.options.pngFilter"),
        pngDeflate: text(options.pngDeflate ?? PROJECTED_CAPTURED_RADIANCE_OPTIONS.pngDeflate, "writer.options.pngDeflate"),
        glbPadding: text(options.glbPadding ?? PROJECTED_CAPTURED_RADIANCE_OPTIONS.glbPadding, "writer.options.glbPadding"),
    };
}

function emptyDescriptor(worldHash) {
    return normalizeVisualLayer({
        kind: VISUAL_LAYER_KIND,
        version: VISUAL_LAYER_VERSION,
        sourceWorldHash: worldHash,
        assetProfile: VISUAL_ASSET_PROFILE,
        assets: [],
        materials: [],
        chunks: [],
        instances: [],
        bindings: [],
        appearanceDependencies: [],
    });
}

function generatedMaterial(id, textureUri) {
    return {
        id,
        mode: "unlit-captured-radiance",
        alphaMode: "MASK",
        alphaCutoff: 0.5,
        doubleSided: true,
        parameters: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 1,
            roughnessFactor: 1,
            emissiveFactor: [0, 0, 0],
            emissiveStrength: 1,
            normalScale: 1,
            occlusionStrength: 1,
            clearcoatFactor: 0,
            clearcoatRoughnessFactor: 0,
            sheenColorFactor: [0, 0, 0],
            sheenRoughnessFactor: 0,
            specularFactor: 1,
            specularColorFactor: [1, 1, 1],
        },
        textures: [{
            slot: "baseColor",
            assetUri: textureUri,
            texCoord: 0,
            transform: { offset: [0, 0], rotation: 0, scale: [1, 1] },
        }],
        extensions: ["KHR_materials_unlit"],
    };
}

function bufferFor(buffers, sampleId, viewId, role) {
    const data = buffers.get(productKey(sampleId, viewId, role))
        ?? buffers.get?.(`${sampleId}:${viewId}:${role}`);
    if (!data) {
        throw artifactError(
            "BAKE_ARTIFACT_INCOMPLETE",
            `Missing ${role} buffer for ${sampleId}:${viewId}.`,
        );
    }
    return data;
}

function responseOutput(response, sampleId, viewId, role) {
    const output = response.outputs.find((entry) => (
        entry.sampleId === sampleId && entry.viewId === viewId && entry.role === role
    ));
    if (!output) {
        throw artifactError(
            "BAKE_ARTIFACT_INCOMPLETE",
            `Provider response is missing ${role} for ${sampleId}:${viewId}.`,
        );
    }
    return output;
}

function rehashOutput(buffers, output) {
    const data = bufferFor(buffers, output.sampleId, output.viewId, output.role);
    const digest = hashCaptureProductBuffer(data);
    if (digest !== output.sha256) {
        throw artifactError(
            "BAKE_ARTIFACT_HASH_MISMATCH",
            `${output.role} for ${output.sampleId}:${output.viewId} changed after provider validation.`,
        );
    }
    return data;
}

function requirePersistentRoles(products, roles = PROJECTED_PERSISTENT_BAKE_OUTPUT_ROLES) {
    for (const role of roles) {
        if (!products.includes(role)) {
            throw artifactError(
                "BAKE_ARTIFACT_INCOMPLETE",
                `Persistent bake artifacts require ${roles.join(", ")}.`,
            );
        }
    }
}

function makeUse(asset, sourceIds) {
    return normalizeVisualAssetUse({
        kind: VISUAL_ASSET_USE_KIND,
        version: VISUAL_ASSET_USE_VERSION,
        asset,
        sourceIds,
        dependencies: {},
    });
}

export function persistentBakeOutputRoles(roles = PERSISTENT_BAKE_OUTPUT_ROLES) {
    const next = Array.isArray(roles) ? [...roles] : [...PERSISTENT_BAKE_OUTPUT_ROLES];
    for (const role of PERSISTENT_BAKE_OUTPUT_ROLES) {
        if (!next.includes(role)) next.push(role);
    }
    return next;
}

function generatedAssetRecord(entry, index, version) {
    if (version >= 2) {
        const record = allowedKeys(entry, GENERATED_ASSET_KEYS_V2, `assets.${index}`);
        return {
            chunkKey: text(record.chunkKey, `assets.${index}.chunkKey`),
            pageIndex: integer(record.pageIndex, `assets.${index}.pageIndex`),
            role: text(record.role, `assets.${index}.role`),
            sha256: digest(record.sha256, `assets.${index}.sha256`),
            mediaType: text(record.mediaType, `assets.${index}.mediaType`),
            sizeBytes: integer(record.sizeBytes, `assets.${index}.sizeBytes`),
            useHash: digest(record.useHash, `assets.${index}.useHash`),
        };
    }
    const record = allowedKeys(entry, GENERATED_ASSET_KEYS, `assets.${index}`);
    return {
        sampleId: text(record.sampleId, `assets.${index}.sampleId`),
        viewId: text(record.viewId, `assets.${index}.viewId`),
        role: text(record.role, `assets.${index}.role`),
        sha256: digest(record.sha256, `assets.${index}.sha256`),
        mediaType: text(record.mediaType, `assets.${index}.mediaType`),
        sizeBytes: integer(record.sizeBytes, `assets.${index}.sizeBytes`),
        useHash: digest(record.useHash, `assets.${index}.useHash`),
    };
}

export function normalizeBakeArtifactSet(value = {}) {
    const version = integer(value.version ?? BAKE_ARTIFACT_SET_VERSION, "version", { min: 1 });
    if (![BAKE_ARTIFACT_SET_VERSION, BAKE_ARTIFACT_SET_VERSION_V2, BAKE_ARTIFACT_SET_VERSION_V3].includes(version)) {
        fail("version", "unsupported bake-artifact-set version");
    }
    const source = allowedKeys(
        value,
        version >= 3
            ? ARTIFACT_DOCUMENT_KEYS_V3
            : (version >= 2 ? ARTIFACT_DOCUMENT_KEYS_V2 : ARTIFACT_DOCUMENT_KEYS),
        "bakeArtifactSet",
    );
    if ((source.kind ?? BAKE_ARTIFACT_SET_KIND) !== BAKE_ARTIFACT_SET_KIND) {
        fail("kind", `expected ${BAKE_ARTIFACT_SET_KIND}`);
    }
    const writerSource = allowedKeys(source.writer ?? {}, WRITER_KEYS, "writer");
    const assets = Object.freeze(sortDigests(
        (source.assets ?? []).map((entry, index) => generatedAssetRecord(entry, index, version)),
        version,
    ));
    const providerOutputDigests = Object.freeze(sortDigests(
        (source.providerOutputDigests ?? []).map((entry, index) => ({
            sampleId: text(entry.sampleId, `providerOutputDigests.${index}.sampleId`),
            viewId: text(entry.viewId, `providerOutputDigests.${index}.viewId`),
            role: text(entry.role, `providerOutputDigests.${index}.role`),
            sha256: digest(entry.sha256, `providerOutputDigests.${index}.sha256`),
        })),
        1,
    ));
    const normalized = {
        kind: BAKE_ARTIFACT_SET_KIND,
        version,
        environmentId: text(source.environmentId, "environmentId"),
        worldHash: digest(source.worldHash, "worldHash"),
        environmentRevision: integer(source.environmentRevision, "environmentRevision"),
        bakeGeneration: integer(source.bakeGeneration, "bakeGeneration", { min: 1 }),
        recipeHash: digest(source.recipeHash, "recipeHash"),
        snapshotHash: digest(source.snapshotHash, "snapshotHash"),
        planHash: digest(source.planHash, "planHash"),
        requestHash: digest(source.requestHash, "requestHash"),
        responseHash: digest(source.responseHash, "responseHash"),
        providerOutputDigests,
        writer: {
            id: text(writerSource.id ?? PROJECTED_CAPTURED_RADIANCE_WRITER.id, "writer.id"),
            version: integer(writerSource.version ?? PROJECTED_CAPTURED_RADIANCE_WRITER.version, "writer.version", { min: 1 }),
            options: closedWriterOptions(writerSource.options),
        },
        assets,
        descriptorHash: digest(source.descriptorHash, "descriptorHash"),
        accessHash: digest(source.accessHash, "accessHash"),
        jobId: source.jobId == null ? null : text(source.jobId, "jobId"),
        timestamps: source.timestamps ?? null,
        progress: source.progress ?? null,
        logs: source.logs ?? null,
    };
    if (version >= 2) {
        normalized.constructionHash = digest(source.constructionHash, "constructionHash");
        normalized.atlasManifestDigest = digest(source.atlasManifestDigest, "atlasManifestDigest");
    }
    if (version >= 3) normalized.materialProposalHash = digest(source.materialProposalHash, "materialProposalHash");
    return normalized;
}

export function hashBakeArtifactSet(value) {
    const normalized = normalizeBakeArtifactSet(value);
    return sha256ExactUtf8(canonicalExactStringify(identityRecord(normalized)));
}

export function copyCaptureBuffers(buffers) {
    const copies = new Map();
    for (const [key, data] of buffers.entries()) copies.set(key, copyTyped(data));
    return copies;
}

export function captureProductKey(sampleId, viewId, role) {
    return productKey(sampleId, viewId, role);
}

/**
 * Upload generated bake bytes through VisualAssetClient. Every result must
 * match the precomputed digest, size, media type, and use hash. A partial
 * upload never reports bake success.
 */
export async function uploadBakeArtifacts(client, uploads) {
    const published = [];
    for (const upload of uploads) {
        const created = await client.createUpload({
            kind: VISUAL_ASSET_USE_KIND,
            version: VISUAL_ASSET_USE_VERSION,
            asset: upload.use.asset,
            sourceIds: upload.use.sourceIds,
            dependencies: upload.use.dependencies,
        });
        if (created.useHash !== upload.useHash) {
            throw artifactError(
                "BAKE_UPLOAD_MISMATCH",
                `Upload use hash ${created.useHash} does not match ${upload.useHash}.`,
            );
        }
        let result = created;
        if (!created.existing) {
            result = await client.putUploadContent(created.id, upload.bytes, {
                mediaType: upload.mediaType,
            });
        }
        const asset = result.use?.asset ?? created.use?.asset;
        if (
            result.useHash !== upload.useHash
            || asset?.sha256 !== upload.use.asset.sha256
            || asset?.sizeBytes !== upload.use.asset.sizeBytes
            || asset?.mediaType !== upload.mediaType
            || asset?.role !== upload.role
        ) {
            throw artifactError(
                "BAKE_UPLOAD_MISMATCH",
                `Upload result for ${upload.role} did not match the artifact set.`,
            );
        }
        published.push(result);
    }
    return published;
}

function sampleRoleBuffer(buffers, sample, role, response) {
    if (response) {
        return rehashOutput(buffers, responseOutput(response, sample.sampleId, sample.viewId, role));
    }
    return bufferFor(buffers, sample.sampleId, sample.viewId, role);
}

export function encodeBakeUnitArtifacts({
    sample,
    buffers,
    response = null,
    config,
    writer,
    sourceIds,
    viewsById,
} = {}) {
    requirePersistentRoles(sample.products);
    const unitId = unitIdForSample(sample);
    const resolvedWriter = defaultWriter(writer?.options ?? writer ?? {});
    const width = config.views.find((view) => view.id === sample.viewId)?.camera.width;
    const height = config.views.find((view) => view.id === sample.viewId)?.camera.height;
    const beauty = sampleRoleBuffer(buffers, sample, "beauty", response);
    const worldPosition = sampleRoleBuffer(buffers, sample, "world-position", response);
    const validity = sampleRoleBuffer(buffers, sample, "validity", response);
    const geometry = buildProjectedCaptureGeometry({
        width,
        height,
        worldPosition,
        validity,
        pose: sample.pose ?? viewsById.get(sample.viewId)?.pose,
        cellSizePx: resolvedWriter.options.cellSizePx,
        maxTriangleDepthDelta: resolvedWriter.options.maxTriangleDepthDelta,
        surfaceOffset: resolvedWriter.options.surfaceOffset,
    });
    if (!geometry) {
        throw artifactError(
            "BAKE_ARTIFACT_INCOMPLETE",
            `No projectable geometry for ${sample.sampleId}:${sample.viewId}.`,
        );
    }
    const rgba = maskedBeautyRgba(beauty, validity, width, height);
    const png = encodeDeterministicRgbaPng(rgba, width, height);
    const pngDigest = sha256ExactBytes(png);
    const textureAsset = {
        sha256: pngDigest,
        mediaType: "image/png",
        sizeBytes: png.length,
        role: "texture",
    };
    const textureUse = makeUse(textureAsset, sourceIds);
    const textureUseHash = hashVisualAssetUse(textureUse);
    const textureUri = `sha256:${pngDigest}`;
    const materialId = generatedId(unitId, pngDigest, "material");
    const glb = encodeProjectedCaptureGlb({
        positions: geometry.positions,
        uvs: geometry.uvs,
        indices: geometry.indices,
        materialId,
    });
    const glbDigest = sha256ExactBytes(glb);
    const meshAsset = {
        sha256: glbDigest,
        mediaType: "model/gltf-binary",
        sizeBytes: glb.length,
        role: "mesh",
    };
    const meshUse = makeUse(meshAsset, sourceIds);
    const meshUseHash = hashVisualAssetUse(meshUse);
    const meshUri = `sha256:${glbDigest}`;
    const instanceId = generatedId(unitId, glbDigest, "instance");
    const chunkId = generatedId(unitId, glbDigest, "chunk");
    const fragments = {
        materialId,
        instanceId,
        chunkId,
        texture: {
            sha256: pngDigest,
            mediaType: "image/png",
            sizeBytes: png.length,
            useHash: textureUseHash,
            role: "texture",
        },
        mesh: {
            sha256: glbDigest,
            mediaType: "model/gltf-binary",
            sizeBytes: glb.length,
            useHash: meshUseHash,
            role: "mesh",
        },
        matrix: [...geometry.matrix],
    };
    return {
        unitId,
        fragments,
        geometry,
        material: generatedMaterial(materialId, textureUri),
        instance: {
            id: instanceId,
            assetUri: meshUri,
            lodLevels: [meshUri],
            matrix: geometry.matrix,
            chunkIds: [chunkId],
            materialIds: [materialId],
        },
        chunk: {
            id: chunkId,
            instanceIds: [instanceId],
            dependencyUris: [meshUri, textureUri],
        },
        uploads: [
            {
                kind: "texture",
                sampleId: sample.sampleId,
                viewId: sample.viewId,
                unitId,
                bytes: png,
                mediaType: "image/png",
                role: "texture",
                use: textureUse,
                useHash: textureUseHash,
            },
            {
                kind: "mesh",
                sampleId: sample.sampleId,
                viewId: sample.viewId,
                unitId,
                bytes: glb,
                mediaType: "model/gltf-binary",
                role: "mesh",
                use: meshUse,
                useHash: meshUseHash,
            },
        ],
        generatedAssets: [
            {
                sampleId: sample.sampleId,
                viewId: sample.viewId,
                role: "texture",
                sha256: pngDigest,
                mediaType: "image/png",
                sizeBytes: png.length,
                useHash: textureUseHash,
            },
            {
                sampleId: sample.sampleId,
                viewId: sample.viewId,
                role: "mesh",
                sha256: glbDigest,
                mediaType: "model/gltf-binary",
                sizeBytes: glb.length,
                useHash: meshUseHash,
            },
        ],
        uses: [textureUse, meshUse],
    };
}

function fragmentDescriptorParts(unitId, fragments, matrix) {
    const textureUri = `sha256:${fragments.texture.sha256}`;
    const meshUri = `sha256:${fragments.mesh.sha256}`;
    return {
        unitId,
        fragments,
        material: generatedMaterial(fragments.materialId, textureUri),
        instance: {
            id: fragments.instanceId,
            assetUri: meshUri,
            lodLevels: [meshUri],
            matrix,
            chunkIds: [fragments.chunkId],
            materialIds: [fragments.materialId],
        },
        chunk: {
            id: fragments.chunkId,
            instanceIds: [fragments.instanceId],
            dependencyUris: [meshUri, textureUri],
        },
        generatedAssets: [
            {
                sampleId: unitId,
                viewId: fragments.chunkId,
                role: "texture",
                sha256: fragments.texture.sha256,
                mediaType: fragments.texture.mediaType,
                sizeBytes: fragments.texture.sizeBytes,
                useHash: fragments.texture.useHash,
            },
            {
                sampleId: unitId,
                viewId: fragments.chunkId,
                role: "mesh",
                sha256: fragments.mesh.sha256,
                mediaType: fragments.mesh.mediaType,
                sizeBytes: fragments.mesh.sizeBytes,
                useHash: fragments.mesh.useHash,
            },
        ],
    };
}

function referencedAssetDigests(descriptor) {
    const live = new Set();
    const visit = (uri) => {
        if (typeof uri === "string" && uri.startsWith("sha256:")) live.add(uri.slice("sha256:".length));
    };
    for (const material of descriptor.materials ?? []) {
        for (const texture of material.textures ?? []) visit(texture.assetUri);
    }
    for (const instance of descriptor.instances ?? []) {
        visit(instance.assetUri);
        for (const uri of instance.lodLevels ?? []) visit(uri);
    }
    for (const chunk of descriptor.chunks ?? []) {
        for (const uri of chunk.dependencyUris ?? []) visit(uri);
    }
    for (const uri of descriptor.appearanceDependencies ?? []) visit(uri);
    return live;
}

function pruneUnreachableAssets(descriptor) {
    const live = referencedAssetDigests(descriptor);
    return {
        ...descriptor,
        assets: descriptor.assets.filter((asset) => live.has(asset.sha256)),
        appearanceDependencies: descriptor.appearanceDependencies.filter((uri) => {
            if (!String(uri).startsWith("sha256:")) return true;
            return live.has(uri.slice("sha256:".length));
        }),
    };
}

function keepTrustedBase(records, keepGeneratedIds) {
    return records.filter((record) => {
        if (!isBakeGeneratedId(record.id)) return true;
        return keepGeneratedIds.has(record.id);
    });
}

/**
 * Retain exact VIS-07 buffers, re-hash them, and emit PNG/GLB projection assets
 * plus a merged descriptor/access/artifact-set document. Reused fragments are
 * merged by stable unit identity; sourceWorldHash is rebound to the current
 * world without entering per-unit keys.
 */
export function writeBakeArtifacts({
    job,
    buffers,
    sourceIds,
    currentDescriptor = null,
    currentAccess = null,
    worldHash,
    graph = null,
    reuseFragments = null,
    captureUnitIds = null,
    scene = null,
    layout = null,
    previousContributions = null,
    previousPages = null,
    rebuildChunkKeys = null,
    materialProposalSet = null,
    materialProposalBuffers = null,
} = {}) {
    if (!job?.config || !job.snapshot || !job.plan || !job.request || !job.response) {
        throw artifactError("BAKE_ARTIFACT_INCOMPLETE", "Completed VIS-07 documents are required.");
    }
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
        throw artifactError("BAKE_OUTPUT_SOURCE_MISSING", "Trusted generated-output source IDs are required.");
    }
    const config = normalizeBakeRunConfig(job.config);
    const snapshot = normalizeBakeSourceSnapshot(job.snapshot);
    const plan = normalizeBakeCapturePlan(job.plan);
    const request = normalizeBakeProviderRequest(job.request);
    const response = normalizeBakeProviderResponse(job.response);
    const recipeHash = hashBakeRunConfig(config);
    const snapshotHash = hashBakeSourceSnapshot(snapshot);
    const planHash = hashBakeCapturePlan(plan);
    const requestHash = hashBakeProviderRequest(request);
    const responseHash = hashBakeProviderResponse(response);
    if (recipeHash !== job.recipeHash) fail("recipeHash", "does not match the completed job");
    if (snapshotHash !== job.snapshotHash) fail("snapshotHash", "does not match the completed job");
    if (planHash !== job.planHash) fail("planHash", "does not match the completed job");
    if (requestHash !== job.requestHash) fail("requestHash", "does not match the completed job");
    if (responseHash !== job.responseHash) fail("responseHash", "does not match the completed job");
    if (snapshot.worldHash !== (worldHash ?? snapshot.worldHash)) {
        fail("worldHash", "snapshot world hash does not match the reserved binding");
    }
    const boundWorld = worldHash ?? snapshot.worldHash;
    const construction = constructionFromConfig(config);
    const finalize = (fields) => finalizeArtifacts({
        job,
        snapshot,
        request,
        response,
        recipeHash,
        snapshotHash,
        planHash,
        requestHash,
        responseHash,
        currentAccess,
        ...fields,
    });
    if (isChunkAtlasConstruction(construction)) {
        return writeAtlasArtifacts({
            job: { ...job, config, snapshot, plan, request, response },
            buffers,
            sourceIds,
            currentDescriptor,
            currentAccess,
            worldHash: boundWorld,
            graph,
            scene,
            layout,
            captureUnitIds,
            previousContributions,
            previousPages,
            rebuildChunkKeys,
            construction,
            finalize,
            materialProposalSet,
            materialProposalBuffers,
        });
    }
    const writer = defaultWriter();
    const viewsById = new Map(plan.views.map((view) => [view.viewId, view]));
    const captureSet = captureUnitIds ? new Set(captureUnitIds) : null;
    const fragmentsByUnit = new Map();
    const uploads = [];
    const generatedAssets = [];
    const generatedMaterials = [];
    const generatedInstances = [];
    const generatedChunks = [];
    const appearanceDependencies = [];
    const usesByHash = new Map();
    const keepGeneratedIds = new Set();
    const reuseUnits = [];

    for (const sample of plan.samples) {
        const unitId = unitIdForSample(sample);
        const shouldCapture = !captureSet || captureSet.has(unitId);
        if (shouldCapture) {
            const encoded = encodeBakeUnitArtifacts({
                sample,
                buffers,
                response,
                config,
                writer,
                sourceIds,
                viewsById,
            });
            fragmentsByUnit.set(unitId, encoded.fragments);
            generatedMaterials.push(encoded.material);
            generatedInstances.push(encoded.instance);
            generatedChunks.push(encoded.chunk);
            generatedAssets.push(...encoded.generatedAssets);
            uploads.push(...encoded.uploads);
            for (const use of encoded.uses) usesByHash.set(hashVisualAssetUse(use), use);
            appearanceDependencies.push(`sha256:${encoded.fragments.texture.sha256}`);
            keepGeneratedIds.add(encoded.fragments.materialId);
            keepGeneratedIds.add(encoded.fragments.instanceId);
            keepGeneratedIds.add(encoded.fragments.chunkId);
            const graphUnit = graph?.units?.find((entry) => entry.unitId === unitId);
            reuseUnits.push({
                unitId,
                pathId: sample.pathId,
                sampleIndex: sample.sampleIndex,
                viewId: sample.viewId,
                dependencyKey: graphUnit?.dependencyKey ?? "0".repeat(64),
                chunkKeys: graphUnit?.chunkKeys ?? [],
                fragments: encoded.fragments,
            });
            continue;
        }
        const reused = reuseFragments?.get(unitId);
        if (!reused) {
            throw artifactError("BAKE_REUSE_INVALID", `Missing reusable fragments for ${unitId}.`);
        }
        const parts = fragmentDescriptorParts(unitId, reused, reused.matrix);
        fragmentsByUnit.set(unitId, reused);
        generatedMaterials.push(parts.material);
        generatedInstances.push(parts.instance);
        generatedChunks.push(parts.chunk);
        generatedAssets.push(...parts.generatedAssets.map((entry) => ({
            ...entry,
            sampleId: sample.sampleId,
            viewId: sample.viewId,
        })));
        appearanceDependencies.push(`sha256:${reused.texture.sha256}`);
        keepGeneratedIds.add(reused.materialId);
        keepGeneratedIds.add(reused.instanceId);
        keepGeneratedIds.add(reused.chunkId);
        const graphUnit = graph?.units?.find((entry) => entry.unitId === unitId);
        reuseUnits.push({
            unitId,
            pathId: sample.pathId,
            sampleIndex: sample.sampleIndex,
            viewId: sample.viewId,
            dependencyKey: graphUnit?.dependencyKey ?? "0".repeat(64),
            chunkKeys: graphUnit?.chunkKeys ?? [],
            fragments: reused,
        });
    }

    const base = currentDescriptor
        ? normalizeVisualLayer(currentDescriptor)
        : emptyDescriptor(boundWorld);
    const retainedMaterials = keepTrustedBase(base.materials, keepGeneratedIds);
    const retainedInstances = keepTrustedBase(base.instances, keepGeneratedIds);
    const retainedChunks = keepTrustedBase(base.chunks, keepGeneratedIds);
    const materialsById = new Map(retainedMaterials.map((material) => [material.id, material]));
    for (const material of generatedMaterials) materialsById.set(material.id, material);
    const instancesById = new Map(retainedInstances.map((instance) => [instance.id, instance]));
    for (const instance of generatedInstances) instancesById.set(instance.id, instance);
    const chunksById = new Map(retainedChunks.map((chunk) => [chunk.id, chunk]));
    for (const chunk of generatedChunks) chunksById.set(chunk.id, chunk);
    const assetsByDigest = new Map(base.assets.map((asset) => [asset.sha256, asset]));
    for (const upload of uploads) assetsByDigest.set(upload.use.asset.sha256, upload.use.asset);
    for (const asset of generatedAssets) {
        assetsByDigest.set(asset.sha256, {
            sha256: asset.sha256,
            mediaType: asset.mediaType,
            sizeBytes: asset.sizeBytes,
            role: asset.role,
        });
    }

    const descriptor = normalizeVisualLayer(pruneUnreachableAssets({
        ...base,
        sourceWorldHash: boundWorld,
        assets: [...assetsByDigest.values()],
        materials: [...materialsById.values()],
        instances: [...instancesById.values()],
        chunks: [...chunksById.values()],
        bindings: base.bindings.filter((binding) => (
            !isBakeGeneratedId(binding.instanceId) || keepGeneratedIds.has(binding.instanceId)
        )),
        appearanceDependencies: [...new Set([
            ...base.appearanceDependencies,
            ...appearanceDependencies,
        ])],
    }));

    const finalized = finalizeArtifacts({
        job,
        snapshot,
        request,
        response,
        recipeHash,
        snapshotHash,
        planHash,
        requestHash,
        responseHash,
        writer,
        generatedAssets,
        descriptor,
        uploads,
        usesByHash,
        currentAccess,
    });
    const reuseManifest = graph
        ? normalizeBakeReuseManifest({
            kind: "cev-sim.bake-reuse-manifest",
            version: 1,
            sourceWorldHash: boundWorld,
            keyVersion: graph.keyVersion,
            globalKey: graph.globalKey,
            chunkKeys: graph.chunkKeys,
            units: reuseUnits,
            writer: graph.writer,
            descriptorHash: hashVisualLayer(finalized.descriptor),
            accessHash: hashVisualLayerAccess(finalized.access),
        })
        : null;
    return {
        ...finalized,
        fragmentsByUnit,
        reuseManifest,
        reuseUnits,
    };
}

function resolveAccessAssets(descriptor, generatedAssets, currentAccess) {
    const generatedByDigest = new Map(generatedAssets.map((entry) => [entry.sha256, entry.useHash]));
    const retainedByDigest = new Map((currentAccess?.assets ?? []).map((entry) => [entry.sha256, entry.useHash]));
    return descriptor.assets.map((asset) => {
        const useHash = generatedByDigest.get(asset.sha256) ?? retainedByDigest.get(asset.sha256);
        if (!useHash) {
            throw artifactError(
                "BAKE_ARTIFACT_INCOMPLETE",
                `Missing use hash for asset ${asset.sha256}.`,
            );
        }
        return { sha256: asset.sha256, useHash };
    });
}

function finalizeArtifacts({
    job,
    snapshot,
    request,
    response,
    recipeHash,
    snapshotHash,
    planHash,
    requestHash,
    responseHash,
    writer,
    generatedAssets,
    descriptor,
    uploads,
    usesByHash,
    currentAccess,
    artifactVersion = BAKE_ARTIFACT_SET_VERSION,
    constructionHash = null,
    atlasManifestDigest = null,
    materialProposalHash = null,
}) {
    const descriptorHash = hashVisualLayer(descriptor);
    const access = normalizeVisualLayerAccess({
        kind: "cev-sim.visual-layer-access",
        version: 1,
        descriptorHash,
        assets: resolveAccessAssets(descriptor, generatedAssets, currentAccess),
    });
    const accessHash = hashVisualLayerAccess(access);
    const artifactSet = normalizeBakeArtifactSet({
        kind: BAKE_ARTIFACT_SET_KIND,
        version: artifactVersion,
        environmentId: job.config.environmentId,
        worldHash: snapshot.worldHash,
        environmentRevision: snapshot.environmentRevision,
        bakeGeneration: snapshot.bakeGeneration,
        recipeHash,
        snapshotHash,
        planHash,
        requestHash,
        responseHash,
        providerOutputDigests: response.outputs.map((entry) => ({
            sampleId: entry.sampleId,
            viewId: entry.viewId,
            role: entry.role,
            sha256: entry.sha256,
        })),
        writer,
        assets: generatedAssets,
        descriptorHash,
        accessHash,
        jobId: job.jobId,
        timestamps: job.status?.timestamps ?? null,
        progress: job.status?.progress ?? null,
        logs: job.status?.logs ?? null,
        ...(artifactVersion >= 2 ? { constructionHash, atlasManifestDigest } : {}),
        ...(artifactVersion >= 3 ? { materialProposalHash } : {}),
    });
    return {
        descriptor,
        access,
        artifactSet,
        artifactHash: hashBakeArtifactSet(artifactSet),
        uploads,
        usesByHash,
        request,
        response,
    };
}
