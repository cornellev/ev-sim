import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import {
    addRoadEdge,
    computeArmPoint,
    createIntersectionNode,
    documentToRoadNetworkInputs,
    getOrCreateNode,
    moveRoadNode,
    setRoadNodeElevation,
} from "../app/3d/editor/document/documentMutations.js";
import {
    findDocumentConflicts,
    roadCorridorYRange,
    yRangesOverlap,
} from "../app/3d/editor/document/documentGeometry.js";
import { Road } from "../app/3d/city/Road.js";
import { Intersection } from "../app/3d/city/Intersection.js";
import Unit from "../app/util/Unit.js";
import { hashEnvironmentRoadNetwork } from "../app/scenarios/route/roadGraph.js";
import { createWorldDescription } from "../app/simulation/world/WorldDescription.js";
import { createLidarGeometry } from "../app/simulation/lidar/LidarGeometry.js";

test("cloneNode round-trips y and defaults missing y to 0", () => {
    const withY = new EnvironmentDocument({
        roads: {
            nodes: [{ id: "a", x: 1, y: 2.5, z: 3 }],
            edges: [],
        },
    });
    assert.equal(withY.snapshot().roads.nodes[0].y, 2.5);

    const withoutY = new EnvironmentDocument({
        roads: {
            nodes: [{ id: "b", x: 0, z: 0 }],
            edges: [],
        },
    });
    assert.equal(withoutY.snapshot().roads.nodes[0].y, 0);
});

test("omitted y and explicit y:0 share the same roadNetworkHash", () => {
    const omitted = {
        environmentId: "hash-test",
        roads: {
            nodes: [
                { id: "a", x: 0, z: 0 },
                { id: "b", x: 10, z: 0 },
            ],
            edges: [{
                id: "e1",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
                width: 7,
                laneCount: 2,
            }],
        },
    };
    const explicit = {
        environmentId: "hash-test",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0 },
                { id: "b", x: 10, y: 0, z: 0 },
            ],
            edges: omitted.roads.edges,
        },
    };
    assert.equal(hashEnvironmentRoadNetwork(omitted), hashEnvironmentRoadNetwork(explicit));
});

test("documentToRoadNetworkInputs preserves nonzero node y", () => {
    const document = new EnvironmentDocument({
        roads: {
            nodes: [
                { id: "a", x: 0, y: 1.5, z: 0 },
                { id: "b", x: 20, y: 4, z: 0 },
            ],
            edges: [{
                id: "e1",
                startNodeId: "a",
                endNodeId: "b",
                bidirectional: true,
            }],
        },
    });
    const { vectorMap } = documentToRoadNetworkInputs(document);
    assert.equal(vectorMap.get("a").y, 1.5);
    assert.equal(vectorMap.get("b").y, 4);
});

test("computeArmPoint copies junction elevation", () => {
    const arm = computeArmPoint({ x: 0, y: 3, z: 0 }, { x: 20, y: 0, z: 0 }, 5);
    assert.equal(arm.y, 3);
    assert.ok(Math.abs(arm.x - 5) < 1e-9);
});

test("setRoadNodeElevation updates intersections without moving xz", () => {
    const document = new EnvironmentDocument({ environmentId: "elev" });
    const node = createIntersectionNode(document, { x: 5, z: -2 });
    assert.equal(node.y, 0);
    const result = setRoadNodeElevation(document, node.id, 2.25);
    assert.equal(result.ok, true);
    assert.equal(document.getNode(node.id).x, 5);
    assert.equal(document.getNode(node.id).z, -2);
    assert.equal(document.getNode(node.id).y, 2.25);
});

test("moveRoadNode preserves elevation unless point.y is supplied", () => {
    const document = new EnvironmentDocument({ environmentId: "elev" });
    const a = getOrCreateNode(document, { x: 0, y: 1.2, z: 0 }, 0.1);
    getOrCreateNode(document, { x: 10, z: 0 }, 0.1);
    addRoadEdge(document, a.id, document.roads.nodes[1].id);
    moveRoadNode(document, a.id, { x: 1, z: 1 });
    assert.equal(document.getNode(a.id).y, 1.2);
    moveRoadNode(document, a.id, { x: 2, y: 4, z: 2 });
    assert.equal(document.getNode(a.id).y, 4);
});

test("snapping to an existing node keeps the existing elevation", () => {
    const document = new EnvironmentDocument({ environmentId: "elev" });
    const existing = getOrCreateNode(document, { x: 0, y: 7, z: 0 }, 0.1);
    const snapped = getOrCreateNode(document, { x: 0.2, y: 99, z: 0.1 }, 1);
    assert.equal(snapped.id, existing.id);
    assert.equal(snapped.y, 7);
});

