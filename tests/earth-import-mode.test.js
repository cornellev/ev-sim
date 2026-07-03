import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import {
    EDITOR_MODES,
    EARTH_IMPORT_STATUS,
    EditorState,
} from "../app/3d/editor/EditorState.js";
import { ChunkManager } from "../app/3d/editor/chunks/ChunkManager.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { EnvironmentRegistry } from "../app/3d/editor/EnvironmentRegistry.js";
import {
    DEFAULT_EARTH_IMPORT_CONFIG,
    boundsCenter,
    makeDefaultBounds,
    normalizeEarthImportEditorState,
    validateBounds,
} from "../app/3d/earth/EarthImportConfig.js";
import { GoogleEarthTilesService } from "../app/3d/earth/GoogleEarthTilesService.js";
import { EarthTilesManager } from "../app/3d/earth/EarthTilesManager.js";
import { EarthImportController } from "../app/3d/earth/EarthImportController.js";
import { EarthImportSceneIsolation, isEarthImportPreservedObject } from "../app/3d/earth/EarthImportSceneIsolation.js";
import {
    latLngHeightToECEF,
    latLngToLocal,
    localToLatLng,
    simplifyLatLngPolyline,
} from "../app/3d/earth/GeospatialTransform.js";
import { OverpassRoadProvider } from "../app/3d/earth/roads/OverpassRoadProvider.js";
import { importRoadNetworkToDocument } from "../app/3d/earth/roads/RoadGraphImporter.js";
import { Road, resolveRoadSampleInfo } from "../app/3d/city/Road.js";
import { defaultFetch } from "../app/util/Fetch.js";

test.beforeEach(() => {
    resetDocumentIdCounter();
});

function waitForTimers() {
    return new Promise((resolve) => setTimeout(resolve, 5));
}

class FakeTilesRenderer {
    constructor(rootUrl) {
        this.rootURL = rootUrl;
        this.group = new THREE.Group();
        this.lruCache = {};
        this.listeners = new Map();
        this.registeredPlugins = [];
        this.updateCalls = 0;
        this.disposed = false;
    }

    registerPlugin(plugin) {
        this.registeredPlugins.push(plugin);
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
        this.listeners.get(type)?.delete(listener);
    }

    dispatch(type, event = {}) {
        this.listeners.get(type)?.forEach((listener) => listener({ type, ...event }));
    }

    setLatLonToYUp() {
        throw new Error("Deprecated setLatLonToYUp should not be called.");
    }

    setCamera(camera) {
        this.camera = camera;
    }

    setResolutionFromRenderer(camera, renderer) {
        this.resolutionCamera = camera;
        this.resolutionRenderer = renderer;
    }

    update() {
        this.updateCalls += 1;
    }

    getAttributions() {
        return [
            { type: "image", value: "https://example.test/google.svg", alt: "Google" },
            { value: "Data Provider" },
            "Imagery Provider",
        ];
    }

    dispose() {
        this.disposed = true;
    }
}

test("EditorState supports earth import mode transitions", () => {
    const editor = new EditorState();
    let entered = false;
    let exited = false;

    editor.setEarthImportModeEnterHandler(() => {
        entered = true;
    });
    editor.setEarthImportModeExitHandler(() => {
        exited = true;
    });

    editor.setEditorMode(EDITOR_MODES.EARTH_IMPORT);
    assert.equal(editor.snapshot().editorMode, EDITOR_MODES.EARTH_IMPORT);
    assert.equal(entered, true);
    assert.ok(editor.snapshot().earthImport);

    editor.patchEarthImport({ anchorLat: 40, anchorLng: -75 });
    assert.equal(editor.snapshot().earthImport.anchorLat, 40);

    editor.setEditorMode(EDITOR_MODES.SCENE);
    assert.equal(editor.snapshot().editorMode, EDITOR_MODES.SCENE);
    assert.equal(exited, true);
    assert.equal(editor.snapshot().earthImport.previewActive, false);
});

