import * as THREE from "three";

function assignedIds(object) {
    let current = object;
    while (current) {
        const data = current.userData ?? {};
        if (data.buildingId) {
            return {
                id: String(data.buildingId),
                entityId: String(data.entityId ?? `building:${data.buildingId}`),
                kind: "building",
            };
        }
        if (data.entityId) {
            return {
                id: String(data.entityId),
                entityId: String(data.entityId),
                kind: data.kind ?? "entity",
            };
        }
        current = current.parent;
    }
    return {
        id: String(object.uuid),
        entityId: String(object.uuid),
        kind: "unassigned",
    };
}

function effectiveBuildingId(object) {
    return assignedIds(object).kind === "building" ? assignedIds(object).id : null;
}

function boundsFromObject(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) {
        const world = new THREE.Vector3();
        object.getWorldPosition(world);
        return {
            minX: world.x,
            minY: world.y,
            minZ: world.z,
            maxX: world.x,
            maxY: world.y,
            maxZ: world.z,
        };
    }
    return {
        minX: box.min.x,
        minY: box.min.y,
        minZ: box.min.z,
        maxX: box.max.x,
        maxY: box.max.y,
        maxZ: box.max.z,
    };
}

function boundsFromRecord(record) {
    const footprint = record?.footprint ?? [];
    if (!footprint.length) return null;
    const height = Number(record.height ?? 0);
    return footprint.reduce((bounds, point) => ({
        minX: Math.min(bounds.minX, point.x),
        minY: 0,
        minZ: Math.min(bounds.minZ, point.z),
        maxX: Math.max(bounds.maxX, point.x),
        maxY: Math.max(bounds.maxY, height),
        maxZ: Math.max(bounds.maxZ, point.z),
    }), {
        minX: Infinity,
        minY: 0,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: height,
        maxZ: -Infinity,
    });
}

function box3FromBounds(bounds) {
    return new THREE.Box3(
        new THREE.Vector3(bounds.minX, bounds.minY ?? 0, bounds.minZ),
        new THREE.Vector3(bounds.maxX, bounds.maxY ?? 0, bounds.maxZ),
    );
}

function pointInExpandedBounds(point, bounds, tolerance) {
    return point.x >= bounds.minX - tolerance
        && point.x <= bounds.maxX + tolerance
        && point.y >= (bounds.minY ?? -Infinity) - tolerance
        && point.y <= (bounds.maxY ?? Infinity) + tolerance
        && point.z >= bounds.minZ - tolerance
        && point.z <= bounds.maxZ + tolerance;
}

function distanceToBounds(point, bounds) {
    const dx = Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX);
    const dy = Math.max((bounds.minY ?? 0) - point.y, 0, point.y - (bounds.maxY ?? 0));
    const dz = Math.max(bounds.minZ - point.z, 0, point.z - bounds.maxZ);
    return Math.hypot(dx, dy, dz);
}

/**
 * Spatial index built once at bake start from registry/chunk data.
 * Steady-state bake queries must use this index instead of scene.traverse.
 */
export class BakeSpatialIndex {
    constructor() {
        this.entries = new Map();
        this.byChunk = new Map();
        this.searches = 0;
        this.wholeSceneSearches = 0;
    }

    static fromRegistry(registry, chunkManager = null, { scene = null } = {}) {
        const index = new BakeSpatialIndex();
        const entities = typeof registry?.listEntities === "function" ? registry.listEntities() : [];
        for (const summary of entities) {
            const entity = registry.getEntity?.(summary.id) ?? summary;
            const object3D = entity.object3D ?? null;
            const meshes = [];
            const assetUris = [];
            object3D?.traverse?.((child) => {
                if (child.isMesh) meshes.push(child);
                const uri = child.userData?.assetUri ?? child.userData?.visualAssetUri;
                if (uri) assetUris.push(String(uri));
            });
            const buildingId = entity.sourceId
                ?? entity.record?.buildingId
                ?? (entity.kind === "building" ? String(entity.id).replace(/^building:/, "") : null);
            const bounds = object3D
                ? boundsFromObject(object3D)
                : boundsFromRecord(entity.record) ?? entity.bounds ?? null;
            if (!bounds) continue;
            index.upsert({
                id: buildingId || entity.id,
                entityId: entity.id,
                kind: entity.kind ?? (buildingId ? "building" : "entity"),
                hidden: entity.hidden === true,
                visible: entity.visible !== false,
                chunkKeys: entity.coveredChunks ?? [],
                bounds,
                object3D,
                meshes,
                assetUris,
            });
        }
        if (chunkManager?.index) {
            for (const chunk of chunkManager.listChunks()) {
                index.byChunk.set(chunk.key, [...chunk.objectIds]);
            }
        }
        if (scene && index.entries.size === 0) {
            index.ingestSceneOnce(scene);
        }
        return index;
    }

