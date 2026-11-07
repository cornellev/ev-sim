import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as THREE from "three";

import { EnvironmentRegistry } from "../app/3d/editor/EnvironmentRegistry.js";
import { ChunkManager } from "../app/3d/editor/chunks/ChunkManager.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { deltaFromTranslation } from "../app/3d/editor/objects/transformDelta.js";
import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { SceneProjector } from "../app/3d/editor/projection/SceneProjector.js";
import { createDriveAreasProjector } from "../app/3d/editor/projection/projectors/driveAreasProjector.js";
import { createObjectsProjector } from "../app/3d/editor/projection/projectors/objectsProjector.js";
import { PerceptionTruthIndex, perceptionMetadataFromObject } from "../app/autonomy/PerceptionTruthIndex.js";
import { perceptionClassId } from "../app/autonomy/PerceptionLabelCatalog.js";
import { ScenarioMetricCollector } from "../app/scenarios/ScenarioMetrics.js";
import { assertStartPoseClear } from "../app/simulation/headless/EpisodeOverrides.js";
import { pavementPoseIssue } from "../app/simulation/world/DriveAreas.js";
import { createRoadGroundSampler } from "../app/simulation/vehicles/roadGroundSampler.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import { assertWorldResource, createWorldDescription, createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { createPlanningBundle, firstClearRouteIndex, vehicleFootprint } from "../server/headless/PlanningBundle.js";
import { StorageService } from "../server/storage/StorageService.js";

const LOT = [{ x: -10, z: -10 }, { x: 10, z: -10 }, { x: 10, z: 10 }, { x: -10, z: 10 }];

function world(document = {}) {
    return createWorldDescription({ environmentId: "yard", templateId: "blank", document: { driveAreas: [{ id: "lot", footprint: LOT }], ...document } });
}

test("start clearance rejects contained obstacles and applies the vehicle box center", () => {
    for (const yaw of [0, Math.PI / 2]) {
        const footprint = [{ x: -0.1, z: 1.4 }, { x: 0.1, z: 1.4 }, { x: 0.1, z: 1.6 }, { x: -0.1, z: 1.6 }]
            .map(({ x, z }) => ({ x: x * Math.cos(yaw) + z * Math.sin(yaw), z: -x * Math.sin(yaw) + z * Math.cos(yaw) }));
        const description = world({ buildings: [{ buildingId: "inside", height: 2, footprint }] });
        const pose = { x: 0, z: 0, yaw };
        assert.match(pavementPoseIssue(description, pose, { x: 4, z: 4 }), /obstacle/);
        assert.equal(firstClearRouteIndex([pose, { x: Math.cos(yaw) * 5, z: -Math.sin(yaw) * 5 }], { x: 4, z: 4 }, description.obstacles), -1);
    }
    const description = world();
    const size = { x: 2, z: 2 };
    const center = { x: 10, z: 0 };
    assert.match(pavementPoseIssue(description, { x: 0, z: 0, yaw: 0 }, size, center), /drivable surface/);
    assert.deepEqual(vehicleFootprint({ x: 0, z: 0 }, 0, size, center).map((point) => point.x).sort((a, b) => a - b), [9, 9, 11, 11]);
    assert.throws(() => assertStartPoseClear({ world: { description }, vehicles: [{ actorId: "ego", manifest: { boundingBox: { size, center } } }] }, { x: 0, z: 0, yaw: 0 }), /drivable surface/);
});

test("area-only bundle creation rejects a building wholly inside the default car", async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "drive-area-clearance-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const storage = new StorageService(root);
    const original = await storage.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
    const size = getBuiltInVehicleManifest("big-car").boundingBox.size;
    const dx = size.x * 0.03;
    const dz = size.z * 0.03;
    const z = size.z * 0.35;
    await storage.putEnvironment("yard", {
        manifest: {
            ...original,
            document: {
                ...original.document,
                driveAreas: [{ id: "lot", footprint: LOT }],
                buildings: [{ buildingId: "inside", height: 2, footprint: [
                    { x: -dx, z: z - dz }, { x: dx, z: z - dz },
                    { x: dx, z: z + dz }, { x: -dx, z: z + dz },
                ] }],
            },
        },
        expectedRevision: original.revision,
        supportedDriveAreaVersions: [1],
    });
    await assert.rejects(() => createPlanningBundle({ dataDir: root, environmentId: "yard", finish: "none" }), /overlaps an obstacle/);
});

test("v5 cannot omit policies to bypass road, primitive, or floor validation", async () => {
    const fixture = JSON.parse(await readFile(new URL("./fixtures/environment-editor/curved-elevated-network.v2.json", import.meta.url)));
    const roads = world({ roads: fixture.roads });
    assertWorldResource(createWorldResource(roads));
    const missingRoadPolicy = structuredClone(roads);
    delete missingRoadPolicy.roadGeometryPolicy;
    assert.throws(() => assertWorldResource(createWorldResource(missingRoadPolicy)), /road geometry policy/);
    const changedRoad = structuredClone(missingRoadPolicy);
    changedRoad.drivableSurfaces.find((surface) => surface.kind === "road-mesh").vertices[0].y += 100;
    assert.throws(() => assertWorldResource(createWorldResource(changedRoad)), /road geometry policy/);
    for (const document of [{ floor: { enabled: true } }, { primitives: [{ id: "box", shape: "box" }] }]) {
        const description = world(document);
        assertWorldResource(createWorldResource(description));
        delete description.primitivePolicy;
        assert.throws(() => assertWorldResource(createWorldResource(description)), /primitive policy/);
    }
    const floor = world({ floor: { enabled: true } });
    floor.groundPlane.y = 50;
    delete floor.primitivePolicy;
    assert.throws(() => assertWorldResource(createWorldResource(floor)), /primitive policy/);
});

