/**
 * VIS-10a atlas artifact emission: per-page GLB/PNG, unlit captured-radiance
 * materials, atlas-manifest buffer, and confidence/validity maps.
 */

import {
    VISUAL_ASSET_PROFILE,
    VISUAL_ASSET_USE_KIND,
    VISUAL_ASSET_USE_VERSION,
    VISUAL_LAYER_KIND,
    VISUAL_LAYER_VERSION,
    hashVisualAssetUse,
    hashVisualLayer,
    hashVisualLayerAccess,
    normalizeVisualAssetUse,
    normalizeVisualLayer,
    sha256ExactBytes,
} from "../../../simulation/visual/VisualLayer.js";
import {
    hashBakeConstruction,
    isChunkAtlasConstruction,
    writerForConstruction,
    CAPTURED_RADIANCE_UNLIT,
    INTRINSIC_PBR_SUPPLIED,
    isIntrinsicProposalConstruction,
} from "./BakeConstructionPolicy.js";
import {
    encodeBakeAtlasContribution,
    decodeBakeAtlasContribution,
} from "./BakeAtlasContribution.js";
import {
    atlasManifestBytes,
    atlasManifestFromConstruction,
} from "./BakeAtlasManifest.js";
import {
    buildAtlasLayout,
    fuseChunkPages,
    mapCaptureToContributions,
    mapMaterialProposalsToContributions,
} from "./BakeAtlasCore.js";
import { extractBakeSnapshotTriangles } from "./BakeAtlasSnapshotAdapter.js";
import {
    bakeCaptureUnitId,
    bakeGeneratedRecordId,
    isBakeGeneratedId,
    isBakeReuseManifestV2,
    normalizeBakeReuseManifest,
    BAKE_REUSE_MANIFEST_VERSION_V2,
} from "./BakeReuseContracts.js";
import {
    encodeDeterministicRgbaPng,
    encodeProjectedCaptureGlb,
} from "./BakeDeterministicMedia.js";
import { compareUtf8 } from "./BakeRunCatalog.js";
import {
    validateBakeMaterialProposals,
} from "./BakeMaterialProposals.js";

function artifactError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
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

function viewsWithCameras(job) {
    const map = new Map();
    for (const view of job.plan?.views ?? []) {
        map.set(view.viewId, { ...view });
    }
    for (const view of job.config?.views ?? []) {
        const id = view.id ?? view.viewId;
        const existing = map.get(id) ?? {};
        map.set(id, {
            ...existing,
            ...view,
            viewId: id,
            camera: view.camera ?? existing.camera,
            pose: view.pose ?? existing.pose,
        });
    }
    return map;
}

