import assert from "node:assert/strict";
import test from "node:test";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { BrowserAnalyticRenderRuntime } from "../app/3d/perception/BrowserPbrRenderRuntime.js";
import { createRenderSceneResource } from "../app/simulation/render/RenderScene.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { LIVE_CAMERA_OBJECT_MOTION } from "../app/simulation/render/CameraObjectMotion.js";

test("engine prepares owned live analytic camera scenes and retains the legacy camera path", async () => {
    const world = createWorldResource({ environmentId: "camera-selection", templateId: "blank", document: { roads: {}, objects: [], primitives: [] } });
    const engine = Object.create(SimulationEngine.prototype);
    engine.data = { vehicles: () => ({ vehicles: [] }) };
    engine.renderer = {};
    engine._bindRenderRuntime = (runtime) => { engine.renderRuntime = runtime; };
    engine._disposeRendering = () => { engine.renderRuntime?.dispose(); engine.renderRuntime = null; };
    const live = { world, renderScene: createRenderSceneResource(world, [], undefined, { cameraObjectMotion: LIVE_CAMERA_OBJECT_MOTION }) };
    const runtime = await engine._prepareRendering(live);
    assert.ok(runtime instanceof BrowserAnalyticRenderRuntime);
    assert.equal(runtime.cameraOptions().captureSceneHandle.objectMotion, LIVE_CAMERA_OBJECT_MOTION);
    assert.notEqual(runtime.appearanceScene, runtime.analyticScene);
    assert.equal(engine.renderRuntime, runtime);
    const legacy = { world, renderScene: createRenderSceneResource(world) };
    assert.equal(await engine._prepareRendering(legacy), null);
    assert.equal(engine.renderRuntime, null);
    assert.equal(engine.renderProviderStatus.provider.id, "canonical-analytic");
});
