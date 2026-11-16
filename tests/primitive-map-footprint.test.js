import assert from "node:assert/strict";
import test from "node:test";

import { pickMapTarget, primitiveMapFootprint } from "../app/3d/editor/map/mapHitTest.js";

function span(points, axis) {
    const values = points.map((point) => point[axis]);
    return Math.max(...values) - Math.min(...values);
}

function wall(overrides = {}) {
    return {
        id: "wall",
        shape: "box",
        position: { x: 0, y: 0.15, z: 0 },
        rotationY: 0,
        size: { x: 0.1, y: 0.3, z: 8 },
        ...overrides,
    };
}

function snapshot(primitives) {
    return { roads: { nodes: [], edges: [] }, buildings: [], features: [], primitives };
}

const layers = { props: true, roads: true, buildings: true, detail: true };

test("a thin box keeps its rectangle", () => {
    const footprint = primitiveMapFootprint(wall());
    assert.equal(footprint.kind, "polygon");
    assert.ok(Math.abs(span(footprint.points, "x") - 0.1) < 1e-9);
    assert.ok(Math.abs(span(footprint.points, "z") - 8) < 1e-9);
});

test("a quarter turn swaps the box axes", () => {
    const footprint = primitiveMapFootprint(wall({ rotationY: Math.PI / 2 }));
    assert.ok(Math.abs(span(footprint.points, "x") - 8) < 1e-9);
    assert.ok(Math.abs(span(footprint.points, "z") - 0.1) < 1e-9);
});

test("sphere, cylinder, and cone are circles of diameter size.x", () => {
    for (const shape of ["sphere", "cylinder", "cone"]) {
        assert.deepEqual(
            primitiveMapFootprint({ id: shape, shape, position: { x: 1, z: 2 }, size: { x: 3, y: 4, z: 9 } }),
            { kind: "circle", center: { x: 1, z: 2 }, radius: 1.5 },
        );
    }
});

test("a pyramid is its base rectangle", () => {
    const footprint = primitiveMapFootprint({
        id: "py",
        shape: "pyramid",
        position: { x: 0, z: 0 },
        rotationY: 0,
        size: { x: 2, y: 5, z: 4 },
    });
    assert.equal(footprint.kind, "polygon");
    assert.ok(Math.abs(span(footprint.points, "x") - 2) < 1e-9);
    assert.ok(Math.abs(span(footprint.points, "z") - 4) < 1e-9);
});

test("a point on the wall hits and a point beside it misses", () => {
    const document = snapshot([wall()]);
    const viewport = { zoom: 8 };
    assert.deepEqual(pickMapTarget({ x: 0, z: 3 }, document, viewport, layers), { type: "primitive", id: "wall" });
    assert.equal(pickMapTarget({ x: 2, z: 0 }, document, viewport, layers), null);
    assert.deepEqual(pickMapTarget({ x: 0.3, z: 0 }, document, viewport, layers), { type: "primitive", id: "wall" });
});

test("the nearer center wins when a post sits on the wall", () => {
    const document = snapshot([
        wall(),
        { id: "post", shape: "box", position: { x: 0, y: 0.1, z: 1 }, rotationY: 0, size: { x: 0.2, y: 0.2, z: 0.2 } },
    ]);
    assert.deepEqual(
        pickMapTarget({ x: 0, z: 1 }, document, { zoom: 8 }, layers),
        { type: "primitive", id: "post" },
    );
});
