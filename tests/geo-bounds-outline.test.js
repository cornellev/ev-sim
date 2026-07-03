import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { DEFAULT_EARTH_IMPORT_CONFIG } from "../app/3d/earth/EarthImportConfig.js";
import {
    computeOutlineVerticalRange,
    cornersToSamplePoints,
    createGeoBoundsOutlineGroup,
    geoBoundsToLocalCorners,
} from "../app/3d/earth/map/GeoBoundsOutlineGeometry.js";
import { sampleEarthTileElevation } from "../app/3d/earth/map/sampleEarthTileElevation.js";

const anchor = { lat: 42.443, lng: -76.502 };
const bounds = {
    north: 42.445,
    south: 42.441,
    east: -76.499,
    west: -76.505,
};

test("geoBoundsToLocalCorners places anchor near the bounds center", () => {
    const corners = geoBoundsToLocalCorners(bounds, anchor);
    const centerX = (corners.sw.x + corners.ne.x) / 2;
    const centerZ = (corners.sw.z + corners.ne.z) / 2;

    assert.ok(Math.abs(centerX) < 5);
    assert.ok(Math.abs(centerZ) < 5);
    assert.ok(corners.ne.x > corners.sw.x);
    assert.ok(corners.ne.z > corners.sw.z);
});

test("computeOutlineVerticalRange extends 100m above sampled tile elevation", () => {
    const range = computeOutlineVerticalRange({
        minY: 12,
        maxY: 180,
        sampled: true,
    });

    assert.equal(
        range.topY,
        180 + DEFAULT_EARTH_IMPORT_CONFIG.boundsOutlineClearanceMeters,
    );
    assert.equal(range.baseY, 0);
});

test("computeOutlineVerticalRange uses fallback height before tiles are sampled", () => {
    const range = computeOutlineVerticalRange({ sampled: false });
    assert.equal(range.baseY, 0);
    assert.equal(range.topY, 300);
});

test("sampleEarthTileElevation finds the highest tile intersection", () => {
    const tileRoot = new THREE.Group();
    const lowMesh = new THREE.Mesh(
        new THREE.BoxGeometry(10, 20, 10),
        new THREE.MeshBasicMaterial(),
    );
    lowMesh.position.set(0, 10, 0);
    const highMesh = new THREE.Mesh(
        new THREE.BoxGeometry(10, 80, 10),
        new THREE.MeshBasicMaterial(),
    );
    highMesh.position.set(5, 40, 5);
    tileRoot.add(lowMesh, highMesh);

    const elevation = sampleEarthTileElevation(tileRoot, [{ x: 5, z: 5 }]);
    assert.equal(elevation.sampled, true);
    assert.ok(elevation.maxY >= 79);
});

test("createGeoBoundsOutlineGroup tags preserved earth import metadata", () => {
    const group = createGeoBoundsOutlineGroup(bounds, anchor, { baseY: 0, topY: 250 });

    assert.equal(group.name, "EarthImportBoundsOutline");
    assert.equal(group.userData.preserveInEarthImportMode, true);
    assert.equal(group.userData.earthImportLayer, true);
    assert.equal(group.children.length, 1);
    assert.equal(group.children[0].name, "EarthImportBoundsOutline");
    assert.ok(group.children[0].geometry?.attributes?.position?.count > 8);
});

test("cornersToSamplePoints includes center sample", () => {
    const corners = geoBoundsToLocalCorners(bounds, anchor);
    const points = cornersToSamplePoints(corners);
    assert.equal(points.length, 5);
});
