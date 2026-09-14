import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createBlankInitialManifest, createGltfInitialManifest, createGoogleInitialManifest } from "../app/3d/environment/EnvironmentCreation.js";
import { ENVIRONMENT_EDITOR_SOURCE_DOWNGRADE, assertNoEditorSourceDowngrade, environmentSourceKind, parseEnvironmentWriteEnvelope } from "../app/3d/environment/EnvironmentManifestPolicy.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { StorageService } from "../server/storage/StorageService.js";

const FRAME = { version: 1, projection: "wgs84-local-tangent", axes: "east-up-south", origin: { lat: 42.443, lng: -76.502, height: 0 } };
const SOURCE = {
    version: 2, tileProvider: "google-photorealistic",
    bounds: { north: 42.448, south: 42.438, east: -76.497, west: -76.507 },
    quality: { maxScreenSpaceError: 1, maxCachedTiles: 2000, maxCacheBytes: 1073741824 },
    roadProvider: null, roadFilters: { highwayClasses: [] }, importedLayerIds: ["google-earth-tiles"], importedAt: "2026-09-13T00:00:00.000Z",
};

test("ED-08 creation builders produce complete Blank, Google, and GLTF revision-one documents", () => {
    const blank = createBlankInitialManifest("blank-one");
    assert.deepEqual(blank.document.roads, { nodes: [], edges: [], turnRules: [] });
    assert.equal(blank.document.objects[0].typeId, "skybox");
    assert.equal(environmentSourceKind(blank), "blank");
    const google = createGoogleInitialManifest("google-one", { geoFrame: FRAME, source: SOURCE, includeRoads: false });
    assert.deepEqual(google.document.geoFrame, FRAME);
    assert.equal(google.document.objects.find((entry) => entry.id === "tile").typeVersion, 1);
    assert.equal(environmentSourceKind(google), "google");
    const gltf = createGltfInitialManifest("gltf-one", { assetId: "base", revision: 1, publishedRevision: { version: 1, revision: 1 }, scale: { x: 2, y: 3, z: 4 } });
    const tile = gltf.document.objects.find((entry) => entry.id === "tile");
    assert.equal(tile.typeVersion, 2);
    assert.equal(environmentSourceKind(gltf), "gltf");
    assert.equal(tile.components.tile.assetTypeVersion, 1);
    assert.deepEqual(tile.components.asset.scale, { x: 2, y: 3, z: 4 });
});

test("ED-08 writer envelopes advertise source support and reject older full-document writers", () => {
    const google = createGoogleInitialManifest("guard", { geoFrame: FRAME, source: SOURCE, includeRoads: false });
    assert.throws(() => assertNoEditorSourceDowngrade(google, null, []), (error) => error.code === ENVIRONMENT_EDITOR_SOURCE_DOWNGRADE && error.statusCode === 409);
    assert.doesNotThrow(() => assertNoEditorSourceDowngrade(google, null, [1]));
    assert.deepEqual(parseEnvironmentWriteEnvelope({ manifest: google, expectedRevision: 0, supportedEditorSourceVersions: [1, 1, "bad"] }).supportedEditorSourceVersions, [1]);
});

test("ED-08 server creates a prepared Google manifest atomically at revision 1", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed08-create-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const service = new StorageService(dir);
    const initialManifest = createGoogleInitialManifest("atomic-google", { geoFrame: FRAME, source: SOURCE, includeRoads: false });
    await assert.rejects(service.createEnvironment({ id: "atomic-google", name: "Atomic Google", initialManifest }), (error) => error.code === ENVIRONMENT_EDITOR_SOURCE_DOWNGRADE);
    await assert.rejects(fs.access(path.join(dir, "environments", "atomic-google.json")));
    const created = await service.createEnvironment({ id: "atomic-google", name: "Atomic Google", initialManifest, supportedEditorSourceVersions: [1] });
    assert.equal(created.revision, 1);
    assert.equal(created.schemaVersion, 4);
    assert.deepEqual(created.document.geoFrame, FRAME);
    assert.equal(created.document.earth.version, 2);
    const listed = (await service.listEnvironments()).find((entry) => entry.id === "atomic-google");
    assert.equal(listed?.sourceKind, "google");
});

test("ED-08 road provenance survives authoring but remains outside metric world identity", () => {
    const manifest = createBlankInitialManifest("hash-source");
    manifest.roadsAuthored = true;
    manifest.document.roadsAuthored = true;
    manifest.document.roads = {
        geometryVersion: 2,
        nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }],
        edges: [{ id: "road", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2, bidirectional: true, geometry: { version: 1, kind: "polyline", knots: [{ id: "start" }, { id: "end" }] } }],
        turnRules: [],
    };
    const before = createWorldResource(manifest).hash;
    manifest.document.roads.nodes[0].source = { providerId: "overpass", importId: "one", osmNodeId: "1" };
    manifest.document.roads.edges[0].source = { providerId: "overpass", importId: "one", osmWayId: "2" };
    assert.equal(createWorldResource(manifest).hash, before);
});
