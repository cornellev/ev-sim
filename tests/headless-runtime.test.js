import assert from "node:assert/strict";
import test from "node:test";

import { createHeadlessRuntimeContext } from "../app/simulation/headless/HeadlessRuntimeContext.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { StorageService } from "../server/storage/StorageService.js";

test("resolved sensor-disabled bundle completes the Node lifecycle without browser services", async () => {
    const resolved = await new StorageService().resolveRunManifest("igvc-default");
    resolved.manifest.clock.modules.sensors = false;
    resolved.manifest.clock.modules.physics = true;

    const originalFetch = globalThis.fetch;
    const browserDescriptors = Object.fromEntries(["window", "document", "WebGLRenderingContext"].map((key) => [
        key,
        Object.getOwnPropertyDescriptor(globalThis, key),
    ]));
    globalThis.fetch = () => { throw new Error("fetch must not run in headless vehicle preparation"); };
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: undefined,
    });
    for (const key of ["document", "WebGLRenderingContext"]) {
        Object.defineProperty(globalThis, key, {
            configurable: true,
            get() { throw new Error(`${key} must not be read by the headless runtime`); },
        });
    }
    try {
        const runtime = createHeadlessRuntimeContext();
        const kernel = new SimulationKernel(runtime.context);
        await kernel.prepare(resolved);
        assert.deepEqual(kernel.getCanonicalState().environment, { worldHash: resolved.world.hash });
        kernel.step(3);
        const finalized = kernel.finalize();
        assert.equal(finalized.kind, "cev-sim.episode-finalization");
        assert.equal(kernel.lifecycleState, "finalized");
        kernel.clearRun();
        assert.equal(runtime.physics.world, null);
        assert.deepEqual(runtime.vehicles.vehicles, []);
    } finally {
        globalThis.fetch = originalFetch;
        for (const [key, descriptor] of Object.entries(browserDescriptors)) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

test("headless runtime rejects unsupported enabled sensor requests", async () => {
    const resolved = await new StorageService().resolveRunManifest("igvc-default");
    const runtime = createHeadlessRuntimeContext();
    const kernel = new SimulationKernel(runtime.context);
    await assert.rejects(() => kernel.prepare(resolved), /Unsupported headless sensor request/);
    kernel.clearRun();
});

test("backend identity mismatch is rejected during runtime preparation", async () => {
    const resolved = await new StorageService().resolveRunManifest("igvc-default");
    resolved.manifest.clock.modules.sensors = false;
    resolved.backendSelections[0].version = "0.19.2";
    const runtime = createHeadlessRuntimeContext();
    const kernel = new SimulationKernel(runtime.context);
    await assert.rejects(() => kernel.prepare(resolved), /backend mismatch.*version/i);
    kernel.clearRun();
});

test("VIS-15a headless rendering preparation is awaited and async disposal releases its immutable handle", async () => {
    let finishPreparation;
    let released = 0;
    const rendererClient = {
        preparePbr() {
            return new Promise((resolve) => { finishPreparation = resolve; });
        },
        async releasePbr() { released += 1; },
    };
    const runtime = createHeadlessRuntimeContext({ rendererClient });
    const preparation = runtime.context.rendering.prepare({
        renderScene: { description: { provider: { id: "pbr-mesh", version: 1 } } },
        manifest: { sensorRig: { sensors: [] } },
    });
    assert.equal(runtime.context.rendering.current(), null);
    finishPreparation({ generation: 4, renderSceneHash: "a".repeat(64), status: { state: "ready" } });
    const handle = await preparation;
    assert.equal(runtime.context.rendering.current(), handle);
    await runtime.context.rendering.dispose();
    assert.equal(released, 1);
    assert.equal(runtime.context.rendering.current(), null);
});