test("EditorState restores earth import sub-state in snapshots", () => {
    const editor = new EditorState({
        editorMode: EDITOR_MODES.EARTH_IMPORT,
        earthImport: {
            anchorLat: 41,
            anchorLng: -74,
            status: EARTH_IMPORT_STATUS.PREVIEW,
            previewActive: true,
        },
    });

    const snapshot = editor.snapshot();
    assert.equal(snapshot.editorMode, EDITOR_MODES.EARTH_IMPORT);
    assert.equal(snapshot.earthImport.anchorLat, 41);
    assert.equal(snapshot.earthImport.status, EARTH_IMPORT_STATUS.PREVIEW);
    assert.equal(snapshot.earthImport.previewActive, true);
});

test("EnvironmentDocument persists earth source metadata", () => {
    const document = new EnvironmentDocument();
    document.setEarthSource({
        anchor: { lat: 42.44, lng: -76.5 },
        bounds: { north: 42.45, south: 42.43, east: -76.49, west: -76.51 },
        tileProvider: "google-photorealistic",
        roadProvider: "overpass",
        importedLayerIds: ["google-earth-tiles", "roads:overpass"],
        importedAt: "2026-06-29T00:00:00.000Z",
    });

    const snapshot = document.snapshot();
    assert.equal(snapshot.earth.tileProvider, "google-photorealistic");
    assert.equal(snapshot.earth.importedLayerIds.length, 2);

    const restored = EnvironmentDocument.fromManifest(snapshot);
    assert.equal(restored.earth.roadProvider, "overpass");
    assert.equal(restored.earth.bounds.north, 42.45);
});

test("EnvironmentDocument restoreSnapshot rolls back roads and earth metadata", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [{ id: "n1", x: 0, z: 0 }],
            edges: [],
        },
    });
    const backup = document.snapshot();

    document.setEarthSource({
        anchor: { lat: 1, lng: 2 },
        bounds: makeDefaultBounds({ lat: 1, lng: 2 }),
        tileProvider: "google-photorealistic",
        roadProvider: "overpass",
        importedLayerIds: ["google-earth-tiles"],
        importedAt: "2026-06-29T00:00:00.000Z",
    });
    document.roads.nodes.push({ id: "n2", x: 10, z: 10 });

    document.restoreSnapshot(backup);
    assert.equal(document.roads.nodes.length, 1);
    assert.equal(document.earth, null);
});

test("validateBounds rejects oversized import areas", () => {
    const bounds = {
        north: 43,
        south: 42,
        east: -75,
        west: -77,
    };
    const result = validateBounds(bounds);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /limit/i);
});

test("geospatial transform round trips local coordinates near anchor", () => {
    const anchor = { lat: 42.443, lng: -76.502 };
    const original = { lat: 42.444, lng: -76.501 };
    const local = latLngToLocal(original.lat, original.lng, anchor);
    const roundTrip = localToLatLng(local.x, local.z, anchor);

    assert.ok(Math.abs(roundTrip.lat - original.lat) < 1e-5);
    assert.ok(Math.abs(roundTrip.lng - original.lng) < 1e-5);
});

test("latLngHeightToECEF returns non-zero ECEF coordinates", () => {
    const ecef = latLngHeightToECEF(42.443, -76.502, 0);
    assert.ok(ecef.length() > 6_000_000);
});

test("simplifyLatLngPolyline reduces dense polylines", () => {
    const anchor = { lat: 42.443, lng: -76.502 };
    const points = Array.from({ length: 20 }, (_, index) => ({
        lat: anchor.lat + index * 0.00001,
        lng: anchor.lng + index * 0.00001,
    }));

    const simplified = simplifyLatLngPolyline(points, anchor, 5);
    assert.ok(simplified.length < points.length);
    assert.equal(simplified[0].lat, points[0].lat);
    assert.equal(simplified.at(-1).lat, points.at(-1).lat);
});

test("OverpassRoadProvider normalizes OSM ways", async () => {
    const provider = new OverpassRoadProvider({
        fetchImpl: async () => ({
            ok: true,
            async json() {
                return {
                    elements: [
                        { type: "node", id: 1, lat: 42.444, lon: -76.501 },
                        { type: "node", id: 2, lat: 42.445, lon: -76.500 },
                        {
                            type: "way",
                            id: 10,
                            nodes: [1, 2],
                            tags: { highway: "residential", oneway: "no" },
                        },
                    ],
                };
            },
        }),
    });

    const network = await provider.fetchRoadNetwork(makeDefaultBounds({ lat: 42.443, lng: -76.502 }));
    assert.equal(network.providerId, "overpass");
    assert.equal(network.ways.length, 1);
    assert.equal(network.ways[0].points.length, 2);
});

