import assert from "node:assert/strict";
import test from "node:test";

import { placeAssetInstance, updateAssetInstances } from "../app/3d/editor/commands/assetCommands.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { objectTypeRegistry } from "../app/3d/editor/objects/index.js";
import { collectAssetInstanceReferences } from "../app/editor-assets/EditorAssetContract.js";
import { hashAssetMetric } from "../app/editor-assets/AssetDefinition.js";
import { assetBindingRevisionVersion, readAssetBinding, updateAssetRevisionBinding } from "../app/editor-assets/AssetBackedObject.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";

function tileRecord(revision = 1, assetTypeVersion = 1) {
    return {
        id: "tile", typeId: "tile", typeVersion: 2, name: "GLTF Tile", parentId: null, order: 0,
        components: {
            tags: [], locked: false, editorHidden: false,
            asset: { assetId: "base", revision, position: { x: 2, y: 3, z: 4 }, rotationY: 0.25, scale: { x: 2, y: 1, z: 0.5 }, overrides: {} },
            tile: { provider: "gltf", assetTypeVersion },
        },
    };
}

const metric = {
    version: 1,
    collision: [{ id: "body", kind: "convex", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], triangles: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] }],
    lidar: [],
};
const revision2 = { version: 2, revision: 2, metric, metricHash: hashAssetMetric(metric) };

test("ED-08 registers tile@2 independently from Google tile@1", () => {
    const google = objectTypeRegistry.get("tile", 1);
    const gltf = objectTypeRegistry.get("tile", 2);
    assert.equal(google.legacy.domain, "earth");
    assert.equal(gltf.legacy, null);
    assert.equal(gltf.singleton, "tile");
    assert.equal(gltf.capabilities.transformable, true);
    assert.equal(gltf.capabilities.deletable, true);
});

test("ED-08 GLTF Tile placement, transform data, revision updates, undo, and pin reads preserve tile@2", () => {
    const document = new EnvironmentDocument({ environmentId: "gltf" });
    const service = createEnvironmentCommandService({ document });
    let result = service.bus.execute(placeAssetInstance({ record: tileRecord() }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(document.getObject("tile").typeVersion, 2);
    assert.equal(assetBindingRevisionVersion(document.getObject("tile")), 1);
    assert.deepEqual(readAssetBinding(document.getObject("tile")).scale, { x: 2, y: 1, z: 0.5 });

    const beforeAsset = structuredClone(readAssetBinding(document.getObject("tile")));
    result = service.bus.execute(updateAssetInstances({
        expectedDocumentVersion: document.version,
        targetRevision: 2,
        changes: [{ objectId: "tile", beforeAsset, afterAsset: { ...beforeAsset, revision: 2 } }],
        publishedRevision: revision2,
    }));
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(document.getObject("tile").typeId, "tile");
    assert.equal(document.getObject("tile").typeVersion, 2);
    assert.equal(document.getObject("tile").components.tile.assetTypeVersion, 2);
    assert.equal(document.assetMetrics.definitions[0].metricHash, revision2.metricHash);
    assert.equal(service.bus.undo().ok, true);
    assert.equal(document.getObject("tile").components.asset.revision, 1);
});

test("ED-08 centralized asset binding keeps object and revision versions distinct", () => {
    const updated = updateAssetRevisionBinding(tileRecord(), 4, 2);
    assert.equal(updated.typeVersion, 2);
    assert.equal(updated.components.tile.assetTypeVersion, 2);
    assert.equal(updated.components.asset.revision, 4);
    assert.deepEqual(collectAssetInstanceReferences({ objects: [updated] }), [{ objectId: "tile", assetId: "base", revision: 4 }]);
});

test("ED-08 GLTF Tile compiles the same asset metric geometry as an equivalent asset instance", () => {
    const definition = { assetId: "base", revision: 2, metricHash: revision2.metricHash, collision: metric.collision, lidar: [] };
    const asset = tileRecord(2, 2).components.asset;
    const manifest = (record, id) => ({
        environmentId: id, templateId: "blank", roadsAuthored: true, buildingsAuthored: true, featuresAuthored: true,
        document: { environmentId: id, roads: { nodes: [], edges: [] }, buildings: [], features: [], objects: [record], assetMetrics: { version: 1, definitions: [definition] } },
    });
    const tileProxy = createWorldResource(manifest(tileRecord(2, 2), "tile-world")).description.assetProxies[0];
    const instanceRecord = { ...tileRecord(2, 2), id: "instance", typeId: "asset-instance", typeVersion: 2, components: { ...tileRecord(2, 2).components } };
    delete instanceRecord.components.tile;
    const instanceProxy = createWorldResource(manifest(instanceRecord, "instance-world")).description.assetProxies[0];
    assert.deepEqual(tileProxy.collision.map(({ id: _id, sourceId: _sourceId, ...entry }) => entry), instanceProxy.collision.map(({ id: _id, sourceId: _sourceId, ...entry }) => entry));
});
