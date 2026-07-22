import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { buildRoadNetwork } from "../app/3d/city/RoadNetwork.js";
import { getEnvironmentApplyPolicy } from "../app/3d/environment/EnvironmentManifestPolicy.js";
import Unit from "../app/util/Unit.js";

test("legacy IGVC manifests preserve native template roads", () => {
    const policy = getEnvironmentApplyPolicy({
        environmentId: "igvc",
        document: {
            roads: {
                nodes: [{ id: "hydrated", x: 0, z: 0 }],
                edges: [],
            },
        },
    }, "igvc");

    assert.equal(policy.roadsAuthored, false);
    assert.equal(policy.rebuildRoads, false);
});

test("explicitly authored roads rebuild in every template", () => {
    const policy = getEnvironmentApplyPolicy({
        document: { roadsAuthored: true },
    }, "igvc");

    assert.equal(policy.roadsAuthored, true);
    assert.equal(policy.rebuildRoads, true);
});

test("road network builder preserves per-edge width, shoulders, and explicit arms", () => {
    const vectors = new Map([
        ["a", new THREE.Vector3(0, 0, 0)],
        ["b", new THREE.Vector3(20, 0, 0)],
    ]);
    const result = buildRoadNetwork(null, vectors, [[
        "a",
        "b",
        true,
        {
            width: 6.096,
            laneCount: 2,
            shoulderWidth: 3,
            startArm: { x: 2, z: 0 },
            endArm: { x: 18, z: 0 },
        },
    ]]);
    const road = result.roads[0];

    assert.equal(road.width.getValue(Unit.Type.METER), 6.096);
    assert.equal(road.options.laneCount, 2);
    assert.equal(road.options.shoulderWidth, 3);
    assert.equal(road.points[0].x, 2);
    assert.equal(road.points.at(-1).x, 18);
});

