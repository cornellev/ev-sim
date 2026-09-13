/**
 * @typedef {{ id: string, x: number, y?: number, z: number, kind?: 'intersection' | 'endpoint' }} RoadNode
 * @typedef {{ x: number, y?: number, z: number }} RoadPoint
 * @typedef {{ id: string, direction: 1 | -1 | 0, width: number, markingLeft?: string }} RoadLane
 * @typedef {{ id: string, startNodeId: string, endNodeId: string, bidirectional?: boolean, direction?: number | string, oneWay?: boolean, oneWayDirection?: number | string, width?: number, laneCount?: number, lanes?: RoadLane[], shoulderWidth?: number, tension?: number, borderLeft?: string, borderRight?: string, startArm?: RoadPoint, endArm?: RoadPoint }} RoadEdge
 * @typedef {{ nodeId: string, fromEdgeId: string, toEdgeId: string, allowed: boolean }} RoadTurnRule
 * @typedef {{ id: string, type: string, x: number, z: number, dir?: number, rotationY?: number, tags?: string[] }} FeatureRecord
 * @typedef {{ lat: number, lng: number }} EarthAnchor
 * @typedef {{ north: number, south: number, east: number, west: number }} EarthBounds
 * @typedef {{ version?: number, anchor?: EarthAnchor, bounds: EarthBounds, tileProvider: string, roadProvider: string|null, quality?: object, roadFilters?: object, importedLayerIds: string[], importedAt: string|null }} EarthSourceRecord
 * @typedef {import("../objects/objectRecord.js").ObjectRecord} ObjectRecord
 */

