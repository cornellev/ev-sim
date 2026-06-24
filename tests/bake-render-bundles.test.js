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
    assert.equal(passes[1].kind, "mask");
    assert.equal(passes[1].includeTags.includes("road"), true);
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
