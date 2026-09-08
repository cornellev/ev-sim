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

function encodePageAssets({
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
    };
}

export function encodeUnitContribution({
    sample,
    buffers,
    layout,
    construction,
    unitId,
    viewsById,
}) {
    const view = viewsById.get(sample.viewId);
    const width = view?.camera?.width;
    const height = view?.camera?.height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
        throw artifactError("BAKE_ARTIFACT_INCOMPLETE", `Missing camera size for ${sample.viewId}.`);
    }
    const beauty = bufferFor(buffers, sample.sampleId, sample.viewId, "beauty");
    const worldPosition = bufferFor(buffers, sample.sampleId, sample.viewId, "world-position");
    const validity = bufferFor(buffers, sample.sampleId, sample.viewId, "validity");
    const geometricNormal = bufferFor(buffers, sample.sampleId, sample.viewId, "geometric-normal");
    const confidence = bufferFor(buffers, sample.sampleId, sample.viewId, "confidence");
    const pose = sample.pose ?? view?.pose;
    const records = mapCaptureToContributions({
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
    const bytes = encodeBakeAtlasContribution({
        unitId,
        constructionHash: hashBakeConstruction(construction),
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
            }).bytes;
            contributionPayloads.set(unitId, payload);
        }
        if (!payload) {
            throw artifactError("BAKE_REUSE_INVALID", `Missing reusable contribution for ${unitId}.`);
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
                decodeBakeAtlasContribution(payload).records.map((entry) => entry.chunkKey),
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
            `${entry.textureDigest}:${entry.meshDigest}:${entry.confidenceDigest}`
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
            dependencyUris.push(encoded.textureUri, encoded.meshUri, encoded.confidenceUri);
            appearanceDependencies.push(encoded.textureUri, encoded.confidenceUri);
            generatedAssets.push(...encoded.generatedAssets);
            uploads.push(...encoded.uploads);
            for (const upload of encoded.uploads) usesByHash.set(upload.useHash, upload.use);
            pages.push({
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
        artifactVersion: 2,
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
    };
}
