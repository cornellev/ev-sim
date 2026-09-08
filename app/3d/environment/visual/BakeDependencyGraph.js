/**
 * VIS-09 per-unit bake dependency graph. Keys are recomputed from authoritative
 * snapshot/config/scene state at bake time. sourceWorldHash binds the layer
 * and never enters per-unit reuse keys. Residency is ignored.
 */

import * as THREE from "three";

import { compareUtf8 } from "./BakeRunCatalog.js";
import {
    composeBakePoses,
    interpolateBakePathSample,
    pathLengthMeters,
    planIntegerSampleDistances,
} from "./BakeRunCatalog.js";
import { applyProjectionToThreeCamera } from "./VisualCapturePipeline.js";
import {
    BAKE_REUSE_KEY_VERSION,
    BAKE_REUSE_REASONS,
    bakeCaptureUnitId,
    hashBakeDependencyRecord,
    normalizeBakeReuseReport,
} from "./BakeReuseContracts.js";
import { PROJECTED_CAPTURED_RADIANCE_WRITER } from "./BakeDeterministicMedia.js";
import {
    constructionFromConfig,
    writerForConstruction,
} from "./BakeConstructionPolicy.js";
import { getCoveredChunkKeysForBounds } from "../../editor/chunks/ChunkIndex.js";

function asVector3(value) {
    if (!value) return new THREE.Vector3();
    if (value.isVector3 || typeof value.clone === "function") return value.clone();
    return new THREE.Vector3(value.x ?? 0, value.y ?? 0, value.z ?? 0);
}

function digestJson(value) {
    return hashBakeDependencyRecord(value);
}

function boxFromBounds(bounds) {
    return {
        minX: Number(bounds?.minX ?? 0),
        minY: Number(bounds?.minY ?? 0),
        minZ: Number(bounds?.minZ ?? 0),
        maxX: Number(bounds?.maxX ?? 0),
        maxY: Number(bounds?.maxY ?? 0),
        maxZ: Number(bounds?.maxZ ?? 0),
    };
}

function boundsFromMatrix(matrix, fallback = 0.5) {
    const origin = {
        x: Number(matrix?.[12] ?? 0),
        y: Number(matrix?.[13] ?? 0),
        z: Number(matrix?.[14] ?? 0),
    };
    return {
        minX: origin.x - fallback,
        minY: origin.y - fallback,
        minZ: origin.z - fallback,
        maxX: origin.x + fallback,
        maxY: origin.y + fallback,
        maxZ: origin.z + fallback,
    };
}

function assignedEntityId(object) {
    let current = object;
    while (current) {
        const data = current.userData ?? {};
        if (data.buildingId) return String(data.buildingId);
        if (data.entityId) return String(data.entityId);
        if (data.cevSimVisualInstanceId) return String(data.cevSimVisualInstanceId);
        current = current.parent;
    }
    return null;
}

function colorHex(color) {
    if (!color) return null;
    if (typeof color.getHex === "function") return color.getHex();
    return Number(color) || 0;
}

function textureDigest(texture) {
    if (!texture) return null;
    return digestJson({
        uuid: texture.uuid ?? null,
        imageWidth: texture.image?.width ?? texture.source?.data?.width ?? 0,
        imageHeight: texture.image?.height ?? texture.source?.data?.height ?? 0,
        encoding: texture.colorSpace ?? texture.encoding ?? null,
    });
}

function indexSnapshotEntities(snapshot) {
    const byId = new Map();
    for (const geometry of snapshot.geometryState ?? []) {
        const current = byId.get(geometry.entityId) ?? {
            entityId: geometry.entityId,
            geometryDigest: geometry.geometryDigest,
            matrix: geometry.matrix,
            visible: geometry.visible !== false,
            materials: [],
        };
        current.geometryDigest = geometry.geometryDigest;
        current.matrix = geometry.matrix;
        current.visible = geometry.visible !== false;
        byId.set(geometry.entityId, current);
    }
    for (const material of snapshot.materialState ?? []) {
        const current = byId.get(material.entityId) ?? {
            entityId: material.entityId,
            geometryDigest: "0".repeat(64),
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            visible: true,
            materials: [],
        };
        current.materials.push({
            materialDigest: material.materialDigest,
            opacity: material.opacity,
            transparent: material.transparent === true,
        });
        byId.set(material.entityId, current);
    }
    return byId;
}

function semanticRecord(entry) {
    return {
        entityId: entry.entityId,
        geometryDigest: entry.geometryDigest,
        matrix: entry.matrix,
        visible: entry.visible !== false,
        materials: [...(entry.materials ?? [])].sort((left, right) => (
            compareUtf8(left.materialDigest, right.materialDigest)
        )),
    };
}

