import assert from "node:assert/strict";
import test from "node:test";
import {
    EDITOR_MODES,
    EditorState,
    MAP_TOOLS,
} from "../app/3d/editor/EditorState.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import {
    addBuildingRectangle,
    addFeature,
    addRoadEdge,
    canMoveNode,
    connectEndpointToIntersection,
    dedupeRoadNodes,
    documentToRoadNetworkInputs,
    findNearestNode,
    getEdgeIntersectionConnectors,
    getEdgeRenderEndpoints,
    getIntersectionNodeIds,
    getOrCreateNode,
    getNodeDegree,
    moveFeature,
    moveRoadNode,
    normalizeRectangleFootprint,
    removeBuilding,
    removeFeature,
    removeIntersectionNode,
    removeRoadEdge,
    snapPoint,
} from "../app/3d/editor/document/documentMutations.js";
import { pickMapTarget } from "../app/3d/editor/map/mapHitTest.js";
import { advancePanDrag, PAN_DRAG_THRESHOLD } from "../app/3d/editor/map/mapPointerInteractions.js";
import { screenToWorld, worldSizeToScreen, worldToScreen, isMapDetailZoom } from "../app/3d/editor/map/mapCoords.js";
import { getPlacementAsset, fusionObjectToCatalogType } from "../app/3d/editor/placement/placementCatalogData.js";
import { hydrateDocumentFromRuntime } from "../app/3d/editor/document/documentRuntimeHydration.js";

test.beforeEach(() => {
    resetDocumentIdCounter();
});

test("EnvironmentDocument snapshots roads, buildings, and features", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [{ id: "n1", x: 0, z: 0 }],
            edges: [{ id: "e1", startNodeId: "n1", endNodeId: "n1" }],
        },
        buildings: [{
            buildingId: "b1",
            footprint: [
                { x: 0, y: 0, z: 0 },
                { x: 4, y: 0, z: 0 },
                { x: 4, y: 0, z: 4 },
                { x: 0, y: 0, z: 4 },
            ],
            height: 8,
            textureId: 0,
            tags: ["building"],
            meshName: "b1",
        }],
        features: [{ id: "f1", type: "stop-sign", x: 2, z: 2, dir: 0, tags: [] }],
    });

    const snapshot = document.snapshot();
    assert.equal(snapshot.roads.nodes.length, 1);
    assert.equal(snapshot.buildings[0].buildingId, "b1");
    assert.equal(snapshot.features[0].type, "stop-sign");
});

test("road graph mutations snap, connect, and validate degree", () => {
    const document = new EnvironmentDocument();
    const a = getOrCreateNode(document, { x: 0, z: 0 }, 1);
    const b = getOrCreateNode(document, { x: 10, z: 0 }, 1);
    const c = getOrCreateNode(document, { x: 20, z: 0 }, 1);
    const d = getOrCreateNode(document, { x: 10, z: 10 }, 1);
    const e = getOrCreateNode(document, { x: 10, z: -10 }, 1);
    const f = getOrCreateNode(document, { x: 0, z: 10 }, 1);

    assert.equal(addRoadEdge(document, b.id, a.id).ok, true);
    assert.equal(addRoadEdge(document, b.id, c.id).ok, true);
    assert.equal(addRoadEdge(document, b.id, d.id).ok, true);
    assert.equal(addRoadEdge(document, b.id, e.id).ok, true);

    const blocked = addRoadEdge(document, b.id, f.id);
    assert.equal(blocked.ok, false);

    const nearest = findNearestNode({ x: 0.5, z: 0.2 }, document.roads.nodes, 2);
    assert.equal(nearest?.id, a.id);
});

test("intersection nodes are derived from edge degree", () => {
    const document = new EnvironmentDocument();
    const a = getOrCreateNode(document, { x: 0, z: 0 }, 0.5);
    const b = getOrCreateNode(document, { x: 10, z: 0 }, 0.5);
    const c = getOrCreateNode(document, { x: 10, z: 10 }, 0.5);

    addRoadEdge(document, a.id, b.id);
    addRoadEdge(document, b.id, c.id);

    const intersections = getIntersectionNodeIds(document);
    assert.deepEqual(intersections, [b.id]);
});

