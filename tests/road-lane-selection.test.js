import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { createEditorPresentationRegistry } from "../app/3d/editor/presentation/EditorPresentationRegistry.js";
import { BUILTIN_SECTION_PROVIDERS, SECTION_KINDS, roadDisplayModel } from "../app/3d/editor/presentation/builtinSections.js";
import { SelectionStore, normalizeSub } from "../app/3d/editor/selection/SelectionStore.js";
import { entityIdForSub, mapSelectionFromSelection, subForEntity, typeIdForEntityKind } from "../app/3d/editor/selection/selectionIds.js";
import { pickMapTarget } from "../app/3d/editor/map/mapHitTest.js";

const polyline = { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] };
const ASYMMETRIC_LANES = [
    { id: "lane-0", direction: 1, width: 3.5, markingLeft: "dashed_white" },
    { id: "lane-1", direction: 1, width: 3.5 },
    { id: "lane-2", direction: -1, width: 4 },
];

function laneDocument() {
    const document = new EnvironmentDocument({
        environmentId: "lane-selection",
        roads: {
            geometryVersion: 2,
            nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 60, y: 0, z: 0 }],
            edges: [
                { id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 11, laneCount: 3, shoulderWidth: 1, geometry: polyline, lanes: ASYMMETRIC_LANES, borderLeft: "solid_yellow" },
                { id: "cd", startNodeId: "c", endNodeId: "d", bidirectional: true, width: 7, laneCount: 2, geometry: polyline },
            ].filter((edge) => edge.id === "ab"),
        },
    });
    // Object records so the presentation registry can resolve the road.
    createEnvironmentCommandService({ document });
    return document;
}

test("ED-05 the road-display section is a pure cross-section descriptor emitted for every road", () => {
    const document = laneDocument();
    const registry = createEditorPresentationRegistry();
    for (const [typeId, getInspectorSections] of Object.entries(BUILTIN_SECTION_PROVIDERS)) registry.register(typeId, { getInspectorSections });
    const record = { id: "ab", typeId: "road", typeVersion: 1, name: "Road", parentId: null, order: 0, components: {} };
    const sections = registry.forRecord(record).getInspectorSections({ record, document });
    const display = sections.find((section) => section.kind === SECTION_KINDS.ROAD_DISPLAY);
    assert.ok(display, "roads get the lane diagram");
    assert.equal(display.title, "Lanes");
    assert.equal(display.edgeId, "ab");
    assert.equal(display.explicit, true);
    assert.equal(display.geometryVersion, 2);
    assert.equal(display.width, 11);
    assert.equal(display.shoulderWidth, 1);
    assert.deepEqual(display.lanes.map((lane) => [lane.id, lane.index, lane.direction, lane.width, lane.offset]), [
        ["lane-0", 0, 1, 3.5, 3.75],
        ["lane-1", 1, 1, 3.5, 0.25],
        ["lane-2", 2, -1, 4, -3.5],
    ]);
    assert.deepEqual(display.dividers.map((divider) => [divider.dividerIndex, divider.opposing, divider.marking]), [[1, false, "dashed_white"], [2, true, null]]);
    assert.deepEqual(display.borders, { left: "solid_yellow", right: null });
    const order = sections.map((section) => section.kind);
    assert.ok(order.indexOf(SECTION_KINDS.ROAD_DISPLAY) < order.indexOf(SECTION_KINDS.ROAD_ENDPOINTS), "the diagram precedes endpoints and geometry");

    const implicit = roadDisplayModel({ id: "x", width: 7, laneCount: 2, bidirectional: true });
    assert.equal(implicit.explicit, false);
    assert.deepEqual(implicit.lanes.map((lane) => [lane.id, lane.direction, lane.offset]), [["lane-0", 1, 1.75], ["lane-1", -1, -1.75]]);
    assert.deepEqual(implicit.dividers.map((divider) => [divider.opposing, divider.marking]), [[true, null]]);
});

test("ED-05 lane sub-selection is a distinct selection kind that survives normalization and comparison", () => {
    assert.deepEqual(normalizeSub({ kind: "road-lane", edgeId: "ab", laneId: "lane-1" }), { kind: "road-lane", edgeId: "ab", laneId: "lane-1" });
    assert.equal(normalizeSub({ kind: "road-lane", edgeId: "ab" }), null, "a lane sub needs its lane id");
    const store = new SelectionStore({ now: () => 0 });
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });
    store.select("ab", { sub: { kind: "road-lane", edgeId: "ab", laneId: "lane-0" } });
    const afterFirst = notifications;
    store.select("ab", { sub: { kind: "road-lane", edgeId: "ab", laneId: "lane-1" } });
    assert.equal(notifications, afterFirst + 1, "selecting a different lane on the same road is a change");
    assert.equal(store.sub.laneId, "lane-1");
    store.select("ab", { sub: { kind: "road-lane", edgeId: "ab", laneId: "lane-1" } });
    assert.equal(notifications, afterFirst + 1, "reselecting the same lane is a no-op");
    store.prune(["cd"]);
    assert.equal(store.sub, null, "the lane sub is dropped with its road");

    assert.equal(entityIdForSub({ kind: "road-lane", edgeId: "ab", laneId: "lane-1" }), "road-lane:ab:lane-1");
    assert.deepEqual(subForEntity({ kind: "road-lane", edgeId: "ab", laneId: "lane-1" }), { kind: "road-lane", edgeId: "ab", laneId: "lane-1" });
    assert.equal(typeIdForEntityKind("road-lane"), "road");
    assert.deepEqual(
        mapSelectionFromSelection({ ids: ["ab"], primary: "ab", sub: { kind: "road-lane", edgeId: "ab", laneId: "lane-2" } }, laneDocument()),
        { type: "road", id: "ab", sub: { kind: "road-lane", edgeId: "ab", laneId: "lane-2" } },
    );
});

test("ED-05 a map click on an already selected road picks its lane by lateral offset", () => {
    const snapshot = laneDocument().snapshot();
    const viewport = { centerX: 30, centerZ: 0, zoom: 1 };
    const layers = { roads: true, buildings: false, props: false, detail: true, selectedRoadId: "ab" };
    const reverse = pickMapTarget({ x: 30, z: -3.4 }, snapshot, viewport, layers);
    assert.deepEqual(reverse, { type: "road", id: "ab", sub: { kind: "road-lane", edgeId: "ab", laneId: "lane-2" } });
    const inner = pickMapTarget({ x: 30, z: 0.3 }, snapshot, viewport, layers);
    assert.equal(inner.sub.laneId, "lane-1");
    const outer = pickMapTarget({ x: 30, z: 3.6 }, snapshot, viewport, layers);
    assert.equal(outer.sub.laneId, "lane-0");
    const shoulder = pickMapTarget({ x: 30, z: 6 }, snapshot, viewport, layers);
    assert.deepEqual(shoulder, { type: "road", id: "ab" }, "the paved shoulder selects the road, not a lane");
    const unselected = pickMapTarget({ x: 30, z: 0.3 }, snapshot, viewport, { ...layers, selectedRoadId: null });
    assert.deepEqual(unselected, { type: "road", id: "ab" }, "the first click selects the road itself");
});
