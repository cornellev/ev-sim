import assert from "node:assert/strict";
import test from "node:test";

import { createBuiltInIGVCEnvironmentDocument } from "../app/3d/igvc/IGVCEnvironmentDocument.js";
import { createPhysicsBackendSelection } from "../app/physics/PhysicsBackend.js";
import { hashEnvironmentRoadNetwork } from "../app/scenarios/route/roadGraph.js";
import {
    createWorldDescription,
    createWorldResource,
} from "../app/simulation/world/WorldDescription.js";
import { StorageService } from "../server/storage/StorageService.js";

function manifest(overrides = {}) {
    return {
        environmentId: "world-test",
        templateId: "blank",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: true,
        document: {
            roads: { nodes: [], edges: [] },
            buildings: [],
            features: [],
        },
        ...overrides,
    };
}

test("IGVC world fallback is complete, stable, and preserves road identity", () => {
    const source = createBuiltInIGVCEnvironmentDocument();
    const world = createWorldDescription({ environmentId: "igvc", templateId: "igvc", document: {} });
    assert.equal(world.kind, "cev-sim.world-description");
    assert.equal(world.version, 1);
    assert.equal(world.roads.edges.length, 12);
    assert.ok(world.features.some((entry) => entry.type === "stop-sign"));
    assert.ok(world.features.some((entry) => entry.type === "barrel"));
    assert.ok(world.buildings.length > 0);
    assert.equal(world.roadNetworkHash, hashEnvironmentRoadNetwork(source));
    assert.deepEqual(createWorldResource(world), createWorldResource(world));
    assert.ok(world.bounds.min.x < world.bounds.max.x);
    assert.ok(world.bounds.min.z < world.bounds.max.z);
});

test("authored domains, including empty arrays, win over hydrated/template data", () => {
    const empty = createWorldDescription({
        environmentId: "igvc",
        templateId: "igvc",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: true,
        document: {
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: true,
            roads: { nodes: [], edges: [] },
            buildings: [],
            features: [],
        },
    });
    assert.deepEqual(empty.roads, { nodes: [], edges: [] });
    assert.deepEqual(empty.buildings, []);
    assert.deepEqual(empty.features, []);
    assert.deepEqual(empty.domainSources, {
        roads: "authored",
        buildings: "authored",
        features: "authored",
    });

    const hydrated = createBuiltInIGVCEnvironmentDocument();
    hydrated.roads.edges[0].id = "persisted-road-id";
    hydrated.features[0].id = "persisted-feature-id";
    const persisted = createWorldDescription({
        environmentId: "igvc",
        templateId: "igvc",
        document: hydrated,
    });
    assert.ok(persisted.roads.edges.some((entry) => entry.id === "persisted-road-id"));
    assert.ok(persisted.features.some((entry) => entry.id === "persisted-feature-id"));
    assert.equal(persisted.domainSources.roads, "persisted-template");
});

test("world normalization sorts IDs and emits exact collision geometry", () => {
    const world = createWorldDescription(manifest({
        document: {
            roads: {
                nodes: [
                    { id: "z", x: 10, z: 0 },
                    { id: "a", x: 0, z: 0 },
                ],
                edges: [{ id: "road-z", startNodeId: "a", endNodeId: "z", width: 6 }],
            },
            buildings: [{
                buildingId: "building-z",
                footprint: [{ x: 1, z: 1 }, { x: 5, z: 2 }, { x: 4, z: 5 }, { x: 0, z: 4 }],
                height: 7,
            }],
            features: [{ id: "feature-a", type: "stop-sign", x: 8, z: 3, dir: 1, rotationY: 0.25 }],
        },
    }));
    assert.deepEqual(world.roads.nodes.map((entry) => entry.id), ["a", "z"]);
    assert.equal(world.drivableSurfaces[0].sourceId, "road-z");
    assert.deepEqual(world.drivableSurfaces[0].bounds, {
        min: { x: 0, y: 0, z: -3 },
        max: { x: 10, y: 0, z: 3 },
    });
    assert.equal(world.obstacles.length, 2);
    assert.equal(world.obstacles.find((entry) => entry.sourceId === "building-z").triangles.length, 2);
    assert.equal(world.obstacles.find((entry) => entry.sourceId === "feature-a").shape, "oriented-box-prism");
});

test("world validation rejects duplicate IDs, invalid references, feature types, and non-finite geometry", () => {
    assert.throws(() => createWorldDescription(manifest({
        document: { roads: { nodes: [{ id: "a", x: 0, z: 0 }, { id: "a", x: 1, z: 1 }], edges: [] }, buildings: [], features: [] },
    })), /Duplicate road node ID/);
    assert.throws(() => createWorldDescription(manifest({
        document: { roads: { nodes: [{ id: "a", x: 0, z: 0 }], edges: [{ id: "e", startNodeId: "a", endNodeId: "missing" }] }, buildings: [], features: [] },
    })), /missing end node/);
    assert.throws(() => createWorldDescription(manifest({
        document: { roads: { nodes: [], edges: [] }, buildings: [], features: [{ id: "x", type: "tree", x: 0, z: 0 }] },
    })), /unknown type/);
    assert.throws(() => createWorldDescription(manifest({
        document: { roads: { nodes: [], edges: [] }, buildings: [], features: [{ id: "x", type: "cone", x: Infinity, z: 0 }] },
    })), /must be finite/);
});

test("resolved runs embed world and pinned physics identities", async () => {
    const resolved = await new StorageService().resolveRunManifest("igvc-default");
    assert.equal(resolved.dependencyHashes.world, resolved.world.hash);
    assert.deepEqual(resolved.backendSelections, [createPhysicsBackendSelection()]);
    assert.equal(resolved.world.description.roadNetworkHash, hashEnvironmentRoadNetwork(resolved.environment.manifest));
});
