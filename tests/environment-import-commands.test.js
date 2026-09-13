import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { applyRoadImport } from "../app/3d/editor/commands/importCommands.js";
import { splitRoad } from "../app/3d/editor/commands/roadCommands.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";

function draft(importId = "fixture", { empty = false } = {}) {
    return {
        importId,
        roads: {
            geometryVersion: 2,
            nodes: empty ? [] : [
                { id: "a", x: 10, y: 0, z: 0, source: { providerId: "overpass", importId, osmNodeId: "1", layer: 0, bridge: false, tunnel: false } },
                { id: "b", x: 20, y: 0, z: 0, source: { providerId: "overpass", importId, osmNodeId: "2", layer: 0, bridge: false, tunnel: false } },
            ],
            edges: empty ? [] : [{
                id: "edge", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2, bidirectional: true,
                geometry: { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] },
                source: { providerId: "overpass", importId, osmWayId: "10", layer: 0, bridge: false, tunnel: false },
            }],
            turnRules: [],
        },
        issues: [],
    };
}

function legacyDocument() {
    return new EnvironmentDocument({
        environmentId: "import",
        roads: {
            nodes: [{ id: "old-a", x: 0, z: 0 }, { id: "old-b", x: 5, z: 0 }],
            edges: [{ id: "old-edge", startNodeId: "old-a", endNodeId: "old-b", width: 7, laneCount: 2, bidirectional: true }],
            turnRules: [],
        },
        buildings: [{ buildingId: "building", footprint: [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }], height: 3 }],
    });
}

test("ED-08 Add upgrades legacy geometry, namespaces IDs, and commits one exact history entry", () => {
    const document = legacyDocument();
    const service = createEnvironmentCommandService({ document });
    const before = document.snapshot();
    const result = service.bus.execute(applyRoadImport({ expectedDocumentVersion: document.version, draft: draft(), mode: "add" }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.result.upgradedLegacyRoads, true);
    assert.equal(document.roads.geometryVersion, 2);
    assert.equal(document.roads.edges.length, 2);
    assert.match(document.roads.edges[1].id, /^import:fixture:/);
    assert.equal(document.roads.edges[1].startNodeId === "old-b", false, "Add never auto-connects by proximity");
    assert.equal(service.bus.history.length, 1);
    assert.equal(service.bus.undo().ok, true);
    assert.deepEqual(document.snapshot(), before);
});

test("ED-08 Replace swaps the complete road domain and preserves other authored domains", () => {
    const document = legacyDocument();
    const service = createEnvironmentCommandService({ document });
    const building = structuredClone(document.buildings);
    const replacement = draft("replace");
    replacement.roads.turnRules = [{ nodeId: "a", fromEdgeId: "edge", toEdgeId: "edge", allowed: false }];
    const result = service.bus.execute(applyRoadImport({ expectedDocumentVersion: 0, draft: replacement, mode: "replace" }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.deepEqual(document.roads.turnRules, replacement.roads.turnRules);
    assert.deepEqual(document.buildings, building);
    assert.equal(document.getEdge("old-edge"), null);
});

test("ED-08 stale, invalid, and implicit empty replacement attempts are atomic", () => {
    const document = legacyDocument();
    const service = createEnvironmentCommandService({ document });
    const before = document.snapshot();
    document.notify();
    let result = service.bus.execute(applyRoadImport({ expectedDocumentVersion: 0, draft: draft(), mode: "replace" }));
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, "command.document.stale");
    assert.deepEqual(document.snapshot(), before);

    result = service.bus.execute(applyRoadImport({ expectedDocumentVersion: document.version, draft: draft("empty", { empty: true }), mode: "replace" }));
    assert.equal(result.ok, false);
    assert.match(result.error, /explicit confirmation/i);
    assert.deepEqual(document.snapshot(), before);

    const invalid = draft();
    invalid.issues.push({ path: ["roads"], code: "fixture.invalid", message: "bad topology", severity: "error" });
    result = service.bus.execute(applyRoadImport({ expectedDocumentVersion: document.version, draft: invalid, mode: "add" }));
    assert.equal(result.ok, false);
    assert.deepEqual(document.snapshot(), before);
});

test("ED-08 explicit empty Replace and tiles-only source changes remain undoable", () => {
    const document = legacyDocument();
    const service = createEnvironmentCommandService({ document });
    let result = service.bus.execute(applyRoadImport({
        expectedDocumentVersion: 0, draft: draft("empty", { empty: true }), mode: "replace", allowEmptyReplace: true,
    }));
    assert.equal(result.ok, true);
    assert.equal(document.roads.edges.length, 0);
    service.bus.undo();
    assert.equal(document.roads.edges.length, 1);

    const source = { anchor: { lat: 1, lng: 2 }, bounds: { north: 1.01, south: 0.99, east: 2.01, west: 1.99 }, tileProvider: "google-photorealistic", roadProvider: null, importedLayerIds: ["google-earth-tiles"], importedAt: null };
    result = service.bus.execute(applyRoadImport({
        expectedDocumentVersion: document.version, includeRoads: false, draft: null, mode: "add", source,
    }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(document.roads.edges.length, 1);
    assert.deepEqual(document.earth, source);
});

test("ED-08 road editing preserves imported provenance across a topology split", () => {
    const document = new EnvironmentDocument({ environmentId: "split" });
    const service = createEnvironmentCommandService({ document });
    assert.equal(service.bus.execute(applyRoadImport({ expectedDocumentVersion: 0, draft: draft(), mode: "replace" })).ok, true);
    const sourceEdge = document.roads.edges[0];
    const result = service.bus.execute(splitRoad({ edgeId: sourceEdge.id, at: { span: 0, u: 0.5 } }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const splitNode = document.getNode(result.result.node.id);
    assert.equal(splitNode.source.providerId, "overpass");
    assert.equal(splitNode.source.importId, "fixture");
    assert.match(splitNode.source.boundaryId, /^split:/);
    assert.ok(result.result.left.source.osmWayId);
    assert.ok(result.result.right.source.osmWayId);
});
