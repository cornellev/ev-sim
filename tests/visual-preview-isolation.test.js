import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import { EnvironmentRegistry } from "../app/3d/editor/EnvironmentRegistry.js";
import {
    isVisualPreviewObject,
    sanitizePreviewObject,
} from "../app/3d/environment/visual/VisualPreviewIsolation.js";
import { PerceptionTruthIndex } from "../app/autonomy/PerceptionTruthIndex.js";
import {
    MEASURED_PERCEPTION_CONFIG,
    MEASURED_STATE_CONFIG,
} from "../app/simulation/headless/ProfileRegistry.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";

const root = new URL("../", import.meta.url);

test("preview sanitization overwrites imported extras and stays out of registry and perception truth", () => {
    const scene = new THREE.Scene();
    const building = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    building.userData = { buildingId: "metric-building" };
    scene.add(building);

    const preview = new THREE.Group();
    const forged = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    forged.userData = {
        buildingId: "forged-building",
        perceptionSourceId: "forged-perception",
        perceptionKind: "building",
        collisionBodyId: "forged-collision",
        lidarId: "forged-lidar",
        extras: { nested: { id: "leak" } },
    };
    preview.add(forged);
    sanitizePreviewObject(preview, {
        layerHash: "a".repeat(64),
        instanceId: "visual-0",
        bindingId: "binding-0",
    });
    scene.add(preview);

    assert.equal(isVisualPreviewObject(forged), true);
    assert.equal(isVisualPreviewObject(preview), true);
    assert.equal(forged.userData.buildingId, undefined);
    assert.equal(forged.userData.perceptionSourceId, undefined);
    assert.equal(forged.userData.collisionBodyId, undefined);
    assert.equal(forged.userData.truthEntityId, undefined);
    assert.equal(forged.userData.cevSimVisualPreviewOnly, true);
    assert.equal(forged.userData.skipEnvironmentSelection, true);

    const registry = new EnvironmentRegistry();
    registry.registerExistingContent(scene, { bakeRunConfig: () => ({ buildings: [] }), city: () => null });
    const kinds = registry.listEntities().map((entity) => entity.kind);
    assert.equal(kinds.includes("building") && registry.listEntities().some((entity) => (
        entity.sourceId === "forged-building" || entity.id.includes("forged")
    )), false);
    assert.equal(registry.findEntityFromObject3D(forged), null);
    assert.equal(registry.listEntities().length, 1);

    const truth = new PerceptionTruthIndex();
    const snapshot = truth.refresh({ scene, environmentRegistry: registry });
    assert.equal(snapshot.some((entity) => entity.sourceId === "forged-perception"), false);
    assert.equal(snapshot.some((entity) => entity.sourceId === "visual-0"), false);
});

test("G-ISOLATION world identity and measured observation schemas stay independent of preview markers", () => {
    const manifest = {
        environmentId: "yard",
        templateId: "blank",
        roadStylePreset: "default",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: false,
        visualLayer: {
            descriptorHash: "a".repeat(64),
            accessHash: "b".repeat(64),
        },
        evidence: { reportHash: "c".repeat(64) },
        document: {
            environmentId: "yard",
            chunkSize: 20,
            roads: {
                nodes: [{ id: "n0", x: 0, z: 0 }, { id: "n1", x: 10, z: 0 }],
                edges: [{ id: "e0", startNodeId: "n0", endNodeId: "n1", bidirectional: true, width: 4, laneCount: 1 }],
            },
            buildings: [{
                buildingId: "building-0",
                footprint: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 4 }, { x: 0, z: 4 }],
                height: 8,
            }],
            features: [],
            earth: null,
            roadsAuthored: true,
            buildingsAuthored: true,
            featuresAuthored: false,
        },
    };
    const withPreview = createWorldResource(manifest);
    const withoutPreview = createWorldResource({ ...manifest, visualLayer: null, evidence: null });
    assert.equal(withPreview.hash, withoutPreview.hash);
    assert.equal(MEASURED_PERCEPTION_CONFIG.oracleProducts, "excluded");
    assert.equal(MEASURED_STATE_CONFIG.kind, "cev-sim.observation-profile-config");
    assert.equal(JSON.stringify(MEASURED_STATE_CONFIG).includes("g-buffer"), false);
    assert.equal(JSON.stringify(MEASURED_PERCEPTION_CONFIG).includes("oracle"), true);
});

test("measured camera products exclude visual preview objects", async () => {
    const source = await readFile(new URL("app/3d/perception/CameraRenderProducts.js", root), "utf8");
    assert.match(source, /if \(isVisualPreviewObject\(object\)\) return true;/);
});