test("building rectangle helper normalizes footprint and enforces minimum size", () => {
    const footprint = normalizeRectangleFootprint(
        { x: 5, z: 2 },
        { x: 1, z: 8 },
        1,
    );

    assert.equal(footprint[0].x, 1);
    assert.equal(footprint[2].z, 8);

    const document = new EnvironmentDocument();
    const tooSmall = addBuildingRectangle(
        document,
        { x: 0, z: 0 },
        { x: 1, z: 1 },
    );
    assert.equal(tooSmall.ok, false);

    const created = addBuildingRectangle(
        document,
        { x: 0, z: 0 },
        { x: 6, z: 8 },
    );
    assert.equal(created.ok, true);
    assert.equal(document.buildings.length, 1);
});

test("feature placement stores typed records", () => {
    const document = new EnvironmentDocument();
    const result = addFeature(document, {
        type: "stop-sign",
        x: 4,
        z: 9,
        dir: 2,
    });

    assert.equal(result.ok, true);
    assert.equal(document.features[0].type, "stop-sign");
    assert.equal(document.features[0].dir, 2);
});

test("documentToRoadNetworkInputs matches buildRoadNetwork tuple format", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0 },
                { id: "b", x: 20, z: 0 },
            ],
            edges: [{
                id: "e1",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
            }],
        },
    });

    const { vectorMap, connections } = documentToRoadNetworkInputs(document);
    assert.equal(vectorMap.get("a").x, 0);
    assert.deepEqual(connections, [["a", "b", true]]);
});

test("editor state tracks map mode, viewport, and map tools", () => {
    const editor = new EditorState();
    editor.setEditorMode(EDITOR_MODES.MAP);
    editor.setActiveMapTool(MAP_TOOLS.ROAD_PEN);
    editor.setMapViewport({ centerX: 12, centerZ: -4, zoom: 2 });
    editor.setMapSnapEnabled(true);
    editor.setMapDraft({ type: "road-pen", activeNodeId: "n1" });

    const snapshot = editor.snapshot();
    assert.equal(snapshot.editorMode, EDITOR_MODES.MAP);
    assert.equal(snapshot.map.activeMapTool, MAP_TOOLS.ROAD_PEN);
    assert.equal(snapshot.map.centerX, 12);
    assert.equal(snapshot.map.draft.activeNodeId, "n1");
});

test("map coordinate helpers round-trip world and screen space", () => {
    const viewport = { centerX: 10, centerZ: -5, zoom: 1.5 };
    const size = { width: 800, height: 600 };
    const world = { x: 14, z: 3 };
    const screen = worldToScreen(world, viewport, size);
    const back = screenToWorld(screen, viewport, size);

    assert.ok(Math.abs(back.x - world.x) < 0.001);
    assert.ok(Math.abs(back.z - world.z) < 0.001);
});

test("worldSizeToScreen converts road width meters to pixels", () => {
    assert.equal(worldSizeToScreen(7, { zoom: 1 }), 28);
    assert.equal(worldSizeToScreen(3.5, { zoom: 2 }), 28);
});

test("isMapDetailZoom hides detail layers when zoomed out", () => {
    assert.equal(isMapDetailZoom({ zoom: 0.8 }), true);
    assert.equal(isMapDetailZoom({ zoom: 0.55 }), true);
    assert.equal(isMapDetailZoom({ zoom: 0.54 }), false);
});

test("snapPoint aligns to grid", () => {
    assert.deepEqual(snapPoint({ x: 1.2, z: 2.7 }, 1), { x: 1, z: 3 });
});

test("hydrateDocumentFromRuntime imports props and buildings from runtime", () => {
    const document = new EnvironmentDocument();
    const registry = {
        entities: new Map([
            ["fusion:abc", {
                layer: "props",
                sourceId: "abc",
                fusionObject: {
                    _uuid: "abc",
                    constructor: { name: "StopSign" },
                    position: { x: 12, z: -4 },
                    dir: 1,
                    tags: ["sign"],
                },
                tags: ["sign"],
            }],
        ]),
    };

    hydrateDocumentFromRuntime({
        bakeRunConfig: () => ({
            buildings: [{
                buildingId: "b1",
                footprint: [
                    { x: 0, y: 0, z: 0 },
                    { x: 4, y: 0, z: 0 },
                    { x: 4, y: 0, z: 4 },
                    { x: 0, y: 0, z: 4 },
                ],
                height: 8,
                textureId: 0,
                tags: ["building"],
                meshName: "b1",
            }],
        }),
        environment: () => ({ objects: () => registry }),
        city: () => ({ getRoads: () => [] }),
    }, document);

    assert.equal(document.features.length, 1);
    assert.equal(document.features[0].type, "stop-sign");
    assert.equal(document.buildings.length, 1);
});