    ingestSceneOnce(scene) {
        this.wholeSceneSearches += 1;
        scene.traverse((object) => {
            if (!object.isMesh) return;
            const ids = assignedIds(object);
            const existing = this.entries.get(ids.entityId) ?? this.entries.get(ids.id);
            const bounds = boundsFromObject(object);
            if (existing) {
                existing.meshes.push(object);
                existing.bounds = unionBounds(existing.bounds, bounds);
                return;
            }
            this.upsert({
                id: ids.id,
                entityId: ids.entityId,
                kind: ids.kind,
                hidden: object.visible === false,
                visible: object.visible !== false,
                chunkKeys: [],
                bounds,
                object3D: object,
                meshes: [object],
                assetUris: object.userData?.assetUri ? [String(object.userData.assetUri)] : [],
            });
        });
    }

    upsert(entry) {
        this.entries.set(entry.id, {
            ...entry,
            meshes: [...(entry.meshes ?? [])],
            chunkKeys: [...(entry.chunkKeys ?? [])],
            assetUris: [...(entry.assetUris ?? [])],
        });
        for (const key of entry.chunkKeys ?? []) {
            const list = this.byChunk.get(key) ?? [];
            if (!list.includes(entry.entityId ?? entry.id)) list.push(entry.entityId ?? entry.id);
            this.byChunk.set(key, list);
        }
        return this.entries.get(entry.id);
    }

    updateEntity(id, { bounds, object3D, hidden, visible } = {}) {
        const current = this.entries.get(id);
        if (!current) return null;
        if (bounds) current.bounds = bounds;
        if (object3D) {
            current.object3D = object3D;
            current.meshes = [];
            object3D.traverse?.((child) => {
                if (child.isMesh) current.meshes.push(child);
            });
            if (!bounds) current.bounds = boundsFromObject(object3D);
        }
        if (hidden != null) current.hidden = hidden;
        if (visible != null) current.visible = visible;
        return current;
    }

    queryFrustum(camera) {
        return this._queryFrustum(camera, (entry) => !entry.kind || entry.kind === "building");
    }

    queryCaptureInfluence(camera) {
        return this._queryFrustum(camera, () => true);
    }

    _queryFrustum(camera, predicate) {
        this.searches += 1;
        const frustum = new THREE.Frustum();
        const matrix = new THREE.Matrix4().multiplyMatrices(
            camera.projectionMatrix,
            camera.matrixWorldInverse,
        );
        frustum.setFromProjectionMatrix(matrix);
        const hits = [];
        for (const entry of this.entries.values()) {
            if (!predicate(entry)) continue;
            const box = box3FromBounds(entry.bounds);
            if (!frustum.intersectsBox(box)) continue;
            hits.push(entry);
        }
        return hits;
    }

    nearestBuildingId(world, tolerance = 0.05) {
        this.searches += 1;
        const point = world.isVector3 ? world : new THREE.Vector3(world.x, world.y, world.z);
        let nearestId = null;
        let nearestDistance = Infinity;
        for (const entry of this.entries.values()) {
            if (entry.kind && entry.kind !== "building") continue;
            if (!pointInExpandedBounds(point, entry.bounds, tolerance)) continue;
            const distance = distanceToBounds(point, entry.bounds);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestId = entry.id;
            }
        }
        return nearestId;
    }

    meshesForBuilding(buildingId) {
        return this.entries.get(buildingId)?.meshes ?? [];
    }

    buildings() {
        return [...this.entries.values()].filter((entry) => !entry.kind || entry.kind === "building");
    }

    entities() {
        return [...this.entries.values()];
    }
}

function unionBounds(left, right) {
    return {
        minX: Math.min(left.minX, right.minX),
        minY: Math.min(left.minY ?? 0, right.minY ?? 0),
        minZ: Math.min(left.minZ, right.minZ),
        maxX: Math.max(left.maxX, right.maxX),
        maxY: Math.max(left.maxY ?? 0, right.maxY ?? 0),
        maxZ: Math.max(left.maxZ, right.maxZ),
    };
}
