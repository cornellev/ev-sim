import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EnvironmentDocument } from "../app/3d/editor/document/EnvironmentDocument.js";
import { createEnvironmentCommandService } from "../app/3d/editor/commands/EnvironmentCommandService.js";
import { createDriveAreasProjector } from "../app/3d/editor/projection/projectors/driveAreasProjector.js";
import { collectMapFitPoints } from "../app/3d/editor/map/mapDocument.js";
import { pickMapTarget } from "../app/3d/editor/map/mapHitTest.js";
import { deltaFromScale, deltaFromTranslation, deltaFromYaw } from "../app/3d/editor/objects/transformDelta.js";
import { ScenarioMetricCollector } from "../app/scenarios/ScenarioMetrics.js";
import {
    HeadlessEpisode,
    TERMINATION_REASON,
} from "../app/simulation/headless/HeadlessEpisode.js";
import { planningOracleProfileRef } from "../app/simulation/headless/ProfileRegistry.js";
import { unpackTensor } from "../app/simulation/headless/TensorProtocol.js";
import { createLidarGeometry } from "../app/simulation/lidar/LidarGeometry.js";
import { OracleOccupancyGrid } from "../app/simulation/occupancy/OracleOccupancyGrid.js";
import { createRoadGroundSampler } from "../app/simulation/vehicles/roadGroundSampler.js";
import {
    compileDriveAreaSurfaces,
    normalizeDriveAreaFootprint,
    pavementPoseIssue,
    pointInDriveAreaSurface,
    polygonCentroidXZ,
    rectangleDriveAreaFootprint,
    triangulateFootprint,
} from "../app/simulation/world/DriveAreas.js";
import {
    assertWorldResource,
    createWorldDescription,
    createWorldResource,
    WORLD_DESCRIPTION_V5,
} from "../app/simulation/world/WorldDescription.js";
import {
    ENVIRONMENT_DRIVE_AREA_DOWNGRADE,
    ENVIRONMENT_DRIVE_AREA_INVALID,
} from "../app/3d/environment/EnvironmentManifestPolicy.js";
import { registerEnvironmentTools } from "../server/mcp/environmentTools.js";
import { createPlanningBundle } from "../server/headless/PlanningBundle.js";
import { StorageService } from "../server/storage/StorageService.js";

const C_FOOTPRINT = [
    { x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 2 }, { x: 2, z: 2 },
    { x: 2, z: 6 }, { x: 6, z: 6 }, { x: 6, z: 8 }, { x: 0, z: 8 },
];
const LOT = [
    { x: 10, z: -20 }, { x: 40, z: -20 }, { x: 40, z: 10 }, { x: 10, z: 10 },
];
const CAPABLE = {
    supportedRoadGeometryVersions: [1, 2],
    supportedAssetMetricVersions: [1],
    supportedEditorSourceVersions: [1],
    supportedScenePrimitiveVersions: [1],
    supportedDriveAreaVersions: [1],
};

function blank(document = {}) {
    return createWorldDescription({
        environmentId: "yard",
        templateId: "blank",
        document: { environmentId: "yard", ...document },
    });
}

function areaWorld(footprint, id = "lot", y = 0, extra = {}) {
    return blank({
        ...extra,
        driveAreas: [{ id, y, footprint }],
    });
}

function failureText(result) {
    return result.error || (result.issues ?? []).map((issue) => issue.message).join(" ");
}

function serviceFor(document = new EnvironmentDocument()) {
    return { document, service: createEnvironmentCommandService({ document }) };
}

function occupancyCell(grid, sample, x, z) {
    const col = Math.floor((x - sample.originX) / sample.resolutionM);
    const row = Math.floor((z - sample.originZ) / sample.resolutionM);
    return sample.cells[row * grid.cells + col];
}

async function tempService() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-drive-area-"));
    return { dir, service: new StorageService(dir) };
}

function mcpTools(storage) {
    const tools = new Map();
    registerEnvironmentTools({ registerTool(name, _definition, handler) { tools.set(name, handler); } }, storage);
    return (name, args) => tools.get(name)(args).then((result) => ({
        ...JSON.parse(result.content[0].text),
        isError: result.isError === true,
    }));
}

