import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
    activeBuildingAllowsPoint,
    CoverageGrid,
    filterForSplatting,
    hitsToWorldPoints,
    sampleColor,
    srgbToLinearColor,
    worldToPixel,
} from "../app/3d/environment/visualization/LidarSplatProjector.js";
import {
    buildCenterSliverBounds,
    composeImageThroughMask,
    countMaskPixelsInSliver,
    pixelInSliver,
} from "../app/3d/environment/visualization/BakeImageMask.js";

const TAG_BUILDING = 1;

function makeLidarFrame({
    width = 2,
    height = 2,
    range = 10,
    hits = [],
}) {
    const data = new Float32Array(width * height * 4);
    const parsedHits = [];

    for (let i = 0; i < width * height; i += 1) {
        const hit = hits[i] ?? { hit: false };
        const base = i * 4;
        const intensity = hit.hit ? (hit.intensity ?? 0.5) : 0;
        data[base + 0] = intensity;
        data[base + 1] = (hit.tagId ?? 0) / 255;
        data[base + 2] = hit.objectKind ?? 0;
        data[base + 3] = hit.hit ? 1 : 0;

        parsedHits.push({
            hit: Boolean(hit.hit),
            distance: hit.hit ? (1 - intensity) * range : range,
            tagId: hit.tagId ?? 0,
            tagName: hit.tagName ?? "unknown",
        });
    }

    return {
        data,
        width,
        height,
        range,
        thetaRange: [-10, 10],
        phiRange: [-5, 5],
        hits: parsedHits,
    };
}

test("hitsToWorldPoints reconstructs a forward hit along camera -Z", () => {
    const frame = makeLidarFrame({
        width: 1,
        height: 1,
        hits: [{ hit: true, intensity: 0.5, tagId: TAG_BUILDING, tagName: "building" }],
    });
    frame.phiRange = [0, 0];
    frame.thetaRange = [0, 0];

    const points = hitsToWorldPoints(frame, {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
    });

    // The LiDAR forward axis is aligned to the camera's -Z view direction so
    // reconstructed hits land inside the camera frustum.
    assert.equal(points.length, 1);
    assert.ok(points[0].world.z < -4.5);
    assert.ok(Math.abs(points[0].world.x) < 0.01);
    assert.ok(Math.abs(points[0].world.y) < 0.01);
    assert.equal(points[0].tagName, "building");
});

test("a forward LiDAR hit projects to the camera image center", () => {
    const frame = makeLidarFrame({
        width: 1,
        height: 1,
        hits: [{ hit: true, intensity: 0.5, tagId: TAG_BUILDING, tagName: "building" }],
    });
    frame.phiRange = [0, 0];
    frame.thetaRange = [0, 0];

    // Camera at origin looking down -Z (identity rotation), matching the LiDAR.
    const extrinsics = {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        matrixWorld: new THREE.Matrix4().identity().elements,
    };
    const intrinsics = { width: 100, height: 50, fx: 50, fy: 50, cx: 50, cy: 25 };

    const [point] = hitsToWorldPoints(frame, extrinsics);
    const pixel = worldToPixel(point.world, intrinsics, extrinsics.matrixWorld);

    assert.ok(pixel, "forward hit should be visible to the camera");
    assert.equal(pixel.px, 50);
    assert.equal(pixel.py, 25);
});

test("filterForSplatting drops road and respects depth band", () => {
    const points = [
        { world: new THREE.Vector3(0, 0, 0), distance: 5, tagName: "building" },
        { world: new THREE.Vector3(1, 0, 0), distance: 5, tagName: "road" },
        { world: new THREE.Vector3(2, 0, 0), distance: 20, tagName: "building" },
    ];

    const filtered = filterForSplatting(points, {
        excludeTags: ["road"],
        bandNear: 0,
        bandFar: 15,
    });

    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tagName, "building");
});

test("worldToPixel projects a point in front of the camera", () => {
    const intrinsics = {
        width: 100,
        height: 50,
        fx: 50,
        fy: 50,
        cx: 50,
        cy: 25,
    };
    const matrixWorld = new THREE.Matrix4().makeTranslation(0, 0, 5).elements;

    const pixel = worldToPixel(
        new THREE.Vector3(0, 0, 0),
        intrinsics,
        matrixWorld,
    );

    assert.ok(pixel);
    assert.equal(pixel.px, 50);
    assert.equal(pixel.py, 25);
});

test("worldToPixel matches THREE.Vector3.project camera mapping", () => {
    const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100);
    camera.position.set(2, 1, 5);
    camera.rotation.set(0.05, -0.25, 0.02);
    camera.updateMatrixWorld(true);
    camera.updateProjectionMatrix();

    const width = 160;
    const height = 90;
    const fovRad = THREE.MathUtils.degToRad(camera.fov);
    const fy = (height / 2) / Math.tan(fovRad / 2);
    const fx = fy;
    const intrinsics = { width, height, fx, fy, cx: width / 2, cy: height / 2 };
    const world = new THREE.Vector3(1.2, 0.8, -3);

    const ours = worldToPixel(world, intrinsics, camera.matrixWorld.elements);
    const ndc = world.clone().project(camera);
    const expected = {
        px: Math.round(((ndc.x + 1) / 2) * width),
        py: Math.round(((ndc.y + 1) / 2) * height),
    };

    assert.deepEqual(ours, expected);
});