test("importRoadNetworkToDocument creates document roads from provider output", () => {
    const document = new EnvironmentDocument();
    const anchor = boundsCenter(makeDefaultBounds({ lat: 42.443, lng: -76.502 }));
    const stats = importRoadNetworkToDocument(document, {
        providerId: "overpass",
        ways: [{
            id: "w1",
            tags: { highway: "residential" },
            points: [
                { lat: 42.444, lng: -76.501 },
                { lat: 42.445, lng: -76.500 },
            ],
        }],
    }, { anchor, replaceExisting: true });

    assert.ok(stats.importedEdges >= 1);
    assert.ok(document.roads.nodes.length >= 2);
    assert.ok(document.roads.edges.length >= 1);
});

test("importRoadNetworkToDocument batches notifications and collapses straight chains", () => {
    const document = new EnvironmentDocument();
    const anchor = { lat: 42.443, lng: -76.502 };
    let notifications = 0;
    document.subscribe(() => {
        notifications += 1;
    });

    const stats = importRoadNetworkToDocument(document, {
        providerId: "overpass",
        ways: [
            {
                id: "w1",
                tags: { highway: "residential" },
                points: [
                    { lat: anchor.lat, lng: anchor.lng },
                    { lat: anchor.lat, lng: anchor.lng + 0.0001 },
                ],
            },
            {
                id: "w2",
                tags: { highway: "residential" },
                points: [
                    { lat: anchor.lat, lng: anchor.lng + 0.0001 },
                    { lat: anchor.lat, lng: anchor.lng + 0.0002 },
                ],
            },
        ],
    }, { anchor, replaceExisting: true });

    assert.equal(stats.importedEdges, 2);
    assert.equal(stats.collapsedNodes, 1);
    assert.equal(document.roads.nodes.length, 2);
    assert.equal(document.roads.edges.length, 1);
    assert.equal(notifications, 2, "subscribe should fire initially and once after bulk import");
});

test("straight road meshes use minimal adaptive sampling", () => {
    const points = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(30, 0, 0),
        new THREE.Vector3(60, 0, 0),
        new THREE.Vector3(90, 0, 0),
    ];
    const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.15);
    const sampleInfo = resolveRoadSampleInfo(points, curve);
    const scene = new THREE.Scene();
    const road = new Road(points);

    road.setup(scene);

    assert.equal(sampleInfo.isStraight, true);
    assert.equal(sampleInfo.segments, 1);
    assert.equal(road.triangles.length, 2);
    assert.equal(road.lanes[0].length, 2);
});

test("curved road meshes keep dense sampling", () => {
    const points = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(30, 0, 12),
        new THREE.Vector3(60, 0, -12),
        new THREE.Vector3(90, 0, 0),
    ];
    const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.15);
    const sampleInfo = resolveRoadSampleInfo(points, curve);

    assert.equal(sampleInfo.isStraight, false);
    assert.ok(sampleInfo.segments >= 48);
});

test("GoogleEarthTilesService requires API key", () => {
    const service = new GoogleEarthTilesService({
        getApiKey: () => null,
    });
    const validation = service.validateSession();
    assert.equal(validation.ok, false);
});

test("GoogleEarthTilesService leaves API key out of root URL", () => {
    const service = new GoogleEarthTilesService({
        getApiKey: () => "test-key",
    });
    const session = service.resolveSession();
    assert.equal(session.rootUrl, "https://tile.googleapis.com/v1/3dtiles/root.json");
    assert.ok(!session.rootUrl.includes("key="));
});

test("GoogleEarthTilesService surfaces Google API errors", async () => {
    const service = new GoogleEarthTilesService({
        getApiKey: () => "test-key",
        fetchImpl: async () => ({
            ok: false,
            status: 404,
            async json() {
                return {
                    error: {
                        message: "Requested entity was not found.",
                    },
                };
            },
        }),
    });

    const validation = await service.validateAccess();
    assert.equal(validation.ok, false);
    assert.match(validation.error ?? "", /404/);
    assert.match(validation.error ?? "", /Requested entity was not found/);
    assert.match(validation.error ?? "", /Map Tiles API/i);
});

