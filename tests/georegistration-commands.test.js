import assert from "node:assert/strict";
import test from "node:test";

import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { migrateGeoregistration, planGeoregistration } from "../app/3d/editor/commands/georegistrationCommands.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";

const EARTH = {
    anchor: { lat: 42.443, lng: -76.502 },
    bounds: { north: 42.448, south: 42.438, east: -76.497, west: -76.507 },
    tileProvider: "google-photorealistic", roadProvider: "overpass",
    importedLayerIds: ["google-earth-tiles"], importedAt: "2026-09-13T00:00:00.000Z",
};
const FRAME = { version: 1, projection: "wgs84-local-tangent", axes: "east-up-south", origin: { lat: 42.443, lng: -76.502, height: 0 } };

function legacyDocument() {
    return new EnvironmentDocument({
        environmentId: "legacy",
        earth: EARTH,
        roads: {
            geometryVersion: 2,
            nodes: [{ id: "a", x: 0, y: 3, z: 0 }, { id: "b", x: 20, y: 3, z: 10 }],
            edges: [{
                id: "road", startNodeId: "a", endNodeId: "b", width: 8, laneCount: 2, bidirectional: true,
                borderLeft: "solid_white", borderRight: "solid_yellow",
                lanes: [
                    { id: "forward", direction: 1, width: 4, markingLeft: "dashed_yellow" },
                    { id: "backward", direction: -1, width: 4 },
                ],
                geometry: {
                    version: 1, kind: "cubic-bezier",
                    knots: [
                        { id: "start", mode: "free", handleOut: { x: 5, y: 0, z: 0 } },
                        { id: "end", mode: "free", handleIn: { x: -5, y: 0, z: 0 } },
                    ],
                },
            }],
        },
        buildings: [{ buildingId: "building", footprint: [{ x: 1, z: 1 }, { x: 4, z: 1 }, { x: 4, z: 4 }], height: 6 }],
        features: [{ id: "prop", type: "cone", x: 2, z: 3, rotationY: 0.5 }],
    });
}

test("ED-08 roads-only georegistration previews a complete handedness conversion", () => {
    const document = legacyDocument();
    const originalBuilding = structuredClone(document.buildings[0]);
    const originalFeature = structuredClone(document.features[0]);
    const plan = planGeoregistration(document, { targetFrame: FRAME, scope: "roads" });
    assert.deepEqual(plan.issues, []);
    assert.equal(plan.statistics.convertedCurves, 1);
    assert.equal(plan.after.geoFrame.axes, "east-up-south");
    assert.equal(plan.after.earth.version, 2);
    assert.equal(Object.hasOwn(plan.after.earth, "anchor"), false);
    assert.equal(plan.after.roads.nodes[0].y, 3, "authored elevation is preserved");
    assert.equal(plan.after.roads.edges[0].geometry.kind, "polyline");
    assert.deepEqual(plan.after.roads.edges[0].lanes.map((lane) => lane.id), ["backward", "forward"]);
    assert.equal(plan.after.roads.edges[0].lanes[0].markingLeft, "dashed_yellow");
    assert.equal(plan.after.roads.edges[0].borderLeft, "solid_yellow");
    assert.deepEqual(plan.after.buildings[0], originalBuilding);
    assert.deepEqual(plan.after.features[0], originalFeature);
});

test("ED-08 whole-environment georegistration visits canonical records once and blocks locks", () => {
    const document = legacyDocument();
    document.objects.push({
        id: "group", typeId: "group", typeVersion: 1, name: "Group", parentId: null, order: 0,
        components: { tags: [], locked: false, editorHidden: false, transform: { position: { x: 5, y: 2, z: 6 }, rotationY: 0.25, scale: 1 } },
    });
    const plan = planGeoregistration(document, { targetFrame: FRAME, scope: "environment" });
    assert.deepEqual(plan.issues, []);
    assert.notDeepEqual(plan.after.buildings[0].footprint, document.buildings[0].footprint);
    assert.notEqual(plan.after.features[0].z, document.features[0].z);
    assert.equal(plan.after.objects[0].components.transform.position.y, 2);
    assert.equal(plan.after.objects[0].components.transform.scale, 1);

    document.objects[0].components.locked = true;
    const blocked = planGeoregistration(document, { targetFrame: FRAME, scope: "environment" });
    assert.equal(blocked.after, null);
    assert.equal(blocked.issues[0].objectId, "group");
});

test("ED-08 georegistration commits and restores exact snapshots through one command", () => {
    const document = legacyDocument();
    const service = createEnvironmentCommandService({ document });
    const before = document.snapshot();
    const plan = planGeoregistration(document, { targetFrame: FRAME, scope: "roads" });
    const result = service.bus.execute(migrateGeoregistration({ expectedDocumentVersion: document.version, plan }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const after = document.snapshot();
    assert.equal(service.bus.history.length, 1);
    assert.equal(service.bus.undo().ok, true);
    assert.deepEqual(document.snapshot(), before);
    assert.equal(service.bus.redo().ok, true);
    assert.deepEqual(document.snapshot(), after);
});

test("ED-08 georegistration rejects stale preview plans without mutation", () => {
    const document = legacyDocument();
    const service = createEnvironmentCommandService({ document });
    const plan = planGeoregistration(document, { targetFrame: FRAME, scope: "roads" });
    document.notify();
    const before = document.snapshot();
    const result = service.bus.execute(migrateGeoregistration({ expectedDocumentVersion: 0, plan }));
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].code, "command.document.stale");
    assert.deepEqual(document.snapshot(), before);
});
