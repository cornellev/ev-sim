import assert from "node:assert/strict";
import test from "node:test";

import { classifyAssetStudioChangeSet } from "../app/3d/editor/assets/assetStudioProjection.js";
import { createEmptyAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { diffAssetSnapshots } from "../app/editor-assets/AssetDocument.js";

const HASH = "a".repeat(64);

function definition(extra = {}) {
    const base = createEmptyAssetDefinition({ modelUseHash: HASH, name: "Body" });
    return {
        ...base,
        ...extra,
        parts: extra.parts ?? structuredClone(base.parts),
        materials: extra.materials ?? structuredClone(base.materials),
        sources: extra.sources ?? structuredClone(base.sources),
        lidarProxies: extra.lidarProxies ?? [],
        collisionProxies: extra.collisionProxies ?? [],
        normalization: extra.normalization ?? structuredClone(base.normalization),
    };
}

function classify(before, after) {
    return classifyAssetStudioChangeSet(diffAssetSnapshots(before, after));
}

function boxProxy(id) {
    return {
        id, kind: "box", enabled: true,
        transform: { position: [0, 1, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        size: [1, 1, 1],
    };
}

test("classifyAssetStudioChangeSet maps each domain to the incremental projection action", () => {
    const empty = classifyAssetStudioChangeSet(null);
    assert.equal(empty.rebuildAppearance, false);
    assert.equal(empty.transformPartIds.size, 0);

    const sources = definition();
    const sourcesAfter = definition({ sources: [{ id: "source", modelUseHash: "b".repeat(64) }] });
    const sourcePlan = classify(sources, sourcesAfter);
    assert.equal(sourcePlan.reconcileSourceLeases, true);
    assert.equal(sourcePlan.rebuildAppearance, true);

    const added = definition();
    const addedAfter = definition({
        parts: [
            ...added.parts,
            {
                id: "child", parentId: null, order: 1, name: "Child",
                transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
                content: { kind: "asset-reference", assetId: "other", revision: 1 },
                appearanceVisible: true, materialBindings: {},
            },
        ],
    });
    const addedPlan = classify(added, addedAfter);
    assert.equal(addedPlan.reconcileChildLeases, true);
    assert.equal(addedPlan.rebuildAppearance, true);

    const parent = definition();
    const parentAfter = definition();
    parentAfter.parts[0].parentId = "missing";
    const parentPlan = classify(parent, parentAfter);
    assert.equal(parentPlan.rebuildAppearance, true);
    assert.equal(parentPlan.reconcileChildLeases, true);

    const content = definition();
    const contentAfter = definition();
    contentAfter.parts[0].content = { kind: "model-node", sourceId: "source", nodeIndex: 1 };
    assert.equal(classify(content, contentAfter).rebuildAppearance, true);

    const bindings = definition({ materials: [{ id: "paint", mode: "metallic-roughness", alphaMode: "OPAQUE", alphaCutoff: 0.5, doubleSided: false, parameters: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 1, roughnessFactor: 1, emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1, clearcoatFactor: 0, clearcoatRoughnessFactor: 0, sheenColorFactor: [0, 0, 0], sheenRoughnessFactor: 0, specularFactor: 1, specularColorFactor: [1, 1, 1] }, textures: [], extensions: [] }] });
    const bindingsAfter = structuredClone(bindings);
    bindingsAfter.parts[0].materialBindings = { default: "paint" };
    const bindingPlan = classify(bindings, bindingsAfter);
    assert.equal(bindingPlan.rebuildAppearance, true);
    assert.equal(bindingPlan.reconcileChildLeases, true);

    const transform = definition();
    const transformAfter = definition();
    transformAfter.parts[0].transform.position = [2, 0, 0];
    const transformPlan = classify(transform, transformAfter);
    assert.equal(transformPlan.rebuildAppearance, false);
    assert.deepEqual([...transformPlan.transformPartIds], ["root"]);
    assert.equal(transformPlan.visibilityPartIds.size, 0);

    const visibility = definition();
    const visibilityAfter = definition();
    visibilityAfter.parts[0].appearanceVisible = false;
    const visibilityPlan = classify(visibility, visibilityAfter);
    assert.equal(visibilityPlan.rebuildAppearance, false);
    assert.deepEqual([...visibilityPlan.visibilityPartIds], ["root"]);

    const named = definition();
    const namedAfter = definition();
    namedAfter.parts[0].name = "Display only";
    const namedPlan = classify(named, namedAfter);
    assert.equal(namedPlan.rebuildAppearance, false);
    assert.equal(namedPlan.transformPartIds.size, 0);
    assert.equal(namedPlan.visibilityPartIds.size, 0);

    const ordered = definition();
    const orderedAfter = definition();
    orderedAfter.parts[0].order = 9;
    const orderedPlan = classify(ordered, orderedAfter);
    assert.equal(orderedPlan.rebuildAppearance, false);
    assert.equal(orderedPlan.refreshMaterials, false);

    const materials = definition();
    const materialsAfter = definition({
        materials: [{
            id: "paint", mode: "metallic-roughness", alphaMode: "OPAQUE", alphaCutoff: 0.5, doubleSided: false,
            parameters: {
                baseColorFactor: [1, 0, 0, 1], metallicFactor: 0.2, roughnessFactor: 0.4,
                emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1,
                clearcoatFactor: 0, clearcoatRoughnessFactor: 0, sheenColorFactor: [0, 0, 0],
                sheenRoughnessFactor: 0, specularFactor: 1, specularColorFactor: [1, 1, 1],
            },
            textures: [], extensions: [],
        }],
    });
    const materialPlan = classify(materials, materialsAfter);
    assert.equal(materialPlan.refreshMaterials, true);
    assert.equal(materialPlan.rebuildAppearance, false);

    const pivot = definition();
    const pivotAfter = definition();
    pivotAfter.normalization.pivot = [1, 0, 0];
    const pivotPlan = classify(pivot, pivotAfter);
    assert.equal(pivotPlan.applyNormalization, true);
    assert.equal(pivotPlan.rebuildAppearance, false);

    const collision = definition();
    const collisionAfter = definition({ collisionProxies: [boxProxy("c1")] });
    const collisionPlan = classify(collision, collisionAfter);
    assert.equal(collisionPlan.rebuildCollision, true);
    assert.equal(collisionPlan.rebuildLidar, false);
    assert.equal(collisionPlan.rebuildAppearance, false);

    const lidar = definition();
    const lidarAfter = definition({ lidarProxies: [{ ...boxProxy("l1"), semantic: "unknown" }] });
    const lidarPlan = classify(lidar, lidarAfter);
    assert.equal(lidarPlan.rebuildLidar, true);
    assert.equal(lidarPlan.rebuildCollision, false);
});

test("classifyAssetStudioChangeSet combines independent domains and ignores name/order with other no-ops", () => {
    const before = definition();
    const after = definition();
    after.parts[0].transform.position = [4, 0, 0];
    after.parts[0].appearanceVisible = false;
    after.normalization.metersPerUnit = 2;
    after.materials = [{
        id: "paint", mode: "metallic-roughness", alphaMode: "OPAQUE", alphaCutoff: 0.5, doubleSided: false,
        parameters: {
            baseColorFactor: [0, 1, 0, 1], metallicFactor: 1, roughnessFactor: 1,
            emissiveFactor: [0, 0, 0], emissiveStrength: 1, normalScale: 1, occlusionStrength: 1,
            clearcoatFactor: 0, clearcoatRoughnessFactor: 0, sheenColorFactor: [0, 0, 0],
            sheenRoughnessFactor: 0, specularFactor: 1, specularColorFactor: [1, 1, 1],
        },
        textures: [], extensions: [],
    }];
    after.collisionProxies = [boxProxy("c1")];
    after.lidarProxies = [{ ...boxProxy("l1"), semantic: "unknown" }];
    const plan = classify(before, after);
    assert.equal(plan.rebuildAppearance, false);
    assert.equal(plan.refreshMaterials, true);
    assert.equal(plan.applyNormalization, true);
    assert.equal(plan.rebuildCollision, true);
    assert.equal(plan.rebuildLidar, true);
    assert.deepEqual([...plan.transformPartIds], ["root"]);
    assert.deepEqual([...plan.visibilityPartIds], ["root"]);

    const noop = classifyAssetStudioChangeSet({ version: 1, domains: {}, scalars: {}, meta: {} });
    assert.equal(noop.rebuildAppearance, false);
    assert.equal(noop.refreshMaterials, false);
});
