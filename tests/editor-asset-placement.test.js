import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";

import { AssetPlacementController } from "../app/3d/editor/assets/AssetPlacementController.js";
import { EditorState, EDITOR_MODES, MAP_TOOLS } from "../app/3d/editor/EditorState.js";
import { assetMapFootprint, assetMapShapes, pickMapTarget } from "../app/3d/editor/map/mapHitTest.js";

test("ED-06 catalog placement pins a revision, snaps consistently, commits once, and cancellation only releases the ghost", async () => {
    const editor = new EditorState({ transformSnap: { enabled: true, translation: 0.5 }, map: { snapEnabled: true, snapSize: 0.5 } });
    const scene = new THREE.Scene();
    const events = [];
    const root = new THREE.Group();
    const assets = {
        repository: { async getRevision(assetId, revision) { events.push(["revision", assetId, revision]); return { modelUseHash: "a".repeat(64) }; } },
        models: { async acquire() { return { root, release() { events.push(["release"]); } }; }, async acquireRevision(revision) { events.push(["acquireRevision", revision.modelUseHash]); return this.acquire(revision.modelUseHash); } },
        instantiation: { async place(input) { events.push(["prepare", input]); return { type: "place" }; } },
    };
    const bus = { execute(command) { events.push(["execute", command]); return { ok: true, result: { objectId: "asset-1" } }; } };
    const selection = { select(id) { events.push(["select", id]); } };
    const environment = { assets: () => assets };
    const data = { editor: () => editor, environment: () => environment, commands: () => bus, selection: () => selection, simulation: () => ({ render() {} }) };
    const controller = new AssetPlacementController({ data, scene });

    await controller.begin({ kind: "catalog", assetId: "tree", revision: 2, label: "Tree" });
    assert.equal(root.parent, scene);
    assert.deepEqual(controller.updatePoint({ x: 1.24, y: 0.26, z: -1.26 }), { x: 1, y: 0.5, z: -1.5 });
    const result = await controller.commit({ x: 1.24, y: 4, z: -1.26 }, { map: true });
    assert.equal(result.ok, true);
    assert.equal(events.filter(([kind]) => kind === "execute").length, 1);
    assert.deepEqual(events.find(([kind]) => kind === "prepare")[1].position, { x: 1, y: 4, z: -1.5 });
    controller.cancel();
    assert.equal(root.parent, null);
    assert.equal(events.filter(([kind]) => kind === "release").length, 1);
    controller.dispose();
});

test("ED-06 map assets use stable object ids and transformed bounds", () => {
    const record = { id: "asset-9", typeId: "asset-instance", components: { asset: { position: { x: 10, y: 3, z: 20 }, rotationY: 0, scale: { x: 2, y: 1, z: 3 } } } };
    const bounds = { min: { x: -1, y: 0, z: -2 }, max: { x: 1, y: 2, z: 2 } };
    const footprint = assetMapFootprint(record, bounds);
    assert.deepEqual(footprint, [{ x: 8, z: 14 }, { x: 12, z: 14 }, { x: 12, z: 26 }, { x: 8, z: 26 }]);
    const pick = pickMapTarget({ x: 10, z: 20 }, { objects: [record], roads: { nodes: [], edges: [] }, features: [], buildings: [] }, { zoom: 10 }, { props: true, roads: true, buildings: true, detail: true }, 12, new Map([[record.id, bounds]]));
    assert.deepEqual(pick, { type: "asset", id: "asset-9" });

    const editor = new EditorState();
    editor.setEditorMode(EDITOR_MODES.MAP);
    editor.setPlacementAsset({ kind: "catalog", assetId: "tree", revision: 3 });
    assert.equal(editor.snapshot().map.activeMapTool, MAP_TOOLS.ASSET_PLACE);
    assert.equal(editor.persistedSnapshot().activePlacement, undefined);
});

function boxVertices(min, max) {
    const vertices = [];
    for (const x of [min[0], max[0]]) {
        for (const y of [min[1], max[1]]) {
            for (const z of [min[2], max[2]]) vertices.push([x, y, z]);
        }
    }
    return vertices;
}

test("map asset shapes use the published collision hull and fall back when it is absent", () => {
    const record = {
        id: "cone",
        typeId: "asset-instance",
        typeVersion: 2,
        components: {
            asset: {
                assetId: "cone",
                revision: 7,
                position: { x: 0, y: 0, z: 0 },
                rotationY: 0,
                scale: { x: 1, y: 1, z: 1 },
            },
        },
    };
    const document = {
        objects: [record],
        roads: { nodes: [], edges: [] },
        features: [],
        buildings: [],
        assetMetrics: {
            definitions: [{
                assetId: "cone",
                revision: 7,
                collision: [{ id: "collision-generated-1", vertices: boxVertices([-0.075, 0.09, -0.075], [0.075, 0.27, 0.075]) }],
            }],
        },
    };
    const shapes = assetMapShapes(record, document, { min: { x: -1, z: -1 }, max: { x: 1, z: 1 } });
    assert.equal(shapes.source, "collision");
    assert.equal(shapes.footprints.length, 1);
    const xs = shapes.footprints[0].map((point) => point.x);
    const zs = shapes.footprints[0].map((point) => point.z);
    assert.ok(Math.max(...xs) - Math.min(...xs) < 0.16);
    assert.ok(Math.max(...zs) - Math.min(...zs) < 0.16);
    const layers = { props: true, roads: true, buildings: true, detail: true };
    const viewport = { zoom: 10 };
    assert.deepEqual(pickMapTarget({ x: 0, z: 0 }, document, viewport, layers), { type: "asset", id: "cone" });
    assert.equal(pickMapTarget({ x: 0.4, z: 0 }, document, viewport, layers), null);

    const turned = structuredClone(record);
    turned.components.asset.rotationY = Math.PI / 2;
    const long = structuredClone(document);
    long.assetMetrics.definitions[0].collision[0].vertices = boxVertices([-0.2, 0, -0.05], [0.2, 0.1, 0.05]);
    long.objects = [turned];
    const turnedHull = assetMapShapes(turned, long).footprints[0];
    const turnedX = turnedHull.map((point) => point.x);
    const turnedZ = turnedHull.map((point) => point.z);
    assert.ok(Math.max(...turnedX) - Math.min(...turnedX) < 0.12);
    assert.ok(Math.max(...turnedZ) - Math.min(...turnedZ) > 0.3);

    const unbound = { ...record, typeVersion: 1 };
    const visual = { min: { x: -1, y: 0, z: -2 }, max: { x: 1, y: 2, z: 2 } };
    const fallback = assetMapShapes(unbound, document, visual);
    assert.equal(fallback.source, "visual");
    assert.deepEqual(fallback.footprints[0], assetMapFootprint(unbound, visual));

    const placeholder = assetMapShapes(record, { objects: [record] });
    assert.equal(placeholder.source, "placeholder");
    assert.deepEqual(placeholder.footprints[0], assetMapFootprint(record));
});

test("asset collision shapes paint above the road surface", () => {
    const source = readFileSync(new URL("../app/3d/overlay/map/MapSurfaceLayers.js", import.meta.url), "utf8");
    const roads = source.indexOf('data-map-layer="roads"');
    const assets = source.indexOf('data-map-layer="assets"');
    const buildings = source.indexOf('data-map-layer="buildings"');
    assert.ok(roads >= 0 && assets > roads && buildings > assets);
});
