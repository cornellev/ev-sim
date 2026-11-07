/**
 * Flat drive-area meshes. LiDAR triangles use geometry type "drive-area" so a
 * road rebuild does not delete them, and the road tag so perception stays road.
 */

import * as THREE from "three";
import { triangulateFootprint } from "../../../../simulation/world/DriveAreas.js";
import { EDITOR_LAYERS } from "../../EditorState.js";
import { trianglesFromSolid } from "../lidarSolidTriangles.js";

export function driveAreaEntityId(id) {
    return `drive-area:${id}`;
}

function meshFor(area) {
    const faces = triangulateFootprint(area.footprint);
    const positions = [];
    for (const face of faces) {
        for (const index of face) {
            const point = area.footprint[index];
            positions.push(point.x, area.y, point.z);
        }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.computeVertexNormals();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
        color: 0x4b5563,
        side: THREE.DoubleSide,
    }));
    mesh.name = driveAreaEntityId(area.id);
    mesh.userData = { driveAreaId: area.id, environmentGeometryType: "drive-area" };
    return mesh;
}

function lidarTriangles(area) {
    return trianglesFromSolid({
        vertices: area.footprint.map((point) => [point.x, area.y, point.z]),
        triangles: triangulateFootprint(area.footprint),
        semantic: "road",
    }, { geometryType: "drive-area", sourceId: area.id });
}

function removeDriveAreaRuntime({ data, scene, registry, id }) {
    const entityId = driveAreaEntityId(id);
    const entity = registry?.getEntity?.(entityId);
    const mesh = entity?.object3D;
    if (mesh) {
        mesh.geometry?.dispose?.();
        mesh.material?.dispose?.();
        scene?.remove?.(mesh);
    }
    data?.objects?.()?.replaceTriangles?.(
        (triangle) => triangle.environmentGeometryType === "drive-area" && triangle.environmentSourceId === id,
        [],
    );
    registry?.unregisterEntity?.(entityId);
}

function regenerateDriveAreaRuntime({ data, scene, registry, record }) {
    removeDriveAreaRuntime({ data, scene, registry, id: record.id });
    const mesh = meshFor(record);
    scene?.add?.(mesh);
    registry?.registerEntity?.({
        id: driveAreaEntityId(record.id),
        sourceId: record.id,
        kind: "drive-area",
        layer: EDITOR_LAYERS.ROADS,
        object3D: mesh,
        record: { ...record },
    });
    data?.objects?.()?.replaceTriangles?.(
        (triangle) => triangle.environmentGeometryType === "drive-area" && triangle.environmentSourceId === record.id,
        lidarTriangles(record),
    );
    return mesh;
}

export function createDriveAreasProjector() {
    return {
        id: "drive-areas",
        apply({ changeSet, data, scene, registry }) {
            const domain = changeSet.domains?.driveAreas;
            if (!domain) return;
            for (const [id, after] of domain.after) {
                if (!after) removeDriveAreaRuntime({ data, scene, registry, id });
                else regenerateDriveAreaRuntime({ data, scene, registry, record: after });
            }
        },
        rebuildAll({ data, scene, registry, document }) {
            for (const entity of [...(registry?.listEntities?.() ?? [])]) {
                if (entity.kind !== "drive-area") continue;
                removeDriveAreaRuntime({ data, scene, registry, id: entity.sourceId });
            }
            data?.objects?.()?.replaceTriangles?.(
                (triangle) => triangle.environmentGeometryType === "drive-area",
                [],
            );
            for (const record of document.driveAreas ?? []) {
                regenerateDriveAreaRuntime({ data, scene, registry, record });
            }
        },
        dispose() {},
    };
}