function collectUnassignedAndShadows(scene) {
    const unassigned = [];
    const shadowCasters = [];
    const lights = [];
    if (!scene?.traverse) {
        return { unassigned, shadowCasters, lights, skyIbl: { background: null, environment: null, fog: null } };
    }
    scene.traverse((object) => {
        if (object.isLight) {
            lights.push({
                id: String(object.uuid),
                kind: object.type ?? "Light",
                color: colorHex(object.color),
                intensity: Number(object.intensity ?? 1),
                castShadow: object.castShadow === true,
                position: { x: object.position.x, y: object.position.y, z: object.position.z },
            });
        }
        if (!object.isMesh) return;
        const assigned = assignedEntityId(object);
        const record = {
            name: object.name || null,
            uuid: object.uuid,
            assigned,
            visible: object.visible !== false,
            castShadow: object.castShadow === true,
            matrix: Array.from(object.matrixWorld?.elements ?? object.matrix?.elements ?? []),
        };
        if (!assigned) unassigned.push(record);
        if (object.castShadow === true) shadowCasters.push(record);
    });
    unassigned.sort((left, right) => compareUtf8(left.uuid, right.uuid));
    shadowCasters.sort((left, right) => compareUtf8(left.uuid, right.uuid));
    lights.sort((left, right) => compareUtf8(left.id, right.id));
    return {
        unassigned,
        shadowCasters,
        lights,
        skyIbl: {
            background: colorHex(scene.background) ?? (scene.background ? textureDigest(scene.background) : null),
            environment: textureDigest(scene.environment),
            fog: scene.fog
                ? {
                    type: scene.fog.type ?? "Fog",
                    color: colorHex(scene.fog.color),
                    near: Number(scene.fog.near ?? 0),
                    far: Number(scene.fog.far ?? 0),
                    density: Number(scene.fog.density ?? 0),
                }
                : null,
        },
    };
}

function chunkMembershipRecords(chunkIndex, entitiesById, spatialIndex) {
    const records = [];
    if (chunkIndex?.listChunks) {
        for (const chunk of chunkIndex.listChunks()) {
            const objects = [...(chunk.objectIds ?? [])].sort(compareUtf8).map((objectId) => (
                semanticRecord(entitiesById.get(objectId) ?? {
                    entityId: objectId,
                    geometryDigest: "0".repeat(64),
                    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                    visible: true,
                    materials: [],
                })
            ));
            records.push({
                chunkKey: chunk.key,
                dependencyKey: digestJson({ chunkKey: chunk.key, objects }),
            });
        }
    } else if (spatialIndex?.entries) {
        const byChunk = new Map();
        for (const entry of spatialIndex.entries.values()) {
            const bounds = boxFromBounds(entry.bounds);
            const keys = entry.chunkKeys?.length
                ? entry.chunkKeys
                : getCoveredChunkKeysForBounds(bounds);
            for (const key of keys) {
                const list = byChunk.get(key) ?? [];
                list.push(entry.entityId ?? entry.id);
                byChunk.set(key, list);
            }
        }
        for (const [chunkKey, ids] of [...byChunk.entries()].sort((left, right) => compareUtf8(left[0], right[0]))) {
            const objects = [...new Set(ids)].sort(compareUtf8).map((objectId) => (
                semanticRecord(entitiesById.get(objectId) ?? {
                    entityId: objectId,
                    geometryDigest: "0".repeat(64),
                    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
                    visible: true,
                    materials: [],
                })
            ));
            records.push({
                chunkKey,
                dependencyKey: digestJson({ chunkKey, objects }),
            });
        }
    }
    return records.sort((left, right) => compareUtf8(left.chunkKey, right.chunkKey));
}

function cameraForSample(config, path, sampleIndex, view) {
    const distances = planIntegerSampleDistances(pathLengthMeters(path), config.sampling);
    const interpolated = interpolateBakePathSample(path.vertices, distances[sampleIndex]);
    const worldPose = composeBakePoses(interpolated, view.pose);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(worldPose.position.x, worldPose.position.y, worldPose.position.z);
    camera.quaternion.set(
        worldPose.rotation.x,
        worldPose.rotation.y,
        worldPose.rotation.z,
        worldPose.rotation.w,
    );
    camera.updateMatrixWorld(true);
    applyProjectionToThreeCamera(camera, view.calibration);
    return { camera, pose: worldPose, distance: distances[sampleIndex] };
}

