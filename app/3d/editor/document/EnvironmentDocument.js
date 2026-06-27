/**
 * @typedef {{ id: string, x: number, z: number, kind?: 'intersection' | 'endpoint' }} RoadNode
 * @typedef {{ id: string, startNodeId: string, endNodeId: string, bidirectional?: boolean, width?: number, laneCount?: number, startArm?: { x: number, z: number }, endArm?: { x: number, z: number } }} RoadEdge
 * @typedef {{ id: string, type: string, x: number, z: number, dir?: number, tags?: string[] }} FeatureRecord
 */

const DEFAULT_ROAD_EDGE = Object.freeze({
    bidirectional: true,
    width: 7,
    laneCount: 2,
});

let idCounter = 0;

export function createId(prefix) {
    idCounter += 1;
    return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function resetDocumentIdCounter() {
    idCounter = 0;
}

/**
 * Canonical authoring document for environment map editing.
 */
export class EnvironmentDocument {
    /**
     * @param {Object} [options]
     */
    constructor(options = {}) {
        this.environmentId = options.environmentId ?? "igvc";
        this.chunkSize = options.chunkSize ?? 20;
        /** @type {RoadNode[]} */
        this.roads = {
            nodes: Array.isArray(options.roads?.nodes) ? options.roads.nodes.map(cloneNode) : [],
            edges: Array.isArray(options.roads?.edges) ? options.roads.edges.map(cloneEdge) : [],
        };
        /** @type {import("../../environment/visualization/BakeRunConfig.js").BuildingRecord[]} */
        this.buildings = Array.isArray(options.buildings)
            ? options.buildings.map(cloneBuilding)
            : [];
        /** @type {FeatureRecord[]} */
        this.features = Array.isArray(options.features)
            ? options.features.map(cloneFeature)
            : [];
        this.subscribers = new Set();
    }

    snapshot() {
        return {
            environmentId: this.environmentId,
            chunkSize: this.chunkSize,
            roads: {
                nodes: this.roads.nodes.map(cloneNode),
                edges: this.roads.edges.map(cloneEdge),
            },
            buildings: this.buildings.map(cloneBuilding),
            features: this.features.map(cloneFeature),
        };
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

    getNode(nodeId) {
        return this.roads.nodes.find((node) => node.id === nodeId) ?? null;
    }

    getEdge(edgeId) {
        return this.roads.edges.find((edge) => edge.id === edgeId) ?? null;
    }

    getBuilding(buildingId) {
        return this.buildings.find((building) => building.buildingId === buildingId) ?? null;
    }

    getFeature(featureId) {
        return this.features.find((feature) => feature.id === featureId) ?? null;
    }

    toManifest() {
        return this.snapshot();
    }

    /**
     * @param {ReturnType<EnvironmentDocument["snapshot"]>} manifest
     */
    static fromManifest(manifest) {
        return new EnvironmentDocument(manifest ?? {});
    }
}

function cloneNode(node) {
    return {
        id: node.id,
        x: node.x,
        z: node.z,
        kind: node.kind ?? null,
    };
}

function cloneEdge(edge) {
    return {
        id: edge.id,
        startNodeId: edge.startNodeId,
        endNodeId: edge.endNodeId,
        bidirectional: edge.bidirectional ?? DEFAULT_ROAD_EDGE.bidirectional,
        width: edge.width ?? DEFAULT_ROAD_EDGE.width,
        laneCount: edge.laneCount ?? DEFAULT_ROAD_EDGE.laneCount,
        startArm: edge.startArm ? { ...edge.startArm } : null,
        endArm: edge.endArm ? { ...edge.endArm } : null,
    };
}

function cloneBuilding(building) {
    return {
        buildingId: building.buildingId,
        footprint: building.footprint.map((point) => ({ ...point })),
        height: building.height,
        textureId: building.textureId ?? 0,
        tags: [...(building.tags ?? ["building"])],
        meshName: building.meshName ?? building.buildingId,
    };
}

function cloneFeature(feature) {
    return {
        id: feature.id,
        type: feature.type,
        x: feature.x,
        z: feature.z,
        dir: feature.dir ?? 0,
        tags: [...(feature.tags ?? [])],
    };
}

export { DEFAULT_ROAD_EDGE };
