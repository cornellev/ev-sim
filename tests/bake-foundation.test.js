import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import {
    denormalizeTagId,
    normalizeTagId,
    objectMatchesTags,
    resolveTagId,
    tagNameFromId,
} from "../app/3d/data/ObjectTagRegistry.js";
import { BakePath } from "../app/3d/environment/visualization/BakePath.js";
import { prepareRgbaForPng } from "../app/3d/environment/visualization/bakeUpload.js";

test("ObjectTagRegistry resolves known tags", () => {
    assert.equal(resolveTagId("building"), 1);
    assert.equal(resolveTagId("unknown-tag"), 0);
    assert.equal(tagNameFromId(2), "sign");
    assert.equal(denormalizeTagId(normalizeTagId(2)), 2);
});

test("objectMatchesTags respects include and exclude lists", () => {
    const object = { tags: ["building"], tagId: 1 };

    assert.equal(objectMatchesTags(object, ["building"], []), true);
    assert.equal(objectMatchesTags(object, ["sign"], []), false);
    assert.equal(objectMatchesTags(object, [], ["sign"]), true);
    assert.equal(objectMatchesTags(object, [], ["building"]), false);
});

test("BakePath samples by arc length", () => {
    const path = new BakePath([
        { position: new THREE.Vector3(0, 0, 0) },
        { position: new THREE.Vector3(10, 0, 0) },
        { position: new THREE.Vector3(10, 0, 10) },
    ]);

    assert.equal(path.totalLength, 20);

    const midpoint = path.sampleAtDistance(5);
    assert.ok(midpoint);
    assert.equal(midpoint.position.x, 5);
    assert.equal(midpoint.position.z, 0);

    const corner = path.sampleAtDistance(10);
    assert.ok(corner);
    assert.equal(corner.position.x, 10);
    assert.equal(corner.position.z, 0);

    const end = path.sampleAtDistance(20);
    assert.ok(end);
    assert.equal(end.position.x, 10);
    assert.equal(end.position.z, 10);
});

test("prepareRgbaForPng flips WebGL rows and can preserve raw color", () => {
    const rgba = new Uint8Array([
        1, 2, 3, 255,
        4, 5, 6, 255,
        7, 8, 9, 255,
        10, 11, 12, 255,
    ]);

    const prepared = prepareRgbaForPng(rgba, 2, 2, { linearToSrgb: false });

    assert.deepEqual([...prepared], [
        7, 8, 9, 255,
        10, 11, 12, 255,
        1, 2, 3, 255,
        4, 5, 6, 255,
    ]);
});