async function putAreas(service, id, created, driveAreas) {
    const current = await service.getEnvironment(id);
    await service.putEnvironment(id, {
        manifest: { ...current, document: { ...current.document, driveAreas } },
        expectedRevision: current.revision,
        ...CAPABLE,
    });
    return service.getEnvironment(id);
}

test("polygons, shared triangles, and world v5 stay canonical", () => {
    const plain = blank();
    const empty = blank({ driveAreas: [] });
    assert.equal(JSON.stringify(plain), JSON.stringify(empty));
    assert.equal(createWorldResource(plain).hash, createWorldResource(empty).hash);
    assert.ok(plain.version < WORLD_DESCRIPTION_V5);

    const rectangle = rectangleDriveAreaFootprint({ x: 0, z: 0 }, { x: 4, z: 6 });
    assert.throws(() => rectangleDriveAreaFootprint({ x: 0, z: 0 }, { x: 1, z: 4 }), /2/);
    assert.deepEqual(compileDriveAreaSurfaces([{ id: "lot", y: 1, footprint: rectangle }])[0].triangles, triangulateFootprint(rectangle));
    const concave = normalizeDriveAreaFootprint(C_FOOTPRINT);
    assert.ok(concave.length >= 3);
    assert.throws(() => normalizeDriveAreaFootprint([{ x: 0, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 2, z: 0 }]), /self-intersects/);
    assert.throws(() => normalizeDriveAreaFootprint([{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 3, z: 1 }, { x: 1, z: 0 }, { x: 0, z: 1 }]), /self-intersects/);
    assert.throws(() => normalizeDriveAreaFootprint([{ x: Number.NaN, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 1 }]), /finite/);

    const notch = areaWorld(C_FOOTPRINT, "c");
    assert.equal(notch.version, WORLD_DESCRIPTION_V5);
    assert.equal(notch.roadNetworkHash, plain.roadNetworkHash);
    const surface = notch.drivableSurfaces.find((entry) => entry.kind === "area-polygon");
    assert.equal(pointInDriveAreaSurface({ x: 4, z: 4 }, surface), false);
    assert.equal(pointInDriveAreaSurface({ x: 1, z: 4 }, surface), true);
    assert.match(pavementPoseIssue(notch, { x: 4, z: 4, yaw: 0 }, { x: 2.7, z: 1.3 }), /drivable surface/);
    const grid = new OracleOccupancyGrid(notch, { resolutionM: 1, cells: 16 });
    const sample = grid.sample({ x: 4, z: 4 });
    assert.equal(occupancyCell(grid, sample, 4, 4), 1);
    assert.equal(occupancyCell(grid, sample, 1, 4), 0);
    const lidar = createLidarGeometry(createWorldResource(notch));
    assert.ok(lidar.staticPrimitives.some((primitive) => JSON.stringify(primitive.tags ?? primitive).includes("road")));
    assertWorldResource(createWorldResource(notch));

    const tampered = structuredClone(notch);
    tampered.drivableSurfaces.find((entry) => entry.kind === "area-polygon").triangles = [[0, 0, 0]];
    assert.throws(() => assertWorldResource(createWorldResource(tampered)), /canonical footprint/);
    const moved = structuredClone(notch);
    moved.bounds = { ...moved.bounds, max: { ...moved.bounds.max, x: moved.bounds.max.x + 5 } };
    assert.throws(() => assertWorldResource(createWorldResource(moved)), /bounds/);
    const legacy = structuredClone(plain);
    legacy.drivableSurfaces.push(surface);
    assert.throws(() => assertWorldResource(createWorldResource(legacy)), /version 5/);
    const stripped = structuredClone(notch);
    stripped.drivableSurfaces = stripped.drivableSurfaces.filter((entry) => entry.kind !== "area-polygon");
    assert.throws(() => assertWorldResource(createWorldResource(stripped)), /at least one/);

    const mixed = blank({
        primitives: [{ id: "crate", shape: "box", tags: ["sign"] }],
        floor: { enabled: true },
        objects: [{
            id: "crate",
            typeId: "primitive",
            typeVersion: 1,
            name: "Box",
            parentId: null,
            order: 0,
            components: { tags: ["sign"], rigidBody: { mass: 9, bodyType: "kinematic" } },
        }],
        driveAreas: [{ id: "lot", y: 0, footprint: LOT }],
    });
    assert.equal(mixed.version, WORLD_DESCRIPTION_V5);
    assert.equal(mixed.primitives.length, 1);
    assert.ok(mixed.rigidBodies.length >= 1);
    assert.equal(mixed.groundPlane.id, "floor");
    assert.equal(mixed.groundPlane.y, 0);
    assertWorldResource(createWorldResource(mixed));
});

