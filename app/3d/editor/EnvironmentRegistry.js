import * as THREE from "three";
import { EDITOR_LAYERS } from "./EditorState.js";

function shortId(value) {
    const text = String(value ?? "");
    return text.length > 16 ? `${text.slice(0, 10)}...${text.slice(-4)}` : text;
}

function getKindLayer(kind) {
    if (kind === "building") return EDITOR_LAYERS.BUILDINGS;
    if (kind === "road" || kind === "intersection") return EDITOR_LAYERS.ROADS;
    return EDITOR_LAYERS.PROPS;
}

function getFusionKind(fusionObject) {
    const tags = fusionObject?.tags ?? [];
    if (tags.includes("sign")) return "sign";
    if (tags.includes("barrel")) return "barrel";
    if (tags.includes("tire")) return "tire";
    return fusionObject?.constructor?.name ?? "prop";
}

function labelForEntity(entity) {
    if (entity.label) return entity.label;
    if (entity.kind === "building") return `Building ${shortId(entity.sourceId ?? entity.id)}`;
    if (entity.fusionObject?.constructor?.name) return entity.fusionObject.constructor.name;
    return entity.kind;
}

function cloneTransform(object3D) {
    if (!object3D) return null;
    return {
        position: object3D.position.clone(),
        rotation: object3D.rotation.clone(),
        scale: object3D.scale.clone(),
    };
}

function tagObjectTree(object3D, entityId) {
    object3D?.traverse?.((child) => {
        child.userData.envObjectId = entityId;
    });
}

function hasAncestorInSet(object, roots) {
    let current = object.parent;
    while (current) {
        if (roots.has(current)) return true;
        current = current.parent;
    }
    return false;
}

function boundsFromRecord(record) {
    if (!record?.footprint?.length) return null;
    return record.footprint.reduce((bounds, point) => ({
        minX: Math.min(bounds.minX, point.x),
        minZ: Math.min(bounds.minZ, point.z),
        maxX: Math.max(bounds.maxX, point.x),
        maxZ: Math.max(bounds.maxZ, point.z),
    }), {
        minX: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxZ: -Infinity,
    });
}