function projectedArea(t) {
    const document = new EnvironmentDocument();
    const scene = new THREE.Scene();
    const registry = new EnvironmentRegistry({ chunkManager: new ChunkManager({ scene }) });
    const projector = new SceneProjector({ document, registry, scene, projectors: [createDriveAreasProjector(), createObjectsProjector()] }).attach();
    t.after(() => projector.dispose());
    const service = createEnvironmentCommandService({ document });
    assert.equal(service.run("addDriveArea", { driveAreaId: "lot", footprint: LOT }).ok, true);
    return { document, registry, scene, projector, service };
}

test("projected area semantics agree with the road class before and after truth refresh", (t) => {
    const { registry, scene, service } = projectedArea(t);
    const check = () => {
        const entity = registry.getEntity("drive-area:lot");
        assert.equal(entity.kind, "drive-area");
        assert.equal(perceptionMetadataFromObject(entity.object3D).semanticClass, "road");
        const truth = new PerceptionTruthIndex().refresh({ scene, environmentRegistry: registry });
        assert.equal(truth.find((entry) => entry.sourceId === "lot").semanticId, perceptionClassId("road"));
        assert.equal(perceptionMetadataFromObject(entity.object3D).semanticClass, "road");
    };
    check();
    assert.equal(service.run("setObjectOptions", { objectId: "lot", patch: { y: 2 } }).ok, true);
    check();
});

test("area regeneration preserves authored names and inherited visibility through undo and reload", (t) => {
    const { document, registry, scene, projector, service } = projectedArea(t);
    assert.equal(service.run("renameObject", { objectId: "lot", name: "Practice yard" }).ok, true);
    assert.equal(service.run("setObjectsHidden", { objectIds: ["lot"], hidden: true }).ok, true);
    const check = () => {
        const entity = registry.getEntity("drive-area:lot");
        assert.equal(entity.visible, false);
        assert.equal(entity.object3D.visible, false);
        assert.equal(entity.label, "Practice yard");
        const meshes = [];
        scene.traverse((object) => { if (object.userData?.driveAreaId === "lot") meshes.push(object); });
        assert.equal(meshes.length, 1, "regeneration removes the previous mesh from its chunk");
    };
    assert.equal(service.run("setObjectOptions", { objectId: "lot", patch: { y: 2 } }).ok, true);
    check();
    assert.equal(service.bus.undo().ok, true);
    check();
    assert.equal(service.bus.redo().ok, true);
    check();
    assert.equal(service.run("setObjectsHidden", { objectIds: ["lot"], hidden: false }).ok, true);
    const grouped = service.run("groupObjects", { objectIds: ["lot"] });
    assert.equal(grouped.ok, true, JSON.stringify(grouped));
    const groupId = document.getObject("lot").parentId;
    assert.equal(service.run("setObjectsHidden", { objectIds: [groupId], hidden: true }).ok, true);
    assert.equal(service.run("transformObjects", { objectIds: [groupId], delta: deltaFromTranslation({ x: 3, z: 4 }) }).ok, true);
    check();
    document.restoreSnapshot(JSON.parse(JSON.stringify(document.snapshot())));
    projector.applyFullDocument();
    check();
});

test("metric observations use prepared polygons without reading the authored vertices again", () => {
    const environment = { roads: { nodes: [], edges: [] }, driveAreas: [{ id: "lot", footprint: structuredClone(LOT) }] };
    const collector = new ScenarioMetricCollector();
    collector.configure({ environment, footprint: { size: { x: 2, z: 2 }, center: { x: 0, z: 0 } } });
    for (const point of environment.driveAreas[0].footprint) {
        Object.defineProperty(point, "x", { get() { throw new Error("An observation re-read authoring geometry."); } });
    }
    for (let step = 0; step < 10; step += 1) {
        collector.observe({ timeNs: step * 16666667, pose: { x: 0, z: 0, yaw: 0 } });
        assert.equal(collector.current()["off-road"], 0);
    }
});

test("ground queries reuse compiled areas and refresh in-place changes, replacements, and removals", () => {
    const area = { id: "lot", y: 0, footprint: structuredClone(LOT) };
    const environment = { roads: { nodes: [], edges: [] }, driveAreas: [area] };
    const sampler = createRoadGroundSampler(environment);
    for (let step = 0; step < 10; step += 1) assert.equal(sampler.sample(0, 0).y, 0);
    assert.equal(sampler.areaBuilds, 1);
    area.y = 2;
    assert.equal(sampler.sample(0, 0).y, 2);
    assert.equal(sampler.areaBuilds, 2);
    for (const point of area.footprint) point.x += 30;
    assert.equal(sampler.sample(0, 0), null);
    assert.equal(sampler.sample(30, 0).y, 2);
    assert.equal(sampler.areaBuilds, 3);
    environment.driveAreas = [{ id: "replacement", y: 4, footprint: structuredClone(LOT) }];
    assert.equal(sampler.sample(0, 0).y, 4);
    assert.equal(sampler.areaBuilds, 4);
    environment.driveAreas[0].y = Number.NaN;
    assert.throws(() => sampler.sample(0, 0), /finite/);
    environment.driveAreas = [];
    assert.equal(sampler.sample(0, 0), null);
    assert.equal(sampler.areaBuilds, 5);
    assert.equal(sampler.graphBuilds, 0);
    const compiled = createRoadGroundSampler(world());
    for (let step = 0; step < 10; step += 1) assert.equal(compiled.sample(0, 0).y, 0);
    assert.equal(compiled.areaBuilds, 1);
});