test("dedupeRoadNodes keeps the first node for duplicate ids", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "node-a", x: 0, z: 0 },
                { id: "node-a", x: 1, z: 1 },
                { id: "node-b", x: 5, z: 5 },
            ],
            edges: [],
        },
    });

    dedupeRoadNodes(document);
    assert.equal(document.roads.nodes.length, 2);
    assert.equal(document.roads.nodes[0].id, "node-a");
    assert.equal(document.roads.nodes[1].id, "node-b");
});

test("getEdgeRenderEndpoints insets roads at intersection nodes", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "int-a", x: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "edge-1",
                startNodeId: "int-a",
                endNodeId: "end-b",
                bidirectional: true,
            }],
        },
    });

    const endpoints = getEdgeRenderEndpoints(document, document.roads.edges[0]);
    assert.ok(endpoints.startPoint.x > 0);
    assert.equal(endpoints.endPoint.x, 20);
});

test("canMoveNode allows free endpoints but not intersections", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "int-a", x: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "edge-1",
                startNodeId: "int-a",
                endNodeId: "end-b",
                bidirectional: true,
            }],
        },
    });

    assert.equal(canMoveNode(document, "int-a"), false);
    assert.equal(canMoveNode(document, "end-b"), true);
});

test("document helpers work with plain snapshots", () => {
    const snapshot = {
        roads: {
            nodes: [
                { id: "int-a", x: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "edge-1",
                startNodeId: "int-a",
                endNodeId: "end-b",
                bidirectional: true,
            }],
        },
        buildings: [],
        features: [],
    };

    assert.equal(canMoveNode(snapshot, "int-a"), false);
    assert.equal(canMoveNode(snapshot, "end-b"), true);
    assert.equal(getEdgeRenderEndpoints(snapshot, snapshot.roads.edges[0]).endPoint.x, 20);
});

test("moveRoadNode snaps a free endpoint toward a nearby intersection", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "int-a", x: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, z: 0, kind: "endpoint" },
                { id: "int-c", x: 40, z: 0, kind: "intersection" },
            ],
            edges: [{
                id: "edge-1",
                startNodeId: "int-a",
                endNodeId: "end-b",
                bidirectional: true,
            }],
        },
    });

    moveRoadNode(document, "end-b", { x: 38.5, z: 0.5 }, { snapRadius: 3 });
    const endpoint = document.roads.nodes.find((node) => node.id === "end-b");
    assert.equal(endpoint.x, 40);
    assert.equal(endpoint.z, 0);
});

test("connectEndpointToIntersection merges a free endpoint into an intersection", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "int-a", x: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, z: 0, kind: "endpoint" },
                { id: "int-c", x: 40, z: 0, kind: "intersection" },
            ],
            edges: [{
                id: "edge-1",
                startNodeId: "int-a",
                endNodeId: "end-b",
                bidirectional: true,
            }],
        },
    });

    const result = connectEndpointToIntersection(
        document,
        "end-b",
        { x: 39, z: 0 },
        3,
    );

    assert.equal(result.ok, true);
    assert.equal(result.connected, true);
    assert.equal(document.roads.nodes.some((node) => node.id === "end-b"), false);
    assert.equal(document.roads.edges[0].endNodeId, "int-c");
    assert.equal(document.roads.edges.length, 1);
});

test("removeRoadEdge removes orphan endpoints but keeps intersections", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "int-a", x: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "edge-1",
                startNodeId: "int-a",
                endNodeId: "end-b",
                bidirectional: true,
            }],
        },
    });

    removeRoadEdge(document, "edge-1");
    assert.equal(document.roads.edges.length, 0);
    assert.equal(document.roads.nodes.some((node) => node.id === "end-b"), false);
    assert.equal(document.roads.nodes.some((node) => node.id === "int-a"), true);
});

test("removeBuilding and removeFeature update the document", () => {
    const document = new EnvironmentDocument({
        buildings: [{ buildingId: "b-1", footprint: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 0, z: 10 }, { x: 0, y: 0, z: 10 }], height: 8 }],
        features: [{ id: "f-1", type: "barrel", x: 5, z: 5 }],
    });

    removeBuilding(document, "b-1");
    removeFeature(document, "f-1");
    assert.equal(document.buildings.length, 0);
    assert.equal(document.features.length, 0);
});

test("moveFeature updates feature coordinates", () => {
    const document = new EnvironmentDocument({
        features: [{ id: "f-1", type: "barrel", x: 5, z: 5 }],
    });

    moveFeature(document, "f-1", { x: 12, z: 3 });
    assert.equal(document.features[0].x, 12);
    assert.equal(document.features[0].z, 3);
});

