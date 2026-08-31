import * as THREE from "three";

import {
    normalizePerceptionClassName,
    perceptionClassId,
} from "./PerceptionLabelCatalog.js";
import { stableInstanceIdFromSource } from "../simulation/lidar/LidarInstanceIds.js";

export { stableInstanceIdFromSource } from "../simulation/lidar/LidarInstanceIds.js";

const sharedIndexes = new WeakMap();

function plainVector(vector = {}) {
    return {
        x: Number(vector.x || 0),
        y: Number(vector.y || 0),
        z: Number(vector.z || 0),
    };
}

function boundsFromObject(object3D) {
    if (!object3D?.isObject3D) return null;
    object3D.updateWorldMatrix?.(true, true);
    const box = new THREE.Box3().setFromObject(object3D);
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // Three scene axes are +X forward, +Y up, +Z left. The swap is therefore
    // the complete basis proof for axis-aligned world extents into REP-103.
    return {
        min: { x: box.min.x, y: box.min.z, z: box.min.y },
        max: { x: box.max.x, y: box.max.z, z: box.max.y },
        center: { x: center.x, y: center.z, z: center.y },
        size: { x: size.x, y: size.z, z: size.y },
    };
}

function semanticName(entity = {}) {
    const tags = entity.tags || entity.record?.tags || entity.userData?.perceptionTags || [];
    return normalizePerceptionClassName(
        entity.semanticClass
        || entity.kind
        || tags[0]
        || "unknown",
    );
}

function sourceIdForEntity(entity, fallback) {
    return String(
        entity?.sourceId
        ?? entity?.id
        ?? entity?.telemetryId
        ?? entity?.userData?.perceptionSourceId
        ?? fallback,
    );
}

export function annotatePerceptionObject(object3D, {
    sourceId,
    semanticClass = "unknown",
    instanceId = stableInstanceIdFromSource(sourceId),
    kind = null,
    state = null,
} = {}) {
    if (!object3D) return null;
    const metadata = {
        perceptionSourceId: String(sourceId),
        perceptionInstanceId: Number(instanceId) >>> 0,
        perceptionSemanticId: perceptionClassId(semanticClass),
        perceptionSemanticClass: normalizePerceptionClassName(semanticClass),
        ...(kind ? { perceptionKind: kind } : {}),
        ...(state ? { perceptionState: state } : {}),
    };
    object3D.traverse?.((child) => Object.assign(child.userData, metadata));
    Object.assign(object3D.userData, metadata);
    return metadata;
}

export function perceptionMetadataFromObject(object3D) {
    let current = object3D;
    while (current) {
        if (current.userData?.perceptionSourceId) {
            return {
                sourceId: current.userData.perceptionSourceId,
                instanceId: Number(current.userData.perceptionInstanceId) >>> 0,
                semanticId: Number(current.userData.perceptionSemanticId) || 0,
                semanticClass: current.userData.perceptionSemanticClass || "unknown",
                kind: current.userData.perceptionKind || null,
                state: current.userData.perceptionState || null,
            };
        }
        current = current.parent;
    }
    return null;
}

export class PerceptionTruthIndex {
    constructor() {
        this.bySourceId = new Map();
        this.sourceByInstanceId = new Map();
    }

    clear() {
        this.bySourceId.clear();
        this.sourceByInstanceId.clear();
    }

    instanceIdFor(sourceId) {
        const source = String(sourceId);
        const existing = this.bySourceId.get(source);
        if (existing) return existing.instanceId;
        let salt = 0;
        let instanceId = stableInstanceIdFromSource(source);
        while (this.sourceByInstanceId.has(instanceId) && this.sourceByInstanceId.get(instanceId) !== source) {
            salt += 1;
            instanceId = stableInstanceIdFromSource(`${source}#${salt}`);
        }
        this.sourceByInstanceId.set(instanceId, source);
        return instanceId;
    }

