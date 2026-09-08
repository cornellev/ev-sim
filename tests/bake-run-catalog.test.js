import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { BakePath } from "../app/3d/environment/visualization/BakePath.js";
import { BuildingRegionPlanner } from "../app/3d/environment/visualization/BuildingRegionPlanner.js";
import { BakeSpatialIndex } from "../app/3d/environment/visualization/BakeSpatialIndex.js";
import { createDefaultBakeRunConfig } from "../app/3d/environment/visualization/BakeRunConfig.js";
import {
    BAKE_CAPTURE_PLAN_KIND,
    BAKE_JOB_STATES,
    BAKE_PROVIDER_REQUEST_KIND,
    BAKE_PROVIDER_RESPONSE_KIND,
    BAKE_RUN_CONFIG_KIND,
    BakeProviderRegistry,
    BakeRunCatalog,
    CAPTURED_APPEARANCE_PROVIDER,
    assertBakeRunConfig,
    canonicalizePlannerCandidates,
    createDefaultBakeProviderRegistry,
    hashBakeCapturePlan,
    hashBakeProviderRequest,
    hashBakeProviderResponse,
    hashBakeRunConfig,
    interpolateBakePathSample,
    normalizeBakeCapturePlan,
    normalizeBakeProviderRequest,
    normalizeBakeProviderResponse,
    normalizeBakeRunConfig,
    pathLengthMeters,
    planIntegerSampleDistances,
} from "../app/3d/environment/visual/BakeRunCatalog.js";

const HASH_A = "a".repeat(64);

