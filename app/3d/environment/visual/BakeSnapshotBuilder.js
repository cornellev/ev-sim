import * as THREE from "three";

import {
    evaluateVisualSourcePolicy,
    hashVisualLayer,
    hashVisualLayerAccess,
    sha256ExactBytes,
    sha256ExactUtf8,
    canonicalExactStringify,
} from "../../../simulation/visual/VisualLayer.js";
import { captureRightsForRole } from "./AlignedCaptureProducts.js";
import {
    BAKE_CAPTURE_MODE,
    BAKE_PLANNER_ID,
    BAKE_SAMPLING_ID,
    BAKE_SOURCE_SNAPSHOT_KIND,
    BAKE_CONTRACT_VERSION,
    STATIC_SNAPSHOT_POLICY,
    hashBakeSourceSnapshot,
    normalizeBakeSourceSnapshot,
    compareUtf8,
} from "./BakeRunCatalog.js";
import { createOwnedCaptureScene } from "./VisualCapturePipeline.js";
import { isVisualPreviewObject, VISUAL_PREVIEW_USERDATA } from "./VisualPreviewIsolation.js";

const BAKE_RIGHTS = captureRightsForRole("bake-snapshot");

function snapshotError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function digestJson(value) {
    return sha256ExactUtf8(canonicalExactStringify(value));
}

function matrixArray(object) {
    object.updateMatrixWorld?.(true);
    const elements = object.matrixWorld?.elements ?? object.matrix?.elements;
    return Array.from(elements ?? new THREE.Matrix4().elements, (entry) => (
        Object.is(entry, -0) ? 0 : entry
    ));
}

function colorHex(color) {
    if (!color) return 0;
    if (typeof color.getHex === "function") return color.getHex();
    return Number(color) || 0;
}