export async function loadContributionPayloads(manifest, getUseContent) {
    const map = new Map();
    if (!isBakeReuseManifestV2(manifest) || typeof getUseContent !== "function") return map;
    for (const unit of manifest.units ?? []) {
        const loaded = await getUseContent(unit.contribution.useHash);
        const bytes = loaded?.bytes ?? loaded;
        if (!bytes) {
            throw artifactError("BAKE_REUSE_INVALID", `Missing contribution bytes for ${unit.unitId}.`);
        }
        map.set(unit.unitId, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }
    return map;
}

function cameraPosition(pose) {
    return {
        x: Number(pose?.position?.x) || 0,
        y: Number(pose?.position?.y) || 0,
        z: Number(pose?.position?.z) || 0,
    };
}

function generatedMaterial(id, textureUri, { unlit = true } = {}) {
    return {
        id,
        mode: unlit ? "unlit-captured-radiance" : "metallic-roughness",
        alphaMode: "MASK",
        alphaCutoff: 0.5,
        doubleSided: true,
        parameters: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: unlit ? 1 : 0,
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
        extensions: unlit ? ["KHR_materials_unlit"] : [],
    };
}

function generatedIntrinsicMaterial(id, textureUris) {
    const transform = { offset: [0, 0], rotation: 0, scale: [1, 1] };
    return {
        id,
        mode: "metallic-roughness",
        alphaMode: "OPAQUE",
        alphaCutoff: 0.5,
        doubleSided: true,
        parameters: {
            baseColorFactor: [1, 1, 1, 1],
            metallicFactor: 1,
            roughnessFactor: 1,
            emissiveFactor: [1, 1, 1],
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
        textures: [
            { slot: "baseColor", assetUri: textureUris.baseColor, texCoord: 0, transform },
            { slot: "metallicRoughness", assetUri: textureUris.metallicRoughness, texCoord: 0, transform },
            { slot: "normal", assetUri: textureUris.normal, texCoord: 0, transform },
            { slot: "occlusion", assetUri: textureUris.occlusion, texCoord: 0, transform },
            { slot: "emissive", assetUri: textureUris.emissive, texCoord: 0, transform },
        ],
        extensions: [],
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

function bufferFor(buffers, sampleId, viewId, role) {
    const data = buffers.get(`${sampleId}:${viewId}:${role}`);
    if (!data) {
        throw artifactError("BAKE_ARTIFACT_INCOMPLETE", `Missing ${role} buffer for ${sampleId}:${viewId}.`);
    }
    return data;
}

function intrinsicRecords(construction) {
    if (construction.appearanceMode !== INTRINSIC_PBR_SUPPLIED) return [];
    return construction.intrinsicChannels.map((channel) => ({
        name: channel.name,
        present: false,
        unknown: true,
        units: channel.units,
        encoding: channel.encoding,
    }));
}

function encodeCapturedPageAssets({
    chunkKey,
    page,
    construction,
    sourceIds,
    appearanceMode,
}) {
    const texturePng = encodeDeterministicRgbaPng(page.radiance, construction.pageSizePx, construction.pageSizePx);
    const confidencePng = encodeDeterministicRgbaPng(page.confidence, construction.pageSizePx, construction.pageSizePx);
    const textureDigest = sha256ExactBytes(texturePng);
    const confidenceDigest = sha256ExactBytes(confidencePng);
    const unlit = appearanceMode === CAPTURED_RADIANCE_UNLIT;
    const materialId = bakeGeneratedRecordId(
        `atlas:${chunkKey}:${page.pageIndex}:${appearanceMode}`,
        textureDigest,
        "material",
    );
    const glb = encodeProjectedCaptureGlb({
        positions: page.positions,
        uvs: page.uvs,
        indices: page.indices,
        materialId,
    });
    const meshDigest = sha256ExactBytes(glb);
    const instanceId = bakeGeneratedRecordId(
        `atlas:${chunkKey}:${page.pageIndex}:${appearanceMode}`,
        meshDigest,
        "instance",
    );
    const textureAsset = {
        sha256: textureDigest,
        mediaType: "image/png",
        sizeBytes: texturePng.length,
        role: "texture",
    };
    const meshAsset = {
        sha256: meshDigest,
        mediaType: "model/gltf-binary",
        sizeBytes: glb.length,
        role: "mesh",
    };
    const confidenceAsset = {
        sha256: confidenceDigest,
        mediaType: "image/png",
        sizeBytes: confidencePng.length,
        role: "texture",
    };
    const textureUse = makeUse(textureAsset, sourceIds);
    const meshUse = makeUse(meshAsset, sourceIds);
    const confidenceUse = makeUse(confidenceAsset, sourceIds);
    const textureUri = `sha256:${textureDigest}`;
    const meshUri = `sha256:${meshDigest}`;
    const confidenceUri = `sha256:${confidenceDigest}`;
    const textureUseHash = hashVisualAssetUse(textureUse);
    const meshUseHash = hashVisualAssetUse(meshUse);
    const confidenceUseHash = hashVisualAssetUse(confidenceUse);
    return {
        materialId,
        instanceId,
        textureDigest,
        meshDigest,
        confidenceDigest,
        textureUse,
        meshUse,
        confidenceUse,
        textureUri,
        meshUri,
        confidenceUri,
        material: generatedMaterial(materialId, textureUri, { unlit }),
        instance: {
            id: instanceId,
            assetUri: meshUri,
            lodLevels: [meshUri],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            chunkIds: [],
            materialIds: [materialId],
        },
        uploads: [
            {
                kind: "texture",
                chunkKey,
                pageIndex: page.pageIndex,
                role: "texture",
                bytes: texturePng,
                mediaType: "image/png",
                use: textureUse,
                useHash: textureUseHash,
            },
            {
                kind: "mesh",
                chunkKey,
                pageIndex: page.pageIndex,
                role: "mesh",
                bytes: glb,
                mediaType: "model/gltf-binary",
                use: meshUse,
                useHash: meshUseHash,
            },
            {
                kind: "confidence",
                chunkKey,
                pageIndex: page.pageIndex,
                role: "texture",
                bytes: confidencePng,
                mediaType: "image/png",
                use: confidenceUse,
                useHash: confidenceUseHash,
            },
        ],
        generatedAssets: [
            {
                chunkKey,
                pageIndex: page.pageIndex,
                role: "texture",
                sha256: textureDigest,
                mediaType: "image/png",
                sizeBytes: texturePng.length,
                useHash: textureUseHash,
            },
            {
                chunkKey,
                pageIndex: page.pageIndex,
                role: "mesh",
                sha256: meshDigest,
                mediaType: "model/gltf-binary",
                sizeBytes: glb.length,
                useHash: meshUseHash,
            },
            {
                chunkKey,
                pageIndex: page.pageIndex,
                role: "texture",
                sha256: confidenceDigest,
                mediaType: "image/png",
                sizeBytes: confidencePng.length,
                useHash: confidenceUseHash,
            },
        ],
        pageRecord: {
            pageIndex: page.pageIndex,
            texture: {
                sha256: textureDigest,
                mediaType: "image/png",
                sizeBytes: texturePng.length,
                useHash: textureUseHash,
                role: "texture",
            },
            mesh: {
                sha256: meshDigest,
                mediaType: "model/gltf-binary",
                sizeBytes: glb.length,
                useHash: meshUseHash,
                role: "mesh",
            },
            confidence: {
                sha256: confidenceDigest,
                mediaType: "image/png",
                sizeBytes: confidencePng.length,
                useHash: confidenceUseHash,
                role: "texture",
            },
        },
        coverageCount: page.coverageCount,
        conflictCount: page.conflictCount,
        closureUris: [textureUri, meshUri, confidenceUri],
        appearanceUris: [textureUri, confidenceUri],
        outputDigests: [textureDigest, meshDigest, confidenceDigest],
        intrinsic: false,
    };
}


function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(value)));
}

function linearSrgbByte(value) {
    const linear = Math.max(0, Math.min(1, value));
    const encoded = linear <= 0.0031308
        ? linear * 12.92
        : 1.055 * (linear ** (1 / 2.4)) - 0.055;
    return clampByte(encoded * 255);
}

function rgbaFromChannel(channel, mapper) {
    const pixels = channel.knownMask.length;
    const components = channel.values.length / pixels;
    const rgba = new Uint8Array(pixels * 4);
    for (let pixel = 0; pixel < pixels; pixel += 1) {
        const tuple = channel.values.subarray(pixel * components, (pixel + 1) * components);
        const color = mapper(tuple);
        rgba[pixel * 4] = color[0];
        rgba[pixel * 4 + 1] = color[1];
        rgba[pixel * 4 + 2] = color[2];
        rgba[pixel * 4 + 3] = 255;
    }
    return rgba;
}

function scalarDiagnostic(values, float = false) {
    const rgba = new Uint8Array(values.length * 4);
    for (let index = 0; index < values.length; index += 1) {
        const byte = float ? clampByte(values[index] * 255) : (values[index] ? 255 : 0);
        rgba[index * 4] = byte;
        rgba[index * 4 + 1] = byte;
        rgba[index * 4 + 2] = byte;
        rgba[index * 4 + 3] = 255;
    }
    return rgba;
}

function encodeIntrinsicPageAssets({ chunkKey, page, construction, sourceIds, appearanceMode }) {
    const size = construction.pageSizePx;
    const channels = page.intrinsic;
    const runtimeRgba = {
        baseColor: rgbaFromChannel(channels["base-color"], (value) => value.map(linearSrgbByte)),
        normal: rgbaFromChannel(channels.normal, (value) => value.map((entry) => clampByte((entry * 0.5 + 0.5) * 255))),
        metallicRoughness: (() => {
            const pixels = channels.roughness.knownMask.length;
            const rgba = new Uint8Array(pixels * 4);
            for (let pixel = 0; pixel < pixels; pixel += 1) {
                rgba[pixel * 4] = 255;
                rgba[pixel * 4 + 1] = clampByte(channels.roughness.values[pixel] * 255);
                rgba[pixel * 4 + 2] = clampByte(channels.metalness.values[pixel] * 255);
                rgba[pixel * 4 + 3] = 255;
            }
            return rgba;
        })(),
        emissive: rgbaFromChannel(channels.emissive, (value) => value.map(linearSrgbByte)),
        occlusion: rgbaFromChannel(channels.occlusion, (value) => {
            const byte = clampByte(value[0] * 255);
            return [byte, 255, 255];
        }),
    };
    const runtime = {};
    const uploads = [];
    const generatedAssets = [];
    const addTexture = (name, bytes, kind = name) => {
        const digest = sha256ExactBytes(bytes);
        const asset = { sha256: digest, mediaType: "image/png", sizeBytes: bytes.length, role: "texture" };
        const use = makeUse(asset, sourceIds);
        const useHash = hashVisualAssetUse(use);
        const uri = `sha256:${digest}`;
        uploads.push({ kind, chunkKey, pageIndex: page.pageIndex, role: "texture", bytes, mediaType: "image/png", use, useHash });
        generatedAssets.push({ chunkKey, pageIndex: page.pageIndex, role: "texture", sha256: digest, mediaType: "image/png", sizeBytes: bytes.length, useHash });
        return { digest, uri, use, useHash, bytes };
    };
    for (const [name, rgba] of Object.entries(runtimeRgba)) {
        runtime[name] = addTexture(name, encodeDeterministicRgbaPng(rgba, size, size), `intrinsic-${name}`);
    }
    const diagnostics = {};
    for (const policy of construction.intrinsicChannels) {
        const channel = channels[policy.name];
        diagnostics[policy.name] = {
            confidence: addTexture(
                `${policy.name}-confidence`,
                encodeDeterministicRgbaPng(scalarDiagnostic(channel.confidence, true), size, size),
                "intrinsic-confidence",
            ),
            knownMask: addTexture(
                `${policy.name}-known-mask`,
                encodeDeterministicRgbaPng(scalarDiagnostic(channel.knownMask), size, size),
                "intrinsic-known-mask",
            ),
        };
    }
    const textureUris = Object.fromEntries(Object.entries(runtime).map(([name, entry]) => [name, entry.uri]));
    const runtimeKey = Object.values(runtime).map((entry) => entry.digest).join(":");
    const materialId = bakeGeneratedRecordId(
        `atlas:${chunkKey}:${page.pageIndex}:${appearanceMode}`,
        sha256ExactBytes(new TextEncoder().encode(runtimeKey)),
        "material",
    );
    const glb = encodeProjectedCaptureGlb({ positions: page.positions, uvs: page.uvs, indices: page.indices, materialId });
    const meshDigest = sha256ExactBytes(glb);
    const meshAsset = { sha256: meshDigest, mediaType: "model/gltf-binary", sizeBytes: glb.length, role: "mesh" };
    const meshUse = makeUse(meshAsset, sourceIds);
    const meshUseHash = hashVisualAssetUse(meshUse);
    const meshUri = `sha256:${meshDigest}`;
    uploads.push({ kind: "mesh", chunkKey, pageIndex: page.pageIndex, role: "mesh", bytes: glb, mediaType: "model/gltf-binary", use: meshUse, useHash: meshUseHash });
    generatedAssets.push({ chunkKey, pageIndex: page.pageIndex, role: "mesh", sha256: meshDigest, mediaType: "model/gltf-binary", sizeBytes: glb.length, useHash: meshUseHash });
    const instanceId = bakeGeneratedRecordId(`atlas:${chunkKey}:${page.pageIndex}:${appearanceMode}`, meshDigest, "instance");
    const textureForChannel = {
        "base-color": runtime.baseColor,
        normal: runtime.normal,
        roughness: runtime.metallicRoughness,
        metalness: runtime.metallicRoughness,
        emissive: runtime.emissive,
        occlusion: runtime.occlusion,
    };
    const manifestChannels = construction.intrinsicChannels.map((policy) => {
        const channel = channels[policy.name];
        return {
            name: policy.name,
            state: channel.state,
            textureSha256: textureForChannel[policy.name].digest,
            confidenceSha256: diagnostics[policy.name].confidence.digest,
            knownMaskSha256: diagnostics[policy.name].knownMask.digest,
            units: policy.units,
            encoding: policy.encoding,
            declaredDefault: policy.declaredDefault,
            coverageCount: channel.coverageCount,
            conflictCount: channel.conflictCount,
            defaultAppliedCount: channel.defaultAppliedCount,
            unknownCount: channel.unknownCount,
        };
    });
    const base = runtime.baseColor;
    const baseConfidence = diagnostics["base-color"].confidence;
    return {
        materialId,
        instanceId,
        textureDigest: base.digest,
        meshDigest,
        confidenceDigest: baseConfidence.digest,
        textureUri: base.uri,
        meshUri,
        confidenceUri: baseConfidence.uri,
        material: generatedIntrinsicMaterial(materialId, textureUris),
        instance: {
            id: instanceId,
            assetUri: meshUri,
            lodLevels: [meshUri],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            chunkIds: [],
            materialIds: [materialId],
        },
        uploads,
        generatedAssets,
        pageRecord: {
            pageIndex: page.pageIndex,
            texture: { sha256: base.digest, mediaType: "image/png", sizeBytes: base.bytes.length, useHash: base.useHash, role: "texture" },
            mesh: { sha256: meshDigest, mediaType: "model/gltf-binary", sizeBytes: glb.length, useHash: meshUseHash, role: "mesh" },
            confidence: { sha256: baseConfidence.digest, mediaType: "image/png", sizeBytes: baseConfidence.bytes.length, useHash: baseConfidence.useHash, role: "texture" },
        },
        coverageCount: manifestChannels.reduce((sum, entry) => sum + entry.coverageCount, 0),
        conflictCount: manifestChannels.reduce((sum, entry) => sum + entry.conflictCount, 0),
        manifestChannels,
        closureUris: [...Object.values(runtime).map((entry) => entry.uri), meshUri],
        appearanceUris: [
            ...Object.values(runtime).map((entry) => entry.uri),
            ...Object.values(diagnostics).flatMap((entry) => [entry.confidence.uri, entry.knownMask.uri]),
        ],
        outputDigests: [
            meshDigest,
            ...Object.values(runtime).map((entry) => entry.digest),
            ...Object.values(diagnostics).flatMap((entry) => [entry.confidence.digest, entry.knownMask.digest]),
        ],
        intrinsic: true,
    };
}

function encodePageAssets(options) {
    return isIntrinsicProposalConstruction(options.construction)
        ? encodeIntrinsicPageAssets(options)
        : encodeCapturedPageAssets(options);
}

export function encodeUnitContribution({
    sample,
    buffers,
    layout,
    construction,
    unitId,
    viewsById,
    proposalValidation = null,
}) {
    const view = viewsById.get(sample.viewId);
    const width = view?.camera?.width;
    const height = view?.camera?.height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw artifactError("BAKE_ARTIFACT_INCOMPLETE", `Missing camera size for ${sample.viewId}.`);
    }
    const worldPosition = bufferFor(buffers, sample.sampleId, sample.viewId, "world-position");
    const validity = bufferFor(buffers, sample.sampleId, sample.viewId, "validity");
    const geometricNormal = bufferFor(buffers, sample.sampleId, sample.viewId, "geometric-normal");
    const confidence = bufferFor(buffers, sample.sampleId, sample.viewId, "confidence");
    const pose = sample.pose ?? view?.pose;
    let records;
    if (isIntrinsicProposalConstruction(construction)) {
        if (!proposalValidation) {
            throw artifactError("BAKE_MATERIAL_PROPOSAL_MISSING", "Intrinsic construction requires validated material proposals.");
        }
        const proposalUnit = proposalValidation.proposalSet.units.find((entry) => entry.unitId === unitId);
        if (!proposalUnit) throw artifactError("BAKE_MATERIAL_PROPOSAL_MISSING", `Missing proposal unit ${unitId}.`);
        records = mapMaterialProposalsToContributions({
            layout,
            worldPosition,
            geometricNormal,
            captureConfidence: confidence,
            validity,
            width,
            height,
            cameraPosition: cameraPosition(pose),
            unitId,
            proposalUnit,
            proposalSources: proposalValidation.proposalSet.sources,
            proposalBuffers: proposalValidation.buffers,
        });
    } else {
        const beauty = bufferFor(buffers, sample.sampleId, sample.viewId, "beauty");
        records = mapCaptureToContributions({
            layout,
            beauty,
            worldPosition,
            geometricNormal,
            confidence,
            validity,
            width,
            height,
            cameraPosition: cameraPosition(pose),
            unitId,
        });
    }
    const bytes = encodeBakeAtlasContribution({
        version: isIntrinsicProposalConstruction(construction) ? 2 : 1,
        unitId,
        constructionHash: hashBakeConstruction(construction),
        ...(proposalValidation ? { proposalUnitHash: proposalValidation.unitDigests.get(unitId) } : {}),
        records,
    });
    return { unitId, bytes, records, decoded: decodeBakeAtlasContribution(bytes) };
}

