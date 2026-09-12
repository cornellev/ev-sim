import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { materializeCompiledRoadNetwork } from "../app/3d/city/RoadNetwork.js";
import { createLidarGeometry } from "../app/simulation/lidar/LidarGeometry.js";
import { assertWorldResource, createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { planRoadNetworkGeometry } from "../app/roads/RoadNetworkGeometry.js";

async function authored() {
    return JSON.parse(await readFile(new URL("./fixtures/environment-editor/curved-elevated-network.v2.json", import.meta.url)));
}

function floatPoint(point) {
    return [Math.fround(point.x), Math.fround(point.y), Math.fround(point.z)];
}

test("ED-04 world, browser materialization, and portable LiDAR share indexed road triangles", async () => {
    const document = await authored();
    const manifest = { environmentId: document.environmentId, templateId: "blank", roadsAuthored: true, document };
    const world = createWorldResource(manifest);
    assert.equal(assertWorldResource(world).version, 2);
    const plan = planRoadNetworkGeometry(document.roads);
    const browser = materializeCompiledRoadNetwork(null, plan);
    const surface = world.description.drivableSurfaces.find((entry) => entry.sourceId === "curve");
    const lidar = createLidarGeometry(world);
    const twins = lidar.staticPrimitives.filter((entry) => entry.sourceId === "curve");
    assert.equal(browser.roads[0].triangles.length, surface.indices.length / 3);
    assert.equal(twins.length, browser.roads[0].triangles.length);
    const triangle = browser.roads[0].triangles[0];
    const runtimeTriangle = [triangle.a, triangle.b, triangle.c].map((point) => point.toArray());
    const expectedTriangle = surface.indices.slice(0, 3).map((index) => floatPoint(surface.vertices[index]));
    assert.deepEqual(runtimeTriangle, expectedTriangle);
    assert.equal(twins[0].id, "road-surface:curve:0");
});

test("ED-04 compiler cache reuses untouched runtime inputs", async () => {
    const document = await authored();
    const cache = new Map();
    const first = planRoadNetworkGeometry(document.roads, { cache });
    const second = planRoadNetworkGeometry(document.roads, { cache });
    assert.equal(first.edges[0].samples, second.edges[0].samples);
    assert.equal(first.edges[0].surface, second.edges[0].surface);
});
