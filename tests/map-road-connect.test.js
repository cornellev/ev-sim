import assert from "node:assert/strict";
import test from "node:test";

import { EditorState, MAP_TOOLS } from "../app/3d/editor/EditorState.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { deriveObjectGraph } from "../app/3d/editor/objects/index.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { RoadAuthoringController } from "../app/3d/editor/tools/RoadAuthoringController.js";
import {
    advanceConnectPreview,
    endpointNodeIdForSub,
    resolveIntersectionConnectTarget,
    ROAD_CONNECT_PREVIEW_DWELL_MS,
} from "../app/3d/editor/map/mapRoadConnect.js";
import {
    beginNodeDrag,
    finishNodeDrag,
    handleRoadPenClick,
    resolveRoadPenSnap,
} from "../app/3d/editor/map/MapToolLogic.js";

test.beforeEach(() => {
    resetDocumentIdCounter();
});

function polylineEdge(id, startNodeId, endNodeId) {
    return {
        id,
        startNodeId,
        endNodeId,
        bidirectional: true,
        width: 7,
        laneCount: 2,
        geometry: { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] },
    };
}

function connectDocument(extra = {}) {
    const document = new EnvironmentDocument({
        environmentId: "connect",
        roads: {
            geometryVersion: 2,
            nodes: [
                { id: "int-a", x: 0, y: 0, z: 0, kind: "intersection" },
                { id: "end-b", x: 20, y: 0, z: 0, kind: "endpoint" },
                { id: "int-c", x: 40, y: 0, z: 0, kind: "intersection" },
                ...(extra.nodes ?? []),
            ],
            edges: [
                polylineEdge("edge-1", "int-a", "end-b"),
                ...(extra.edges ?? []),
            ],
        },
        objects: extra.objects,
    });
    if (!extra.skipOverlay) document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    return document;
}

function editorData(document, editorOptions = {}) {
    const service = createEnvironmentCommandService({ document });
    const editor = new EditorState({
        map: { snapEnabled: false, snapSize: 1, zoom: 1, activeMapTool: MAP_TOOLS.SELECT, ...editorOptions.map },
    });
    const data = {
        editor: () => editor,
        commands: () => service.bus,
        selection: () => ({ select() {} }),
        simulation: () => ({ render() {} }),
        environment: () => ({
            getDocument: () => document,
            commands: () => service.bus,
            selection: () => ({ select() {} }),
            toolController: { roadAuthoringController: null },
        }),
    };
    const controller = new RoadAuthoringController({ data });
    data.environment = () => ({
        getDocument: () => document,
        commands: () => service.bus,
        selection: () => ({ select() {} }),
        toolController: { roadAuthoringController: controller },
    });
    return { document, service, editor, data, controller, bus: service.bus };
}

test("resolveIntersectionConnectTarget links a free endpoint to a nearby intersection", () => {
    const document = connectDocument();
    const hit = resolveIntersectionConnectTarget(document, { x: 39.2, z: 0.4 }, 3, { kind: "endpoint", nodeId: "end-b" });
    assert.deepEqual(hit, {
        intersectionId: "int-c",
        position: { x: 40, y: 0, z: 0 },
        edgeId: "edge-1",
        end: "end",
    });
});

test("resolveIntersectionConnectTarget rejects self-loops, duplicates, degree 4, and locked records", () => {
    const four = connectDocument({
        nodes: [
            { id: "n1", x: 40, y: 0, z: 10, kind: "endpoint" },
            { id: "n2", x: 40, y: 0, z: -10, kind: "endpoint" },
            { id: "n3", x: 50, y: 0, z: 0, kind: "endpoint" },
            { id: "n4", x: 30, y: 0, z: 0, kind: "endpoint" },
        ],
        edges: [
            polylineEdge("e-n", "int-c", "n1"),
            polylineEdge("e-s", "int-c", "n2"),
            polylineEdge("e-e", "int-c", "n3"),
            polylineEdge("e-w", "int-c", "n4"),
        ],
    });
    assert.equal(resolveIntersectionConnectTarget(four, { x: 40, z: 0 }, 3, { kind: "endpoint", nodeId: "end-b" }), null);

    const loop = connectDocument();
    assert.equal(resolveIntersectionConnectTarget(loop, { x: 0, z: 0 }, 3, { kind: "endpoint", nodeId: "end-b" }), null, "other end is excluded");

    const duplicate = connectDocument({
        edges: [polylineEdge("edge-ac", "int-a", "int-c")],
    });
    assert.equal(resolveIntersectionConnectTarget(duplicate, { x: 40, z: 0 }, 3, { kind: "endpoint", nodeId: "end-b" }), null);

    const locked = connectDocument({
        objects: [
            { id: "int-c", typeId: "intersection", typeVersion: 1, name: "C", parentId: null, order: 0, components: { tags: [], locked: true, editorHidden: false } },
        ],
        skipOverlay: true,
    });
    assert.equal(resolveIntersectionConnectTarget(locked, { x: 40, z: 0 }, 3, { kind: "endpoint", nodeId: "end-b" }), null);
});

test("resolveIntersectionConnectTarget ignores intersection nodes even at degree one", () => {
    const document = connectDocument();
    assert.equal(resolveIntersectionConnectTarget(document, { x: 40, z: 0 }, 3, { kind: "endpoint", nodeId: "int-a" }), null);
});

