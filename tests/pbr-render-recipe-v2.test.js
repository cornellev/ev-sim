import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { applyPbrRenderRecipeToScene } from "../app/3d/environment/visual/PbrRenderRecipeRuntime.js";
import {
    normalizePbrRenderRecipe,
} from "../app/simulation/render/PbrRenderScene.js";
import { renderSceneProviderRegistry } from "../app/simulation/render/RenderSceneProviderRegistry.js";

function recipe(overrides = {}) {
    return normalizePbrRenderRecipe({
        kind: "cev-sim.pbr-render-recipe",
        version: 2,
        background: { colorRgba: [0.08, 0.09, 0.1, 1] },
        lighting: {
            ambient: { colorRgb: [1, 1, 1], intensity: 0.25 },
            directional: [{
                id: "key",
                colorRgb: [1, 0.94, 0.86],
                intensity: 2.2,
                direction: [-0.55, -1, -0.35],
                castShadow: true,
            }],
            point: [{
                id: "room-lamp",
                colorRgb: [1, 0.72, 0.48],
                intensity: 34,
                position: [1.8, 1.2, 1.7],
                range: 7,
                decay: 2,
                castShadow: true,
            }],
        },
        shadows: {
            enabled: true,
            algorithm: "pcf-soft",
            mapSize: 1024,
            bias: -0.0001,
            normalBias: 0.02,
            maxLights: 2,
        },
        colorPipeline: { toneMapping: "AgX", exposure: 0.9 },
        ...overrides,
    });
}

test("pbr recipe v2 normalizes bounded explicit lights, shadows, exposure, and presentation", () => {
    const normalized = recipe();
    assert.equal(normalized.version, 2);
    assert.equal(normalized.lighting.directional[0].id, "key");
    assert.equal(normalized.lighting.point[0].id, "room-lamp");
    assert.deepEqual(normalized.shadows, {
        enabled: true,
        algorithm: "pcf-soft",
        mapSize: 1024,
        bias: -0.0001,
        normalBias: 0.02,
        maxLights: 2,
    });
    assert.deepEqual(normalized.colorPipeline, {
        workingColorSpace: "linear-srgb",
        outputColorSpace: "srgb",
        toneMapping: "AgX",
        exposure: 0.9,
    });
    assert.throws(() => recipe({
        lighting: {
            directional: Array.from({ length: 3 }, (_, index) => ({
                id: `light-${index}`,
                direction: [0, -1, 0],
            })),
        },
    }), /at most 2/);
    assert.throws(() => recipe({ shadows: { enabled: true, mapSize: 4096 } }), /power-of-two/);
    assert.throws(() => recipe({ shadows: { enabled: true, algorithm: "none" } }), /exactly when shadows are enabled/);
});

test("pbr-mesh v2 is advertised for browser execution and rejected for headless execution", () => {
    assert.equal(renderSceneProviderRegistry.lookup(
        { id: "pbr-mesh", version: 2 },
        { requireAvailable: true, target: "browser" },
    ).runtimeAvailability.browser, true);
    assert.throws(() => renderSceneProviderRegistry.lookup(
        { id: "pbr-mesh", version: 2 },
        { requireAvailable: true, target: "headless" },
    ), (error) => error.code === "PROVIDER_UNAVAILABLE");
});

test("the shared recipe applier owns and disposes explicit lights and shadow settings", () => {
    const scene = new THREE.Scene();
    const applied = applyPbrRenderRecipeToScene(scene, recipe());
    const lights = scene.children.filter((object) => object.isLight);
    assert.deepEqual(lights.map((light) => light.type).sort(), ["AmbientLight", "DirectionalLight", "PointLight"]);
    const casters = lights.filter((light) => light.castShadow);
    assert.equal(casters.length, 2);
    assert.equal(casters[0].shadow.mapSize.width, 1024);
    assert.equal(applied.renderPolicy.toneMapping, "AgX");
    assert.equal(applied.renderPolicy.recipeVersion, 2);
    applied.dispose();
    assert.equal(scene.children.length, 0);
});