export function buildAtlasLayoutFromScene(scene, construction) {
    const triangles = extractBakeSnapshotTriangles(scene);
    return buildAtlasLayout({ triangles, construction });
}

function contributionAsset(bytes, sourceIds) {
    const digest = sha256ExactBytes(bytes);
    const asset = {
        sha256: digest,
        mediaType: "application/octet-stream",
        sizeBytes: bytes.length,
        role: "buffer",
    };
    const use = makeUse(asset, sourceIds);
    return {
        use,
        useHash: hashVisualAssetUse(use),
        record: {
            sha256: digest,
            mediaType: "application/octet-stream",
            sizeBytes: bytes.length,
            useHash: hashVisualAssetUse(use),
            role: "buffer",
        },
    };
}

export function writeAtlasArtifacts({
    job,
    buffers,
    sourceIds,
    currentDescriptor = null,
    currentAccess = null,
    worldHash,
    graph = null,
    scene = null,
    layout = null,
    captureUnitIds = null,
    previousContributions = null,
    previousPages = null,
    rebuildChunkKeys = null,
    construction,
    finalize,
    materialProposalSet = null,
    materialProposalBuffers = null,
} = {}) {
    if (!isChunkAtlasConstruction(construction)) {
        throw artifactError("BAKE_ARTIFACT_INVALID", "Atlas writer requires chunk-atlas@1 construction.");
    }
    const snapshotScene = scene ?? job.sceneHandle?.scene ?? null;
    const atlasLayout = layout ?? buildAtlasLayoutFromScene(snapshotScene, construction);
    const viewsById = viewsWithCameras(job);
    const captureSet = captureUnitIds ? new Set(captureUnitIds) : null;
    const rebuild = rebuildChunkKeys ? new Set(rebuildChunkKeys) : null;
    const contributionPayloads = new Map(previousContributions ?? []);
    const contributionUploads = [];
    const reuseUnits = [];
    const writer = writerForConstruction(construction);
    const proposalValidation = isIntrinsicProposalConstruction(construction)
        ? validateBakeMaterialProposals({
            proposalSet: materialProposalSet,
            buffers: materialProposalBuffers,
            construction,
            job,
        })
        : null;

    for (const sample of job.plan.samples) {
        const unitId = bakeCaptureUnitId(sample.pathId, sample.sampleIndex, sample.viewId);
        const graphUnit = graph?.units?.find((entry) => entry.unitId === unitId);
        const shouldCapture = !captureSet || captureSet.has(unitId);
        let payload = contributionPayloads.get(unitId);
        if (shouldCapture) {
            payload = encodeUnitContribution({
                sample,
                buffers,
                layout: atlasLayout,
                construction,
                unitId,
                viewsById,
                proposalValidation,
            }).bytes;
            contributionPayloads.set(unitId, payload);
        }
        if (!payload) {
            throw artifactError("BAKE_REUSE_INVALID", `Missing reusable contribution for ${unitId}.`);
        }
        const decodedPayload = decodeBakeAtlasContribution(payload);
        if (decodedPayload.constructionHash !== hashBakeConstruction(construction)) {
            throw artifactError("BAKE_REUSE_INVALID", `Contribution construction binding is stale for ${unitId}.`);
        }
        if (proposalValidation && (
            decodedPayload.version !== 2
            || decodedPayload.proposalUnitHash !== proposalValidation.unitDigests.get(unitId)
        )) {
            throw artifactError("BAKE_REUSE_INVALID", `Contribution proposal binding is stale for ${unitId}.`);
        }
        const asset = contributionAsset(payload, sourceIds);
        contributionUploads.push({
            kind: "contribution",
            unitId,
            sampleId: sample.sampleId,
            viewId: sample.viewId,
            role: "buffer",
            bytes: payload,
            mediaType: "application/octet-stream",
            use: asset.use,
            useHash: asset.useHash,
        });
        reuseUnits.push({
            unitId,
            pathId: sample.pathId,
            sampleIndex: sample.sampleIndex,
            viewId: sample.viewId,
            dependencyKey: graphUnit?.dependencyKey ?? "0".repeat(64),
            chunkKeys: graphUnit?.chunkKeys ?? [...new Set(
                decodedPayload.records.map((entry) => entry.chunkKey),
            )].sort(compareUtf8),
            contribution: asset.record,
        });
    }

    const recordsByChunk = new Map();
    for (const unit of reuseUnits) {
        const decoded = decodeBakeAtlasContribution(contributionPayloads.get(unit.unitId));
        for (const record of decoded.records) {
            const list = recordsByChunk.get(record.chunkKey) ?? [];
            list.push({ ...record, unitId: unit.unitId });
            recordsByChunk.set(record.chunkKey, list);
        }
    }

    const uploads = [];
    const generatedAssets = [];
    const generatedMaterials = [];
    const generatedInstances = [];
    const generatedChunks = [];
    const appearanceDependencies = [];
    const usesByHash = new Map();
    const keepGeneratedIds = new Set();
    const chunkOutputs = [];
    const previousPageMap = previousPages ?? new Map();

    for (const chunk of atlasLayout.chunks) {
        const previous = previousPageMap.get(chunk.chunkKey);
        const dirty = !rebuild || rebuild.has(chunk.chunkKey) || !previous || previous.chartHash !== chunk.chartHash;
        let pageEncodings;
        let coverageCount = 0;
        let conflictCount = 0;
        if (!dirty && previous) {
            pageEncodings = previous.encodings;
            coverageCount = previous.coverageCount;
            conflictCount = previous.conflictCount;
        } else {
            const fused = fuseChunkPages({
                chunk,
                contributions: recordsByChunk.get(chunk.chunkKey) ?? [],
                construction,
            }).filter((page) => page.positions.length);
            if (!fused.length) continue;
            pageEncodings = fused.map((page) => encodePageAssets({
                chunkKey: chunk.chunkKey,
                page,
                construction,
                sourceIds,
                appearanceMode: construction.appearanceMode,
            }));
            coverageCount = fused.reduce((sum, page) => sum + page.coverageCount, 0);
            conflictCount = fused.reduce((sum, page) => sum + page.conflictCount, 0);
        }
        if (!pageEncodings.length) continue;
        const outputHash = sha256ExactBytes(new TextEncoder().encode(pageEncodings.map((entry) => (
            entry.outputDigests.join(":")
        )).join("|")));
        const visualChunkId = bakeGeneratedRecordId(
            `atlas-chunk:${chunk.chunkKey}:${chunk.chartHash}`,
            outputHash,
            "chunk",
        );
        keepGeneratedIds.add(visualChunkId);
        const instanceIds = [];
        const dependencyUris = [];
        const pages = [];
        for (const encoded of pageEncodings) {
            encoded.instance.chunkIds = [visualChunkId];
            generatedMaterials.push(encoded.material);
            generatedInstances.push(encoded.instance);
            instanceIds.push(encoded.instanceId);
            keepGeneratedIds.add(encoded.materialId);
            keepGeneratedIds.add(encoded.instanceId);
            dependencyUris.push(...encoded.closureUris);
            appearanceDependencies.push(...encoded.appearanceUris);
            generatedAssets.push(...encoded.generatedAssets);
            uploads.push(...encoded.uploads);
            for (const upload of encoded.uploads) usesByHash.set(upload.useHash, upload.use);
            pages.push(encoded.intrinsic
                ? {
                    pageIndex: encoded.pageRecord.pageIndex,
                    width: construction.pageSizePx,
                    height: construction.pageSizePx,
                    meshSha256: encoded.meshDigest,
                    channels: encoded.manifestChannels,
                }
                : {
                    pageIndex: encoded.pageRecord.pageIndex,
                    width: construction.pageSizePx,
                    height: construction.pageSizePx,
                    textureSha256: encoded.textureDigest,
                    meshSha256: encoded.meshDigest,
                    confidenceSha256: encoded.confidenceDigest,
                    coverageCount: encoded.coverageCount,
                    conflictCount: encoded.conflictCount,
                    intrinsic: intrinsicRecords(construction),
                });
        }
        generatedChunks.push({
            id: visualChunkId,
            instanceIds,
            dependencyUris: [...new Set(dependencyUris)],
        });
        chunkOutputs.push({
            chunkKey: chunk.chunkKey,
            chartHash: chunk.chartHash,
            outputHash,
            coverageCount,
            conflictCount,
            pages,
            encodings: pageEncodings,
            dependencyKey: graph?.chunkKeys?.find((entry) => entry.chunkKey === chunk.chunkKey)?.dependencyKey
                ?? "0".repeat(64),
        });
    }

    const atlasManifest = atlasManifestFromConstruction(construction, chunkOutputs.map((entry) => ({
        chunkKey: entry.chunkKey,
        chartHash: entry.chartHash,
        outputHash: entry.outputHash,
        coverageCount: entry.coverageCount,
        conflictCount: entry.conflictCount,
        pages: entry.pages,
    })));
    const atlasBytes = atlasManifestBytes(atlasManifest);
    const atlasAsset = {
        sha256: sha256ExactBytes(atlasBytes),
        mediaType: "application/octet-stream",
        sizeBytes: atlasBytes.length,
        role: "buffer",
    };
    const atlasUse = makeUse(atlasAsset, sourceIds);
    const atlasUseHash = hashVisualAssetUse(atlasUse);
    uploads.push({
        kind: "atlas-manifest",
        chunkKey: "*",
        pageIndex: 0,
        role: "buffer",
        bytes: atlasBytes,
        mediaType: "application/octet-stream",
        use: atlasUse,
        useHash: atlasUseHash,
    });
    generatedAssets.push({
        chunkKey: "*",
        pageIndex: 0,
        role: "buffer",
        sha256: atlasAsset.sha256,
        mediaType: "application/octet-stream",
        sizeBytes: atlasBytes.length,
        useHash: atlasUseHash,
    });
    usesByHash.set(atlasUseHash, atlasUse);
    appearanceDependencies.push(`sha256:${atlasAsset.sha256}`);

    const boundWorld = worldHash ?? job.snapshot.worldHash;
    const base = currentDescriptor
        ? normalizeVisualLayer(currentDescriptor)
        : emptyDescriptor(boundWorld);
    const materialsById = new Map(keepTrustedBase(base.materials, keepGeneratedIds).map((entry) => [entry.id, entry]));
    for (const material of generatedMaterials) materialsById.set(material.id, material);
    const instancesById = new Map(keepTrustedBase(base.instances, keepGeneratedIds).map((entry) => [entry.id, entry]));
    for (const instance of generatedInstances) instancesById.set(instance.id, instance);
    const chunksById = new Map(keepTrustedBase(base.chunks, keepGeneratedIds).map((entry) => [entry.id, entry]));
    for (const chunk of generatedChunks) chunksById.set(chunk.id, chunk);
    const assetsByDigest = new Map(base.assets.map((asset) => [asset.sha256, asset]));
    for (const upload of uploads) assetsByDigest.set(upload.use.asset.sha256, upload.use.asset);

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

    const finalized = finalize({
        writer: {
            id: writer.id,
            version: writer.version,
            options: {
                cellSizePx: 10,
                maxTriangleDepthDelta: 1,
                surfaceOffset: 0.005,
                pngFilter: "none",
                pngDeflate: "stored-zlib",
                glbPadding: "gltf-2",
            },
        },
        generatedAssets,
        descriptor,
        uploads,
        usesByHash,
        currentAccess,
        constructionHash: hashBakeConstruction(construction),
        atlasManifestDigest: atlasAsset.sha256,
        artifactVersion: proposalValidation ? 3 : 2,
        ...(proposalValidation ? { materialProposalHash: proposalValidation.proposalHash } : {}),
    });

    const reuseManifest = graph
        ? normalizeBakeReuseManifest({
            kind: "cev-sim.bake-reuse-manifest",
            version: BAKE_REUSE_MANIFEST_VERSION_V2,
            sourceWorldHash: boundWorld,
            keyVersion: graph.keyVersion,
            globalKey: graph.globalKey,
            chunkKeys: graph.chunkKeys,
            units: reuseUnits,
            chunks: chunkOutputs.map((entry) => ({
                chunkKey: entry.chunkKey,
                dependencyKey: entry.dependencyKey,
                chartHash: entry.chartHash,
                outputHash: entry.outputHash,
                pages: entry.encodings.map((encoded) => encoded.pageRecord),
            })),
            writer,
            descriptorHash: hashVisualLayer(finalized.descriptor),
            accessHash: hashVisualLayerAccess(finalized.access),
            constructionHash: hashBakeConstruction(construction),
            atlasManifestDigest: atlasAsset.sha256,
        })
        : null;

    return {
        ...finalized,
        contributionUploads,
        contributionPayloads,
        reuseManifest,
        reuseUnits,
        atlasLayout,
        atlasManifest,
        chunkOutputs,
        writer,
        materialProposalSet: proposalValidation?.proposalSet ?? null,
        materialProposalHash: proposalValidation?.proposalHash ?? null,
    };
}
