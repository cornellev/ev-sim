import { readFile } from "node:fs/promises";

import { createBuiltInIGVCEnvironmentManifest } from "../../app/3d/igvc/IGVCEnvironmentDocument.js";
import { PLACEMENT_CATALOG } from "../../app/3d/editor/placement/placementCatalogData.js";
import { createLidarGeometryResource } from "../../app/simulation/lidar/LidarGeometry.js";
import { createWorldResource } from "../../app/simulation/world/WorldDescription.js";

export const ENVIRONMENT_EDITOR_BASELINE_KIND = "cev-sim.environment-editor.compatibility-baseline";
export const ENVIRONMENT_EDITOR_BASELINE_VERSION = 1;

const fixtureRoot = new URL("../fixtures/environment-editor/", import.meta.url);

export async function readEnvironmentEditorFixture(name) {
    return JSON.parse(await readFile(new URL(name, fixtureRoot), "utf8"));
}

/**
 * Manifests whose metric identity ED-* PRs must never change: the built-in
 * template, a committed v3 environment, and one synthetic environment that
 * exercises every built-in prop type plus roads, a building, and earth data.
 */
export async function environmentEditorBaselineCases() {
    return [
        { id: "igvc-builtin", source: "createBuiltInIGVCEnvironmentManifest()", manifest: createBuiltInIGVCEnvironmentManifest() },
        { id: "yard-v2", source: "legacy-v2.yard.json", manifest: await readEnvironmentEditorFixture("legacy-v2.yard.json") },
        { id: "city-grid-v3", source: "legacy-v3.city-grid.json", manifest: await readEnvironmentEditorFixture("legacy-v3.city-grid.json") },
        { id: "all-props-v3", source: "all-props.v3.json", manifest: await readEnvironmentEditorFixture("all-props.v3.json") },
    ];
}

export function describeEnvironmentBaseline(manifest) {
    const world = createWorldResource(manifest);
    const lidar = createLidarGeometryResource(world);
    const description = world.description;
    return {
        schemaVersion: manifest.schemaVersion ?? 2,
        worldHash: world.hash,
        roadNetworkHash: description.roadNetworkHash,
        lidarGeometryHash: lidar.hash,
        domainSources: description.domainSources,
        counts: {
            nodes: description.roads.nodes.length,
            edges: description.roads.edges.length,
            buildings: description.buildings.length,
            features: description.features.length,
            obstacles: description.obstacles.length,
            drivableSurfaces: description.drivableSurfaces.length,
        },
        features: description.features.map((feature) => ({
            id: feature.id,
            type: feature.type,
            centerY: feature.transform.position.y,
            yaw: feature.transform.rotation.y,
            size: feature.size,
        })),
    };
}

export async function generateEnvironmentEditorBaseline() {
    const cases = [];
    for (const entry of await environmentEditorBaselineCases()) {
        cases.push({ id: entry.id, source: entry.source, ...describeEnvironmentBaseline(entry.manifest) });
    }
    return {
        kind: ENVIRONMENT_EDITOR_BASELINE_KIND,
        version: ENVIRONMENT_EDITOR_BASELINE_VERSION,
        placementCatalog: PLACEMENT_CATALOG.map((asset) => ({ ...asset })),
        cases,
    };
}