function smallConfig(overrides = {}) {
    return normalizeBakeRunConfig({
        environmentId: "yard",
        seed: 7,
        paths: [{
            id: "path-0",
            vertices: [
                { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
                { position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
            ],
        }],
        views: [{
            id: "bake/view/main",
            position: { x: 0, y: 1.5, z: 0 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            camera: { width: 2, height: 1, fov: 75, near: 0.1, far: 20 },
        }],
        sampling: { deltaDistance: 2, includeEndpoints: true, captureTimeNs: 99 },
        ...overrides,
    });
}

test("BakeRunConfig round-trips through a strict v1 manifest", () => {
    const config = createDefaultBakeRunConfig({
        environmentId: "igvc",
        seed: 42,
        views: [{
            camera: { width: 4, height: 2, fov: 60, near: 0.2, far: 80 },
            position: { x: 1, y: 2, z: 3 },
            rotation: { x: 0, y: Math.PI / 6, z: 0, order: "XYZ" },
        }],
    });
    const manifest = JSON.parse(JSON.stringify(config.toManifest()));
    const restored = createDefaultBakeRunConfig(manifest);
    assert.equal(restored.kind, BAKE_RUN_CONFIG_KIND);
    assert.equal(restored.version, 1);
    assert.equal(canonicalString(restored.toManifest()), canonicalString(config.toManifest()));
    assert.equal(restored.recipeHash(), config.recipeHash());
    assert.equal(restored.views[0].camera.width, 4);
    assert.equal(restored.views[0].passes[0].id, "beauty");
    assert.equal(restored.splat.renderMode, "projectedTexture");
    assert.equal(restored.roundTrip.useModel, false);
    assert.doesNotMatch(JSON.stringify(restored.recipeIdentity()), /pollIntervalMs|localhost:8000|createdAt|saveRawCaptures/);
});

function canonicalString(value) {
    return JSON.stringify(value);
}

test("strict schema validation rejects unknown fields, non-finite values, and bad rotations", () => {
    const base = smallConfig();
    assert.equal(assertBakeRunConfig(base), base);
    assert.throws(
        () => normalizeBakeRunConfig({ ...base, extraField: true }),
        /not supported/,
    );
    assert.throws(
        () => normalizeBakeRunConfig({ ...base, seed: Number.POSITIVE_INFINITY }),
        /finite/,
    );
    assert.throws(
        () => normalizeBakeRunConfig({
            ...base,
            views: [{
                id: "a",
                position: { x: 0, y: 1, z: 0 },
                rotation: { x: 0, y: 0, z: 0, order: "YXZ" },
                camera: { width: 2, height: 1, fov: 75, near: 0.1, far: 20 },
            }],
        }),
        /XYZ/,
    );
    assert.throws(
        () => normalizeBakeRunConfig({
            ...base,
            views: [
                { ...base.views[0], id: "dup" },
                { ...base.views[0], id: "dup" },
            ],
        }),
        /duplicate/,
    );
    assert.throws(
        () => normalizeBakeRunConfig({ ...base, version: 2 }),
        /unsupported/,
    );
});

test("recipe hashes are stable under key reorder and ignore mutable operational fields", () => {
    const left = hashBakeRunConfig(smallConfig({
        operational: { host: "http://localhost:8000", roundTrip: { timeoutMs: 1 } },
    }));
    const right = hashBakeRunConfig({
        ...smallConfig(),
        operational: {
            host: "http://example.test:9",
            runId: "other-job",
            createdAt: "2026-09-07T00:00:00.000Z",
            roundTrip: { useModel: false, pollIntervalMs: 9, timeoutMs: 9, resultEndpoint: "/other" },
            debug: { saveRawCaptures: true, logPipeline: true },
        },
    });
    assert.equal(left, right);
    const providerDefault = hashBakeRunConfig(smallConfig());
    const providerExplicit = hashBakeRunConfig(smallConfig({
        provider: { ...CAPTURED_APPEARANCE_PROVIDER },
        providerOptions: { transform: "identity" },
    }));
    assert.equal(providerDefault, providerExplicit);
    const reorderedOptions = hashBakeRunConfig(smallConfig({
        providerOptions: { transform: "identity" },
        cachePolicy: { mode: "none" },
    }));
    assert.equal(providerDefault, reorderedOptions);
});

test("integer-index sampling keeps endpoints and holds zero-length segments", () => {
    const distances = planIntegerSampleDistances(10, {
        deltaDistance: 3,
        includeEndpoints: true,
    });
    assert.deepEqual([...distances], [0, 3, 6, 9, 10]);
    const zero = interpolateBakePathSample([
        { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { position: { x: 2, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ], 0);
    assert.equal(zero.t, 0);
    assert.equal(zero.position.x, 1);
    const path = new BakePath([
        { position: new THREE.Vector3(0, 0, 0) },
        { position: new THREE.Vector3(0, 0, 0) },
        { position: new THREE.Vector3(4, 0, 0) },
    ]);
    const first = path.sampleAtIndex(0, 2);
    assert.equal(first.position.x, 0);
    assert.equal(first.t, 0);
    const end = path.sampleAtIndex(planIntegerSampleDistances(path.totalLength, { deltaDistance: 2, includeEndpoints: true }).length - 1, 2);
    assert.equal(end.position.x, 4);
    assert.equal(pathLengthMeters({ vertices: path.vertices.map((vertex) => ({ position: vertex.position })) }), 4);
    const pastZero = interpolateBakePathSample([
        { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
        { position: { x: 4, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    ], 4);
    assert.equal(pastZero.position.x, 4);
});

test("planner canonicalizes UTF-8 ids before projection regardless of insertion or index order", () => {
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.position.set(0, 2, 8);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);

    function sceneWithOrder(ids) {
        const scene = new THREE.Scene();
        for (const id of ids) {
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
            mesh.userData.buildingId = id;
            scene.add(mesh);
        }
        return scene;
    }

    const planner = new BuildingRegionPlanner([], { rotationIndex: 0 });
    const first = planner.planForView(sceneWithOrder(["zeta", "alpha", "mu"]), camera);
    const second = planner.planForView(sceneWithOrder(["mu", "zeta", "alpha"]), camera);
    assert.deepEqual(first.visibleBuildingIds, second.visibleBuildingIds);
    assert.equal(first.activeBuildingId, second.activeBuildingId);
    assert.equal(first.activeBuildingId, "alpha");

    const indexA = new BakeSpatialIndex();
    indexA.upsert({ id: "zeta", entityId: "building:zeta", kind: "building", bounds: { minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 2, maxZ: 1 } });
    indexA.upsert({ id: "alpha", entityId: "building:alpha", kind: "building", bounds: { minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 2, maxZ: 1 } });
    const indexB = new BakeSpatialIndex();
    indexB.upsert({ id: "alpha", entityId: "building:alpha", kind: "building", bounds: { minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 2, maxZ: 1 } });
    indexB.upsert({ id: "zeta", entityId: "building:zeta", kind: "building", bounds: { minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 2, maxZ: 1 } });
    assert.deepEqual(
        planner.planForView(indexA, camera).visibleBuildingIds,
        planner.planForView(indexB, camera).visibleBuildingIds,
    );
    assert.deepEqual(
        canonicalizePlannerCandidates([{ id: "b" }, { id: "a" }]).map((entry) => entry.id),
        ["a", "b"],
    );
});

test("mutable job status does not change immutable hashes", () => {
    const catalog = new BakeRunCatalog({ now: () => 1000 });
    const job = catalog.createJob(smallConfig(), { jobId: "job-status" });
    const recipeHash = job.recipeHash;
    catalog.appendLog(job.jobId, "running");
    catalog.updateStatus(job.jobId, {
        timestamps: { startedAt: 2000 },
        progress: { completedSamples: 3, totalSamples: 9 },
    });
    assert.equal(catalog.get(job.jobId).recipeHash, recipeHash);
    assert.equal(catalog.get(job.jobId).status.jobId, "job-status");
    assert.equal(catalog.get(job.jobId).status.logs.length, 1);
    assert.notEqual(catalog.get(job.jobId).status.timestamps.startedAt, catalog.get(job.jobId).status.timestamps.createdAt);
});

test("unavailable providers fail before a registry execute and captured-appearance is identity-local", async () => {
    const registry = createDefaultBakeProviderRegistry();
    assert.equal(registry.has(CAPTURED_APPEARANCE_PROVIDER), true);
    assert.throws(
        () => registry.preflight({ id: "pbr-mesh", version: 1 }),
        (error) => error.code === "BAKE_PROVIDER_UNAVAILABLE",
    );
    const catalog = new BakeRunCatalog({ providers: registry });
    assert.throws(
        () => catalog.createJob(smallConfig({ provider: { id: "missing-model", version: 1 } })),
        (error) => error.code === "BAKE_PROVIDER_UNAVAILABLE",
    );
    const request = normalizeBakeProviderRequest({
        kind: BAKE_PROVIDER_REQUEST_KIND,
        version: 1,
        recipeHash: HASH_A,
        snapshotHash: HASH_A,
        planHash: HASH_A,
        provider: CAPTURED_APPEARANCE_PROVIDER,
        providerOptions: { transform: "identity" },
        cachePolicy: { mode: "none" },
        seed: 7,
        inputs: [{
            sampleId: "bake-7:path-0:0",
            viewId: "bake/view/main",
            role: "beauty",
            mediaType: "image/x.cev-sim.rgba8-srgb",
            encoding: "rgba8-srgb",
            byteSize: 8,
            width: 2,
            height: 1,
            sha256: HASH_A,
        }, {
            sampleId: "bake-7:path-0:0",
            viewId: "bake/view/main",
            role: "validity",
            mediaType: "application/x.cev-sim.uint8",
            encoding: "uint8",
            byteSize: 2,
            width: 2,
            height: 1,
            sha256: "b".repeat(64),
        }],
    });
    const adapter = registry.preflight(CAPTURED_APPEARANCE_PROVIDER);
    const response = await adapter.execute(request);
    assert.equal(response.requestHash, hashBakeProviderRequest(request));
    assert.equal(response.runtimeStack.kind, "local-no-model");
    assert.equal(response.modelRevision, null);
    assert.equal(response.outputs[0].sha256, HASH_A);
    assert.equal(hashBakeProviderResponse(response), hashBakeProviderResponse(response));

    const injectable = new BakeProviderRegistry();
    injectable.register({
        id: "future-model",
        version: 1,
        available: true,
        requiresModel: false,
        defaultOptions: {},
        normalizeOptions: (value) => value,
        execute: async () => {
            throw new Error("should not run unless registered");
        },
    });
    assert.equal(createDefaultBakeProviderRegistry().has({ id: "future-model", version: 1 }), false);
    assert.equal(injectable.has({ id: "future-model", version: 1 }), true);
});

test("plan hashes stay stable when sample records are inserted in a different order", () => {
    const config = smallConfig();
    const recipeHash = hashBakeRunConfig(config);
    const snapshotHash = HASH_A;
    const sample = {
        sampleId: "bake-7:path-0:0",
        pathId: "path-0",
        sampleIndex: 0,
        segmentIndex: 0,
        t: 0,
        distance: 0,
        viewId: "bake/view/main",
        pose: config.views[0].pose,
        products: config.outputRoles,
        activeBuildingId: "alpha",
        visibleBuildingIds: ["zeta", "alpha"],
    };
    const planA = normalizeBakeCapturePlan({
        kind: BAKE_CAPTURE_PLAN_KIND,
        version: 1,
        recipeHash,
        snapshotHash,
        captureTimeNs: 99,
        views: [{ viewId: config.views[0].id, pose: config.views[0].pose, calibration: config.views[0].calibration }],
        samples: [sample],
    });
    const planB = normalizeBakeCapturePlan({
        kind: BAKE_CAPTURE_PLAN_KIND,
        version: 1,
        recipeHash,
        snapshotHash,
        captureTimeNs: 99,
        views: [{ viewId: config.views[0].id, pose: config.views[0].pose, calibration: config.views[0].calibration }],
        samples: [{ ...sample, visibleBuildingIds: ["alpha", "zeta"] }],
    });
    assert.equal(hashBakeCapturePlan(planA), hashBakeCapturePlan(planB));
    assert.deepEqual(planA.samples[0].visibleBuildingIds, ["alpha", "zeta"]);
});