test("grade-separated crossings are not road-crossing conflicts", () => {
    const document = new EnvironmentDocument({ environmentId: "overpass" });
    const a = getOrCreateNode(document, { x: 0, y: 0, z: 0 }, 0.1);
    const b = getOrCreateNode(document, { x: 20, y: 0, z: 20 }, 0.1);
    const c = getOrCreateNode(document, { x: 0, y: 8, z: 20 }, 0.1);
    const d = getOrCreateNode(document, { x: 20, y: 8, z: 0 }, 0.1);
    assert.equal(addRoadEdge(document, a.id, b.id).ok, true);
    assert.equal(addRoadEdge(document, c.id, d.id).ok, true);

    const conflicts = findDocumentConflicts(document);
    assert.equal(conflicts.some((conflict) => conflict.kind === "road-crossing"), false);

    const coplanar = new EnvironmentDocument({ environmentId: "coplanar" });
    const e = getOrCreateNode(coplanar, { x: 0, z: 0 }, 0.1);
    const f = getOrCreateNode(coplanar, { x: 20, z: 20 }, 0.1);
    const g = getOrCreateNode(coplanar, { x: 0, z: 20 }, 0.1);
    const h = getOrCreateNode(coplanar, { x: 20, z: 0 }, 0.1);
    addRoadEdge(coplanar, e.id, f.id);
    addRoadEdge(coplanar, g.id, h.id);
    assert.ok(findDocumentConflicts(coplanar).some((conflict) => conflict.kind === "road-crossing"));
});

test("roadCorridorYRange and yRangesOverlap", () => {
    const low = roadCorridorYRange({ y: 0 }, { y: 0 });
    const high = roadCorridorYRange({ y: 5 }, { y: 5 });
    assert.equal(yRangesOverlap(low, high), false);
    assert.equal(yRangesOverlap(low, roadCorridorYRange({ y: 0 }, { y: 0.1 })), true);
});

test("Road mesh follows centerline elevation with paint offset", () => {
    const scene = new THREE.Scene();
    const road = new Road([
        new THREE.Vector3(0, 2, 0),
        new THREE.Vector3(10, 4, 0),
    ], new Unit(4, Unit.Type.METER));
    road.setup(scene);
    assert.ok(road.roadEdges);
    assert.ok(Math.abs(road.roadEdges.left[0].y - (2 + road.options.elevation)) < 1e-6);
    const last = road.roadEdges.left.length - 1;
    assert.ok(Math.abs(road.roadEdges.left[last].y - (4 + road.options.elevation)) < 1e-6);
});

test("Intersection fill sits at junction elevation, not absolute -0.01", () => {
    const scene = new THREE.Scene();
    const roadA = new Road([
        new THREE.Vector3(-10, 3, 0),
        new THREE.Vector3(-1, 3, 0),
    ], new Unit(4, Unit.Type.METER));
    const roadB = new Road([
        new THREE.Vector3(1, 3, 0),
        new THREE.Vector3(10, 3, 0),
    ], new Unit(4, Unit.Type.METER));
    const roadC = new Road([
        new THREE.Vector3(0, 3, -10),
        new THREE.Vector3(0, 3, -1),
    ], new Unit(4, Unit.Type.METER));
    roadA.setup(scene);
    roadB.setup(scene);
    roadC.setup(scene);

    const intersection = new Intersection([roadA, roadB, roadC]);
    intersection.setup(scene);

    const surface = intersection.root.getObjectByName("IntersectionSurface");
    assert.ok(surface);
    const positions = surface.geometry.getAttribute("position");
    assert.ok(positions.count > 0);
    for (let i = 0; i < positions.count; i++) {
        assert.ok(Math.abs(positions.getY(i) - 2.99) < 1e-6);
    }
    assert.ok(intersection.triangles.length > 0);
    assert.ok(Math.abs(intersection.triangles[0].a.y - 2.99) < 1e-6);
});

test("headless LiDAR corridor slopes with endpoint elevations", () => {
    const flatWorld = createWorldDescription({
        environmentId: "lidar-flat",
        document: {
            roadsAuthored: true,
            roads: {
                nodes: [
                    { id: "a", x: 0, y: 0, z: 0 },
                    { id: "b", x: 10, y: 0, z: 0 },
                ],
                edges: [{
                    id: "e1",
                    startNodeId: "a",
                    endNodeId: "b",
                    width: 4,
                    laneCount: 2,
                    bidirectional: true,
                }],
            },
            buildings: [],
            features: [],
        },
    });
    const rampWorld = createWorldDescription({
        environmentId: "lidar-ramp",
        document: {
            roadsAuthored: true,
            roads: {
                nodes: [
                    { id: "a", x: 0, y: 0, z: 0 },
                    { id: "b", x: 10, y: 5, z: 0 },
                ],
                edges: [{
                    id: "e1",
                    startNodeId: "a",
                    endNodeId: "b",
                    width: 4,
                    laneCount: 2,
                    bidirectional: true,
                }],
            },
            buildings: [],
            features: [],
        },
    });

    const flat = createLidarGeometry(flatWorld);
    const ramp = createLidarGeometry(rampWorld);
    const flatRoad = flat.staticPrimitives.filter((entry) => entry.sourceId === "e1");
    const rampRoad = ramp.staticPrimitives.filter((entry) => entry.sourceId === "e1");
    assert.ok(flatRoad.every((tri) => tri.vertices.every((vertex) => vertex.y === 0)));
    const rampYs = [...new Set(rampRoad.flatMap((tri) => tri.vertices.map((vertex) => vertex.y)))].sort();
    assert.deepEqual(rampYs, [0, 5]);
});
