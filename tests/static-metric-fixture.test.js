import assert from "node:assert/strict";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createLidarGeometryResource } from "../app/simulation/lidar/LidarGeometry.js";
import { visualTruthEntityIds } from "../app/simulation/visual/VisualLayer.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";

function fixtureEnvironment(staticMetricFixtures, staticMetricFixturesAuthored = true) {
    return {
        environmentId: "metric-room",
        templateId: "blank",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: true,
        staticMetricFixturesAuthored,
        document: {
            environmentId: "metric-room",
            roads: { nodes: [], edges: [] },
            buildings: [],
            features: [],
            staticMetricFixtures,
            staticMetricFixturesAuthored,
        },
    };
}

test("optional static metric fixtures persist and enter world and sensor identity", () => {
    const fixtures = [{
        id: "table",
        tags: ["furniture"],
        primitives: [
            { id: "table-top", shape: "box", center: { x: 0, y: 0.75, z: 0 }, size: { x: 1.8, y: 0.1, z: 0.9 } },
            { id: "table-brace", shape: "triangle", vertices: [{ x: -0.5, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 }, { x: 0, y: 0.7, z: 0 }] },
        ],
    }];
    const document = EnvironmentDocument.fromManifest({
        environmentId: "metric-room",
        staticMetricFixturesAuthored: true,
        staticMetricFixtures: fixtures,
    });
    assert.deepEqual(document.toManifest().staticMetricFixtures, fixtures);

    const world = createWorldResource(fixtureEnvironment(fixtures));
    assert.equal(world.description.staticMetricFixtures[0].id, "table");
    assert.equal(visualTruthEntityIds(world.description).has("table"), true);
    assert.ok(world.description.obstacles.some((entry) => entry.sourceId === "table"));

    const lidar = createLidarGeometryResource(world);
    assert.equal(lidar.description.staticPrimitives.length, 2);
    assert.deepEqual(lidar.description.staticPrimitives.map((entry) => entry.shape), ["triangle", "box"]);
    assert.equal(new Set(lidar.description.staticPrimitives.map((entry) => entry.instanceId)).size, 1);
});

test("absent and unauthored empty metric fixture domains preserve legacy world bytes", () => {
    const absent = createWorldResource(fixtureEnvironment(undefined, false));
    const empty = createWorldResource(fixtureEnvironment([], false));
    assert.equal(absent.hash, empty.hash);
    assert.equal(Object.hasOwn(absent.description, "staticMetricFixtures"), false);
    assert.equal(Object.hasOwn(absent.description.domainSources, "staticMetricFixtures"), false);
});

test("metric primitive ids are globally unique and geometry is validated", () => {
    assert.throws(() => createWorldResource(fixtureEnvironment([
        { id: "a", primitives: [{ id: "shared", shape: "box", center: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }] },
        { id: "b", primitives: [{ id: "shared", shape: "box", center: { x: 2, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 } }] },
    ])), /unique across fixtures/);
});
