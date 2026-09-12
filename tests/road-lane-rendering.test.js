import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { roadDisplayModel } from "../app/3d/editor/presentation/builtinSections.js";
import { materializeCompiledRoadNetwork } from "../app/3d/city/RoadNetwork.js";
import { planRoadNetworkGeometry } from "../app/roads/RoadNetworkGeometry.js";

const polyline = { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] };
const ASYMMETRIC_LANES = [
    { id: "lane-0", direction: 1, width: 3.5 },
    { id: "lane-1", direction: 1, width: 3.5, markingLeft: "none" },
    { id: "lane-2", direction: -1, width: 4 },
];

function roads(lanes = ASYMMETRIC_LANES, extra = {}) {
    return {
        geometryVersion: 2,
        nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 60, y: 0, z: 0 }],
        edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 11, laneCount: 3, geometry: polyline, lanes, ...extra }],
    };
}

function markingsOf(road) {
    const markings = [];
    road.root.traverse((object) => { if (object.name === "RoadMarking") markings.push(object); });
    return markings;
}

test("ED-05 scene markings honor authored per-boundary styles and expose lane records to the runtime", () => {
    const scene = new THREE.Scene();
    const plan = planRoadNetworkGeometry(roads());
    const { roads: runtimeRoads } = materializeCompiledRoadNetwork(scene, plan);
    assert.equal(runtimeRoads.length, 1);
    const road = runtimeRoads[0];
    // Two borders plus the one opposing divider; lane-1's "none" removes the
    // same-direction divider that the preset would otherwise draw.
    assert.equal(markingsOf(road).length, 3);
    assert.equal(road.options.laneCount, 3);
    assert.deepEqual(road.options.lanes, ASYMMETRIC_LANES);
    assert.equal(road.laneMeshes.length, 3);
    assert.equal(road.lanes.length, 3);

    const defaults = materializeCompiledRoadNetwork(null, planRoadNetworkGeometry(roads([
        { id: "lane-0", direction: 1, width: 3.5 },
        { id: "lane-1", direction: 1, width: 3.5 },
        { id: "lane-2", direction: -1, width: 4 },
    ]))).roads[0];
    assert.equal(markingsOf(defaults).length, 4, "automatic styles draw every divider");

    const yellow = materializeCompiledRoadNetwork(null, planRoadNetworkGeometry(roads([
        { id: "lane-0", direction: 1, width: 3.5, markingLeft: "solid_yellow" },
        { id: "lane-1", direction: 1, width: 3.5 },
        { id: "lane-2", direction: -1, width: 4 },
    ]))).roads[0];
    const yellowMarkings = markingsOf(yellow).filter((mesh) => mesh.material.color.getHex() === 0xf0d25c);
    assert.equal(yellowMarkings.length, 2, "an authored yellow same-direction divider joins the automatic opposing one");

    const implicit = materializeCompiledRoadNetwork(null, planRoadNetworkGeometry(roads(undefined, { lanes: undefined, laneCount: 2, width: 7 }))).roads[0];
    assert.equal("lanes" in implicit.options, false, "implicit roads carry no lane records into the runtime");
    assert.equal(implicit.options.laneCount, 2);
});

test("ED-05 per-lane widths size the debug lane ribbons and the display model matches the runtime", () => {
    const plan = planRoadNetworkGeometry(roads());
    const road = materializeCompiledRoadNetwork(null, plan).roads[0];
    const ribbonHalfWidths = road.laneMeshes.map((mesh) => {
        const position = mesh.geometry.getAttribute("position");
        // Ribbons are strips of (left, right) pairs; the first pair spans the lane's 90 % width.
        const dz = Math.abs(position.getZ(0) - position.getZ(1));
        return dz / 2;
    });
    assert.ok(Math.abs(ribbonHalfWidths[0] - 3.5 * 0.45) < 1e-6);
    assert.ok(Math.abs(ribbonHalfWidths[2] - 4 * 0.45) < 1e-6);
    const model = roadDisplayModel(plan.edgeById.get("ab").edge);
    assert.deepEqual(model.lanes.map((lane) => lane.offset), [3.75, 0.25, -3.5]);
    assert.deepEqual(road.lanes.map((points) => points[0].z), [3.75, 0.25, -3.5], "runtime lane centerlines sit on the display model offsets");
});
