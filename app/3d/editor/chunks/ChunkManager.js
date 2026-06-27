import * as THREE from "three";
import { ChunkIndex, DEFAULT_CHUNK_SIZE } from "./ChunkIndex.js";

const CHUNK_GROUP_PREFIX = "EnvironmentChunk";

export class ChunkManager {
    constructor({ scene = null, chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
        this.scene = scene;
        this.index = new ChunkIndex({ chunkSize });
        this.groups = new Map();
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

    assignEntity(entity) {
        if (!entity?.id) return null;
        const bounds = entity.bounds ?? this.getObjectBounds(entity.object3D);
        const membership = this.index.assignObject(entity.id, bounds);

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
        this.index.removeObject(entityId);
    }

    markEntityDirty(entityId) {
        const membership = this.index.getObjectMembership(entityId);
        membership?.coveredChunks.forEach((key) => this.index.markDirty(key));
    }

    setChunkLoaded(key, loaded) {
        this.index.setLoaded(key, loaded);
        const group = this.ensureGroup(key);
        group.visible = Boolean(loaded);
    }

    getMembership(entityId) {
        return this.index.getObjectMembership(entityId);
    }

    listChunks() {
        return this.index.listChunks();
    }

    toManifest() {
        return {
            chunkSize: this.chunkSize,
            chunks: Object.fromEntries(
                this.listChunks().map((chunk) => [
                    chunk.key,
                    {
                        bounds: chunk.bounds,
                        objectIds: chunk.objectIds,
                        loaded: chunk.loaded,
                        dirty: chunk.dirty,
                    },
                ]),
            ),
        };
    }
}
