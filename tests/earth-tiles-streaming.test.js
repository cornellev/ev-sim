import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { EarthTilesManager } from "../app/3d/earth/EarthTilesManager.js";
import { ecefToLocalMatrix } from "../app/3d/earth/GeoFrame.js";

class FakeTilesRenderer {
    constructor() {
        this.group = new THREE.Group();
        this.lruCache = { itemList: [], bytesSize: 0 };
        this.listeners = new Map();
        this.plugins = [];
        this.deleted = [];
    }
    registerPlugin(plugin) { this.plugins.push(plugin); }
    addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatch(type, event = {}) { this.listeners.get(type)?.forEach((listener) => listener({ type, ...event })); }
    setCamera(camera) { this.camera = camera; }
    deleteCamera(camera) { this.deleted.push(camera); }
    setResolution(camera, width, height) { this.resolution = { camera, width, height }; }
    setResolutionFromRenderer(camera) { this.resolution = { camera, width: 100, height: 100 }; }
    update() { this.updates = (this.updates ?? 0) + 1; }
    getAttributions() { return []; }
    dispose() { this.disposed = true; }
}

function manager(camera = new THREE.PerspectiveCamera()) {
    const scene = new THREE.Scene();
    const renderer = { domElement: { width: 100, height: 100 }, getSize: (target) => target.set(100, 100) };
    return new EarthTilesManager({ scene, camera, renderer, tileService: { validateAccess: async () => ({ ok: true, session: { rootUrl: "root.json", apiKey: "key" } }) } });
}

test("ED-08 traversal replaces cameras and uses current drawing-buffer dimensions", () => {
    const first = new THREE.PerspectiveCamera();
    const second = new THREE.PerspectiveCamera();
    const host = manager(first);
    const tiles = new FakeTilesRenderer();
    tiles.lruCache.itemList = [1, 2, 3];
    tiles.lruCache.bytesSize = 512;
    host.tilesRenderer = tiles;
    host.group = tiles.group;
    host.setCacheLimits({ maxCachedTiles: 2, maxCacheBytes: 400 });
    host.update(second, { width: 800, height: 450 });
    assert.deepEqual(tiles.deleted, [first]);
    assert.deepEqual(tiles.resolution, { camera: second, width: 800, height: 450 });
    assert.equal(tiles.updates, 1);
    assert.equal(host.diagnostics.residentCount, 3);
    assert.equal(host.diagnostics.residentBytes, 512);
    assert.equal(host.diagnostics.degraded, true);
    assert.ok(host.diagnostics.effectiveScreenSpaceError > host.maxScreenSpaceError);
});

test("ED-08 modern tile roots use the inverse GeoFrame matrix and carry isolation flags", async () => {
    const host = manager();
    let tiles;
    host.createTilesRenderer = () => { tiles = new FakeTilesRenderer(); return tiles; };
    const frame = { version: 1, projection: "wgs84-local-tangent", axes: "east-up-south", origin: { lat: 42, lng: -76, height: 0 } };
    const source = { quality: { maxScreenSpaceError: 2, maxCachedTiles: 25, maxCacheBytes: 2048 } };
    const pending = host.load({ ...frame.origin, geoFrame: frame, bounds: { north: 42.01, south: 41.99, east: -75.99, west: -76.01 }, source });
    await Promise.resolve();
    assert.deepEqual(tiles.group.matrix.toArray(), ecefToLocalMatrix(frame));
    assert.equal(tiles.group.userData.skipEnvironmentSelection, true);
    assert.equal(tiles.group.userData.bakeIgnore, true);
    assert.equal(tiles.lruCache.maxSize, 25);
    assert.equal(tiles.lruCache.maxBytesSize, 2048);
    assert.ok(tiles.plugins.some((plugin) => plugin.name === "ED08_TILE_AOI"));
    assert.equal(tiles.plugins.some((plugin) => "recenter" in plugin), false);
    const model = new THREE.Group();
    model.add(new THREE.Mesh());
    tiles.dispatch("load-model", { scene: model });
    assert.equal(model.children[0].userData.earthImportLayer, true);
    tiles.dispatch("load-root-tileset");
    await pending;
    host.dispose();
});