test("defaultFetch preserves browser fetch binding", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = function fetchWithStrictThis(url) {
        assert.equal(this, globalThis);
        assert.equal(url, "https://example.test/resource.json");
        called = true;
        return Promise.resolve({ ok: true });
    };

    try {
        const response = await defaultFetch("https://example.test/resource.json");
        assert.equal(response.ok, true);
        assert.equal(called, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("GoogleEarthTilesService default fetch preserves global binding", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function fetchWithStrictThis(url) {
        assert.equal(this, globalThis);
        assert.equal(url, "https://tile.googleapis.com/v1/3dtiles/root.json?key=test-key");
        return Promise.resolve({ ok: true });
    };

    try {
        const service = new GoogleEarthTilesService({ getApiKey: () => "test-key" });
        const validation = await service.validateAccess();
        assert.equal(validation.ok, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("OverpassRoadProvider default fetch preserves global binding", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function fetchWithStrictThis(url, options) {
        assert.equal(this, globalThis);
        assert.equal(url, "https://overpass.example.test/api");
        assert.equal(options.method, "POST");
        return Promise.resolve({
            ok: true,
            json: async () => ({ elements: [] }),
        });
    };

    try {
        const provider = new OverpassRoadProvider({
            endpoint: "https://overpass.example.test/api",
        });
        const network = await provider.fetchRoadNetwork(makeDefaultBounds({ lat: 42.443, lng: -76.502 }));
        assert.deepEqual(network.ways, []);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("EarthTilesManager disposes tile renderer cleanly", () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const canvas = { clientWidth: 100, clientHeight: 100 };
    const renderer = {
        domElement: canvas,
        getSize: (target) => target.set(100, 100),
    };

    const manager = new EarthTilesManager({
        scene,
        camera,
        renderer,
        invalidate: () => {},
    });

    manager.disposeTiles();
    assert.equal(manager.tilesRenderer, null);
    assert.equal(manager.status, "idle");

    manager.dispose();
    assert.equal(manager.scene, null);
});

test("EarthTilesManager schedules renderer invalidation outside update", async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const renderer = {
        domElement: { clientWidth: 100, clientHeight: 100 },
        getSize: (target) => target.set(100, 100),
    };

    let renderCalls = 0;
    const manager = new EarthTilesManager({
        scene,
        camera,
        renderer,
        invalidate: () => {
            renderCalls += 1;
            manager.update();
        },
    });

    const fakeRenderer = new FakeTilesRenderer("https://tile.googleapis.com/v1/3dtiles/root.json");
    fakeRenderer.update = () => {
        fakeRenderer.updateCalls += 1;
        if (fakeRenderer.updateCalls === 1) {
            manager.requestRender();
        }
    };

    manager.tilesRenderer = fakeRenderer;
    manager.group = fakeRenderer.group;

    manager.update();
    assert.equal(fakeRenderer.updateCalls, 1);
    assert.equal(renderCalls, 0);

    await waitForTimers();
    assert.equal(renderCalls, 1);
    assert.equal(fakeRenderer.updateCalls, 2);

    manager.dispose();
});

test("EarthTilesManager load waits for root tileset and normalizes attributions", async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const renderer = {
        domElement: { clientWidth: 100, clientHeight: 100 },
        getSize: (target) => target.set(100, 100),
    };
    let fakeRenderer = null;

    const manager = new EarthTilesManager({
        scene,
        camera,
        renderer,
        invalidate: () => {},
        tileService: {
            validateAccess: () => ({
                ok: true,
                session: {
                    providerId: "google-photorealistic",
                    rootUrl: "https://tile.googleapis.com/v1/3dtiles/root.json",
                    apiKey: "test-key",
                },
            }),
        },
        createTilesRenderer: (rootUrl) => {
            fakeRenderer = new FakeTilesRenderer(rootUrl);
            return fakeRenderer;
        },
    });

    let resolved = false;
    const loadPromise = manager.load({ lat: 10, lng: 20 }).then(() => {
        resolved = true;
    });

    await Promise.resolve();
    assert.equal(resolved, false);
    assert.ok(fakeRenderer);
    assert.equal(scene.children.includes(fakeRenderer.group), true);
    const googlePlugin = fakeRenderer.registeredPlugins.find((plugin) => plugin.logoUrl);
    const expectedLat = THREE.MathUtils.degToRad(10);
    const expectedLon = THREE.MathUtils.degToRad(20);
    const reorientationPlugin = fakeRenderer.registeredPlugins.find((plugin) => (
        plugin.lat === expectedLat && plugin.lon === expectedLon && plugin.recenter === true
    ));
    assert.ok(googlePlugin);
    assert.ok(googlePlugin.logoUrl.includes("googlelogo"));
    assert.equal(googlePlugin.useRecommendedSettings, false);
    assert.ok(reorientationPlugin);
    assert.equal(reorientationPlugin.lat, expectedLat);
    assert.equal(reorientationPlugin.lon, expectedLon);
    assert.equal(fakeRenderer.errorTarget, DEFAULT_EARTH_IMPORT_CONFIG.maxScreenSpaceError);
    assert.equal(fakeRenderer.maxDepth, DEFAULT_EARTH_IMPORT_CONFIG.maxTileDepth);
    assert.equal(fakeRenderer.lruCache.minSize <= fakeRenderer.lruCache.maxSize, true);

    fakeRenderer.dispatch("load-root-tileset", {
        tileset: {},
        url: "https://tile.googleapis.com/v1/3dtiles/root.json",
    });
    await loadPromise;

    fakeRenderer.dispatch("tile-visibility-change");
    assert.equal(manager.status, "ready");
    assert.deepEqual(manager.attributions, [
        { type: "image", value: "https://example.test/google.svg", alt: "Google" },
        { type: "string", value: "Data Provider" },
        { type: "string", value: "Imagery Provider" },
    ]);

    manager.dispose();
});

test("EarthTilesManager rejects pending root load when disposed", async () => {
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const renderer = {
        domElement: { clientWidth: 100, clientHeight: 100 },
        getSize: (target) => target.set(100, 100),
    };

    const manager = new EarthTilesManager({
        scene,
        camera,
        renderer,
        invalidate: () => {},
        tileService: {
            validateAccess: () => ({
                ok: true,
                session: {
                    providerId: "google-photorealistic",
                    rootUrl: "https://tile.googleapis.com/v1/3dtiles/root.json",
                    apiKey: "test-key",
                },
            }),
        },
        createTilesRenderer: (rootUrl) => new FakeTilesRenderer(rootUrl),
    });

    const loadPromise = manager.load({ lat: 10, lng: 20 });
    await Promise.resolve();
    manager.disposeTiles();

    await assert.rejects(loadPromise, /cancelled/i);
    assert.equal(manager.status, "idle");
});

test("EarthImportController rolls back preview on exit even after editor clears preview flag", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [{ id: "n1", x: 0, z: 0 }],
            edges: [],
        },
    });
    const editor = new EditorState();
    const scene = new THREE.Scene();
    let disposedTiles = 0;
    let renderCalls = 0;

    const data = {
        scene,
        editor: () => editor,
        environment: () => ({ getDocument: () => document }),
        three: () => ({ scene }),
        simulation: () => ({ render: () => { renderCalls += 1; } }),
    };
    const controller = new EarthImportController(data, {
        group: new THREE.Group(),
        disposeTiles: () => { disposedTiles += 1; },
    });

    controller.previewDocumentBackup = document.snapshot();
    controller.previewEarthBackup = null;

    document.roads.nodes.push({ id: "n2", x: 10, z: 10 });
    document.setEarthSource({
        anchor: { lat: 1, lng: 2 },
        bounds: makeDefaultBounds({ lat: 1, lng: 2 }),
        tileProvider: "google-photorealistic",
        roadProvider: "overpass",
        importedLayerIds: ["google-earth-tiles"],
        importedAt: "2026-06-30T00:00:00.000Z",
    });
    editor.patchEarthImport({ previewActive: false });

    controller.onExitMode();

    assert.equal(document.roads.nodes.length, 1);
    assert.equal(document.earth, null);
    assert.equal(disposedTiles, 1);
    assert.equal(renderCalls >= 1, true);
    assert.equal(controller.hasPreviewBackup(), false);
});

test("EarthImportController keeps tile preview when road preview fetch fails", async () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [{ id: "existing", x: 0, z: 0 }],
            edges: [],
        },
    });
    const editor = new EditorState();
    const scene = new THREE.Scene();
    const tileGroup = new THREE.Group();
    const bounds = makeDefaultBounds({ lat: 42.443, lng: -76.502 });
    let tileLoads = 0;
    let renderCalls = 0;

    editor.patchEarthImport({
        boundsNorth: bounds.north,
        boundsSouth: bounds.south,
        boundsEast: bounds.east,
        boundsWest: bounds.west,
    });

    const data = {
        scene,
        editor: () => editor,
        environment: () => ({ getDocument: () => document }),
        three: () => ({ scene }),
        simulation: () => ({ render: () => { renderCalls += 1; } }),
    };
    const controller = new EarthImportController(data, {
        group: tileGroup,
        load: async () => { tileLoads += 1; },
        disposeTiles: () => {},
    }, {
        fetchRoads: async () => {
            throw new Error("Overpass request failed (504).");
        },
    });

    const originalWarn = console.warn;
    let result = null;
    try {
        console.warn = () => {};
        result = await controller.preview();
    } finally {
        console.warn = originalWarn;
    }
    const earthImport = editor.snapshot().earthImport;

    assert.equal(tileLoads, 1);
    assert.equal(result.stats.edgeCount, 0);
    assert.equal(result.warning, "Overpass request failed (504).");
    assert.equal(document.roads.nodes.length, 0);
    assert.deepEqual(document.earth.importedLayerIds, ["google-earth-tiles"]);
    assert.equal(earthImport.status, EARTH_IMPORT_STATUS.PREVIEW);
    assert.match(earthImport.statusMessage, /roads unavailable/i);
    assert.equal(controller.hasPreviewBackup(), true);
    assert.equal(renderCalls >= 1, true);
});

