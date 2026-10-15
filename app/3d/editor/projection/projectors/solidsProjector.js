/**
 * Scene primitives and the support-plane floor. Meshes use the same
 * tessellation as collision and LiDAR. The floor is a visual stand-in for an
 * infinite plane: it does not take picks, and it is not part of the world bounds.
 */

import * as THREE from "three";
import { EDITOR_LAYERS } from "../../EditorState.js";
import { localPrimitiveMesh } from "../../../../simulation/world/PrimitiveSolids.js";
import { normalizePrimitiveRecord } from "../../../../simulation/world/PrimitiveRecords.js";
import { createWorldResource } from "../../../../simulation/world/WorldDescription.js";

const FLOOR_EXTENT = 20000;
const GROUP_NAME = "scene-primitives";
const FLOOR_NAME = "SimulationFloor";

function geometryFromMesh(mesh) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(mesh.vertices.flat(), 3));
    geometry.setIndex(mesh.triangles.flat());
    geometry.computeVertexNormals();
    return geometry;
}

function signature(record) {
    return `${record.shape}:${record.size.x}:${record.size.y}:${record.size.z}:${record.color}`;
}

function ensureGroup(scene) {
    let group = scene.getObjectByName(GROUP_NAME);
    if (!group) {
        group = new THREE.Group();
        group.name = GROUP_NAME;
        scene.add(group);
    }
    return group;
}

function publishWorld(context) {
    if (context.transient) return;
    const environment = context.data?.environment?.();
    if (typeof environment?.setWorldDescription !== "function") return;
    const document = context.document;
    const resource = createWorldResource({
        environmentId: document.environmentId,
        templateId: document.environmentId === "igvc" ? "igvc" : "blank",
        roadsAuthored: document.roadsAuthored === true,
        buildingsAuthored: document.buildingsAuthored === true,
        featuresAuthored: document.featuresAuthored === true,
        document: document.snapshot(),
    });
    environment.setWorldDescription(resource.description, resource.hash);
}

function syncPrimitive(group, registry, record) {
    const normalized = normalizePrimitiveRecord(record);
    const name = `primitive:${normalized.id}`;
    let mesh = group.getObjectByName(name);
    const nextSignature = signature(normalized);
    if (!mesh || mesh.userData.primitiveSignature !== nextSignature) {
        const geometry = geometryFromMesh(localPrimitiveMesh(normalized));
        const material = new THREE.MeshStandardMaterial({
            color: normalized.color,
            roughness: 0.85,
            metalness: 0,
        });
        if (mesh) {
            mesh.geometry.dispose();
            mesh.material.dispose();
            mesh.geometry = geometry;
            mesh.material = material;
        } else {
            mesh = new THREE.Mesh(geometry, material);
            mesh.name = name;
            group.add(mesh);
        }
        mesh.userData.primitiveSignature = nextSignature;
    }
    mesh.position.set(normalized.position.x, normalized.position.y, normalized.position.z);
    mesh.rotation.set(0, normalized.rotationY, 0);
    mesh.updateMatrixWorld(true);
    registry?.registerEntity?.({
        id: name,
        sourceId: normalized.id,
        kind: "primitive",
        layer: EDITOR_LAYERS.PROPS,
        object3D: mesh,
        record: normalized,
    });
}

function syncPrimitives(context) {
    const group = ensureGroup(context.scene);
    const live = new Set();
    for (const record of context.document.primitives ?? []) {
        syncPrimitive(group, context.registry, record);
        live.add(`primitive:${record.id}`);
    }
    for (const child of [...group.children]) {
        if (child.name === FLOOR_NAME || live.has(child.name)) continue;
        context.registry?.unregisterEntity?.(child.name, { affectsPersistence: false });
        child.geometry?.dispose?.();
        child.material?.dispose?.();
        group.remove(child);
    }
}

function checkerTexture() {
    const data = new Uint8Array([
        194, 194, 194, 255,
        106, 106, 106, 255,
        106, 106, 106, 255,
        194, 194, 194, 255,
    ]);
    const texture = new THREE.DataTexture(data, 2, 2);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.repeat.set(FLOOR_EXTENT, FLOOR_EXTENT);
    texture.needsUpdate = true;
    return texture;
}

function syncFloor(context) {
    const group = ensureGroup(context.scene);
    const enabled = context.document.floor?.enabled === true;
    let mesh = group.getObjectByName(FLOOR_NAME);
    if (!enabled) {
        if (mesh) {
            mesh.geometry?.dispose?.();
            mesh.material?.map?.dispose?.();
            mesh.material?.dispose?.();
            group.remove(mesh);
        }
        return;
    }
    if (mesh) return;
    const geometry = new THREE.PlaneGeometry(FLOOR_EXTENT, FLOOR_EXTENT);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
        map: checkerTexture(),
        roughness: 0.85,
        metalness: 0,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
    });
    mesh = new THREE.Mesh(geometry, material);
    mesh.name = FLOOR_NAME;
    mesh.renderOrder = -1;
    mesh.raycast = () => {};
    mesh.userData.skipEnvironmentSelection = true;
    group.add(mesh);
}

function sync(context, { publish = false } = {}) {
    if (!context.scene || !context.document) return;
    syncPrimitives(context);
    syncFloor(context);
    if (publish) publishWorld(context);
}

export function createSolidsProjector() {
    return {
        id: "solids",
        apply(context) {
            const changeSet = context.changeSet;
            const primitives = changeSet?.domains?.primitives;
            const floor = changeSet?.scalars?.floor;
            const objects = changeSet?.domains?.objects;
            const relevant = Boolean(primitives || floor || (objects && (context.document.primitives.length > 0 || context.document.floor?.enabled)));
            if (!relevant) return;
            sync(context, { publish: !context.transient });
        },
        rebuildAll(context) {
            sync(context, { publish: false });
        },
    };
}
