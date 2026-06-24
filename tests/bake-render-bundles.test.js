import assert from "node:assert/strict";
import test from "node:test";

import {
    buildSampleId,
    passFileRole,
    resolveViewPasses,
} from "../app/3d/environment/visualization/BakePass.js";

test("BakePass resolves default beauty and mask passes", () => {
    const passes = resolveViewPasses();
    assert.equal(passes.length, 3);
    assert.equal(passes[0].id, "beauty");
    assert.equal(passes[0].kind, "render");

    const buildingMask = passes.find((pass) => pass.id === "mask_building");
    assert.ok(buildingMask);
    assert.equal(buildingMask.kind, "mask");
    assert.equal(buildingMask.includeTags.includes("building"), true);

    const noRoadMask = passes.find((pass) => pass.id === "mask_no_road_building");
    assert.ok(noRoadMask);
    assert.equal(noRoadMask.includeTags.length, 0);
    assert.equal(noRoadMask.excludeTags.includes("road"), true);
    assert.equal(noRoadMask.excludeTags.includes("building"), true);
});

test("BakePass preserves custom pass lists", () => {
    const custom = [{ id: "beauty", kind: "render", excludeTags: ["vehicle"] }];
    const passes = resolveViewPasses(custom);
    assert.equal(passes.length, 1);
    assert.equal(passes[0].excludeTags[0], "vehicle");
});

test("BakePass helpers build sample metadata", () => {
    assert.equal(buildSampleId("run-1", 7), "run-1:7");
    assert.equal(passFileRole({ kind: "render" }), "render");
    assert.equal(passFileRole({ kind: "mask" }), "mask");
});
