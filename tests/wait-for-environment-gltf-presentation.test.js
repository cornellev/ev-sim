import assert from "node:assert/strict";
import test from "node:test";

import { waitForEnvironmentGltfPresentation } from "../app/3d/environment/waitForEnvironmentGltfPresentation.js";

test("waitForEnvironmentGltfPresentation compiles only after instances are idle", async () => {
    const order = [];
    let resolveIdle;
    const projector = {
        whenAssetInstancesIdle() {
            return new Promise((resolve) => { resolveIdle = resolve; });
        },
    };
    const renderer = { compile() { order.push("compile"); } };
    const simulation = { render() { order.push("render"); } };
    const done = waitForEnvironmentGltfPresentation({
        projector, renderer, scene: {}, camera: {}, simulation,
    });
    await Promise.resolve();
    assert.deepEqual(order, []);
    resolveIdle();
    await done;
    assert.deepEqual(order, ["compile", "render"]);
});

test("waitForEnvironmentGltfPresentation still renders when compile throws", async () => {
    const order = [];
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args); };
    try {
        await waitForEnvironmentGltfPresentation({
            projector: { async whenAssetInstancesIdle() { order.push("idle"); } },
            renderer: { compile() { order.push("compile"); throw new Error("gpu"); } },
            simulation: { render() { order.push("render"); } },
        });
    } finally {
        console.warn = originalWarn;
    }
    assert.deepEqual(order, ["idle", "compile", "render"]);
    assert.equal(warnings.length, 1);
});

test("waitForEnvironmentGltfPresentation is a no-op without a projector", async () => {
    const simulation = { calls: 0, render() { this.calls += 1; } };
    await waitForEnvironmentGltfPresentation({ simulation });
    assert.equal(simulation.calls, 1);
});
