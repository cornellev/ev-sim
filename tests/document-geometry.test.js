import assert from "node:assert/strict";
import test from "node:test";

import {
    conflictsForNewEntities,
    findDocumentConflicts,
    footprintsOverlap,
    pointInFootprint,
    pointToSegmentDistance,
    roadCorridorFootprint,
    segmentDistance,
    segmentsIntersect,
} from "../app/3d/editor/document/documentGeometry.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import {
    addBuildingRectangle,
    addFeature,
    addRoadEdge,
    getOrCreateNode,
} from "../app/3d/editor/document/documentMutations.js";

test("segmentsIntersect detects proper crossings and shared endpoints", () => {
    assert.equal(
        segmentsIntersect({ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }, { x: 10, z: 0 }),
        true,
    );
    assert.equal(
        segmentsIntersect({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 0, z: 5 }, { x: 10, z: 5 }),
        false,
    );
    assert.equal(
        segmentsIntersect({ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 5, z: 0 }, { x: 15, z: 0 }),
        true,
    );
});

test("segmentDistance and pointToSegmentDistance", () => {
    assert.equal(pointToSegmentDistance({ x: 5, z: 3 }, { x: 0, z: 0 }, { x: 10, z: 0 }), 3);
    assert.ok(segmentDistance(
        { x: 0, z: 0 }, { x: 10, z: 0 },
        { x: 0, z: 4 }, { x: 10, z: 4 },
    ) === 4);
});

test("footprintsOverlap uses SAT for rectangles", () => {
    const a = [
        { x: 0, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
        { x: 4, y: 0, z: 4 },
        { x: 0, y: 0, z: 4 },
    ];
    const b = [
        { x: 2, y: 0, z: 2 },
        { x: 6, y: 0, z: 2 },
        { x: 6, y: 0, z: 6 },
        { x: 2, y: 0, z: 6 },
    ];
    const c = [
        { x: 10, y: 0, z: 10 },
        { x: 14, y: 0, z: 10 },
        { x: 14, y: 0, z: 14 },
        { x: 10, y: 0, z: 14 },
    ];
    assert.equal(footprintsOverlap(a, b), true);
    assert.equal(footprintsOverlap(a, c), false);
    assert.equal(pointInFootprint({ x: 2, z: 2 }, a), true);
    assert.equal(pointInFootprint({ x: 20, z: 20 }, a), false);
});

test("roadCorridorFootprint width produces expected span", () => {
    const footprint = roadCorridorFootprint({ x: 0, z: 0 }, { x: 10, z: 0 }, 4);
    assert.equal(footprint.length, 4);
    const zs = footprint.map((p) => p.z);
    assert.ok(Math.min(...zs) <= -2 && Math.max(...zs) >= 2);
});

test("findDocumentConflicts reports road crossings and building overlaps", () => {
    const document = new EnvironmentDocument({ environmentId: "test" });
    const a = getOrCreateNode(document, { x: 0, z: 0 }, 0.1);
    const b = getOrCreateNode(document, { x: 20, z: 20 }, 0.1);
    const c = getOrCreateNode(document, { x: 0, z: 20 }, 0.1);
    const d = getOrCreateNode(document, { x: 20, z: 0 }, 0.1);
    const edge1 = addRoadEdge(document, a.id, b.id);
    const edge2 = addRoadEdge(document, c.id, d.id);
    assert.equal(edge1.ok, true);
    assert.equal(edge2.ok, true);

    const roadConflicts = findDocumentConflicts(document);
    assert.ok(roadConflicts.some((conflict) => conflict.kind === "road-crossing"));

    const buildingA = addBuildingRectangle(document, { x: 0, z: 0 }, { x: 5, z: 5 }, { height: 8 });
    const buildingB = addBuildingRectangle(document, { x: 2, z: 2 }, { x: 7, z: 7 }, { height: 8 });
    assert.equal(buildingA.ok, true);
    assert.equal(buildingB.ok, true);

    const buildingConflicts = conflictsForNewEntities(document, {
        buildingIds: [buildingB.record.buildingId],
    });
    assert.ok(buildingConflicts.some((conflict) => conflict.kind === "building-overlap"));
});

test("object near road produces object-road-overlap feedback", () => {
    const document = new EnvironmentDocument({ environmentId: "test" });
    const a = getOrCreateNode(document, { x: 0, z: 0 }, 0.1);
    const b = getOrCreateNode(document, { x: 20, z: 0 }, 0.1);
    addRoadEdge(document, a.id, b.id, { width: 6 });
    const feature = addFeature(document, { type: "cone", x: 10, z: 0.5, tags: ["cone"] });
    assert.equal(feature.ok, true);

    const conflicts = conflictsForNewEntities(document, { featureIds: [feature.record.id] });
    assert.ok(conflicts.some((conflict) => conflict.kind === "object-road-overlap"));
});