    register(entity = {}) {
        const sourceId = sourceIdForEntity(entity, `entity-${this.bySourceId.size + 1}`);
        const semanticClass = semanticName(entity);
        const instanceId = this.instanceIdFor(sourceId);
        const object3D = entity.object3D || entity.sceneObject || null;
        const bounds = entity.worldBounds || boundsFromObject(object3D);
        const record = {
            sourceId,
            instanceId,
            semanticId: perceptionClassId(semanticClass),
            semanticClass,
            kind: entity.kind || semanticClass,
            dynamic: entity.dynamic === true,
            visible: entity.visible !== false && object3D?.visible !== false,
            worldBounds: bounds,
            position: bounds?.center || plainVector(entity.position || object3D?.position),
            state: entity.state || entity.userData?.perceptionState || null,
            object3D,
            lane: entity.lane || entity.userData?.perceptionLane || null,
            control: entity.control || entity.userData?.perceptionControl || null,
        };
        this.bySourceId.set(sourceId, record);
        if (object3D) annotatePerceptionObject(object3D, {
            sourceId,
            semanticClass,
            instanceId,
            kind: record.kind,
            state: record.state,
        });
        return record;
    }

    refresh({ scene = null, vehicles = [], environmentRegistry = null } = {}) {
        this.clear();
        const entities = [];
        const environmentEntities = environmentRegistry?.entities
            ? [...environmentRegistry.entities.values()]
            : environmentRegistry?.listEntities?.() || [];
        for (const entity of environmentEntities) {
            entities.push({
                ...entity,
                sourceId: sourceIdForEntity(entity, entity.id),
                object3D: entity.object3D || environmentRegistry?.getEntity?.(entity.id)?.object3D,
                dynamic: false,
            });
        }
        for (const vehicle of vehicles || []) {
            entities.push({
                sourceId: vehicle.telemetryId || vehicle.id,
                kind: "vehicle",
                semanticClass: "vehicle",
                dynamic: true,
                object3D: vehicle.sceneObject,
                position: vehicle.position,
                state: vehicle.currentState || null,
            });
        }
        scene?.traverse?.((object) => {
            const sourceId = object.userData?.perceptionSourceId;
            if (!sourceId || entities.some((entity) => sourceIdForEntity(entity, "") === sourceId)) return;
            entities.push({
                sourceId,
                kind: object.userData.perceptionKind,
                semanticClass: object.userData.perceptionSemanticClass,
                state: object.userData.perceptionState,
                lane: object.userData.perceptionLane,
                control: object.userData.perceptionControl,
                object3D: object,
                dynamic: object.userData.perceptionDynamic === true,
            });
        });
        entities
            .sort((left, right) => sourceIdForEntity(left, "").localeCompare(sourceIdForEntity(right, "")))
            .forEach((entity) => this.register(entity));
        return this.snapshot();
    }

    getBySourceId(sourceId) {
        return this.bySourceId.get(String(sourceId)) || null;
    }

    getByInstanceId(instanceId) {
        const source = this.sourceByInstanceId.get(Number(instanceId) >>> 0);
        return source ? this.bySourceId.get(source) || null : null;
    }

    snapshot() {
        return [...this.bySourceId.values()]
            .sort((left, right) => left.instanceId - right.instanceId || left.sourceId.localeCompare(right.sourceId))
            .map(({ object3D, ...record }) => ({
                ...record,
                worldBounds: record.worldBounds ? structuredClone(record.worldBounds) : null,
                position: { ...record.position },
                lane: record.lane ? structuredClone(record.lane) : null,
                control: record.control ? structuredClone(record.control) : null,
            }));
    }
}

export function getSharedPerceptionTruthIndex(owner) {
    if (!owner || (typeof owner !== "object" && typeof owner !== "function")) {
        return new PerceptionTruthIndex();
    }
    let index = sharedIndexes.get(owner);
    if (!index) {
        index = new PerceptionTruthIndex();
        sharedIndexes.set(owner, index);
    }
    return index;
}