export class EnvironmentRegistry {
    constructor({ chunkManager = null } = {}) {
        this.chunkManager = chunkManager;
        this.entities = new Map();
        this.subscribers = new Set();
    }

    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        callback(this.snapshot());
        return () => {
            this.subscribers.delete(callback);
        };
    }

    notify() {
        const snapshot = this.snapshot();
        this.subscribers.forEach((callback) => callback(snapshot));
    }

    snapshot() {
        return {
            entities: this.listEntities(),
            chunks: this.chunkManager?.listChunks?.() ?? [],
        };
    }

    registerEntity(entity) {
        if (!entity?.id) return null;

        const previous = this.entities.get(entity.id) ?? {};
        const next = {
            ...previous,
            ...entity,
            kind: entity.kind ?? previous.kind ?? "object",
            layer: entity.layer ?? previous.layer ?? getKindLayer(entity.kind),
            visible: entity.visible ?? previous.visible ?? true,
        };

        next.label = labelForEntity(next);
        next.transform = cloneTransform(next.object3D);

        if (!next.bounds && next.record) {
            next.bounds = boundsFromRecord(next.record);
        }

        if (next.object3D) {
            tagObjectTree(next.object3D, next.id);
            next.object3D.userData.environmentLayer = next.layer;
        }

        const membership = this.chunkManager?.assignEntity?.(next);
        if (membership) {
            next.primaryChunk = membership.primaryChunk;
            next.coveredChunks = membership.coveredChunks;
            next.bounds = membership.bounds;
        }

        this.entities.set(next.id, next);
        this.notify();
        return next;
    }

    registerExistingContent(scene, data) {
        const buildingRecords = new Map(
            (data?.bakeRunConfig?.()?.buildings ?? []).map((record) => [record.buildingId, record]),
        );
        const seenBuildings = new Set();
        const seenObjects = new Set();
        const candidates = [];
        const roadRoots = new Set();

        data?.city?.()?.getRoads?.()?.forEach((road, index) => {
            if (!road?.root) return;
            roadRoots.add(road.root);
            candidates.push({
                id: `road:${index}`,
                sourceId: `road:${index}`,
                kind: "road",
                label: `Road ${index + 1}`,
                layer: EDITOR_LAYERS.ROADS,
                object3D: road.root,
                road,
            });
        });

        data?.city?.()?.getIntersections?.()?.forEach((intersection, index) => {
            if (!intersection?.root) return;
            roadRoots.add(intersection.root);
            candidates.push({
                id: `intersection:${index}`,
                sourceId: `intersection:${index}`,
                kind: "intersection",
                label: `Intersection ${index + 1}`,
                layer: EDITOR_LAYERS.ROADS,
                object3D: intersection.root,
                intersection,
            });
        });

        scene?.traverse?.((object) => {
            if (object.userData?.skipEnvironmentSelection || object.userData?.environmentChunkKey) return;
            if (roadRoots.has(object) || hasAncestorInSet(object, roadRoots)) return;

            const buildingId = object.userData?.buildingId;
            if (buildingId && !seenBuildings.has(buildingId)) {
                seenBuildings.add(buildingId);
                candidates.push({
                    id: `building:${buildingId}`,
                    sourceId: buildingId,
                    kind: "building",
                    layer: EDITOR_LAYERS.BUILDINGS,
                    object3D: object,
                    record: buildingRecords.get(buildingId) ?? null,
                });
            }

            const fusionObject = object.userData?.fusionObject;
            if (fusionObject?._uuid && !seenObjects.has(fusionObject._uuid)) {
                seenObjects.add(fusionObject._uuid);
                const kind = getFusionKind(fusionObject);
                candidates.push({
                    id: `fusion:${fusionObject._uuid}`,
                    sourceId: fusionObject._uuid,
                    kind,
                    layer: getKindLayer(kind),
                    object3D: object,
                    fusionObject,
                    tags: [...(fusionObject.tags ?? [])],
                });
            }

            if (!buildingId && !object.userData?.fusionObject && object.isMesh) {
                const roadLike = object.userData?.bakeRoadSurface
                    || object.userData?.road
                    || object.name?.toLowerCase?.().includes("road");
                if (roadLike) {
                    candidates.push({
                        id: `road:${object.uuid}`,
                        sourceId: object.uuid,
                        kind: "road",
                        layer: EDITOR_LAYERS.ROADS,
                        object3D: object,
                    });
                }
            }
        });

        candidates.forEach((entity) => this.registerEntity(entity));
    }

    getEntity(entityId) {
        return this.entities.get(entityId) ?? null;
    }

    listEntities() {
        return [...this.entities.values()]
            .map((entity) => ({
                id: entity.id,
                sourceId: entity.sourceId,
                kind: entity.kind,
                label: entity.label,
                layer: entity.layer,
                visible: entity.visible,
                hidden: entity.hidden === true,
                tags: [...(entity.tags ?? entity.record?.tags ?? [])],
                primaryChunk: entity.primaryChunk ?? null,
                coveredChunks: [...(entity.coveredChunks ?? [])],
                transform: entity.transform,
                record: entity.record ? { ...entity.record } : null,
            }))
            .sort((a, b) => a.layer.localeCompare(b.layer) || a.label.localeCompare(b.label));
    }

    findEntityFromObject3D(object3D) {
        let current = object3D;

        while (current) {
            if (current.userData?.skipEnvironmentSelection) {
                current = current.parent;
                continue;
            }

            const envObjectId = current.userData?.envObjectId;
            if (envObjectId && this.entities.has(envObjectId)) {
                return this.entities.get(envObjectId);
            }

            const buildingId = current.userData?.buildingId;
            if (buildingId && this.entities.has(`building:${buildingId}`)) {
                return this.entities.get(`building:${buildingId}`);
            }

            const fusionObject = current.userData?.fusionObject;
            if (fusionObject?._uuid && this.entities.has(`fusion:${fusionObject._uuid}`)) {
                return this.entities.get(`fusion:${fusionObject._uuid}`);
            }

            current = current.parent;
        }

        return null;
    }

    setEntityVisible(entityId, visible) {
        const entity = this.entities.get(entityId);
        if (!entity) return;

        entity.visible = Boolean(visible);
        entity.hidden = !visible;
        if (entity.object3D) {
            entity.object3D.visible = Boolean(visible);
        }
        this.chunkManager?.markEntityDirty?.(entityId);
        this.notify();
    }

    unregisterEntity(entityId) {
        if (!this.entities.has(entityId)) return false;
        this.entities.delete(entityId);
        this.chunkManager?.removeEntity?.(entityId);
        this.notify();
        return true;
    }

    setLayerVisible(layer, visible) {
        this.entities.forEach((entity) => {
            if (entity.layer !== layer) return;
            entity.visible = Boolean(visible);
            if (entity.object3D) entity.object3D.visible = Boolean(visible);
        });
        this.notify();
    }

    updateEntityTransform(entityId, object3D = null) {
        const entity = this.entities.get(entityId);
        if (!entity) return null;

        const target = object3D ?? entity.object3D;
        if (!target) return entity;

        entity.transform = cloneTransform(target);

        if (entity.fusionObject) {
            const worldPosition = new THREE.Vector3();
            target.getWorldPosition(worldPosition);
            entity.fusionObject.setPosition?.(worldPosition);
        }

        const membership = this.chunkManager?.assignEntity?.(entity);
        if (membership) {
            entity.primaryChunk = membership.primaryChunk;
            entity.coveredChunks = membership.coveredChunks;
            entity.bounds = membership.bounds;
        }

        this.notify();
        return entity;
    }

    toManifest() {
        return {
            objects: Object.fromEntries(
                [...this.entities.entries()].map(([id, entity]) => [
                    id,
                    {
                        id,
                        sourceId: entity.sourceId,
                        kind: entity.kind,
                        layer: entity.layer,
                        primaryChunk: entity.primaryChunk ?? null,
                        coveredChunks: [...(entity.coveredChunks ?? [])],
                        record: entity.record ? { ...entity.record } : null,
                        tags: [...(entity.tags ?? entity.record?.tags ?? [])],
                    },
                ]),
            ),
        };
    }
}