function intersectingEntities({ spatialIndex, camera, entitiesById, scene }) {
    const hits = [];
    if (spatialIndex?.queryCaptureInfluence) {
        for (const entry of spatialIndex.queryCaptureInfluence(camera)) {
            hits.push(entry.entityId ?? entry.id);
        }
    } else if (spatialIndex?.queryFrustum) {
        for (const entry of spatialIndex.queryFrustum(camera)) {
            hits.push(entry.entityId ?? entry.id);
        }
    } else if (scene?.traverse) {
        const frustum = new THREE.Frustum();
        const matrix = new THREE.Matrix4().multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        frustum.setFromProjectionMatrix(matrix);
        scene.traverse((object) => {
            if (!object.isMesh) return;
            const box = new THREE.Box3().setFromObject(object);
            if (!frustum.intersectsBox(box)) return;
            hits.push(assignedEntityId(object) ?? object.uuid);
        });
    } else {
        hits.push(...entitiesById.keys());
    }
    return [...new Set(hits.map((id) => lookupEntity(entitiesById, id).id))].sort(compareUtf8);
}

function localEntityRecords(entityIds, entitiesById, spatialIndex) {
    return entityIds.map((entityId) => {
        const resolved = lookupEntity(entitiesById, entityId);
        const snapshot = resolved.record;
        const spatial = spatialIndex?.entries?.get(resolved.id)
            ?? spatialIndex?.entries?.get(entityId)
            ?? [...(spatialIndex?.entries?.values?.() ?? [])].find((entry) => (
                entry.entityId === entityId
                || entry.id === entityId
                || entry.entityId === resolved.id
                || entry.id === resolved.id
            ));
        const record = snapshot ?? {
            entityId: resolved.id,
            geometryDigest: spatial?.geometryDigest ?? "0".repeat(64),
            matrix: spatial?.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            visible: spatial?.visible !== false && spatial?.hidden !== true,
            materials: spatial?.materialDigest
                ? [{ materialDigest: spatial.materialDigest, opacity: 1, transparent: false }]
                : [],
        };
        const bounds = spatial?.bounds ?? boundsFromMatrix(record.matrix);
        const chunkKeys = [...(spatial?.chunkKeys ?? getCoveredChunkKeysForBounds(bounds))].sort(compareUtf8);
        return {
            ...semanticRecord(record),
            bounds: boxFromBounds(bounds),
            chunkKeys,
            kind: spatial?.kind ?? "entity",
            captureAssets: [...(spatial?.assetUris ?? [])].sort(compareUtf8),
        };
    });
}