function geometryDigest(geometry) {
    const position = geometry?.attributes?.position?.array;
    if (position) return sha256ExactBytes(position);
    return digestJson({
        uuid: geometry?.uuid ?? "none",
        id: geometry?.id ?? 0,
    });
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

function materialDigest(material) {
    return digestJson({
        type: material?.type ?? "none",
        color: colorHex(material?.color),
        opacity: Number(material?.opacity ?? 1),
        transparent: material?.transparent === true,
        alphaTest: Number(material?.alphaTest ?? 0),
        map: textureDigest(material?.map),
        alphaMap: textureDigest(material?.alphaMap),
        side: material?.side ?? 0,
    });
}

function retainShared(resource, leases, { kind, digest }) {
    if (!resource) return resource;
    const lease = {
        kind,
        digest,
        value: resource,
        release() {
            this.released = true;
        },
        released: false,
    };
    leases.push(lease);
    return resource;
}

function cloneMaterial(material, leases) {
    if (!material) return material;
    const cloned = material.clone();
    if (material.map) cloned.map = retainShared(material.map, leases, {
        kind: "texture",
        digest: textureDigest(material.map),
    });
    if (material.alphaMap) cloned.alphaMap = retainShared(material.alphaMap, leases, {
        kind: "texture",
        digest: textureDigest(material.alphaMap),
    });
    return cloned;
}

function stripPreviewUserData(object) {
    const userData = { ...(object.userData ?? {}) };
    delete userData[VISUAL_PREVIEW_USERDATA.previewOnly];
    delete userData.visualPreview;
    delete userData.visualCaptureRole;
    delete userData.skipEnvironmentSelection;
    object.userData = userData;
}

function cloneObject(source, leases) {
    const cloned = source.clone(false);
    cloned.matrix.copy(source.matrix);
    cloned.matrixWorld.copy(source.matrixWorld);
    cloned.position.copy(source.position);
    cloned.quaternion.copy(source.quaternion);
    cloned.scale.copy(source.scale);
    cloned.visible = source.visible;
    cloned.matrixAutoUpdate = source.matrixAutoUpdate;
    stripPreviewUserData(cloned);
    if (source.geometry) {
        cloned.geometry = retainShared(source.geometry, leases, {
            kind: "geometry",
            digest: geometryDigest(source.geometry),
        });
    }
    if (Array.isArray(source.material)) {
        cloned.material = source.material.map((material) => cloneMaterial(material, leases));
    } else if (source.material) {
        cloned.material = cloneMaterial(source.material, leases);
    }
    if (source.isLight) {
        if (source.color) cloned.color = source.color.clone();
        cloned.intensity = source.intensity;
    }
    return cloned;
}

function walkAndClone(source, parent, leases, previewRoot, state, { skipRoot = false } = {}) {
    if (!source) return;
    if (source.userData?.bakeIgnore) return;
    if (source === previewRoot || isVisualPreviewObject(source)) return;
    if (skipRoot) {
        for (const child of source.children ?? []) {
            walkAndClone(child, parent, leases, previewRoot, state);
        }
        return;
    }
    const cloned = cloneObject(source, leases);
    parent.add(cloned);
    if (source.isMesh && source.geometry) {
        const entityId = String(
            source.userData?.cevSimVisualInstanceId
            ?? source.userData?.buildingId
            ?? source.uuid,
        );
        state.geometry.push({
            entityId,
            geometryDigest: geometryDigest(source.geometry),
            matrix: matrixArray(source),
            visible: source.visible !== false && !isHiddenByParent(source),
        });
        const materials = Array.isArray(source.material) ? source.material : [source.material];
        for (const material of materials) {
            if (!material) continue;
            state.materials.push({
                entityId,
                materialDigest: materialDigest(material),
                opacity: Number(material.opacity ?? 1),
                transparent: material.transparent === true,
            });
        }
    }
    if (source.isLight) {
        state.lights.push({
            id: String(source.uuid),
            kind: source.type ?? "Light",
            color: colorHex(source.color),
            intensity: Number(source.intensity ?? 1),
            position: { x: source.position.x, y: source.position.y, z: source.position.z },
            quaternion: {
                x: source.quaternion.x,
                y: source.quaternion.y,
                z: source.quaternion.z,
                w: source.quaternion.w,
            },
        });
    }
    for (const child of source.children ?? []) {
        walkAndClone(child, cloned, leases, previewRoot, state);
    }
}

function isHiddenByParent(object) {
    let current = object;
    while (current) {
        if (current.visible === false) return true;
        current = current.parent;
    }
    return false;
}

function assertCompleteClosure({ descriptor, access, sourceUseHashes, uses = [] }) {
    const assetDigests = [];
    if (descriptor?.assets) {
        for (const asset of descriptor.assets) {
            if (!asset?.sha256) {
                throw snapshotError("BAKE_CLOSURE_INCOMPLETE", "Visual descriptor assets must include SHA-256 digests.");
            }
            assetDigests.push(asset.sha256);
        }
    }
    const useHashes = [...sourceUseHashes].sort(compareUtf8);
    const usesByHash = new Map(uses.map((use) => [use.useHash ?? use.hash, use]));
    if (access?.assets) {
        for (const entry of access.assets) {
            if (entry.useHash && !useHashes.includes(entry.useHash) && !usesByHash.has(entry.useHash)) {
                throw snapshotError("BAKE_CLOSURE_INCOMPLETE", `Missing source-use closure for ${entry.sha256}.`);
            }
            if (entry.sha256) assetDigests.push(entry.sha256);
        }
    }
    return [...new Set(assetDigests)].sort(compareUtf8);
}

function assertBakeRights({ sourceUseHashes, uses = [], registry = null, authorizeSourceUse = null, atTime = "1970-01-01T00:00:00.000Z" }) {
    if (typeof authorizeSourceUse === "function") {
        for (const useHash of sourceUseHashes) {
            const allowed = authorizeSourceUse({ useHash, operations: BAKE_RIGHTS });
            if (allowed === false) {
                throw snapshotError("BAKE_RIGHTS_DENIED", `Bake snapshot denied rights for use ${useHash}.`);
            }
        }
        return;
    }
    if (!registry || sourceUseHashes.length === 0) return;
    const sourceIds = uses.flatMap((use) => use.sourceIds ?? use.sources ?? []);
    if (sourceIds.length === 0) return;
    const decision = evaluateVisualSourcePolicy({
        sourceIds,
        operations: BAKE_RIGHTS,
        registry,
        atTime,
    });
    if (decision.allowed !== true) {
        throw snapshotError("BAKE_RIGHTS_DENIED", "Bake snapshot requires display, machine-interpretation, and derivatives rights.");
    }
}

export function buildBakeSourceSnapshot({
    sourceScene,
    previewRoot = null,
    livePreviewRoot = previewRoot,
    worldHash,
    environmentRevision = 0,
    bakeGeneration = 1,
    visualDescriptorHash = null,
    visualAccessHash = null,
    descriptor = null,
    access = null,
    sourceUseHashes = [],
    uses = [],
    selectedChunks = [],
    outputRoles = ["beauty", "validity"],
    lodPolicyHash = null,
    calibrations = [],
    authorizeSourceUse = null,
    registry = null,
    resourceCache = null,
} = {}) {
    if (!sourceScene || typeof sourceScene !== "object") {
        throw snapshotError("BAKE_SNAPSHOT_INVALID", "A source scene is required to freeze a bake snapshot.");
    }
    if (livePreviewRoot && sourceScene === livePreviewRoot) {
        throw snapshotError(
            "BAKE_SNAPSHOT_PREVIEW_REJECTED",
            "Bake snapshots cannot wrap or capture the live preview root.",
        );
    }
    if (sourceScene.userData?.cevSimVisualPreviewOnly === true && sourceScene === livePreviewRoot) {
        throw snapshotError("BAKE_SNAPSHOT_PREVIEW_REJECTED", "Display/preview roots cannot be captured.");
    }

    const resolvedDescriptorHash = visualDescriptorHash
        ?? (descriptor ? hashVisualLayer(descriptor) : null);
    const resolvedAccessHash = visualAccessHash
        ?? (access ? hashVisualLayerAccess(access) : null);
    const useHashes = [...sourceUseHashes].sort(compareUtf8);
    assertBakeRights({ sourceUseHashes: useHashes, uses, registry, authorizeSourceUse });
    const assetDigests = assertCompleteClosure({
        descriptor,
        access,
        sourceUseHashes: useHashes,
        uses,
    });

    const leases = [];
    const clonedScene = new THREE.Scene();
    clonedScene.name = "cev-sim.bake-snapshot";
    const state = { geometry: [], materials: [], lights: [] };
    const skipRoot = sourceScene.isScene === true;
    walkAndClone(sourceScene, clonedScene, leases, livePreviewRoot, state, { skipRoot });
    if (resourceCache?.attach) resourceCache.attach(clonedScene);

    const snapshot = normalizeBakeSourceSnapshot({
        kind: BAKE_SOURCE_SNAPSHOT_KIND,
        version: BAKE_CONTRACT_VERSION,
        snapshotPolicy: STATIC_SNAPSHOT_POLICY,
        worldHash,
        environmentRevision,
        bakeGeneration,
        visualDescriptorHash: resolvedDescriptorHash,
        visualAccessHash: resolvedAccessHash,
        sourceUseHashes: useHashes,
        selectedChunks: [...selectedChunks].sort((left, right) => compareUtf8(left.id, right.id)),
        geometryState: state.geometry,
        materialState: state.materials,
        lightingState: state.lights,
        algorithms: {
            captureMode: BAKE_CAPTURE_MODE,
            planner: BAKE_PLANNER_ID,
            sampling: BAKE_SAMPLING_ID,
            lodPolicyHash,
        },
        outputRoles,
        dynamicActorPolicy: STATIC_SNAPSHOT_POLICY,
        resourceClosure: { complete: true, assetDigests },
        calibrations,
    });

    const snapshotHash = hashBakeSourceSnapshot(snapshot);
    const sceneHandle = createOwnedCaptureScene({
        role: "bake-snapshot",
        scene: clonedScene,
        generation: bakeGeneration,
        descriptionHash: snapshotHash,
    });
    if (clonedScene.children.some((child) => isVisualPreviewObject(child))) {
        throw snapshotError("BAKE_SNAPSHOT_PREVIEW_REJECTED", "Cloned bake snapshot still contains preview objects.");
    }

    return {
        snapshot,
        snapshotHash,
        sceneHandle,
        leases,
        dispose() {
            for (const lease of leases) lease.release?.();
            clonedScene.clear();
        },
    };
}
