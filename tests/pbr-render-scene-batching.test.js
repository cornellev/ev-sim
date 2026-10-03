import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { BrowserPbrRenderRuntime } from "../app/3d/perception/BrowserPbrRenderRuntime.js";
import { canonicalizeAnalyticBindings } from "../app/3d/environment/visual/VisualCapturePipeline.js";
import { resolvedPbrRun } from "./helpers/pbrResolved.js";

function fakeMaterializer(options) {
    const status = {
        status: "ready",
        error: null,
        residency: {
            requiredChunkIds: [],
            residentChunkIds: [],
            queuedChunkIds: [],
            requiredChunks: 0,
            residentChunks: 0,
            queuedChunks: 0,
            prefetchShed: 0,
            pressure: {},
        },
    };
    return {
        async replaceResolved() { return status; },
        async updateInterest() { return status; },
        residencySnapshot() { return status.residency; },
        async materializeAssetUse() {
            const root = new THREE.Group();
            options.previewRoot?.add?.(root);
            return { root, release() { root.removeFromParent(); } };
        },
        dispose() {},
    };
}

function countMeshes(root) {
    let count = 0;
    root.traverse((object) => {
        if (object.isMesh) count += 1;
    });
    return count;
}

function vehicleStub() {
    return {
        telemetryId: "ego",
        position: new THREE.Vector3(),
        rotation: new THREE.Euler(),
    };
}

async function prepareRuntime({ batchAnalyticGeometry = true } = {}) {
    const resolved = resolvedPbrRun();
    const runtime = new BrowserPbrRenderRuntime({
        renderer: {},
        assetClient: { async validateClosure() {}, async validateAccessSet() {} },
        materializerFactory: fakeMaterializer,
        vehicles: () => [vehicleStub()],
        batchAnalyticGeometry,
    });
    await runtime.prepare(resolved, { vehicles: [vehicleStub()] });
    return { runtime, resolved };
}

test("batched analytic scene collapses same-id triangles into one mesh per group", async () => {
    const { runtime: batched } = await prepareRuntime({ batchAnalyticGeometry: true });
    const { runtime: unbatched } = await prepareRuntime({ batchAnalyticGeometry: false });
    try {
        const batchedMeshes = countMeshes(batched.analyticScene);
        const unbatchedMeshes = countMeshes(unbatched.analyticScene);
        assert.ok(unbatchedMeshes > 1, "fixture should produce multiple analytic triangles");
        assert.ok(
            batchedMeshes < unbatchedMeshes,
            `expected fewer analytic meshes after batching (${batchedMeshes} < ${unbatchedMeshes})`,
        );
        assert.equal(
            canonicalizeAnalyticBindings(batched.analyticBindings),
            batched.analyticBindings,
        );
        for (const binding of batched.analyticBindings) {
            assert.ok(batched.analyticRenderables.has(binding.renderableId));
            assert.match(binding.renderableId, /^(static|actor:[^:]+):s\d+:i\d+:\d+$/);
        }
        const roads = [];
        batched.appearanceScene.traverse((object) => {
            if (object.userData?.cevSimRoadAppearance === true) roads.push(object);
        });
        assert.equal(roads.length, 1);
        assert.equal(roads[0].name, "road-appearance");

        const unbatchedRoads = [];
        unbatched.appearanceScene.traverse((object) => {
            if (object.userData?.cevSimRoadAppearance === true) unbatchedRoads.push(object);
        });
        assert.ok(unbatchedRoads.length > 1);
        assert.ok(roads.length < unbatchedRoads.length);

        // Primitive ids still map to a merged renderable for lookups.
        const staticCount = unbatched.analyticBindings.length;
        assert.ok(batched._primitiveRenderableIds.size >= staticCount);
        for (const binding of unbatched.analyticBindings) {
            const mergedId = batched._primitiveRenderableIds.get(binding.renderableId);
            assert.ok(mergedId, `missing merge map for ${binding.renderableId}`);
            const mergedBinding = batched.analyticBindings.find((entry) => (
                entry.renderableId === mergedId
            ));
            assert.equal(mergedBinding.semanticId, binding.semanticId);
            assert.equal(mergedBinding.instanceId, binding.instanceId);
        }
    } finally {
        batched.dispose();
        unbatched.dispose();
    }
});

test("unbatched analytic path keeps one mesh and binding per primitive", async () => {
    const { runtime } = await prepareRuntime({ batchAnalyticGeometry: false });
    try {
        assert.equal(countMeshes(runtime.analyticScene), runtime.analyticBindings.length);
        for (const binding of runtime.analyticBindings) {
            assert.equal(runtime.analyticRenderables.get(binding.renderableId)?.name, binding.renderableId);
        }
    } finally {
        runtime.dispose();
    }
});
