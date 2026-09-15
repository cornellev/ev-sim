import assert from "node:assert/strict";
import test from "node:test";

import { collectMapFitPoints, compiledMapRoadPlan, mapDocumentFrom } from "../app/3d/editor/map/mapDocument.js";
import { MAP_WORLD_SCALE, screenToWorld, worldToScreen } from "../app/3d/editor/map/mapCoords.js";
import {
    DEFAULT_MAP_VIEWPORT,
    MAP_MAX_ZOOM,
    MAP_MIN_ZOOM,
    fitMapViewport,
    mapWheelZoomFactor,
    panMapViewport,
    zoomMapViewport,
} from "../app/3d/editor/map/mapViewport.js";

function curvedRoads() {
    return {
        geometryVersion: 2,
        nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 30, y: 6, z: 0 }],
        edges: [{
            id: "e",
            startNodeId: "a",
            endNodeId: "b",
            width: 7,
            laneCount: 2,
            geometry: {
                version: 1,
                kind: "cubic-bezier",
                knots: [
                    { id: "start", mode: "auto" },
                    { id: "k1", position: { x: 15, y: 3, z: 10 }, mode: "auto" },
                    { id: "end", mode: "auto" },
                ],
            },
        }],
        turnRules: [{ nodeId: "a", fromEdgeId: "e", toEdgeId: "e", allowed: true }],
    };
}

test("mapDocumentFrom keeps geometryVersion so compiled v2 plans stay available", () => {
    const document = mapDocumentFrom({
        manifest: { document: { roads: curvedRoads(), buildings: [], features: [] } },
    });
    assert.equal(document.roads.geometryVersion, 2);
    assert.equal(document.roads.turnRules.length, 1);
    assert.equal(document.roads.edges[0].geometry.kind, "cubic-bezier");
    assert.ok(compiledMapRoadPlan(document.roads));
    assert.equal(compiledMapRoadPlan(document.roads, { preview: true }), null, "gesture preview skips the compiler");

    const stripped = { nodes: document.roads.nodes, edges: document.roads.edges };
    assert.equal(compiledMapRoadPlan(stripped), null, "the old scenario { nodes, edges } snapshot cannot compile v2 roads");
});

test("collectMapFitPoints includes v2 interior knots", () => {
    const points = collectMapFitPoints({ roads: curvedRoads() });
    assert.ok(points.some((point) => point.x === 15 && point.z === 10));
    assert.ok(points.some((point) => point.x === 0 && point.z === 0));
    assert.ok(points.some((point) => point.x === 30 && point.z === 0));
});

test("panMapViewport and zoomMapViewport keep worldToScreen invertible", () => {
    const size = { width: 800, height: 600 };
    const viewport = { centerX: 10, centerZ: -5, zoom: 1.5, gridVisible: true };
    const world = { x: 14, z: 3 };
    const screen = worldToScreen(world, viewport, size);
    const back = screenToWorld(screen, viewport, size);
    assert.ok(Math.abs(back.x - world.x) < 1e-9);
    assert.ok(Math.abs(back.z - world.z) < 1e-9);

    const panned = panMapViewport(viewport, 40, -20);
    assert.equal(panned.centerX, viewport.centerX - 40 / (viewport.zoom * MAP_WORLD_SCALE));
    assert.equal(panned.centerZ, viewport.centerZ + 20 / (viewport.zoom * MAP_WORLD_SCALE));
    const pannedBack = screenToWorld(worldToScreen(world, panned, size), panned, size);
    assert.ok(Math.abs(pannedBack.x - world.x) < 1e-9);

    const zoomed = zoomMapViewport(viewport, screen, size, 2);
    const before = screenToWorld(screen, viewport, size);
    const after = screenToWorld(screen, zoomed, size);
    assert.ok(Math.abs(after.x - before.x) < 1e-9);
    assert.ok(Math.abs(after.z - before.z) < 1e-9);
    assert.equal(zoomed.zoom, 3);
});

test("fitMapViewport centers on the AABB and clamps zoom", () => {
    const fitted = fitMapViewport([{ x: 0, z: 0 }, { x: 40, z: 20 }], { width: 800, height: 600 });
    assert.equal(fitted.centerX, 20);
    assert.equal(fitted.centerZ, 10);
    assert.ok(fitted.zoom >= MAP_MIN_ZOOM);
    assert.ok(fitted.zoom <= MAP_MAX_ZOOM);
    assert.deepEqual(fitMapViewport([], { width: 800, height: 600 }), { ...DEFAULT_MAP_VIEWPORT });
    assert.ok(mapWheelZoomFactor(100) < 1);
    assert.ok(mapWheelZoomFactor(-100) > 1);
});
