import assert from "node:assert/strict";
import test from "node:test";

import { createEmptyAssetDefinition, hashAssetMetric, normalizeAssetMetric } from "../app/editor-assets/AssetDefinition.js";
import { generateVoxelProxy } from "../app/editor-assets/AssetCompiler.js";
import { meshFromPrimitive, simplifyVoxelMesh } from "../app/editor-assets/VoxelMeshSimplifier.js";
import { buildOutwardConvexMesh, proxyMeshFailure } from "../app/simulation/world/ConvexMesh.js";
import { assertWorldResource, createWorldResource } from "../app/simulation/world/WorldDescription.js";

const USE_HASH = "a".repeat(64);

function assertConvex(mesh) {
    assert.equal(proxyMeshFailure(mesh.vertices, mesh.triangles, { convex: true }), null);
}

function openCone() {
    const segments = 8;
    const vertices = [[0, 0.15, 0]];
    const triangles = [];
    for (let index = 0; index < segments; index += 1) {
        const theta = (Math.PI * 2 * index) / segments;
        vertices.push([0.08 * Math.cos(theta), 0, 0.08 * Math.sin(theta)]);
        const current = 1 + index;
        const next = 1 + ((index + 1) % segments);
        triangles.push([0, current, next]);
    }
    return { vertices, triangles };
}

function concavePrism() {
    const bottom = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
    const top = bottom.map((point) => [point[0], point[1], 1]);
    const vertices = [...bottom, ...top];
    const floor = [[0, 1, 2], [0, 2, 3], [0, 3, 5], [5, 3, 4]];
    const triangles = [...floor, ...floor.map((triangle) => triangle.map((vertex) => vertex + 6).reverse())];
    const ring = [0, 1, 2, 3, 4, 5];
    for (let index = 0; index < ring.length; index += 1) {
        const current = ring[index];
        const next = ring[(index + 1) % ring.length];
        triangles.push([current, next, next + 6], [current, next + 6, current + 6]);
    }
    return { vertices, triangles };
}

function environmentWithCollision(collision, lidar = collision, asset = {}) {
    const metric = normalizeAssetMetric({
        version: 1,
        collision: [{ id: "body", kind: "convex", ...collision }],
        lidar: [{ id: "body", kind: "mesh", semantic: "unknown", ...lidar }],
    });
    return {
        environmentId: "hull-world",
        templateId: "blank",
        document: {
            environmentId: "hull-world",
            roads: {
                nodes: [{ id: "start-node", x: -20, y: 0, z: 0 }, { id: "finish-node", x: 20, y: 0, z: 0 }],
                edges: [{ id: "road", startNodeId: "start-node", endNodeId: "finish-node", width: 8, laneCount: 2, bidirectional: true }],
            },
            buildings: [],
            features: [],
            objects: [{
                id: "asset-muq6888s-1",
                typeId: "asset-instance",
                typeVersion: 2,
                name: "Obstacle",
                parentId: null,
                order: 0,
                components: {
                    tags: [],
                    locked: false,
                    editorHidden: false,
                    asset: {
                        assetId: "crate",
                        revision: 2,
                        position: asset.position ?? { x: 3, y: 1, z: -2 },
                        rotationY: asset.rotationY ?? Math.PI / 5,
                        scale: asset.scale ?? { x: 2, y: 1.5, z: 0.5 },
                        overrides: {},
                    },
                },
            }],
            assetMetrics: {
                version: 1,
                definitions: [{
                    assetId: "crate",
                    revision: 2,
                    metricHash: hashAssetMetric(metric),
                    collision: metric.collision,
                    lidar: metric.lidar,
                }],
            },
        },
    };
}

test("outward convex hull repairs mixed winding, an open cone, a concave prism, and a flat quad", () => {
    const tetra = buildOutwardConvexMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    assertConvex(tetra);
    assert.equal(tetra.vertices.length, 4);
    assert.deepEqual(buildOutwardConvexMesh([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]), tetra);

    const cone = openCone();
    const coneHull = buildOutwardConvexMesh(cone.vertices);
    assertConvex(coneHull);
    assert.ok(Math.max(...coneHull.vertices.map((vertex) => vertex[1])) >= 0.15);
    assert.deepEqual(buildOutwardConvexMesh(cone.vertices), coneHull);

    const prism = concavePrism();
    const prismHull = buildOutwardConvexMesh(prism.vertices);
    assertConvex(prismHull);
    assert.equal(prismHull.vertices.some((vertex) => vertex[0] === 1 && vertex[1] === 1), false);

    const flat = buildOutwardConvexMesh([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]);
    assertConvex(flat);
    const height = Math.max(...flat.vertices.map((vertex) => vertex[1])) - Math.min(...flat.vertices.map((vertex) => vertex[1]));
    assert.ok(height >= 1e-4 && height <= 1e-3);
    assert.deepEqual(buildOutwardConvexMesh([[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]), flat);

    const box = meshFromPrimitive({ kind: "box", size: [2, 2, 2] });
    assertConvex(box);

    const point = buildOutwardConvexMesh([[0, 0, 0]]);
    assertConvex(point);
    assert.deepEqual(buildOutwardConvexMesh([[0, 0, 0]]), point);
    const segment = buildOutwardConvexMesh([[0, 0, 0], [1, 0, 0]]);
    assertConvex(segment);
});

test("collision generation uses the hull and LiDAR keeps the clustered surface", () => {
    const prism = concavePrism();
    const definition = createEmptyAssetDefinition({ modelUseHash: USE_HASH, name: "Prism" });
    const source = { source: { 0: prism } };
    const lidar = generateVoxelProxy(definition, {
        id: "lidar-generated-1", channel: "lidar", includedPartIds: ["root"], semantic: "unknown", sourceGeometries: source,
    });
    const collision = generateVoxelProxy(definition, {
        id: "collision-generated-1", channel: "collision", includedPartIds: ["root"], sourceGeometries: source,
    });
    const simplified = simplifyVoxelMesh(prism, lidar.generated.parameters.voxelSize);
    assert.deepEqual(lidar.vertices, simplified.vertices);
    assert.deepEqual(lidar.triangles, simplified.triangles);
    assertConvex(collision);
    assert.equal(collision.vertices.some((vertex) => vertex[0] === 1 && vertex[1] === 1), false);
    assert.equal(lidar.vertices.some((vertex) => vertex[0] === 1 && vertex[1] === 1), true);
});

test("world compile repairs a stored collision mesh and leaves a valid one unchanged", () => {
    const mixed = {
        vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]],
        triangles: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
    };
    assert.equal(proxyMeshFailure(mixed.vertices, mixed.triangles, { convex: true }), "inconsistent-winding");
    const repaired = createWorldResource(environmentWithCollision(mixed));
    assertWorldResource(repaired);
    assertConvex(repaired.description.assetProxies[0].collision[0]);

    const valid = buildOutwardConvexMesh(mixed.vertices);
    const kept = createWorldResource(environmentWithCollision(valid, valid, {
        position: { x: 0, y: 0, z: 0 },
        rotationY: 0,
        scale: { x: 1, y: 1, z: 1 },
    }));
    assertWorldResource(kept);
    assert.deepEqual(kept.description.assetProxies[0].collision[0].vertices, valid.vertices);
    assert.deepEqual(kept.description.assetProxies[0].collision[0].triangles, valid.triangles);
});
