import assert from "node:assert/strict";
import test from "node:test";

import {
    buildSampleId,
    passFileRole,
    resolveViewPasses,
} from "../app/3d/environment/visualization/BakePass.js";
import {
    countMaskPixels,
    resolvePassesForSample,
} from "../app/3d/environment/visualization/BuildingRegionPlanner.js";
import { createDefaultBakeRunConfig } from "../app/3d/environment/visualization/BakeRunConfig.js";
import { sliverBoundsToUv } from "../app/3d/environment/visualization/ProjectedBuildingTextureManager.js";
import { deriveModelSeed } from "../app/util/SeededRNG.js";
import { buildingIdFromFootprint } from "../app/3d/city/buildingIds.js";

test("BakePass resolves legacy default beauty and mask passes", () => {
    const passes = resolveViewPasses();
    assert.equal(passes.length, 3);
    assert.equal(passes[0].id, "beauty");
});

test("BakeRunConfig defaults to beauty-only capture passes", () => {
    const config = createDefaultBakeRunConfig();
    assert.equal(config.views.length, 1);
    assert.equal(config.views[0].passes.length, 1);
    assert.equal(config.views[0].passes[0].id, "beauty");
    assert.equal(config.passPolicy.activeBuildingMask, true);
    assert.equal(config.passPolicy.processAllVisibleBuildings, true);
    assert.equal(config.passPolicy.contextMask, false);
    assert.equal(config.splat.renderMode, "projectedTexture");
    assert.equal(config.splat.projectedTexture.enabled, true);
    assert.equal(config.splat.projectedTexture.cellSizePx, 10);
    assert.equal(config.splat.projectedTexture.maxPixelDistancePx, 16);
    assert.equal(config.splat.projectedTexture.maxDepthDelta, 1.5);
    assert.equal(config.splat.projectedTexture.maxTriangleDepthDelta, 1);
    assert.equal(config.splat.projectedTexture.surfaceOffset, 0.005);
});

test("projected texture helper maps sliver bounds to normalized UVs", () => {
    const uv = sliverBoundsToUv({ enabled: true, xMin: 160, xMax: 480 }, 640);
    assert.equal(uv.x, 0.25);
    assert.equal(uv.y, 0.75);

    const disabled = sliverBoundsToUv({ enabled: false, xMin: 10, xMax: 20 }, 640);
    assert.equal(disabled.x, 0);
    assert.equal(disabled.y, 1);
});

test("resolvePassesForSample adds all-visible building mask by default", () => {
    const hidden = resolvePassesForSample(
        { beautyAlways: true, activeBuildingMask: true },
        { activeBuildingId: null, hasVisibleBuilding: false },
    );
    assert.equal(hidden.length, 1);
    assert.equal(hidden[0].id, "beauty");

    const visible = resolvePassesForSample(
        { beautyAlways: true, activeBuildingMask: true },
        { activeBuildingId: "bldg-abc", hasVisibleBuilding: true, visibleBuildingIds: ["bldg-abc", "bldg-def"] },
    );
    assert.equal(visible.length, 2);
    assert.equal(visible[1].id, "mask_buildings_visible");
    assert.equal(visible[1].buildingId, null);
    assert.equal(visible[1].processTag, "building");
    assert.equal(visible[1].modelSeedKey, "bldg-abc,bldg-def");
});

test("resolvePassesForSample can restrict mask to the active building", () => {
    const visible = resolvePassesForSample(
        { beautyAlways: true, activeBuildingMask: true, processAllVisibleBuildings: false },
        { activeBuildingId: "bldg-abc", hasVisibleBuilding: true, visibleBuildingIds: ["bldg-abc", "bldg-def"] },
    );

    assert.equal(visible.length, 2);
    assert.equal(visible[1].id, "mask_building_bldg-abc");
    assert.equal(visible[1].buildingId, "bldg-abc");
    assert.equal(visible[1].processTag, "building");
});

test("countMaskPixels ignores transparent pixels", () => {
    const rgba = new Uint8Array([
        255, 255, 255, 255,
        0, 0, 0, 0,
        255, 255, 255, 0,
    ]);
    assert.equal(countMaskPixels(rgba), 1);
});

test("deriveModelSeed is stable for the same inputs", () => {
    const a = deriveModelSeed("run-1", "bldg-1", 0, 3);
    const b = deriveModelSeed("run-1", "bldg-1", 0, 3);
    const c = deriveModelSeed("run-1", "bldg-1", 0, 4);
    assert.equal(a, b);
    assert.notEqual(a, c);
});

test("buildingIdFromFootprint is stable", () => {
    const footprint = [
        { x: 1, y: 0, z: 2 },
        { x: 1, y: 0, z: 7 },
        { x: 6, y: 0, z: 7 },
        { x: 6, y: 0, z: 2 },
    ];
    const a = buildingIdFromFootprint(footprint, 0);
    const b = buildingIdFromFootprint(footprint, 0);
    assert.equal(a, b);
    assert.match(a, /^bldg-[0-9a-f]{8}$/);
});

test("BakePass helpers build sample metadata", () => {
    assert.equal(buildSampleId("run-1", 7), "run-1:7");
    assert.equal(passFileRole({ kind: "render" }), "render");
    assert.equal(passFileRole({ kind: "mask" }), "mask");
    assert.equal(passFileRole({ kind: "depth" }), "depth");
});
