import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { applyModelPlacement } from "../app/3d/vehicles/ModelPlacement.js";
import { pairTolerance } from "../app/vehicles/axle/standardAxle.js";
import { reviewModelWheelPair } from "../app/vehicles/axle/reviewModelWheels.js";
import {
    measurePlacedVehicleModel,
    wheelShapeFromBounds,
} from "../app/vehicles/model/measurePlacedVehicle.js";
import { buildBoxGlb, symmetricWheelParts, WHEEL_SIZE } from "./helpers/vehicle-wheel-glb.js";

const IDENTITY_MODEL = {
    scale: 1,
    rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
    offset: { x: 0, y: 0, z: 0 },
};

function close(actual, expected, epsilon = 1e-6) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected}, got ${actual}`);
}

function measureWheels(parts, { model = IDENTITY_MODEL, boundingBox = null, hiddenNodeIndices, fileName } = {}) {
    return measurePlacedVehicleModel({
        glbBytes: buildBoxGlb(parts),
        model,
        boundingBox,
        hiddenNodeIndices,
        fileName,
    });
}

test("symmetric wheel nodes share X Y radius and width and mirror Z", () => {
    const measured = measureWheels(symmetricWheelParts());
    const left = measured.nodes[0];
    const right = measured.nodes[1];
    close(left.center.x, 0.75);
    close(left.center.y, 0.25);
    close(left.center.z, 0.5);
    close(right.center.z, -0.5);
    close(left.radius, 0.25);
    close(left.width, 0.25);
    const review = reviewModelWheelPair({ left, right, axle: "front" });
    assert.equal(review.withinTolerance, true);
    assert.equal(review.maxAdjustment, 0);
    close(review.proposed.x, 0.75);
    close(review.proposed.z, 0.5);
    close(review.proposed.radius, 0.25);
    close(review.proposed.width, 0.25);
    assert.equal(review.proposed.steerable, true);
});

test("a 1e-6 vertex perturbation stays inside pair tolerance", () => {
    const parts = symmetricWheelParts();
    parts[1] = {
        ...parts[1],
        vertexDelta: { index: 1, axis: 0, delta: 1e-6 },
    };
    const measured = measureWheels(parts);
    const review = reviewModelWheelPair({
        left: measured.nodes[0],
        right: measured.nodes[1],
        axle: "front",
    });
    assert.equal(review.withinTolerance, true);
    assert.ok(review.maxAdjustment > 0);
    const shift = Math.abs(measured.nodes[0].center.x - measured.nodes[1].center.x);
    assert.ok(shift <= pairTolerance(measured.nodes[0].center.x, measured.nodes[1].center.x));
});

test("a wheel shift larger than pair tolerance blocks the pair", () => {
    const parts = symmetricWheelParts();
    parts[1] = { ...parts[1], center: { x: 0.875, y: 0.25, z: -0.5 } };
    const measured = measureWheels(parts);
    const review = reviewModelWheelPair({
        left: measured.nodes[0],
        right: measured.nodes[1],
        axle: "front",
    });
    assert.equal(review.withinTolerance, false);
    assert.equal(review.proposed, null);
    assert.ok(review.issues.some((entry) => entry.code === "vehicle.axle.asymmetric"));
});

test("the GLB file name and hidden node list do not move placement", () => {
    const parts = symmetricWheelParts();
    const named = measureWheels(parts, { fileName: "car.glb", hiddenNodeIndices: [] });
    const renamed = measureWheels(parts, { fileName: "renamed.glb", hiddenNodeIndices: [1] });
    assert.deepEqual(renamed.sceneBounds, named.sceneBounds);
    assert.deepEqual(renamed.placement.alignment, named.placement.alignment);
    assert.deepEqual(renamed.nodes.map((node) => node.center), named.nodes.map((node) => node.center));
});

test("a wheel rotated off the lateral axis reports radial asymmetry", () => {
    const quarter = Math.sin(Math.PI / 4);
    const measured = measureWheels([
        {
            name: "turned-wheel",
            center: { x: 0, y: 0, z: 0 },
            size: WHEEL_SIZE,
            rotation: [quarter, 0, 0, quarter],
        },
    ]);
    const wheel = measured.nodes[0];
    assert.ok(wheel.radialDelta > pairTolerance(wheel.size.x, wheel.size.y));
    const review = reviewModelWheelPair({ left: wheel, right: wheel, axle: "front" });
    assert.equal(review.withinTolerance, false);
    assert.ok(review.issues.some((entry) => entry.code === "vehicle.wheel.radial-asymmetry"));
});

test("analytical placement matches applyModelPlacement for the same box", () => {
    const glbBytes = buildBoxGlb([
        { name: "body", center: { x: 1, y: 0.5, z: 0 }, size: { x: 2, y: 1, z: 1 } },
    ]);
    const model = {
        scale: 1,
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        offset: { x: 0.1, y: 0, z: -0.2 },
    };
    const boundingBox = { center: { x: 0, y: 0.7, z: 0 } };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
    mesh.geometry.translate(1, 0.5, 0);
    const alignment = applyModelPlacement(mesh, model, boundingBox);
    const measured = measurePlacedVehicleModel({ glbBytes, model, boundingBox });
    close(measured.placement.alignment.x, alignment.x);
    close(measured.placement.alignment.y, alignment.y);
    close(measured.placement.alignment.z, alignment.z);
    close(measured.sceneBounds.center.x, 0.1);
    close(measured.sceneBounds.center.y, 0.7);
    close(measured.sceneBounds.center.z, -0.2);
});

test("rotated placement matches THREE.Euler XYZ", () => {
    const glbBytes = buildBoxGlb([
        { name: "body", center: { x: 1, y: 0.5, z: 0 }, size: { x: 2, y: 1, z: 1 } },
    ]);
    const model = {
        scale: 1.5,
        rotation: { x: 0.2, y: -0.4, z: 0.1, order: "XYZ" },
        offset: { x: 0.1, y: 0, z: -0.2 },
    };
    const boundingBox = { center: { x: 0, y: 0.7, z: 0 } };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1));
    mesh.geometry.translate(1, 0.5, 0);
    const alignment = applyModelPlacement(mesh, model, boundingBox);
    const measured = measurePlacedVehicleModel({ glbBytes, model, boundingBox });
    close(measured.placement.alignment.x, alignment.x, 1e-5);
    close(measured.placement.alignment.y, alignment.y, 1e-5);
    close(measured.placement.alignment.z, alignment.z, 1e-5);
});

test("wheelShapeFromBounds reads width from Z and radius from the larger radial extent", () => {
    const shape = wheelShapeFromBounds({
        min: { x: -0.2, y: -0.25, z: -0.07 },
        max: { x: 0.2, y: 0.25, z: 0.08 },
    });
    close(shape.radius, 0.25);
    close(shape.width, 0.15);
    close(shape.center.z, 0.005);
    close(shape.radialDelta, 0.1);
});

test("sparse position accessors are rejected", async () => {
    const bytes = buildBoxGlb(symmetricWheelParts());
    const { readGlb, writeGlb } = await import("../app/simulation/visual/GlbContainer.js");
    const parsed = readGlb(bytes, {
        requireTotalLength: true,
        requireAligned: true,
        requireLeadingJson: true,
        json: "last",
        jsonPadding: "whitespace",
        copyChunks: true,
    });
    parsed.json.accessors[0].sparse = { count: 1, indices: { bufferView: 0, componentType: 5123 }, values: { bufferView: 0 } };
    const rewritten = writeGlb(parsed.json, parsed.bin);
    assert.throws(
        () => measurePlacedVehicleModel({ glbBytes: rewritten, model: IDENTITY_MODEL }),
        (error) => error.code === "vehicle.wheel.bounds-unavailable",
    );
});