test("commands draw, move, elevate, duplicate, delete, and undo an area", () => {
    const { document, service } = serviceFor();
    const empty = document.snapshot();
    assert.equal("driveAreas" in empty, false);
    const tiny = service.run("addDriveArea", { cornerA: { x: 0, z: 0 }, cornerB: { x: 1, z: 1 } });
    assert.equal(tiny.ok, false);
    assert.match(failureText(tiny), /2/);
    assert.equal(document.driveAreas.length, 0);

    const created = service.run("addDriveArea", {
        driveAreaId: "lot",
        y: 1,
        cornerA: { x: 0, z: 0 },
        cornerB: { x: 12, z: 8 },
    });
    assert.equal(created.ok, true);
    assert.equal(created.result.objectId, "lot");
    assert.equal(document.objects.some((record) => record.id === "lot" && record.typeId === "drive-area"), true);
    const before = document.getDriveArea("lot").footprint.map((point) => point.x);
    assert.equal(service.run("transformObjects", {
        objectIds: ["lot"],
        delta: deltaFromTranslation({ x: 4, z: -2 }),
    }).ok, true);
    assert.ok(document.getDriveArea("lot").footprint.every((point, index) => point.x === before[index] + 4));
    assert.equal(service.run("transformObjects", {
        objectIds: ["lot"],
        delta: deltaFromTranslation({ y: 9 }),
    }).ok, true);
    assert.equal(document.getDriveArea("lot").y, 1);
    const rotated = service.run("transformObjects", { objectIds: ["lot"], delta: deltaFromYaw(0.4) });
    const scaled = service.run("transformObjects", { objectIds: ["lot"], delta: deltaFromScale(2) });
    assert.equal(rotated.issues[0].code, "transform.rotation.unsupported");
    assert.equal(scaled.issues[0].code, "transform.scale.unsupported");
    assert.equal(service.run("setObjectOptions", { objectId: "lot", patch: { y: 2 } }).ok, true);
    assert.equal(document.getDriveArea("lot").y, 2);

    const duplicated = service.run("duplicateObjects", { objectIds: ["lot"] });
    assert.equal(duplicated.ok, true);
    assert.equal(document.driveAreas.length, 2);
    assert.equal(service.run("deleteObjects", { objectIds: [duplicated.result.createdIds[0]] }).ok, true);
    assert.equal(document.driveAreas.length, 1);
    assert.equal(service.bus.undo().ok, true);
    assert.equal(document.driveAreas.length, 2);
    assert.equal(service.bus.undo().ok, true);
    assert.equal(document.driveAreas.length, 1);
    document.restoreSnapshot(empty);
    assert.equal(document.driveAreas.length, 0);

    const { document: polygonDocument, service: polygonService } = serviceFor();
    assert.equal(polygonService.run("addDriveArea", { driveAreaId: "c", footprint: C_FOOTPRINT }).ok, true);
    assert.equal(polygonService.run("addDriveArea", {
        driveAreaId: "cross",
        footprint: [{ x: 0, z: 0 }, { x: 2, z: 2 }, { x: 0, z: 2 }, { x: 2, z: 0 }],
    }).ok, false);
    assert.equal(polygonDocument.driveAreas.length, 1);
    const fit = collectMapFitPoints(polygonDocument);
    assert.ok(fit.some((point) => point.x === 0 && point.z === 0));
    const hit = pickMapTarget(
        { x: 1, z: 4 },
        polygonDocument.snapshot(),
        { zoom: 8 },
        { roads: true, buildings: true, props: false },
    );
    assert.deepEqual(hit, { type: "drive-area", id: "c" });
    assert.equal(pickMapTarget(
        { x: 1, z: 4 },
        polygonDocument.snapshot(),
        { zoom: 8 },
        { roads: false, buildings: true, props: false },
    ), null);

    const added = [];
    const entities = [];
    const triangles = [];
    createDriveAreasProjector().rebuildAll({
        document: polygonDocument,
        scene: { add(mesh) { added.push(mesh); }, remove() {} },
        registry: {
            listEntities: () => entities,
            registerEntity(entity) { entities.push(entity); },
            getEntity: (id) => entities.find((entity) => entity.id === id),
            unregisterEntity() {},
        },
        data: { objects: () => ({ replaceTriangles(_match, next) { triangles.splice(0, triangles.length, ...next); } }) },
    });
    assert.equal(added.length, 1);
    assert.equal(added[0].userData.environmentGeometryType, "drive-area");
    assert.equal(entities[0].kind, "drive-area");
    assert.ok(triangles.length > 0);
    assert.ok(triangles.every((triangle) => triangle.environmentGeometryType === "drive-area"));
});