test("pinhole LiDAR reconstruction projects back to its frustum pixel center", () => {
    const frame = makeLidarFrame({
        width: 4,
        height: 2,
        hits: [
            { hit: false },
            { hit: false },
            { hit: false },
            { hit: false },
            { hit: false },
            { hit: false },
            { hit: true, intensity: 0.5, tagId: TAG_BUILDING, tagName: "building" },
            { hit: false },
        ],
    });
    frame.thetaRange = [-45, 45];
    frame.phiRange = [-30, 30];
    frame.projection = "pinhole";

    const extrinsics = {
        position: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        matrixWorld: new THREE.Matrix4().identity().elements,
    };
    const intrinsics = {
        width: 400,
        height: 200,
        fx: 200,
        fy: 200,
        cx: 200,
        cy: 100,
    };

    const [point] = hitsToWorldPoints(frame, extrinsics);
    const pixel = worldToPixel(point.world, intrinsics, extrinsics.matrixWorld);

    assert.ok(point.cameraPlane);
    assert.deepEqual(pixel, {
        px: Math.round(intrinsics.fx * point.cameraPlane.x + intrinsics.cx),
        py: Math.round(intrinsics.fy * point.cameraPlane.y + intrinsics.cy),
    });
});

test("CoverageGrid deduplicates nearby world points", () => {
    const grid = new CoverageGrid(1);
    const a = new THREE.Vector3(0.2, 0, 0.2);
    const b = new THREE.Vector3(1.8, 0, 1.8);

    assert.equal(grid.has(a), false);
    grid.add(a);
    assert.equal(grid.has(a), true);
    assert.equal(grid.has(b), false);
});

test("CoverageGrid.hasNeighbor rejects offset duplicates across voxels", () => {
    const grid = new CoverageGrid(0.25);
    grid.add(new THREE.Vector3(0, 0, 0));

    // A point one voxel away (drift from a different viewpoint) is treated as
    // already covered so it does not deposit an offset duplicate splat.
    assert.equal(grid.hasNeighbor(new THREE.Vector3(0.26, 0, 0)), true);
    // A point several voxels away is genuinely new.
    assert.equal(grid.hasNeighbor(new THREE.Vector3(1.0, 0, 0)), false);
});

test("sampleColor reads bottom-left origin RGBA", () => {
    const rgba = new Uint8Array([
        255, 0, 0, 255,
        0, 255, 0, 255,
    ]);
    const top = sampleColor(rgba, 1, 2, 0, 1);
    const bottom = sampleColor(rgba, 1, 2, 0, 0);

    assert.deepEqual(top, { r: 0, g: 1, b: 0 });
    assert.deepEqual(bottom, { r: 1, g: 0, b: 0 });
});

test("srgbToLinearColor converts for Spark", () => {
    const color = srgbToLinearColor({ r: 1, g: 0, b: 0 });
    assert.ok(color.r > 0.9);
    assert.equal(color.g, 0);
});

test("center sliver bounds admit only the configured middle band", () => {
    const bounds = buildCenterSliverBounds(10, { enabled: true, widthPx: 4 });

    assert.deepEqual(bounds, { enabled: true, xMin: 3, xMax: 7, width: 4 });
    assert.equal(pixelInSliver(2, bounds), false);
    assert.equal(pixelInSliver(3, bounds), true);
    assert.equal(pixelInSliver(6, bounds), true);
    assert.equal(pixelInSliver(7, bounds), false);
});

test("mask pre-check counts only update pixels inside the center sliver", () => {
    const mask = new Uint8Array(8 * 1 * 4);
    for (const x of [1, 3, 4, 6]) {
        const idx = x * 4;
        mask[idx + 0] = 255;
        mask[idx + 3] = 255;
    }

    const bounds = buildCenterSliverBounds(8, { enabled: true, widthPx: 2 });

    assert.equal(countMaskPixelsInSliver({ data: mask, width: 8, height: 1 }, bounds), 2);
    assert.equal(countMaskPixelsInSliver({ data: mask, width: 8, height: 1 }, {
        enabled: true,
        xMin: 6,
        xMax: 8,
    }), 1);
    assert.equal(countMaskPixelsInSliver({ data: mask, width: 8, height: 1 }, {
        enabled: true,
        xMin: 0,
        xMax: 1,
    }), 0);
});

test("composeImageThroughMask preserves original pixels outside the process mask", () => {
    const base = {
        data: new Uint8Array([
            10, 20, 30, 255,
            40, 50, 60, 255,
        ]),
        width: 2,
        height: 1,
        colorSpace: "srgb",
        source: "raw",
    };
    const processed = {
        data: new Uint8Array([
            100, 110, 120, 255,
            200, 210, 220, 255,
        ]),
        width: 2,
        height: 1,
        colorSpace: "srgb",
        source: "model",
    };
    const mask = {
        data: new Uint8Array([
            0, 0, 0, 0,
            255, 255, 255, 255,
        ]),
        width: 2,
        height: 1,
    };

    const composited = composeImageThroughMask(base, processed, mask);

    assert.deepEqual([...composited.data], [
        10, 20, 30, 255,
        200, 210, 220, 255,
    ]);
    assert.equal(composited.source, "model");
});

test("active building attribution rejects explicit wrong-building candidates", () => {
    assert.equal(activeBuildingAllowsPoint("building-a", "building-a"), true);
    assert.equal(activeBuildingAllowsPoint("building-a", null), true);
    assert.equal(activeBuildingAllowsPoint(null, "building-b"), true);
    assert.equal(activeBuildingAllowsPoint("building-a", "building-b"), false);
});
