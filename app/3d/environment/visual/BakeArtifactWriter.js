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
    encodeDeterministicRgbaPng,
    encodeProjectedCaptureGlb,
    PROJECTED_CAPTURED_RADIANCE_OPTIONS,
    PROJECTED_CAPTURED_RADIANCE_WRITER,
} from "./BakeDeterministicMedia.js";
import {
    buildProjectedCaptureGeometry,
    maskedBeautyRgba,
} from "./ProjectedCaptureGeometry.js";

export const BAKE_ARTIFACT_SET_KIND = "cev-sim.bake-artifact-set";
export const BAKE_ARTIFACT_SET_VERSION = 1;
export const PERSISTENT_BAKE_OUTPUT_ROLES = Object.freeze([
    "beauty",
    "world-position",
    "validity",
]);

const ARTIFACT_IDENTITY_KEYS = Object.freeze([
    "kind", "version", "environmentId", "worldHash", "environmentRevision",
    "bakeGeneration", "recipeHash", "snapshotHash", "planHash", "requestHash",
    "responseHash", "providerOutputDigests", "writer", "assets",
    "descriptorHash", "accessHash",
]);
const ARTIFACT_DOCUMENT_KEYS = Object.freeze([
    ...ARTIFACT_IDENTITY_KEYS,
    "jobId", "timestamps", "progress", "logs",
]);
const WRITER_KEYS = Object.freeze(["id", "version", "options"]);
const GENERATED_ASSET_KEYS = Object.freeze([
    "sampleId", "viewId", "role", "sha256", "mediaType", "sizeBytes", "useHash",
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

function generatedId(responseHash, sampleId, viewId, kind) {
    return `bake-${sha256ExactUtf8(`${responseHash}:${sampleId}:${viewId}:${kind}`)}`;
}

function identityRecord(value) {
    const identity = {};
    for (const key of ARTIFACT_IDENTITY_KEYS) identity[key] = value[key];
    return identity;
}

function sortDigests(records) {
    return [...records].sort((left, right) => {
        const leftKey = `${left.sampleId}:${left.viewId}:${left.role}`;
        const rightKey = `${right.sampleId}:${right.viewId}:${right.role}`;
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

function requirePersistentRoles(products) {
    for (const role of PERSISTENT_BAKE_OUTPUT_ROLES) {
        if (!products.includes(role)) {
            throw artifactError(
                "BAKE_ARTIFACT_INCOMPLETE",
                `Persistent bake artifacts require ${PERSISTENT_BAKE_OUTPUT_ROLES.join(", ")}.`,
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

export function normalizeBakeArtifactSet(value = {}) {
    const source = allowedKeys(value, ARTIFACT_DOCUMENT_KEYS, "bakeArtifactSet");
    if ((source.kind ?? BAKE_ARTIFACT_SET_KIND) !== BAKE_ARTIFACT_SET_KIND) {
        fail("kind", `expected ${BAKE_ARTIFACT_SET_KIND}`);
    }
    if ((source.version ?? BAKE_ARTIFACT_SET_VERSION) !== BAKE_ARTIFACT_SET_VERSION) {
        fail("version", "unsupported bake-artifact-set version");
    }
    const writerSource = allowedKeys(source.writer ?? {}, WRITER_KEYS, "writer");
    const assets = Object.freeze(sortDigests(
        (source.assets ?? []).map((entry, index) => {
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
        }),
    ));
    const providerOutputDigests = Object.freeze(sortDigests(
        (source.providerOutputDigests ?? []).map((entry, index) => ({
            sampleId: text(entry.sampleId, `providerOutputDigests.${index}.sampleId`),
            viewId: text(entry.viewId, `providerOutputDigests.${index}.viewId`),
            role: text(entry.role, `providerOutputDigests.${index}.role`),
            sha256: digest(entry.sha256, `providerOutputDigests.${index}.sha256`),
        })),
    ));
    return {
        kind: BAKE_ARTIFACT_SET_KIND,
        version: BAKE_ARTIFACT_SET_VERSION,
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
                `Upload result for ${upload.sampleId}:${upload.viewId} ${upload.role} did not match the artifact set.`,
            );
        }
        published.push(result);
    }
    return published;
}

/**
 * Retain exact VIS-07 buffers, re-hash them, and emit PNG/GLB projection assets
 * plus a merged descriptor/access/artifact-set document.
 */
export function writeBakeArtifacts({
    job,
    buffers,
    sourceIds,
    currentDescriptor = null,
    currentAccess = null,
    worldHash,
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
    const writer = defaultWriter();
    const viewsById = new Map(plan.views.map((view) => [view.viewId, view]));
    const uploads = [];
    const generatedAssets = [];
    const generatedMaterials = [];
    const generatedInstances = [];
    const generatedChunks = [];
    const appearanceDependencies = [];
    const usesByHash = new Map();

    for (const sample of plan.samples) {
        requirePersistentRoles(sample.products);
        const width = config.views.find((view) => view.id === sample.viewId)?.camera.width;
        const height = config.views.find((view) => view.id === sample.viewId)?.camera.height;
        const beauty = rehashOutput(buffers, responseOutput(response, sample.sampleId, sample.viewId, "beauty"));
        const worldPosition = rehashOutput(
            buffers,
            responseOutput(response, sample.sampleId, sample.viewId, "world-position"),
        );
        const validity = rehashOutput(buffers, responseOutput(response, sample.sampleId, sample.viewId, "validity"));
        const geometry = buildProjectedCaptureGeometry({
            width,
            height,
            worldPosition,
            validity,
            pose: sample.pose ?? viewsById.get(sample.viewId)?.pose,
            cellSizePx: writer.options.cellSizePx,
            maxTriangleDepthDelta: writer.options.maxTriangleDepthDelta,
            surfaceOffset: writer.options.surfaceOffset,
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
        usesByHash.set(textureUseHash, textureUse);
        const materialId = generatedId(responseHash, sample.sampleId, sample.viewId, "material");
        const instanceId = generatedId(responseHash, sample.sampleId, sample.viewId, "instance");
        const chunkId = generatedId(responseHash, sample.sampleId, sample.viewId, "chunk");
        const textureUri = `sha256:${pngDigest}`;
        generatedAssets.push({
            sampleId: sample.sampleId,
            viewId: sample.viewId,
            role: "texture",
            sha256: pngDigest,
            mediaType: "image/png",
            sizeBytes: png.length,
            useHash: textureUseHash,
        });
        uploads.push({
            kind: "texture",
            sampleId: sample.sampleId,
            viewId: sample.viewId,
            bytes: png,
            mediaType: "image/png",
            role: "texture",
            use: textureUse,
            useHash: textureUseHash,
        });
        appearanceDependencies.push(textureUri);
        generatedMaterials.push(generatedMaterial(materialId, textureUri));
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
        usesByHash.set(meshUseHash, meshUse);
        const meshUri = `sha256:${glbDigest}`;
        generatedAssets.push({
            sampleId: sample.sampleId,
            viewId: sample.viewId,
            role: "mesh",
            sha256: glbDigest,
            mediaType: "model/gltf-binary",
            sizeBytes: glb.length,
            useHash: meshUseHash,
        });
        uploads.push({
            kind: "mesh",
            sampleId: sample.sampleId,
            viewId: sample.viewId,
            bytes: glb,
            mediaType: "model/gltf-binary",
            role: "mesh",
            use: meshUse,
            useHash: meshUseHash,
        });
        generatedInstances.push({
            id: instanceId,
            assetUri: meshUri,
            lodLevels: [meshUri],
            matrix: geometry.matrix,
            chunkIds: [chunkId],
            materialIds: [materialId],
        });
        generatedChunks.push({
            id: chunkId,
            instanceIds: [instanceId],
            dependencyUris: [meshUri, textureUri],
        });
    }

    const base = currentDescriptor
        ? normalizeVisualLayer(currentDescriptor)
        : emptyDescriptor(boundWorld);
    if (base.sourceWorldHash !== boundWorld) {
        fail("sourceWorldHash", "current descriptor is bound to a different world");
    }
    const assetsByDigest = new Map(base.assets.map((asset) => [asset.sha256, asset]));
    for (const upload of uploads) {
        assetsByDigest.set(upload.use.asset.sha256, upload.use.asset);
    }
    const materialsById = new Map(base.materials.map((material) => [material.id, material]));
    for (const material of generatedMaterials) materialsById.set(material.id, material);
    const instancesById = new Map(base.instances.map((instance) => [instance.id, instance]));
    for (const instance of generatedInstances) instancesById.set(instance.id, instance);
    const chunksById = new Map(base.chunks.map((chunk) => [chunk.id, chunk]));
    for (const chunk of generatedChunks) chunksById.set(chunk.id, chunk);

    const descriptor = normalizeVisualLayer({
        ...base,
        sourceWorldHash: boundWorld,
        assets: [...assetsByDigest.values()],
        materials: [...materialsById.values()],
        instances: [...instancesById.values()],
        chunks: [...chunksById.values()],
        bindings: base.bindings,
        appearanceDependencies: [...new Set([...base.appearanceDependencies, ...appearanceDependencies])],
    });

    return finalizeArtifacts({
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
        version: BAKE_ARTIFACT_SET_VERSION,
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