test("aware writers keep areas and unaware replacements are rejected", async () => {
    const { dir, service } = await tempService();
    try {
        const created = await service.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
        await putAreas(service, "yard", created, [{ id: "lot", y: 1, footprint: LOT }]);
        const stored = await service.getEnvironment("yard");
        assert.equal(stored.document.driveAreas[0].id, "lot");
        await assert.rejects(
            () => service.putEnvironment("yard", {
                manifest: stored,
                expectedRevision: stored.revision,
            }),
            (error) => error.code === ENVIRONMENT_DRIVE_AREA_DOWNGRADE && error.statusCode === 409,
        );
        const blank = await service.createEnvironment({ id: "plain", name: "Plain", templateId: "blank" });
        await assert.rejects(
            () => service.putEnvironment("plain", {
                manifest: { ...blank, document: { ...blank.document, driveAreas: [{ id: "lot", y: 0, footprint: LOT }] } },
                expectedRevision: blank.revision,
            }),
            (error) => error.code === ENVIRONMENT_DRIVE_AREA_DOWNGRADE && error.statusCode === 409,
        );
        await assert.rejects(
            () => service.putEnvironment("yard", {
                manifest: {
                    ...stored,
                    document: { ...stored.document, driveAreas: [{ id: "bad", y: 0, footprint: [{ x: 0, z: 0 }, { x: 1, z: 0 }] }] },
                },
                expectedRevision: stored.revision,
                ...CAPABLE,
            }),
            (error) => error.code === ENVIRONMENT_DRIVE_AREA_INVALID && error.statusCode === 400,
        );
        const renamed = await service.putEnvironment("yard", {
            manifest: { name: "Renamed yard" },
            expectedRevision: stored.revision,
        });
        assert.equal(renamed.name, "Renamed yard");
        assert.equal(renamed.document.driveAreas[0].id, "lot");
        const removed = await service.putEnvironment("yard", {
            manifest: { ...renamed, document: { ...renamed.document, driveAreas: [] } },
            expectedRevision: renamed.revision,
            ...CAPABLE,
        });
        assert.equal(removed.document.driveAreas, undefined);
        await putAreas(service, "yard", removed, [{ id: "lot", y: 1, footprint: LOT }]);
        const again = await service.getEnvironment("yard");
        await service.duplicateEnvironment("yard", { id: "yard-copy", name: "Copy", expectedRevision: again.revision });
        const copy = await service.getEnvironment("yard-copy");
        assert.equal(copy.document.driveAreas[0].id, "lot");

        const call = mcpTools(service);
        const added = await call("environment_add_drive_area", {
            environmentId: "plain",
            id: "pad",
            cornerA: { x: 0, z: 0 },
            cornerB: { x: 8, z: 8 },
        });
        assert.equal(added.isError, false, JSON.stringify(added));
        assert.equal((await service.getEnvironment("plain")).document.driveAreas[0].id, "pad");
        const gone = await call("environment_remove_drive_area", { environmentId: "plain", driveAreaId: "pad" });
        assert.equal(gone.isError, false, JSON.stringify(gone));
        assert.equal((await service.getEnvironment("plain")).document.driveAreas, undefined);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("sampling prefers graded roads and refreshes area elevation without rebuilding the graph", () => {
    const ramp = {
        environmentId: "ramp",
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0, kind: "endpoint" },
                { id: "b", x: 10, y: 5, z: 0, kind: "endpoint" },
            ],
            edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 }],
        },
        driveAreas: [
            { id: "b", y: 4, footprint: [{ x: 0, z: 6 }, { x: 10, z: 6 }, { x: 10, z: 14 }, { x: 0, z: 14 }] },
            { id: "a", y: 9, footprint: [{ x: 0, z: 6 }, { x: 10, z: 6 }, { x: 10, z: 14 }, { x: 0, z: 14 }] },
        ],
    };
    const sampler = createRoadGroundSampler(ramp);
    const onRoad = sampler.sample(5, 0);
    assert.equal(onRoad.kind, "road");
    assert.ok(Math.abs(onRoad.y - 2.5) < 1e-6);
    const onArea = sampler.sample(5, 10);
    assert.equal(onArea.kind, "area");
    assert.equal(onArea.y, 9);
    assert.equal(onArea.pitch, 0);
    assert.deepEqual(onArea.normal, { x: 0, y: 1, z: 0 });
    const builds = sampler.graphBuilds;
    ramp.driveAreas[1].y = 3;
    assert.equal(sampler.sample(5, 10).y, 3);
    assert.equal(sampler.graphBuilds, builds);
    ramp.roads.nodes[1].y = 7;
    sampler.sample(5, 0);
    assert.equal(sampler.graphBuilds, builds + 1);

    const compiled = createWorldDescription({ environmentId: "ramp", document: ramp });
    const headless = createRoadGroundSampler(compiled);
    assert.equal(headless.sample(5, 0).kind, "road");
    assert.ok(Math.abs(headless.sample(5, 0).y - compiledSampleY(sampler, 5, 0)) < 1e-6);
    assert.equal(headless.sample(5, 10).kind, "area");
    const edge = createRoadGroundSampler(areaWorld([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }], "edge", 2));
    assert.equal(edge.sample(0, 5).kind, "area");
    assert.equal(edge.graphBuilds, 0);
    assert.equal(createRoadGroundSampler(blank()).sample(0, 0), null);

    const { document, service } = serviceFor();
    service.run("addDriveArea", { driveAreaId: "lot", cornerA: { x: 0, z: 0 }, cornerB: { x: 20, z: 20 } });
    const live = createRoadGroundSampler(document);
    assert.equal(live.sample(5, 5).y, 0);
    service.run("setObjectOptions", { objectId: "lot", patch: { y: 2 } });
    assert.equal(live.sample(5, 5).y, 2);
    assert.equal(live.graphBuilds, 0);
});

