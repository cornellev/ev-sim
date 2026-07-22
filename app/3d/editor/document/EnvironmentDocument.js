/**
 * @typedef {{ id: string, x: number, z: number, kind?: 'intersection' | 'endpoint' }} RoadNode
 * @typedef {{ id: string, startNodeId: string, endNodeId: string, bidirectional?: boolean, width?: number, laneCount?: number, shoulderWidth?: number, tension?: number, borderLeft?: string, borderRight?: string, startArm?: { x: number, z: number }, endArm?: { x: number, z: number } }} RoadEdge
 * @typedef {{ id: string, type: string, x: number, z: number, dir?: number, rotationY?: number, tags?: string[] }} FeatureRecord
 * @typedef {{ lat: number, lng: number }} EarthAnchor
 * @typedef {{ north: number, south: number, east: number, west: number }} EarthBounds
 * @typedef {{ anchor: EarthAnchor, bounds: EarthBounds, tileProvider: string, roadProvider: string, importedLayerIds: string[], importedAt: string|null }} EarthSourceRecord
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
        // Runtime hydration describes a template but is not an author edit.
        // Map/Earth mutations flip this flag so the loader knows when native
        // template roads should be replaced by document-authored roads.
        this.roadsAuthored = options.roadsAuthored === true;
        this.buildingsAuthored = options.buildingsAuthored === true;
        this.featuresAuthored = options.featuresAuthored === true;
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
        /** @type {EarthSourceRecord|null} */
        this.earth = options.earth ? cloneEarthSource(options.earth) : null;
        this.subscribers = new Set();
    }

    snapshot() {
        return {
            environmentId: this.environmentId,
            chunkSize: this.chunkSize,
            roadsAuthored: this.roadsAuthored,
            buildingsAuthored: this.buildingsAuthored,
            featuresAuthored: this.featuresAuthored,
            roads: {
                nodes: this.roads.nodes.map(cloneNode),
                edges: this.roads.edges.map(cloneEdge),
            },
            buildings: this.buildings.map(cloneBuilding),
            features: this.features.map(cloneFeature),
            earth: this.earth ? cloneEarthSource(this.earth) : null,
        };
    }

    /**
     * Restore a prior snapshot produced by {@link snapshot}.
     * @param {ReturnType<EnvironmentDocument["snapshot"]>} manifest
     */
    restoreSnapshot(manifest) {
        this.environmentId = manifest.environmentId ?? this.environmentId;
        this.chunkSize = manifest.chunkSize ?? this.chunkSize;
        this.roadsAuthored = manifest.roadsAuthored === true;
        this.buildingsAuthored = manifest.buildingsAuthored === true;
        this.featuresAuthored = manifest.featuresAuthored === true;
        this.roads = {
            nodes: Array.isArray(manifest.roads?.nodes) ? manifest.roads.nodes.map(cloneNode) : [],
            edges: Array.isArray(manifest.roads?.edges) ? manifest.roads.edges.map(cloneEdge) : [],
        };
        this.buildings = Array.isArray(manifest.buildings)
            ? manifest.buildings.map(cloneBuilding)
            : [];
        this.features = Array.isArray(manifest.features)
            ? manifest.features.map(cloneFeature)
            : [];
        this.earth = manifest.earth ? cloneEarthSource(manifest.earth) : null;
        this.notify();
    }

    /**
     * @param {Partial<EarthSourceRecord>} source
     */
    setEarthSource(source) {
        this.earth = cloneEarthSource({
            anchor: source.anchor ?? { lat: 0, lng: 0 },
            bounds: source.bounds ?? { north: 0, south: 0, east: 0, west: 0 },
            tileProvider: source.tileProvider ?? "google-photorealistic",
            roadProvider: source.roadProvider ?? "overpass",
            importedLayerIds: source.importedLayerIds ?? [],
            importedAt: source.importedAt ?? null,
        });
        this.notify();
    }

    clearEarthSource() {
        if (!this.earth) return;
        this.earth = null;
        this.notify();
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
        shoulderWidth: edge.shoulderWidth ?? null,
        tension: edge.tension ?? null,
        borderLeft: edge.borderLeft ?? null,
        borderRight: edge.borderRight ?? null,
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
        rotationY: feature.rotationY ?? 0,
        tags: [...(feature.tags ?? [])],
    };
}

/**
 * @param {Partial<EarthSourceRecord>|null|undefined} earth
 * @returns {EarthSourceRecord}
 */
function cloneEarthSource(earth) {
    return {
        anchor: {
            lat: Number(earth?.anchor?.lat) || 0,
            lng: Number(earth?.anchor?.lng) || 0,
        },
        bounds: {
            north: Number(earth?.bounds?.north) || 0,
            south: Number(earth?.bounds?.south) || 0,
            east: Number(earth?.bounds?.east) || 0,
            west: Number(earth?.bounds?.west) || 0,
        },
        tileProvider: earth?.tileProvider ?? "google-photorealistic",
        roadProvider: earth?.roadProvider ?? "overpass",
        importedLayerIds: [...(earth?.importedLayerIds ?? [])],
        importedAt: earth?.importedAt ?? null,
    };
}

export { DEFAULT_ROAD_EDGE };