test("EarthImportController apply can continue when road fetch fails", async () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [{ id: "existing", x: 0, z: 0 }],
            edges: [],
        },
    });
    const editor = new EditorState();
    const scene = new THREE.Scene();
    const bounds = makeDefaultBounds({ lat: 42.443, lng: -76.502 });
    const city = {
        roads: [],
        intersections: [],
        roadSetup: true,
        intersectionSetup: true,
        getRoads: () => [],
        getIntersections: () => [],
        addRoads: () => {},
        addIntersection: () => {},
    };
    let tileLoads = 0;
    let disposedTiles = 0;

    editor.setEditorMode(EDITOR_MODES.EARTH_IMPORT);
    editor.patchEarthImport({
        boundsNorth: bounds.north,
        boundsSouth: bounds.south,
        boundsEast: bounds.east,
        boundsWest: bounds.west,
    });

    const data = {
        scene,
        city: () => city,
        editor: () => editor,
        environment: () => ({ getDocument: () => document }),
        three: () => ({ scene }),
        simulation: () => ({ render: () => {} }),
    };
    const controller = new EarthImportController(data, {
        group: new THREE.Group(),
        load: async () => { tileLoads += 1; },
        disposeTiles: () => { disposedTiles += 1; },
    }, {
        fetchRoads: async () => {
            throw new Error("Overpass request failed (504).");
        },
    });

    const originalWarn = console.warn;
    let result = null;
    try {
        console.warn = () => {};
        result = await controller.apply();
    } finally {
        console.warn = originalWarn;
    }

    const earthImport = editor.snapshot().earthImport;
    assert.equal(tileLoads, 1);
    assert.equal(disposedTiles, 1);
    assert.equal(result.stats.edgeCount, 0);
    assert.equal(document.roads.nodes.length, 0);
    assert.deepEqual(document.earth.importedLayerIds, ["google-earth-tiles"]);
    assert.equal(editor.snapshot().editorMode, EDITOR_MODES.SCENE);
    assert.equal(earthImport.status, EARTH_IMPORT_STATUS.APPLIED);
    assert.match(earthImport.statusMessage, /without roads/i);
});