import { OBJECT_GRAPH_VERSION, cloneObjectRecord, sortObjectRecords } from "../objects/objectRecord.js";
import { skyConfigToManifest } from "../../skybox/EnvironmentSkyConfig.js";
import { legacyIndex } from "../objects/objectGraph.js";
import { cloneRoadGeometry } from "../../../roads/RoadGeometryRecord.js";
import { cloneRoadLanes } from "../../../roads/RoadLaneModel.js";
import {
    CHANGE_DOMAINS,
    CHANGE_SCALARS,
    diffSnapshots,
    domainKeyOf,
    isEmptyChangeSet,
} from "./ChangeSet.js";
import { createGeoFrame } from "../../earth/GeoFrame.js";

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
            ...(options.roads?.geometryVersion !== undefined && Number(options.roads.geometryVersion) !== 1
                ? { geometryVersion: Number(options.roads.geometryVersion) }
                : {}),
            nodes: Array.isArray(options.roads?.nodes) ? options.roads.nodes.map(cloneNode) : [],
            edges: Array.isArray(options.roads?.edges) ? options.roads.edges.map(cloneEdge) : [],
            turnRules: Array.isArray(options.roads?.turnRules)
                ? options.roads.turnRules.map(cloneTurnRule).sort(compareTurnRules)
                : [],
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
        /** ED-08: optional, versioned geospatial frame. Absence is the legacy Mercator frame. */
        this.geoFrame = options.geoFrame ? createGeoFrame(options.geoFrame) : null;
        // Schema-v4 authoring overlay. Records share ids with the legacy
        // domains above; geometry never lives here. Empty for v2/v3 documents
        // until a loader or writer reconciles the graph.
        /** @type {ObjectRecord[]} */
        this.objects = Array.isArray(options.objects) ? options.objects.map(cloneObjectRecord) : [];
        // ED-07: immutable metric products copied from pinned v2 asset
        // revisions. Null means the optional domain has not been adopted by
        // this document; an empty definitions array means it has.
        this.assetMetrics = options.assetMetrics
            ? cloneAssetMetrics(options.assetMetrics)
            : null;
        // ED-03: the environment sky as a tracked scalar so skybox edits are
        // ordinary undoable commands. `null` until an Environment seeds it;
        // the persisted location stays `manifest.sky` (see `toManifest()`), so
        // documents built from `manifest.document` never carry it.
        /** @type {object|null} */
        this.sky = options.sky ? skyConfigToManifest(options.sky) : null;
        this.subscribers = new Set();
        // ED-02: monotonic change counter and transaction state. Every
        // delivered notification bumps `version`; nested transactions collapse
        // into one notification carrying a merged change set.
        this.version = 0;
        this.transactionDepth = 0;
        this.pendingNotify = false;
    }

    snapshot() {
        return {
            environmentId: this.environmentId,
            chunkSize: this.chunkSize,
            roadsAuthored: this.roadsAuthored,
            buildingsAuthored: this.buildingsAuthored,
            featuresAuthored: this.featuresAuthored,
            roads: {
                ...(this.roads.geometryVersion !== undefined ? { geometryVersion: this.roads.geometryVersion } : {}),
                nodes: this.roads.nodes.map(cloneNode),
                edges: this.roads.edges.map(cloneEdge),
                ...((this.roads.turnRules ?? []).length > 0
                    ? { turnRules: this.roads.turnRules.map(cloneTurnRule) }
                    : {}),
            },
            buildings: this.buildings.map(cloneBuilding),
            features: this.features.map(cloneFeature),
            earth: this.earth ? cloneEarthSource(this.earth) : null,
            ...(this.geoFrame ? { geoFrame: createGeoFrame(this.geoFrame) } : {}),
            ...(this.objects.length > 0
                ? { objectGraphVersion: OBJECT_GRAPH_VERSION, objects: this.objects.map(cloneObjectRecord) }
                : {}),
            ...(this.assetMetrics ? { assetMetrics: cloneAssetMetrics(this.assetMetrics) } : {}),
            ...(this.sky ? { sky: skyConfigToManifest(this.sky) } : {}),
        };
    }

    /**
     * Restore a prior snapshot produced by {@link snapshot}. A snapshot
     * without a `sky` key leaves the current sky untouched.
     * @param {ReturnType<EnvironmentDocument["snapshot"]>} manifest
     */
    restoreSnapshot(manifest, { notify = true } = {}) {
        this.environmentId = manifest.environmentId ?? this.environmentId;
        this.chunkSize = manifest.chunkSize ?? this.chunkSize;
        this.roadsAuthored = manifest.roadsAuthored === true;
        this.buildingsAuthored = manifest.buildingsAuthored === true;
        this.featuresAuthored = manifest.featuresAuthored === true;
        this.roads = {
            ...(manifest.roads?.geometryVersion !== undefined && Number(manifest.roads.geometryVersion) !== 1
                ? { geometryVersion: Number(manifest.roads.geometryVersion) }
                : {}),
            nodes: Array.isArray(manifest.roads?.nodes) ? manifest.roads.nodes.map(cloneNode) : [],
            edges: Array.isArray(manifest.roads?.edges) ? manifest.roads.edges.map(cloneEdge) : [],
            turnRules: Array.isArray(manifest.roads?.turnRules)
                ? manifest.roads.turnRules.map(cloneTurnRule).sort(compareTurnRules)
                : [],
        };
        this.buildings = Array.isArray(manifest.buildings)
            ? manifest.buildings.map(cloneBuilding)
            : [];
        this.features = Array.isArray(manifest.features)
            ? manifest.features.map(cloneFeature)
            : [];
        this.earth = manifest.earth ? cloneEarthSource(manifest.earth) : null;
        this.geoFrame = manifest.geoFrame ? createGeoFrame(manifest.geoFrame) : null;
        this.objects = Array.isArray(manifest.objects) ? manifest.objects.map(cloneObjectRecord) : [];
        this.assetMetrics = manifest.assetMetrics ? cloneAssetMetrics(manifest.assetMetrics) : null;
        if (manifest.sky !== undefined) this.sky = manifest.sky ? skyConfigToManifest(manifest.sky) : null;
        if (notify) this.notify({ source: "restore" });
    }

    /** Replace the authoring overlay without touching geometry. Stored in canonical `(order, id)` order. */
    replaceObjectGraph(records, { notify = true } = {}) {
        this.objects = sortObjectRecords(Array.isArray(records) ? records.map(cloneObjectRecord) : []);
        if (notify) this.notify();
    }

    /**
     * Replace, insert, or delete records of one change domain by key. A null
     * record deletes. Clones through the domain's canonical shape and keeps
     * turn rules and object records in canonical order.
     * @param {string} domain one of CHANGE_DOMAINS
     * @param {Iterable<[string, object|null]>} entries
     */
    replaceDomainRecords(domain, entries, { notify = true } = {}) {
        if (!CHANGE_DOMAINS.includes(domain)) throw new TypeError(`Unknown change domain "${domain}".`);
        const list = domainArray(this, domain);
        const cloner = DOMAIN_CLONERS[domain];
        let changed = false;
        for (const [key, record] of entries instanceof Map ? entries.entries() : entries) {
            const index = list.findIndex((candidate) => domainKeyOf(domain, candidate) === String(key));
            if (record === null || record === undefined) {
                if (index >= 0) {
                    list.splice(index, 1);
                    changed = true;
                }
                continue;
            }
            const cloned = cloner(record);
            if (index >= 0) list[index] = cloned;
            else list.push(cloned);
            changed = true;
        }
        if (domain === "roads.turnRules") list.sort(compareTurnRules);
        if (domain === "objects") this.objects = sortObjectRecords(list);
        if (domain === "assetMetrics.definitions") {
            this.assetMetrics.definitions.sort(compareAssetMetricDefinitions);
        }
        if (changed && notify) this.notify();
        return changed;
    }

    /** Set one tracked scalar (`earth`, `geoFrame`, `sky`, authored flags, `chunkSize`, road geometry version). */
    setScalar(name, value, { notify = true } = {}) {
        if (!CHANGE_SCALARS.includes(name)) throw new TypeError(`Unknown change scalar "${name}".`);
        if (name === "earth") this.earth = value ? cloneEarthSource(value) : null;
        else if (name === "geoFrame") this.geoFrame = value ? createGeoFrame(value) : null;
        else if (name === "sky") this.sky = value ? skyConfigToManifest(value) : null;
        else if (name === "chunkSize") this.chunkSize = Number.isFinite(Number(value)) ? Number(value) : this.chunkSize;
        else if (name === "roadGeometryVersion") {
            const version = Number(value);
            if (value === null || value === undefined || version === 1) delete this.roads.geometryVersion;
            else this.roads.geometryVersion = version;
        }
        else if (name === "assetMetricsVersion") {
            if (value === null || value === undefined) this.assetMetrics = null;
            else {
                const version = Number(value);
                if (!Number.isInteger(version) || version < 1) throw new TypeError("Asset metric version must be a positive integer.");
                this.assetMetrics ??= { version, definitions: [] };
                this.assetMetrics.version = version;
            }
        }
        else this[name] = value === true;
        if (notify) this.notify();
    }

    /** The environment sky configuration (manifest shape) or `null` when unseeded. */
    setSky(config, { notify = true } = {}) {
        this.setScalar("sky", config, { notify });
    }

    setRoadGeometryVersion(version, { notify = true } = {}) {
        this.setScalar("roadGeometryVersion", version, { notify });
    }

    /**
     * Run `fn` as one unit of change. Mutations inside may call `notify()`
     * freely; subscribers receive a single notification afterwards carrying
     * the change set between the entry and exit snapshots. Nested
     * transactions fold into the outermost one.
     * @template T
     * @param {(document: EnvironmentDocument) => T} fn
     * @param {{ source?: string, transient?: boolean, label?: string }} [meta]
     * @returns {{ result: T, changeSet: object|null }}
     */
    transaction(fn, meta = {}) {
        if (this.transactionDepth > 0) {
            this.transactionDepth += 1;
            try {
                return { result: fn(this), changeSet: null };
            } finally {
                this.transactionDepth -= 1;
            }
        }
        const before = this.snapshot();
        this.transactionDepth = 1;
        this.pendingNotify = false;
        let result;
        try {
            result = fn(this);
        } finally {
            this.transactionDepth = 0;
        }
        const changeSet = diffSnapshots(before, this.snapshot(), {
            source: meta.source ?? "command",
            transient: meta.transient === true,
            ...(meta.label ? { label: meta.label } : {}),
            ...(meta.commandId ? { commandId: meta.commandId } : {}),
            ...(meta.gestureId ? { gestureId: meta.gestureId } : {}),
            ...(meta.delta ? { delta: meta.delta } : {}),
        });
        const hadPending = this.pendingNotify;
        this.pendingNotify = false;
        if (!isEmptyChangeSet(changeSet)) {
            this.notify({ source: changeSet.meta.source, transient: changeSet.meta.transient, changeSet });
        } else if (hadPending && meta.notifyEmpty === true) {
            this.notify({ source: meta.source ?? "command", transient: meta.transient === true, changeSet: null });
        }
        return { result, changeSet: isEmptyChangeSet(changeSet) ? null : changeSet };
    }

    /**
     * Canonical legacy index plus an object-record map for the current
     * document state. Recomputed on every call; callers hold it for the span
     * of one plan or diff.
     */
    index() {
        const index = legacyIndex(this);
        const objects = new Map();
        for (const record of this.objects) objects.set(String(record.id), record);
        return { ...index, objects };
    }

    /**
     * @param {Partial<EarthSourceRecord>} source
     */
    setEarthSource(source) {
        this.earth = cloneEarthSource(source);
        this.notify();
    }

    clearEarthSource() {
        if (!this.earth) return;
        this.earth = null;
        this.notify();
    }

    /**
     * Subscribe to document changes. The callback receives
     * `(snapshot, event)` where `event` is
     * `{ version, transient, changeSet, source }`; the immediate call on
     * subscribe carries `source: "subscribe"`.
     */
    subscribe(callback) {
        if (typeof callback !== "function") return () => {};
        this.subscribers.add(callback);
        callback(this.snapshot(), { version: this.version, transient: false, changeSet: null, source: "subscribe" });
        return () => {
            this.subscribers.delete(callback);
        };
    }

    /**
     * Notify subscribers. Inside a transaction the call is deferred so the
     * transaction can publish once with its change set.
     * @param {{ source?: string, transient?: boolean, changeSet?: object|null }} [event]
     */
    notify(event = null) {
        if (this.transactionDepth > 0) {
            this.pendingNotify = true;
            return;
        }
        this.version += 1;
        const payload = {
            version: this.version,
            transient: event?.transient === true,
            changeSet: event?.changeSet ?? null,
            source: event?.source ?? "mutation",
        };
        const snapshot = this.snapshot();
        this.subscribers.forEach((callback) => callback(snapshot, payload));
    }

    get inTransaction() {
        return this.transactionDepth > 0;
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

    getObject(objectId) {
        return this.objects.find((record) => record.id === objectId) ?? null;
    }

    /**
     * Persisted document shape. The sky is stored at `manifest.sky` by the
     * environment, not inside the document, so it is stripped here.
     */
    toManifest() {
        const { sky: _sky, ...manifest } = this.snapshot();
        return manifest;
    }

    /**
     * @param {ReturnType<EnvironmentDocument["snapshot"]>} manifest
     */
    static fromManifest(manifest) {
        return new EnvironmentDocument(manifest ?? {});
    }
}

