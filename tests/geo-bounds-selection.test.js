import assert from "node:assert/strict";
import test from "node:test";
import { boundsCenter } from "../app/3d/earth/EarthImportConfig.js";
import {
    editorStateToGeoBounds,
    geoBoundsEqual,
    geoBoundsToEarthImportPatch,
    leafletLatLngBoundsToGeoBounds,
    normalizeCorners,
    summarizeBounds,
} from "../app/3d/earth/map/GeoBoundsSelection.js";

test("normalizeCorners orders north/south and east/west", () => {
    const bounds = normalizeCorners(
        { lat: 42.44, lng: -76.51 },
        { lat: 42.45, lng: -76.49 },
    );

    assert.equal(bounds.north, 42.45);
    assert.equal(bounds.south, 42.44);
    assert.equal(bounds.east, -76.49);
    assert.equal(bounds.west, -76.51);
});

test("normalizeCorners handles reversed drag direction", () => {
    const bounds = normalizeCorners(
        { lat: 42.45, lng: -76.49 },
        { lat: 42.44, lng: -76.51 },
    );

    assert.equal(bounds.north, 42.45);
    assert.equal(bounds.south, 42.44);
    assert.equal(bounds.east, -76.49);
    assert.equal(bounds.west, -76.51);
});

test("leafletLatLngBoundsToGeoBounds converts Leaflet bounds", () => {
    const bounds = leafletLatLngBoundsToGeoBounds({
        getSouthWest: () => ({ lat: 42.44, lng: -76.51 }),
        getNorthEast: () => ({ lat: 42.45, lng: -76.49 }),
    });

    assert.deepEqual(bounds, {
        north: 42.45,
        south: 42.44,
        east: -76.49,
        west: -76.51,
    });
});

test("geoBoundsToEarthImportPatch updates anchor from bounds center", () => {
    const bounds = {
        north: 42.45,
        south: 42.43,
        east: -76.49,
        west: -76.51,
    };
    const patch = geoBoundsToEarthImportPatch(bounds);
    const center = boundsCenter(bounds);

    assert.equal(patch.boundsNorth, bounds.north);
    assert.equal(patch.boundsSouth, bounds.south);
    assert.equal(patch.boundsEast, bounds.east);
    assert.equal(patch.boundsWest, bounds.west);
    assert.equal(patch.anchorLat, center.lat);
    assert.equal(patch.anchorLng, center.lng);
});

test("editorStateToGeoBounds reads editor import fields", () => {
    const bounds = editorStateToGeoBounds({
        boundsNorth: 1,
        boundsSouth: 2,
        boundsEast: 3,
        boundsWest: 4,
    });

    assert.deepEqual(bounds, {
        north: 1,
        south: 2,
        east: 3,
        west: 4,
    });
});

test("summarizeBounds reports validation for oversized areas", () => {
    const summary = summarizeBounds({
        north: 43,
        south: 42,
        east: -75,
        west: -77,
    });

    assert.equal(summary.valid, false);
    assert.ok(summary.error);
    assert.ok(summary.edgeMeters > 5000);
});

test("geoBoundsEqual compares bounds within epsilon", () => {
    const a = { north: 1, south: 0, east: 2, west: 1 };
    const b = { north: 1.00000001, south: 0, east: 2, west: 1 };

    assert.equal(geoBoundsEqual(a, b), true);
    assert.equal(geoBoundsEqual(a, { ...a, west: 0.5 }), false);
});