export function buildBakeDependencyGraph({
    config,
    snapshot,
    scene = null,
    spatialIndex = null,
    chunkIndex = null,
    writer = null,
    proposalUnitDigests = null,
} = {}) {
    const construction = constructionFromConfig(config);
    const resolvedWriter = writer ?? writerForConstruction(construction);
    const entitiesById = indexSnapshotEntities(snapshot);
    const sceneInfluences = collectUnassignedAndShadows(scene);
    const lighting = [...(snapshot.lightingState ?? [])]
        .map((light) => {
            const live = sceneInfluences.lights.find((entry) => entry.id === light.id);
            return {
                ...light,
                castShadow: live?.castShadow === true,
            };
        })
        .sort((left, right) => compareUtf8(left.id, right.id));
    const unboundedShadow = lighting.some((light) => light.castShadow === true)
        || sceneInfluences.shadowCasters.length > 0;
    const unassignedObjects = sceneInfluences.unassigned;
    const globalRecord = {
        keyVersion: BAKE_REUSE_KEY_VERSION,
        skyIbl: sceneInfluences.skyIbl,
        renderer: scene?.userData?.bakeRendererState ?? null,
        lighting,
        unboundedShadow,
        unboundedOcclusion: unboundedShadow,
        unassignedObjects,
        algorithms: snapshot.algorithms,
        writer: {
            id: resolvedWriter.id ?? PROJECTED_CAPTURED_RADIANCE_WRITER.id,
            version: resolvedWriter.version ?? PROJECTED_CAPTURED_RADIANCE_WRITER.version,
            ...(resolvedWriter.constructionHash ? { constructionHash: resolvedWriter.constructionHash } : {}),
        },
        provider: config.provider,
        outputRoles: [...(config.outputRoles ?? [])],
        seed: config.seed,
        seedKeys: config.seedKeys,
    };
    const globalKey = digestJson(globalRecord);
    const chunkKeys = chunkMembershipRecords(chunkIndex, entitiesById, spatialIndex);
    const units = [];
    for (const path of config.paths ?? []) {
        const distances = planIntegerSampleDistances(pathLengthMeters(path), config.sampling);
        for (let sampleIndex = 0; sampleIndex < distances.length; sampleIndex += 1) {
            for (const view of config.views ?? []) {
                const unitId = bakeCaptureUnitId(path.id, sampleIndex, view.id);
                const { camera, pose } = cameraForSample(config, path, sampleIndex, view);
                const intersecting = intersectingEntities({
                    spatialIndex,
                    camera,
                    entitiesById,
                    scene,
                });
                const localEntities = localEntityRecords(intersecting, entitiesById, spatialIndex);
                const unitChunkKeys = [...new Set(localEntities.flatMap((entry) => entry.chunkKeys))].sort(compareUtf8);
                const dependencyKey = digestJson({
                    unitId,
                    pathId: path.id,
                    sampleIndex,
                    viewId: view.id,
                    pose,
                    calibration: view.calibration,
                    camera: view.camera,
                    products: view.products,
                    includeTags: view.includeTags,
                    excludeTags: view.excludeTags,
                    path: {
                        id: path.id,
                        vertices: path.vertices,
                    },
                    sampling: config.sampling,
                    seed: config.seed,
                    seedKeys: config.seedKeys,
                    algorithms: snapshot.algorithms,
                    planner: config.planner,
                    writer: globalRecord.writer,
                    outputRoles: config.outputRoles,
                    localEntities,
                    intersectingChunkKeys: unitChunkKeys,
                    captureAssets: [...new Set(localEntities.flatMap((entry) => entry.captureAssets))].sort(compareUtf8),
                    proposalUnitDigest: proposalUnitDigests?.get(unitId) ?? null,
                });
                units.push({
                    unitId,
                    pathId: path.id,
                    sampleIndex,
                    viewId: view.id,
                    dependencyKey,
                    chunkKeys: unitChunkKeys,
                    localEntityIds: intersecting,
                });
            }
        }
    }
    units.sort((left, right) => compareUtf8(left.unitId, right.unitId));
    return {
        sourceWorldHash: snapshot.worldHash,
        keyVersion: BAKE_REUSE_KEY_VERSION,
        globalKey,
        globalRecord,
        chunkKeys,
        units,
        writer: globalRecord.writer,
        construction: construction,
    };
}

function previousByUnit(manifest) {
    const map = new Map();
    for (const unit of manifest?.units ?? []) map.set(unit.unitId, unit);
    return map;
}

function lookupEntity(entitiesById, entityId) {
    const id = String(entityId);
    if (entitiesById.has(id)) return { id, record: entitiesById.get(id) };
    const stripped = id.replace(/^building:/, "");
    if (entitiesById.has(stripped)) return { id: stripped, record: entitiesById.get(stripped) };
    const prefixed = `building:${id}`;
    if (entitiesById.has(prefixed)) return { id: prefixed, record: entitiesById.get(prefixed) };
    return { id, record: null };
}

function pickGlobalReason(current, previous) {
    if (!previous) return [BAKE_REUSE_REASONS.MISSING_PROVENANCE];
    if (previous.keyVersion !== current.keyVersion) return [BAKE_REUSE_REASONS.ALGORITHM];
    if (previous.globalKey === current.globalKey) return [];
    const prev = previous.globalRecord;
    const next = current.globalRecord;
    if (!prev || !next) return [BAKE_REUSE_REASONS.GLOBAL_KEY_CHANGED];
    const reasons = [];
    if (digestJson(prev.skyIbl) !== digestJson(next.skyIbl)) reasons.push(BAKE_REUSE_REASONS.GLOBAL_SKY_IBL);
    if (digestJson(prev.lighting) !== digestJson(next.lighting)) reasons.push(BAKE_REUSE_REASONS.GLOBAL_LIGHTING);
    if (Boolean(prev.unboundedShadow) !== Boolean(next.unboundedShadow)) {
        reasons.push(BAKE_REUSE_REASONS.UNBOUNDED_SHADOW);
    }
    if (Boolean(prev.unboundedOcclusion) !== Boolean(next.unboundedOcclusion)) {
        reasons.push(BAKE_REUSE_REASONS.UNBOUNDED_OCCLUSION);
    }
    if (digestJson(prev.unassignedObjects) !== digestJson(next.unassignedObjects)) {
        reasons.push(BAKE_REUSE_REASONS.UNASSIGNED_OBJECT);
    }
    if (
        digestJson(prev.algorithms) !== digestJson(next.algorithms)
        || digestJson(prev.provider) !== digestJson(next.provider)
        || digestJson(prev.writer) !== digestJson(next.writer)
        || prev.seed !== next.seed
        || digestJson(prev.seedKeys) !== digestJson(next.seedKeys)
        || digestJson(prev.outputRoles) !== digestJson(next.outputRoles)
    ) {
        reasons.push(BAKE_REUSE_REASONS.ALGORITHM);
    }
    if (!reasons.length) reasons.push(BAKE_REUSE_REASONS.GLOBAL_KEY_CHANGED);
    return [...new Set(reasons)].sort(compareUtf8);
}