test("getEdgeIntersectionConnectors draws from road arm to intersection center", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "int-a", x: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, z: 0, kind: "endpoint" },
            ],
            edges: [{
                id: "edge-1",
                startNodeId: "int-a",
                endNodeId: "end-b",
                bidirectional: true,
            }],
        },
    });

    const connectors = getEdgeIntersectionConnectors(document, document.roads.edges[0]);
    assert.equal(connectors.length, 1);
    assert.equal(connectors[0].nodeId, "int-a");
    assert.equal(connectors[0].to.x, 0);
    assert.equal(connectors[0].to.z, 0);
    assert.ok(connectors[0].from.x > 0);
});

test("removeIntersectionNode removes connected roads and orphan endpoints", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "int-a", x: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, z: 0, kind: "endpoint" },
                { id: "int-c", x: 40, z: 0, kind: "intersection" },
            ],
            edges: [
                {
                    id: "edge-1",
                    startNodeId: "int-a",
                    endNodeId: "end-b",
                    bidirectional: true,
                },
                {
                    id: "edge-2",
                    startNodeId: "end-b",
                    endNodeId: "int-c",
                    bidirectional: true,
                },
            ],
        },
    });

    removeIntersectionNode(document, "int-a");
    assert.equal(document.roads.nodes.some((node) => node.id === "int-a"), false);
    assert.equal(document.roads.edges.length, 1);
    assert.equal(document.roads.edges[0].startNodeId, "end-b");
});

test("pickMapTarget prefers features over buildings and roads", () => {
    const snapshot = {
        roads: {
            nodes: [],
            edges: [{
                id: "edge-1",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
                width: 7,
            }],
        },
        buildings: [{
            buildingId: "b-1",
            footprint: [
                { x: 0, y: 0, z: 0 },
                { x: 20, y: 0, z: 0 },
                { x: 20, y: 0, z: 20 },
                { x: 0, y: 0, z: 20 },
            ],
            height: 8,
        }],
        features: [{ id: "f-1", type: "barrel", x: 10, z: 10 }],
    };

    const pick = pickMapTarget(
        { x: 10, z: 10 },
        snapshot,
        { zoom: 1 },
        { buildings: true, roads: true, props: true },
    );

    assert.deepEqual(pick, { type: "feature", id: "f-1" });
});

test("pickMapTarget selects intersections before roads", () => {
    const snapshot = {
        roads: {
            nodes: [
                { id: "int-a", x: 10, z: 10, kind: "intersection" },
                { id: "end-b", x: 30, z: 10, kind: "endpoint" },
            ],
            edges: [{
                id: "edge-1",
                startNodeId: "int-a",
                endNodeId: "end-b",
                bidirectional: true,
                width: 7,
            }],
        },
        buildings: [],
        features: [],
    };

    const pick = pickMapTarget(
        { x: 10.5, z: 10.5 },
        snapshot,
        { zoom: 1 },
        { buildings: true, roads: true, props: true },
    );

    assert.deepEqual(pick, { type: "intersection", id: "int-a" });
});

test("placement catalog includes map colors for feature types", () => {
    const stopSign = getPlacementAsset("stop-sign");
    const barrel = getPlacementAsset("barrel");
    assert.equal(stopSign.mapColor, "#ef4444");
    assert.equal(barrel.mapColor, "#f97316");
});

test("advancePanDrag waits for drag threshold before panning", () => {
    const pans = [];
    const pending = { mode: "pending-pan", x: 100, y: 200 };

    const unchanged = advancePanDrag(
        pending,
        100 + PAN_DRAG_THRESHOLD - 1,
        200,
        (dx, dy) => pans.push({ dx, dy }),
    );
    assert.deepEqual(unchanged, pending);
    assert.equal(pans.length, 0);

    const panned = advancePanDrag(
        pending,
        100 + PAN_DRAG_THRESHOLD + 2,
        200,
        (dx, dy) => pans.push({ dx, dy }),
    );
    assert.deepEqual(panned, {
        x: 100 + PAN_DRAG_THRESHOLD + 2,
        y: 200,
        mode: "pan",
    });
    assert.deepEqual(pans, [{ dx: PAN_DRAG_THRESHOLD + 2, dy: 0 }]);
});

test("advancePanDrag pans immediately when already in pan mode", () => {
    const pans = [];
    const active = { mode: "pan", x: 10, y: 20 };

    const next = advancePanDrag(active, 15, 25, (dx, dy) => pans.push({ dx, dy }));

    assert.deepEqual(next, { x: 15, y: 25, mode: "pan" });
    assert.deepEqual(pans, [{ dx: 5, dy: 5 }]);
});