test("resolveIntersectionConnectTarget for a stroke excludes the start node", () => {
    const document = connectDocument();
    assert.equal(resolveIntersectionConnectTarget(document, { x: 0, z: 0 }, 3, { kind: "stroke", startNodeId: "int-a" }), null);
    const hit = resolveIntersectionConnectTarget(document, { x: 40, z: 0 }, 3, { kind: "stroke", startNodeId: "int-a" });
    assert.equal(hit.intersectionId, "int-c");
    assert.equal(hit.edgeId, null);
});

test("advanceConnectPreview arms only after the dwell and resets on a new candidate", () => {
    const first = advanceConnectPreview(null, "int-c", 1000);
    assert.equal(first.armed, false);
    const waiting = advanceConnectPreview(first.state, "int-c", 1000 + ROAD_CONNECT_PREVIEW_DWELL_MS - 1);
    assert.equal(waiting.armed, false);
    const armed = advanceConnectPreview(waiting.state, "int-c", 1000 + ROAD_CONNECT_PREVIEW_DWELL_MS);
    assert.equal(armed.armed, true);
    assert.equal(armed.intersectionId, "int-c");
    const moved = advanceConnectPreview(armed.state, "int-a", 2000);
    assert.equal(moved.armed, false);
    const left = advanceConnectPreview(armed.state, null, 2000);
    assert.equal(left.state, null);
    assert.equal(left.armed, false);
});

test("endpointNodeIdForSub maps start/end knots onto topology nodes", () => {
    const document = connectDocument();
    assert.equal(endpointNodeIdForSub(document, { kind: "road-knot", edgeId: "edge-1", knotId: "end" }), "end-b");
    assert.equal(endpointNodeIdForSub(document, { kind: "road-knot", edgeId: "edge-1", knotId: "start" }), "int-a");
    assert.equal(endpointNodeIdForSub(document, { kind: "road-knot", edgeId: "edge-1", knotId: "k1" }), null);
    assert.equal(endpointNodeIdForSub(document, { kind: "road-handle", edgeId: "edge-1", knotId: "end" }), null);
});

test("finishNodeDrag on v2 cancels the move and connects in one undo step", () => {
    const { document, editor, data, bus } = editorData(connectDocument());
    const interaction = beginNodeDrag({ document, data, nodeId: "end-b", worldPoint: { x: 20, z: 0 } });
    assert.ok(interaction?.gestureId);
    const result = finishNodeDrag({ interaction, document, editor, data, worldPoint: { x: 39.5, z: 0.2 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.connected, true);
    assert.equal(document.getEdge("edge-1").endNodeId, "int-c");
    assert.equal(document.getNode("end-b"), null);
    assert.equal(bus.history.length, 1);
    assert.equal(bus.snapshot().history.at(-1), "Connect road endpoint");
    bus.undo();
    assert.equal(document.getEdge("edge-1").endNodeId, "end-b");
    assert.ok(document.getNode("end-b"));
});

test("finishNodeDrag without a target still commits an ordinary move", () => {
    const { document, editor, data, bus } = editorData(connectDocument());
    const interaction = beginNodeDrag({ document, data, nodeId: "end-b", worldPoint: { x: 20, z: 0 } });
    const result = finishNodeDrag({ interaction, document, editor, data, worldPoint: { x: 24, z: 2 } });
    assert.equal(result.ok, true);
    assert.equal(result.connected, false);
    assert.equal(document.getEdge("edge-1").endNodeId, "end-b");
    assert.equal(document.getNode("end-b").x, 24);
    assert.equal(bus.snapshot().history.at(-1), "Move road node");
});

test("road pen prefers an unsnapped intersection over the grid", () => {
    const { document, editor } = editorData(connectDocument(), { map: { snapEnabled: true, snapSize: 1, zoom: 2 } });
    const snap = resolveRoadPenSnap({
        worldPoint: { x: 11.6, z: 0 },
        document: new EnvironmentDocument({
            environmentId: "pen",
            roads: {
                geometryVersion: 2,
                nodes: [{ id: "int-c", x: 10.2, y: 0, z: 0, kind: "intersection" }],
                edges: [],
            },
        }),
        editor,
        draft: { type: "road-stroke", startNodeId: "start-free" },
    });
    assert.equal(snap.snapTarget.nodeId, "int-c");
    assert.equal(snap.point.x, 10.2);
});

test("road pen click finishing on an intersection reuses that node", () => {
    const document = new EnvironmentDocument({
        environmentId: "pen",
        roads: {
            geometryVersion: 2,
            nodes: [{ id: "int-c", x: 10.2, y: 0, z: 0, kind: "intersection" }],
            edges: [],
        },
    });
    document.replaceObjectGraph(deriveObjectGraph(document.snapshot()));
    const { editor, data, bus } = editorData(document, { map: { snapEnabled: true, snapSize: 1, zoom: 2, activeMapTool: MAP_TOOLS.ROAD_PEN } });
    handleRoadPenClick({ worldPoint: { x: 0, z: 0 }, document, editor, data });
    const finished = handleRoadPenClick({ worldPoint: { x: 11.6, z: 0 }, document, editor, data });
    assert.equal(finished.ok, true, JSON.stringify(finished));
    assert.equal(finished.result.edge.endNodeId, "int-c");
    assert.equal(bus.history.length, 1);
    assert.equal(editor.snapshot().roadDraft, null);
});