export function compareBakeReuseGraphs({
    graph,
    previousManifest = null,
    previousGraph = null,
    reuseDisabled = false,
} = {}) {
    const previous = previousManifest
        ? previousByUnit(previousManifest)
        : previousByUnit({ units: previousGraph?.units ?? [] });
    const atlasWriter = graph.writer?.id === "chunk-atlas";
    const v1Candidate = Boolean(previousManifest) && previousManifest.version === 1 && atlasWriter;
    const trusted = Boolean(previousManifest)
        && previousManifest.keyVersion === graph.keyVersion
        && !reuseDisabled
        && !v1Candidate;
    const globalReasons = [];
    if (reuseDisabled) globalReasons.push(BAKE_REUSE_REASONS.REUSE_DISABLED);
    else if (!previousManifest) globalReasons.push(BAKE_REUSE_REASONS.MISSING_PROVENANCE);
    else if (v1Candidate) globalReasons.push(BAKE_REUSE_REASONS.LEGACY_REBUILD);
    else globalReasons.push(...pickGlobalReason({
        keyVersion: graph.keyVersion,
        globalKey: graph.globalKey,
        globalRecord: graph.globalRecord,
    }, {
        keyVersion: previousManifest.keyVersion,
        globalKey: previousManifest.globalKey,
        globalRecord: previousGraph?.globalRecord ?? null,
    }));
    const globalInvalidatesAll = !trusted || globalReasons.some((reason) => reason !== BAKE_REUSE_REASONS.MISSING_PROVENANCE);
    const reused = [];
    const invalidated = [];
    const captured = [];
    const currentIds = new Set(graph.units.map((unit) => unit.unitId));
    for (const unit of graph.units) {
        const prior = previous.get(unit.unitId);
        if (trusted && prior && prior.dependencyKey === unit.dependencyKey && !globalInvalidatesAll) {
            reused.push({ unitId: unit.unitId, reason: BAKE_REUSE_REASONS.KEYS_UNCHANGED });
            continue;
        }
        let reason = BAKE_REUSE_REASONS.LEGACY_REBUILD;
        if (reuseDisabled) reason = BAKE_REUSE_REASONS.REUSE_DISABLED;
        else if (v1Candidate) reason = BAKE_REUSE_REASONS.LEGACY_REBUILD;
        else if (!trusted) reason = BAKE_REUSE_REASONS.MISSING_PROVENANCE;
        else if (globalInvalidatesAll && globalReasons[0]) reason = globalReasons[0];
        else if (!prior) reason = BAKE_REUSE_REASONS.UNIT_ADDED;
        else if (prior.dependencyKey !== unit.dependencyKey) reason = BAKE_REUSE_REASONS.KEY_MISMATCH;
        invalidated.push({ unitId: unit.unitId, reason });
        captured.push({ unitId: unit.unitId, reason: BAKE_REUSE_REASONS.CAPTURED });
    }
    const removed = [];
    for (const [unitId] of previous) {
        if (currentIds.has(unitId)) continue;
        removed.push({ unitId, reason: BAKE_REUSE_REASONS.UNIT_REMOVED });
    }
    const allReused = reused.length === graph.units.length && captured.length === 0 && removed.length === 0;
    const mode = allReused && trusted && previousManifest?.sourceWorldHash === graph.sourceWorldHash
        ? "noop"
        : "promote";
    const report = normalizeBakeReuseReport({
        kind: "cev-sim.bake-reuse-report",
        version: 1,
        sourceWorldHash: graph.sourceWorldHash,
        previousManifestHash: null,
        mode,
        reused,
        invalidated,
        removed,
        captured,
        uploaded: [],
        globalReasons: [...new Set(globalReasons)].sort(compareUtf8),
    });
    return {
        report,
        reusedUnitIds: reused.map((entry) => entry.unitId),
        captureUnitIds: captured.map((entry) => entry.unitId),
        removedUnitIds: removed.map((entry) => entry.unitId),
        mode,
    };
}

export function fragmentMapFromManifest(manifest) {
    const map = new Map();
    for (const unit of manifest?.units ?? []) {
        if (unit.fragments) map.set(unit.unitId, unit.fragments);
    }
    return map;
}