test("EarthImportController apply registers imported roads into chunks", async () => {
    const document = new EnvironmentDocument();
    const editor = new EditorState();
    const scene = new THREE.Scene();
    const chunkManager = new ChunkManager({ scene, chunkSize: 20 });
    const registry = new EnvironmentRegistry({ chunkManager });
    const bounds = makeDefaultBounds({ lat: 42.443, lng: -76.502 });
    const city = {
        roads: [],
        intersections: [],
        roadSetup: true,
        intersectionSetup: true,
        getRoads() {
            return this.roads;
        },
        getIntersections() {
            return this.intersections;
        },
        addRoads(roads) {
            this.roads.push(...roads);
        },
        addIntersection(intersection) {
            this.intersections.push(intersection);
        },
    };

    editor.setEditorMode(EDITOR_MODES.EARTH_IMPORT);
    editor.patchEarthImport({
        boundsNorth: bounds.north,
        boundsSouth: bounds.south,
        boundsEast: bounds.east,
        boundsWest: bounds.west,
    });

    const data = {
        scene,
        city: () => city,
        editor: () => editor,
        environment: () => ({
            getDocument: () => document,
            objects: () => registry,
        }),
        three: () => ({ scene }),
        simulation: () => ({ render: () => {} }),
    };
    const controller = new EarthImportController(data, {
        group: new THREE.Group(),
        load: async () => {},
        disposeTiles: () => {},
    }, {
        fetchRoads: async () => {
            document.roads = {
                nodes: [
                    { id: "node-a", x: 0, z: 0 },
                    { id: "node-b", x: 60, z: 0 },
                ],
                edges: [{
                    id: "edge-a",
                    startNodeId: "node-a",
                    endNodeId: "node-b",
                    bidirectional: true,
                    width: 7,
                    laneCount: 2,
                }],
            };
            document.notify?.();
            return {
                network: { providerId: "overpass", ways: [] },
                providerId: "overpass",
                stats: {
                    importedEdges: 1,
                    skippedEdges: 0,
                    nodeCount: 2,
                    edgeCount: 1,
                },
            };
        },
    });

    await controller.apply();

    const roadEntity = registry.getEntity("road:0");
    assert.ok(roadEntity, "road entity should be registered after apply");
    assert.equal(roadEntity.layer, "roads");
    assert.ok(roadEntity.primaryChunk, "road entity should have a primary chunk");
    assert.ok(chunkManager.getMembership("road:0"), "road entity should be indexed in chunks");
    assert.match(roadEntity.object3D.parent?.name ?? "", /^EnvironmentChunk:/);
});