function nodeY(value) {
    const y = Number(value);
    return Number.isFinite(y) ? y : 0;
}

function cloneRoadPoint(point) {
    if (!point) return null;
    return {
        x: point.x,
        y: nodeY(point.y),
        z: point.z,
    };
}

function cloneNode(node) {
    return {
        id: node.id,
        x: node.x,
        y: nodeY(node.y),
        z: node.z,
        kind: node.kind ?? null,
        ...(node.source ? { source: structuredClone(node.source) } : {}),
    };
}

function cloneEdge(edge) {
    return {
        id: edge.id,
        startNodeId: edge.startNodeId,
        endNodeId: edge.endNodeId,
        bidirectional: edge.bidirectional ?? DEFAULT_ROAD_EDGE.bidirectional,
        ...(edge.direction !== undefined && edge.direction !== null ? { direction: edge.direction } : {}),
        ...(edge.oneWay !== undefined && edge.oneWay !== null ? { oneWay: edge.oneWay } : {}),
        ...(edge.oneWayDirection !== undefined && edge.oneWayDirection !== null
            ? { oneWayDirection: edge.oneWayDirection }
            : {}),
        width: edge.width ?? DEFAULT_ROAD_EDGE.width,
        laneCount: edge.laneCount ?? DEFAULT_ROAD_EDGE.laneCount,
        shoulderWidth: edge.shoulderWidth ?? null,
        tension: edge.tension ?? null,
        borderLeft: edge.borderLeft ?? null,
        borderRight: edge.borderRight ?? null,
        startArm: cloneRoadPoint(edge.startArm),
        endArm: cloneRoadPoint(edge.endArm),
        ...(edge.geometry ? { geometry: cloneRoadGeometry(edge.geometry) } : {}),
        ...(Array.isArray(edge.lanes) ? { lanes: cloneRoadLanes(edge.lanes) } : {}),
        ...(edge.source ? { source: structuredClone(edge.source) } : {}),
    };
}