function compiledSampleY(sampler, x, z) {
    return sampler.sample(x, z).y;
}

test("pavement metrics use every corner and stay null without pavement", () => {
    const environment = {
        roads: {
            nodes: [
                { id: "a", x: 0, y: 0, z: 0 },
                { id: "b", x: 30, y: 0, z: 0 },
            ],
            edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 }],
        },
        driveAreas: [{ id: "pad", y: 0, footprint: [{ x: 0, z: 4 }, { x: 30, z: 4 }, { x: 30, z: 16 }, { x: 0, z: 16 }] }],
    };
    const footprint = { size: { x: 2, z: 2 }, center: { x: 0, y: 0, z: 0 } };
    const mixed = new ScenarioMetricCollector();
    mixed.configure({ environment, footprint });
    mixed.observe({ timeNs: 0, pose: { x: 5, z: 4, yaw: 0 } });
    assert.equal(mixed.current()["off-road"], 0);
    assert.equal(mixed.current()["route-progress"], null);
    assert.equal(mixed.current()["wrong-way"], null);
    const outside = new ScenarioMetricCollector();
    outside.configure({ environment, footprint });
    outside.observe({ timeNs: 0, pose: { x: 5, z: 20, yaw: 0 } });
    assert.equal(outside.current()["off-road"], 1);

    const areaOnly = areaWorld([{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }]);
    const inside = new ScenarioMetricCollector();
    inside.configure({
        environment: { document: { driveAreas: [{ id: "lot", y: 0, footprint: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }] }], roads: { nodes: [], edges: [] } } },
        footprint,
    });
    inside.observe({ timeNs: 0, pose: { x: 1, z: 1, yaw: 0 } });
    assert.equal(inside.current()["off-road"], 0);
    assert.equal(inside.finalize().failure, 0);
    const boundary = new ScenarioMetricCollector();
    boundary.configure({ environment: areaOnly, footprint });
    boundary.observe({ timeNs: 0, pose: { x: 0, z: 1, yaw: 0 } });
    assert.equal(boundary.current()["off-road"], 1);
    assert.equal(boundary.finalize().failure, 1);

    const none = new ScenarioMetricCollector();
    none.configure({ environment: blank(), footprint });
    none.observe({ timeNs: 0, pose: { x: 0, z: 0, yaw: 0 } });
    assert.equal(none.current()["off-road"], null);
    assert.equal(none.finalize().failure, null);
});

