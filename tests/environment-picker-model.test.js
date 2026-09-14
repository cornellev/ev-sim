import assert from "node:assert/strict";
import test from "node:test";

import { createBlankInitialManifest, createGltfInitialManifest, createGoogleInitialManifest } from "../app/3d/environment/EnvironmentCreation.js";
import { environmentSourceKind, environmentSummaryFields } from "../app/3d/environment/EnvironmentManifestPolicy.js";
import {
    canEditIdentity,
    inspectEnvironment,
    shouldLoadOnOpen,
    sourceKindLabel,
} from "../app/3d/environment/environmentPickerModel.js";

const FRAME = { version: 1, projection: "wgs84-local-tangent", axes: "east-up-south", origin: { lat: 42.443, lng: -76.502, height: 0 } };
const SOURCE = {
    version: 2, tileProvider: "google-photorealistic",
    bounds: { north: 42.448, south: 42.438, east: -76.497, west: -76.507 },
    quality: { maxScreenSpaceError: 1, maxCachedTiles: 2000, maxCacheBytes: 1073741824 },
    roadProvider: null, roadFilters: { highwayClasses: [] }, importedLayerIds: ["google-earth-tiles"], importedAt: "2026-09-13T00:00:00.000Z",
};

test("environmentSourceKind classifies blank, google, gltf, and igvc catalogs", () => {
    const blank = createBlankInitialManifest("blank-one");
    const google = createGoogleInitialManifest("google-one", { geoFrame: FRAME, source: SOURCE, includeRoads: false });
    const gltf = createGltfInitialManifest("gltf-one", { assetId: "base", revision: 1, publishedRevision: { version: 1, revision: 1 } });
    assert.equal(environmentSourceKind(blank), "blank");
    assert.equal(environmentSourceKind(google), "google");
    assert.equal(environmentSourceKind(gltf), "gltf");
    assert.equal(environmentSourceKind({ environmentId: "igvc", templateId: "igvc" }), "blank");
    assert.equal(environmentSourceKind({
        environmentId: "legacy-earth",
        templateId: "blank",
        document: { earth: { anchor: { lat: 42.44, lng: -76.5 } } },
    }), "google");
    assert.equal(environmentSummaryFields(blank).sourceKind, "blank");
    assert.equal(environmentSummaryFields(google).sourceKind, "google");
    assert.equal(environmentSummaryFields(gltf).sourceKind, "gltf");
    assert.equal(sourceKindLabel("google"), "Google Earth");
    assert.equal(sourceKindLabel("unknown"), "Blank environment");
});

test("picker inspect helpers do not treat a click as a load", () => {
    const list = [
        { id: "igvc", name: "IGVC", builtIn: true, sourceKind: "blank" },
        { id: "yard", name: "Yard", builtIn: false, sourceKind: "blank" },
    ];
    assert.equal(inspectEnvironment(list, "yard")?.name, "Yard");
    assert.equal(inspectEnvironment(list, "missing"), null);
    assert.equal(canEditIdentity(inspectEnvironment(list, "igvc")), false);
    assert.equal(canEditIdentity(inspectEnvironment(list, "yard")), true);
    assert.equal(shouldLoadOnOpen("yard", "igvc"), true);
    assert.equal(shouldLoadOnOpen("igvc", "igvc"), false);
    assert.equal(shouldLoadOnOpen(null, "igvc"), false);
});
