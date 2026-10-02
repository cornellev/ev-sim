import assert from "node:assert/strict";
import test from "node:test";

import { perceptionClassId } from "../app/autonomy/PerceptionLabelCatalog.js";
import { AssetInstantiation } from "../app/3d/editor/assets/AssetInstantiation.js";
import { AssetObstaclePublisher } from "../app/3d/editor/assets/AssetObstaclePublisher.js";
import { CommandBus } from "../app/3d/editor/commands/CommandBus.js";
import { EnvironmentDocument, resetDocumentIdCounter } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createBuiltinObjectTypeRegistry } from "../app/3d/editor/objects/builtinObjectTypes.js";
import { sweepAabbConvex } from "../app/physics/SweptConvex.js";
import { createLidarGeometry } from "../app/simulation/lidar/LidarGeometry.js";
import { assertWorldResource, createWorldResource } from "../app/simulation/world/WorldDescription.js";

const USE_HASH = "a".repeat(64);
const POINTS = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
const INDICES = [0, 1, 2, 0, 1, 3, 0, 2, 3, 1, 2, 3];

function tetraLease() {
    const mesh = {
        isMesh: true,
        name: "Cone",
        parent: null,
        position: { toArray: () => [0, 0, 0] },
        quaternion: { toArray: () => [0, 0, 0, 1] },
        scale: { toArray: () => [1, 1, 1] },
        matrix: { toArray: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        geometry: {
            attributes: {
                position: {
                    count: POINTS.length,
                    getX: (index) => POINTS[index][0],
                    getY: (index) => POINTS[index][1],
                    getZ: (index) => POINTS[index][2],
                },
            },
            index: { count: INDICES.length, getX: (index) => INDICES[index] },
        },
    };
    const root = { name: "Root", traverse(visit) { visit(root); visit(mesh); } };
    mesh.parent = root;
    let released = 0;
    return {
        modelUseHash: USE_HASH,
        root,
        nodeMappings: new Map([[mesh, { nodes: 0 }]]),
        release() { released += 1; },
        released: () => released,
    };
}

test("OBS-03 publishes a v1 pin as a barrel obstacle and the world, LiDAR, and sweep consume it", async () => {
    resetDocumentIdCounter();
    const lease = tetraLease();
    let published = null;
    let publishes = 0;
    const v1 = { version: 1, revision: 1, assetId: "cone", modelUseHash: USE_HASH };
    const repository = {
        async get() {
            return { catalogRevision: 4, asset: { id: "cone", name: "Cone", latestRevision: published?.revision ?? 1 } };
        },
        async getRevision(_assetId, revision) {
            if (published && revision === published.revision) return published;
            if (revision === 1) return v1;
            throw new Error(`missing revision ${revision}`);
        },
        async publishRevision(_assetId, draft) {
            publishes += 1;
            published = {
                version: 2,
                revision: 2,
                assetId: "cone",
                modelUseHash: draft.modelUseHash,
                definition: draft.definition,
                metric: draft.metric,
                metricHash: draft.metricHash,
                appearance: draft.appearance,
            };
            return { catalogRevision: 5, revision: published, asset: { latestRevision: 2, name: "Cone" } };
        },
    };
    const models = { async acquireRevision() { return lease; } };
    const publisher = new AssetObstaclePublisher({ repository, models });
    const document = new EnvironmentDocument({ environmentId: "obstacle", roads: { nodes: [], edges: [] } });
    const instantiation = new AssetInstantiation({ repository, document, publisher });
    const bus = new CommandBus({ document, registry: createBuiltinObjectTypeRegistry() });

    const command = await instantiation.placeObstacle({
        assetId: "cone",
        revision: 1,
        position: { x: 0, y: 0, z: 0 },
        name: "Cone",
        semantic: "barrel",
    });
    const placed = bus.execute(command);
    assert.equal(placed.ok, true, JSON.stringify(placed.issues));
    assert.equal(publishes, 1);
    assert.equal(lease.released(), 1);
    assert.equal(published.definition.lidarProxies[0].semantic, "barrel");
    assert.equal(document.objects[0].typeVersion, 2);
    assert.equal(document.assetMetrics.definitions[0].lidar[0].semantic, "barrel");

    const again = await publisher.ensureObstacleRevision({ assetId: "cone", revision: 1, semantic: "barrel" });
    assert.equal(again.revision, 2);
    assert.equal(publishes, 1, "a matching v2 pin is reused");

    const world = createWorldResource({
        environmentId: "obstacle",
        templateId: "blank",
        document: document.snapshot(),
    });
    assert.equal(world.description.version, 3);
    assertWorldResource(world);
    const convex = world.description.assetProxies[0].collision[0];
    assert.equal(Number.isFinite(sweepAabbConvex(
        { x: -2, y: 0.2, z: 0.2 },
        { x: 2, y: 0.2, z: 0.2 },
        { x: 0.4, y: 0.4, z: 0.4 },
        convex,
    )), true);
    assert.equal(sweepAabbConvex(
        { x: -2, y: 8, z: 0.2 },
        { x: 2, y: 8, z: 0.2 },
        { x: 0.4, y: 0.4, z: 0.4 },
        convex,
    ), null);
    const lidar = createLidarGeometry(world);
    assert.ok(lidar.staticPrimitives.some((entry) => entry.semanticId === perceptionClassId("barrel")));
});
