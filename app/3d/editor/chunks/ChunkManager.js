import * as THREE from "three";
import { ChunkIndex, CHUNK_MUTATION_TYPES, DEFAULT_CHUNK_SIZE } from "./ChunkIndex.js";

const CHUNK_GROUP_PREFIX = "EnvironmentChunk";

export class ChunkManager {
    constructor({ scene = null, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
        this.scene = scene;
        this.index = new ChunkIndex({ chunkSize });
        this.groups = new Map();
        this.entityAliases = new Map();
    }

    setScene(scene) {
        this.scene = scene;
    }

    get chunkSize() {
        return this.index.chunkSize;
    }

    ensureGroup(key) {
        if (this.groups.has(key)) return this.groups.get(key);

        const group = new THREE.Group();
        group.name = `${CHUNK_GROUP_PREFIX}:${key}`;
        group.userData.environmentChunkKey = key;
        group.userData.skipEnvironmentSelection = true;

        this.scene?.add?.(group);
        this.groups.set(key, group);
        this.index.ensureChunk(key);
        return group;
    }

    assignEntity(entity, { mutationType = null } = {}) {
        if (!entity?.id) return null;
        const bounds = entity.bounds ?? this.getObjectBounds(entity.object3D);
        const membership = this.index.assignObject(entity.id, bounds, { mutationType });

        if (entity.object3D && membership?.primaryChunk && this.scene) {
            const group = this.ensureGroup(membership.primaryChunk);
            if (entity.object3D.parent !== group) {
                group.attach(entity.object3D);
            }
        }

        return membership;
    }

    getObjectBounds(object3D) {
        if (!object3D) {
            return { minX: 0, minZ: 0, maxX: 0, maxZ: 0 };
        }

        const box = new THREE.Box3().setFromObject(object3D);
        if (box.isEmpty()) {
            const world = new THREE.Vector3();
            object3D.getWorldPosition(world);
            return { minX: world.x, minZ: world.z, maxX: world.x, maxZ: world.z };
        }

        return {
            minX: box.min.x,
            minZ: box.min.z,
            maxX: box.max.x,
            maxZ: box.max.z,
        };
    }

    removeEntity(entityId) {
        const canonicalId = this.entityAliases.get(entityId) ?? entityId;
        const evidence = this.index.removeObject(canonicalId);
        for (const [alias, target] of this.entityAliases) {
            if (alias === entityId || target === canonicalId) this.entityAliases.delete(alias);
        }
        return evidence;
    }

    aliasEntity(alias, entityId) {
        if (alias && entityId && alias !== entityId) this.entityAliases.set(alias, entityId);
    }

    markEntityDirty(entityId, { mutationType = CHUNK_MUTATION_TYPES.material } = {}) {
        return this.index.recordCoverageMutation(
            this.entityAliases.get(entityId) ?? entityId,
            mutationType,
        );
    }

    setChunkLoaded(key, loaded) {
        this.index.setLoaded(key, loaded);
        const group = this.ensureGroup(key);
        group.visible = Boolean(loaded);
    }

    setChunkPrefetch(key, prefetch) {
        this.index.setPrefetch(key, prefetch);
    }

    setChunkEviction(key, eviction) {
        this.index.setEviction(key, eviction);
        if (eviction) this.setChunkLoaded(key, false);
    }

    getMembership(entityId) {
        return this.index.getObjectMembership(this.entityAliases.get(entityId) ?? entityId);
    }

    listChunks() {
        return this.index.listChunks();
    }

    queryKeysInRadius(point, radius) {
        return this.index.queryKeysInRadius(point, radius);
    }

    queryKeysInBounds(bounds) {
        return this.index.queryKeysInBounds(bounds);
    }

    queryObjectsInRadius(point, radius) {
        return this.index.queryObjectsInRadius(point, radius);
    }

    queryObjectsInBounds(bounds) {
        return this.index.queryObjectsInBounds(bounds);
    }

    toManifest() {
        return {
            chunkSize: this.chunkSize,
            semanticGeneration: this.index.semanticGeneration,
            chunks: Object.fromEntries(
                this.listChunks().map((chunk) => [
                    chunk.key,
                    {
                        bounds: chunk.bounds,
                        objectIds: chunk.objectIds,
                        loaded: chunk.loaded,
                        prefetch: chunk.prefetch,
                        eviction: chunk.eviction,
                        dirty: chunk.dirty,
                    },
                ]),
            ),
        };
    }
}