function cloneTurnRule(rule) {
    return {
        nodeId: String(rule.nodeId),
        fromEdgeId: String(rule.fromEdgeId),
        toEdgeId: String(rule.toEdgeId),
        allowed: rule.allowed === true,
    };
}

function compareTurnRules(left, right) {
    const leftKey = `${left.nodeId}\u0000${left.fromEdgeId}\u0000${left.toEdgeId}`;
    const rightKey = `${right.nodeId}\u0000${right.fromEdgeId}\u0000${right.toEdgeId}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
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
    const version = earth?.version === undefined ? null : Number(earth.version);
    const result = {
        bounds: {
            north: Number(earth?.bounds?.north) || 0,
            south: Number(earth?.bounds?.south) || 0,
            east: Number(earth?.bounds?.east) || 0,
            west: Number(earth?.bounds?.west) || 0,
        },
        tileProvider: earth?.tileProvider ?? "google-photorealistic",
        roadProvider: earth?.roadProvider === null ? null : earth?.roadProvider ?? "overpass",
        importedLayerIds: [...(earth?.importedLayerIds ?? [])],
        importedAt: earth?.importedAt ?? null,
    };
    if (version === null) {
        result.anchor = {
            lat: Number(earth?.anchor?.lat) || 0,
            lng: Number(earth?.anchor?.lng) || 0,
        };
        return result;
    }
    result.version = version;
    result.quality = {
        maxScreenSpaceError: Math.max(1, Number(earth?.quality?.maxScreenSpaceError) || 1),
        maxCachedTiles: Math.max(1, Math.trunc(Number(earth?.quality?.maxCachedTiles) || 2000)),
        maxCacheBytes: Math.max(1, Math.trunc(Number(earth?.quality?.maxCacheBytes) || 1024 * 1024 * 1024)),
    };
    result.roadFilters = {
        highwayClasses: [...new Set((earth?.roadFilters?.highwayClasses ?? []).map(String))].sort(),
    };
    return result;
}

function domainArray(document, domain) {
    switch (domain) {
        case "roads.nodes":
            return document.roads.nodes;
        case "roads.edges":
            return document.roads.edges;
        case "roads.turnRules":
            document.roads.turnRules ??= [];
            return document.roads.turnRules;
        case "buildings":
            return document.buildings;
        case "features":
            return document.features;
        case "objects":
            return document.objects;
        case "assetMetrics.definitions":
            document.assetMetrics ??= { version: 1, definitions: [] };
            return document.assetMetrics.definitions;
        default:
            throw new TypeError(`Unknown change domain "${domain}".`);
    }
}

const DOMAIN_CLONERS = Object.freeze({
    "roads.nodes": cloneNode,
    "roads.edges": cloneEdge,
    "roads.turnRules": cloneTurnRule,
    buildings: cloneBuilding,
    features: cloneFeature,
    objects: cloneObjectRecord,
    "assetMetrics.definitions": cloneAssetMetricDefinition,
});

function cloneAssetMetrics(assetMetrics) {
    const version = Number(assetMetrics?.version ?? 1);
    return {
        version,
        definitions: (Array.isArray(assetMetrics?.definitions) ? assetMetrics.definitions : [])
            .map(cloneAssetMetricDefinition)
            .sort(compareAssetMetricDefinitions),
    };
}

function cloneAssetMetricDefinition(definition) {
    return {
        assetId: String(definition.assetId),
        revision: Number(definition.revision),
        metricHash: String(definition.metricHash),
        collision: structuredClone(Array.isArray(definition.collision) ? definition.collision : []),
        lidar: structuredClone(Array.isArray(definition.lidar) ? definition.lidar : []),
    };
}

function compareAssetMetricDefinitions(left, right) {
    const asset = String(left.assetId).localeCompare(String(right.assetId));
    return asset || Number(left.revision) - Number(right.revision);
}

export { DEFAULT_ROAD_EDGE };