test("area-only bundles admit, preserve the centroid, and reject bad starts", async () => {
    const { dir, service } = await tempService();
    try {
        await service.createEnvironment({ id: "yard", name: "Yard", templateId: "blank" });
        await putAreas(service, "yard", null, [{ id: "lot", y: 1.5, footprint: LOT }]);
        const bundle = await createPlanningBundle({
            dataDir: dir,
            environmentId: "yard",
            finish: "none",
            bundleId: "yard-run",
        });
        const scenario = bundle.resolved.scenario.scenario;
        assert.equal(scenario.freeDrive, true);
        assert.deepEqual(scenario.routes, []);
        assert.deepEqual(scenario.zones, []);
        assert.ok(JSON.stringify(scenario.triggers).includes("cev-sim.free-drive.stop"));
        const pose = bundle.manifest.initialState.vehicles.find((vehicle) => vehicle.id === "ego").pose;
        const centroid = polygonCentroidXZ(LOT);
        assert.ok(Math.abs(pose.position.x - centroid.x) < 1e-6);
        assert.ok(Math.abs(pose.position.z - centroid.z) < 1e-6);
        assert.ok(Math.abs(pose.position.y - 1.5) < 1e-6);
        assert.equal(pose.rotation.y, 0);
        assert.ok(bundle.resolved.world.description.drivableSurfaces.some((surface) => surface.kind === "area-polygon"));

        const importedDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-drive-import-"));
        try {
            const imported = new StorageService(importedDir);
            await imported.importRunBundle(bundle);
            const environment = await imported.getEnvironment("yard");
            assert.equal(environment.document.driveAreas[0].id, "lot");
        } finally {
            await fs.rm(importedDir, { recursive: true, force: true });
        }

        const episode = new HeadlessEpisode();
        await episode.prepare(bundle.resolved);
        episode.reset();
        const stepped = episode.step([0, 0]);
        assert.equal(stepped.terminated, false);
        const validity = unpackTensor(stepped.observation.entries.find((entry) => entry.name === "task/validity").tensor);
        assert.ok(validity.slice(0, 5).every((value) => !value));
        assert.ok(validity[5]);

        const oracle = new HeadlessEpisode();
        await oracle.prepare(bundle.resolved, { observationProfile: planningOracleProfileRef() });
        oracle.reset({
            observationProfile: planningOracleProfileRef(),
            overrides: {
                goal: { x: pose.position.x, z: pose.position.z, yaw: null, positionToleranceM: 2, yawToleranceRad: Math.PI },
            },
        });
        assert.equal(oracle.step([0, 0]).terminated, true);
        const blockedStart = new HeadlessEpisode();
        await blockedStart.prepare(bundle.resolved);
        assert.throws(
            () => blockedStart.reset({ overrides: { startPose: { x: 1000, z: 1000, yaw: 0 } } }),
            (error) => error.code === "INVALID_REQUEST",
        );

        await putAreas(service, "yard", null, [{ id: "thin", y: 0, footprint: [{ x: 0, z: -10 }, { x: 4, z: -10 }, { x: 4, z: 10 }, { x: 0, z: 10 }] }]);
        const thin = await createPlanningBundle({ dataDir: dir, environmentId: "yard", finish: "none", bundleId: "thin-run" });
        const leaving = new HeadlessEpisode();
        await leaving.prepare(thin.resolved);
        leaving.reset();
        let outcome = null;
        for (let step = 0; step < 400 && !outcome?.terminated; step += 1) outcome = leaving.step([1, 0]);
        assert.equal(outcome.terminated, true);
        assert.equal(outcome.info.terminationReason, TERMINATION_REASON.OFF_ROAD);

        await assert.rejects(
            () => createPlanningBundle({ dataDir: dir, environmentId: "yard", finish: "route", bundleId: "routed" }),
            /--finish none/,
        );
        await assert.rejects(
            () => createPlanningBundle({ dataDir: dir, environmentId: "yard", finish: "none", roadId: "ab", bundleId: "selector" }),
            /selectors/,
        );
        await putAreas(service, "yard", null, [{ id: "small", y: 0, footprint: [{ x: 0, z: 0 }, { x: 2.2, z: 0 }, { x: 2.2, z: 2.2 }, { x: 0, z: 2.2 }] }]);
        await assert.rejects(
            () => createPlanningBundle({ dataDir: dir, environmentId: "yard", finish: "none", bundleId: "small" }),
            /drivable surface/,
        );
        const notchCentroid = polygonCentroidXZ(C_FOOTPRINT);
        const notchWorld = areaWorld(C_FOOTPRINT, "c");
        assert.equal(pointInDriveAreaSurface(
            { x: notchCentroid.x, z: notchCentroid.z },
            notchWorld.drivableSurfaces.find((surface) => surface.kind === "area-polygon"),
        ), false);
        await putAreas(service, "yard", null, [{ id: "c", y: 0, footprint: C_FOOTPRINT }]);
        await assert.rejects(
            () => createPlanningBundle({ dataDir: dir, environmentId: "yard", finish: "none", bundleId: "notch" }),
            /drivable surface/,
        );
        await putAreas(service, "yard", null, [{ id: "lot", y: 0, footprint: LOT }]);
        const current = await service.getEnvironment("yard");
        await service.putEnvironment("yard", {
            manifest: {
                ...current,
                document: {
                    ...current.document,
                    buildings: [{
                        buildingId: "hut",
                        footprint: [
                            { x: centroid.x - 2, z: centroid.z - 2 },
                            { x: centroid.x + 2, z: centroid.z - 2 },
                            { x: centroid.x + 2, z: centroid.z + 2 },
                            { x: centroid.x - 2, z: centroid.z + 2 },
                        ],
                        height: 3,
                    }],
                },
            },
            expectedRevision: current.revision,
            ...CAPABLE,
        });
        await assert.rejects(
            () => createPlanningBundle({ dataDir: dir, environmentId: "yard", finish: "none", bundleId: "blocked" }),
            /obstacle/,
        );

        await service.createEnvironment({ id: "street", name: "Street", templateId: "blank" });
        const street = await service.getEnvironment("street");
        await service.putEnvironment("street", {
            manifest: {
                ...street,
                document: {
                    ...street.document,
                    roads: {
                        nodes: [
                            { id: "a", x: 0, y: 0, z: 0, kind: "endpoint" },
                            { id: "b", x: 40, y: 0, z: 0, kind: "endpoint" },
                        ],
                        edges: [{ id: "ab", startNodeId: "a", endNodeId: "b", bidirectional: true, width: 8, laneCount: 2 }],
                    },
                },
            },
            expectedRevision: street.revision,
            ...CAPABLE,
        });
        await assert.rejects(
            () => createPlanningBundle({ dataDir: dir, environmentId: "street", finish: "none", roadId: "missing", bundleId: "miss" }),
            /no routable road edge/,
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
