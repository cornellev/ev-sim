import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentPersistence } from "../app/3d/environment/EnvironmentPersistence.js";
import {
    computeEpisodeHash,
    computeSimulationSemanticHash,
    defaultEpisodeIdentity,
    simulationSha256,
} from "../app/simulation/kernel/SimulationHashes.js";
import { createLidarGeometryResource } from "../app/simulation/lidar/LidarGeometry.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { StorageService } from "../server/storage/StorageService.js";

test("ED-06 nonpersistent registry events never dirty environment autosave", () => {
    let registryNotify = () => {};
    const environment = {
        environmentId: "yard", revision: 0,
        toManifest() { return { environmentId: "yard", document: {} }; },
        getDocument() { return { subscribe() { return () => {}; } }; },
        objects() { return { subscribe(listener) { registryNotify = listener; return () => {}; } }; },
        editor() { return { subscribe() { return () => {}; }, persistedSnapshot() { return {}; } }; },
        sky() { return { subscribe() { return () => {}; } }; },
    };
    const persistence = new EnvironmentPersistence({ data: { environment: () => environment }, scene: {}, put: async () => ({}) });
    persistence.attach();
    registryNotify({}, { affectsPersistence: false });
    assert.equal(persistence.isDirty, false);
    registryNotify({}, { affectsPersistence: true });
    assert.equal(persistence.isDirty, true);
    persistence._clearTimer();
});

test("ED-06 save validation checks new pins but preserves unchanged unavailable pins", async () => {
    const service = new StorageService("/tmp/unused-editor-asset-pins");
    const checked = [];
    service.editorAssets.getRevision = async (assetId, revision) => { checked.push(`${assetId}@${revision}`); };
    const component = (assetId, revision) => ({
        id: "asset-1", typeId: "asset-instance",
        components: { asset: { assetId, revision } },
    });
    await service._assertEditorAssetPins(
        { document: { objects: [component("missing", 1)] } },
        { document: { objects: [component("missing", 1)] } },
    );
    assert.deepEqual(checked, []);
    await service._assertEditorAssetPins(
        { document: { objects: [component("crate", 2)] } },
        { document: { objects: [component("crate", 1)] } },
    );
    assert.deepEqual(checked, ["crate@2"]);
});

test("ED-06 asset-only edits preserve metric, measured-render, and episode identity", () => {
    const manifest = {
        environmentId: "yard",
        templateId: "blank",
        roadStylePreset: "default",
        roadsAuthored: true,
        buildingsAuthored: false,
        featuresAuthored: false,
        document: {
            objectGraphVersion: 1,
            objects: [],
            roads: {
                nodes: [{ id: "a", x: 0, y: 0, z: 0 }, { id: "b", x: 20, y: 0, z: 0 }],
                edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", width: 4, laneCount: 1, bidirectional: true }],
            },
            buildings: [],
            features: [],
            earth: null,
        },
    };
    const edited = structuredClone(manifest);
    edited.document.objects.push({
        id: "asset-1",
        typeId: "asset-instance",
        typeVersion: 1,
        name: "Crate",
        parentId: null,
        order: 0,
        components: {
            tags: [], locked: false, editorHidden: false,
            asset: {
                assetId: "crate", revision: 2,
                position: { x: 4, y: 0, z: 3 }, rotationY: 0.5,
                scale: { x: 1, y: 2, z: 1 }, overrides: {},
            },
        },
    });

    const beforeWorld = createWorldResource(manifest);
    const afterWorld = createWorldResource(edited);
    const beforeLidar = createLidarGeometryResource(beforeWorld);
    const afterLidar = createLidarGeometryResource(afterWorld);
    assert.equal(afterWorld.hash, beforeWorld.hash);
    assert.equal(afterWorld.description.roadNetworkHash, beforeWorld.description.roadNetworkHash);
    assert.equal(afterLidar.hash, beforeLidar.hash);

    const renderScene = {
        hash: "a".repeat(64),
        description: { worldHash: beforeWorld.hash, provider: { id: "canonical-analytic", version: 1 } },
    };
    const resolved = (environment) => ({
        kind: "cev-sim.run-manifest",
        version: 11,
        identityProfile: { id: "world-bound", version: 2 },
        manifest: {
            version: 11,
            seed: "1",
            environment: { id: "yard" },
            clock: { stepNs: 10_000_000, maxSteps: 100 },
            sensorRig: { sensors: [] },
        },
        environment: { hash: simulationSha256(environment), manifest: environment },
        world: beforeWorld,
        renderScene,
        dependencyHashes: { environment: simulationSha256(environment), world: beforeWorld.hash },
        backendSelections: [],
    });
    const beforeResolved = resolved(manifest);
    const afterResolved = resolved(edited);
    assert.notEqual(afterResolved.environment.hash, beforeResolved.environment.hash, "the authored environment envelope may change");
    assert.deepEqual(afterResolved.renderScene, beforeResolved.renderScene, "measured render resources do not include editor-only instances");
    assert.equal(computeSimulationSemanticHash(afterResolved), computeSimulationSemanticHash(beforeResolved));
    assert.equal(
        computeEpisodeHash(defaultEpisodeIdentity(afterResolved)),
        computeEpisodeHash(defaultEpisodeIdentity(beforeResolved)),
    );
});
