import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentTileHost } from "../app/3d/earth/EnvironmentTileHost.js";
import { TileAoiPlugin } from "../app/3d/earth/TileAoiPlugin.js";
import { wgs84ToEcef } from "../app/autonomy/Geodesy.js";

const FRAME = { version: 1, projection: "wgs84-local-tangent", axes: "east-up-south", origin: { lat: 42, lng: -76, height: 0 } };
function source(west = -76.01, quality = 1) {
    return { version: 2, tileProvider: "google-photorealistic", bounds: { north: 42.01, south: 41.99, east: -75.99, west }, quality: { maxScreenSpaceError: quality, maxCachedTiles: 20, maxCacheBytes: 1000 }, roadProvider: null, roadFilters: { highwayClasses: [] }, importedLayerIds: ["google-earth-tiles"], importedAt: null };
}

function fakeFactory(log, { failFirst = false } = {}) {
    let count = 0;
    return (config) => {
        const id = ++count;
        const session = {
            id, group: { id }, status: "ready", attributions: [{ type: "string", value: `credit-${id}` }], diagnostics: { status: "ready" }, disposed: 0,
            async load(options) { log.push(["load", id, config.bounds.west, options.geoFrame.origin.lat]); if (failFirst && id === 1) throw new Error("root failed"); },
            dispose() { this.disposed += 1; log.push(["dispose", id]); },
            setVisible(value) { log.push(["visible", id, value]); },
            setMaxScreenSpaceError(value) { log.push(["quality", id, value]); },
            setCacheLimits(value) { log.push(["cache", id, value.maxCachedTiles]); },
            update(camera, viewport) { log.push(["update", id, camera, viewport]); },
            getAttributions() { return this.attributions; },
        };
        log.push(["create", id]);
        return session;
    };
}

test("ED-08 tile host transfers preview ownership without disposing the prepared session", async () => {
    const log = [];
    const host = new EnvironmentTileHost({ createSession: fakeFactory(log) });
    const preview = await host.prepare(source(), FRAME);
    assert.equal(host.commitPreview(preview, source(), FRAME), true);
    assert.equal(host.active.session, preview);
    assert.equal(preview.disposed, 0);
    assert.deepEqual(host.getAttributions(), [{ type: "string", value: "credit-1" }]);
    host.update("camera", { width: 100, height: 50 });
    assert.ok(log.some((entry) => entry[0] === "update" && entry[2] === "camera"));
    await host.reconcile(source(-76.01, 4), FRAME);
    assert.equal(host.active.session, preview, "quality-only changes retain session identity");
    assert.ok(log.some((entry) => entry[0] === "quality" && entry[2] === 4));
    await host.reconcile(null, null);
    assert.equal(preview.disposed, 1);
});

test("ED-08 tile reconciliation adopts an armed preview without opening a duplicate session", async () => {
    const log = [];
    const host = new EnvironmentTileHost({ createSession: fakeFactory(log) });
    const config = source();
    const preview = await host.prepare(config, FRAME);
    assert.equal(host.armPreviewCommit(preview, config, FRAME), true);
    assert.equal(await host.reconcile(config, FRAME), preview);
    assert.equal(host.active.session, preview);
    assert.equal(preview.disposed, 0);
    assert.equal(log.filter((entry) => entry[0] === "create").length, 1);
});

test("ED-08 tile host disposes failed and stale sessions and retries the exact requested source", async () => {
    const log = [];
    const host = new EnvironmentTileHost({ createSession: fakeFactory(log, { failFirst: true }) });
    await assert.rejects(host.reconcile(source(), FRAME), /root failed/);
    assert.deepEqual(log.filter((entry) => entry[0] === "dispose"), [["dispose", 1]]);
    const retried = await host.retry();
    assert.equal(retried.id, 2);
    assert.equal(host.active.source.bounds.west, source().bounds.west);

    const waits = [];
    const raceLog = [];
    const racing = new EnvironmentTileHost({ createSession: (config) => {
        const id = waits.length + 1;
        let resolve;
        const pending = new Promise((done) => { resolve = done; });
        waits.push({ resolve });
        return { id, group: {}, status: "ready", load: () => pending, setVisible() {}, dispose() { raceLog.push(id); } };
    } });
    const first = racing.reconcile(source(-76.02), FRAME);
    const second = racing.reconcile(source(-76.03), FRAME);
    waits[1].resolve();
    await second;
    waits[0].resolve();
    await first;
    assert.equal(racing.active.source.bounds.west, -76.03);
    assert.deepEqual(raceLog, [1]);
});

test("ED-08 AOI plugin prunes disjoint regions and retains intersecting or unknown volumes", () => {
    const plugin = new TileAoiPlugin({ north: 1, south: 0, east: 1, west: 0 });
    const disjoint = { internal: {}, boundingVolume: { region: [2, 2, 2.1, 2.1, 0, 10] }, children: [{ id: "drop" }] };
    plugin.preprocessNode(disjoint);
    assert.equal(disjoint.children.length, 0);
    const target = { inView: true, error: 10, distanceFromCamera: 1 };
    assert.equal(plugin.calculateTileViewError(disjoint, target), true);
    assert.equal(target.inView, false);

    const intersecting = { internal: {}, boundingVolume: { region: [0, 0, 0.01, 0.01, 0, 10] }, children: [{ id: "keep" }] };
    plugin.preprocessNode(intersecting);
    assert.equal(intersecting.children.length, 1);
    const unknown = { internal: {}, boundingVolume: {}, children: [{ id: "keep" }] };
    plugin.preprocessNode(unknown);
    assert.equal(unknown.children.length, 1);

    const distant = wgs84ToEcef(10, 10, 0);
    const sphere = { internal: {}, boundingVolume: { sphere: [distant.x, distant.y, distant.z, 10] }, children: [{ id: "drop" }] };
    plugin.preprocessNode(sphere);
    assert.equal(sphere.children.length, 0, "ECEF spheres outside the AOI are pruned");

    const nearby = wgs84ToEcef(0.005, 0.005, 0);
    const box = { internal: {}, boundingVolume: { box: [nearby.x, nearby.y, nearby.z, 10, 0, 0, 0, 10, 0, 0, 0, 10] }, children: [{ id: "keep" }] };
    plugin.preprocessNode(box);
    assert.equal(box.children.length, 1, "ECEF boxes intersecting the AOI are retained");
});