test("normalizeEarthImportEditorState fills default bounds", () => {
    const state = normalizeEarthImportEditorState({ anchorLat: 10, anchorLng: 20 });
    assert.equal(state.anchorLat, 10);
    assert.ok(state.boundsNorth > state.boundsSouth);
    assert.ok(state.boundsEast > state.boundsWest);
});

test("EarthImportSceneIsolation hides environment roots but preserves sky and tiles", () => {
    const scene = new THREE.Scene();
    const sky = new THREE.Group();
    sky.name = "TakramEnvironmentSky";
    sky.userData.preserveInEarthImportMode = true;

    const roads = new THREE.Group();
    roads.name = "Roads";

    const tiles = new THREE.Group();
    tiles.name = "GoogleEarthTiles";
    tiles.userData.earthImportLayer = true;

    scene.add(sky, roads, tiles);

    const isolation = new EarthImportSceneIsolation();
    isolation.activate(scene);

    assert.equal(sky.visible, true);
    assert.equal(tiles.visible, true);
    assert.equal(roads.visible, false);

    isolation.deactivate(scene);
    assert.equal(roads.visible, true);
});

test("isEarthImportPreservedObject recognizes tile and sky roots", () => {
    const tileRoot = new THREE.Group();
    tileRoot.userData.earthImportLayer = true;
    assert.equal(isEarthImportPreservedObject(tileRoot), true);

    const skyRoot = new THREE.Group();
    skyRoot.name = "TakramEnvironmentSky";
    assert.equal(isEarthImportPreservedObject(skyRoot), true);
});
