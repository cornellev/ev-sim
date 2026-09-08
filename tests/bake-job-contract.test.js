import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as THREE from "three";

import {
    createDefaultBakeRunConfig,
    createLegacyCompatibleBakeRunConfig,
} from "../app/3d/environment/visualization/BakeRunConfig.js";
import { buildBakeSourceSnapshot } from "../app/3d/environment/visual/BakeSnapshotBuilder.js";
import { runVersion1BakeJob } from "../app/3d/environment/visual/BakeJobRunner.js";
import {
    BAKE_JOB_STATES,
    BAKE_PRODUCT_RESULT_KEYS,
    BakeRunCatalog,
    hashBakeRunConfig,
    normalizeBakeRunConfig,
} from "../app/3d/environment/visual/BakeRunCatalog.js";
import { VISUAL_PREVIEW_USERDATA } from "../app/3d/environment/visual/VisualPreviewIsolation.js";

const WORLD = "c".repeat(64);
const root = new URL("../", import.meta.url);

function jobConfig(overrides = {}) {
    return normalizeBakeRunConfig({
        environmentId: "yard",
        seed: 11,
        paths: [{
            id: "path-0",
            vertices: [
                { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
            ],
        }],
        views: [{
            id: "bake/view/main",
            position: { x: 0, y: 1, z: 4 },
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            camera: { width: 2, height: 1, fov: 75, near: 0.1, far: 50 },
        }],
        sampling: { deltaDistance: 2, includeEndpoints: true, captureTimeNs: 5 },
        ...overrides,
    });
}

function mesh(name, { preview = false, color = 0xff0000 } = {}) {
    const object = new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color }),
    );
    object.name = name;
    object.userData.buildingId = name;
    if (preview) object.userData[VISUAL_PREVIEW_USERDATA.previewOnly] = true;
    return object;
}

function sourceScene() {
    const scene = new THREE.Scene();
    const building = mesh("alpha");
    building.position.set(0, 0, -3);
    const light = new THREE.DirectionalLight(0xffffff, 1.25);
    light.position.set(2, 4, 1);
    scene.add(building, light);
    return { scene, building, light };
}

function productBuffer(role, fill) {
    const width = 2;
    const height = 1;
    if (role === "beauty") {
        const data = new Uint8Array(width * height * 4);
        data.fill(fill);
        data[3] = 255;
        data[7] = 255;
        return data;
    }
    if (role === "validity") {
        const data = new Uint8Array(width * height);
        data.fill(1);
        return data;
    }
    throw new Error(`unsupported test role ${role}`);
}

function captureWithFill(fill) {
    return async (_view, { products, sample }) => ({
        visual: {
            products: Object.fromEntries(products.map((role) => [
                BAKE_PRODUCT_RESULT_KEYS[role],
                productBuffer(role, fill),
            ])),
            sampleId: sample?.sampleId,
        },
    });
}

async function runJob(catalog, options) {
    return runVersion1BakeJob({ catalog }, options);
}

test("detached bake snapshot is immutable after editor scene mutations and does not wrap the preview root", () => {
    const previewRoot = new THREE.Group();
    previewRoot.userData[VISUAL_PREVIEW_USERDATA.previewOnly] = true;
    const previewChild = mesh("preview-building", { preview: true, color: 0x00ff00 });
    previewRoot.add(previewChild);
    const { scene, building, light } = sourceScene();
    scene.add(previewRoot);

    assert.throws(
        () => buildBakeSourceSnapshot({
            sourceScene: previewRoot,
            previewRoot,
            worldHash: WORLD,
            bakeGeneration: 2,
        }),
        /preview root/i,
    );

    const frozen = buildBakeSourceSnapshot({
        sourceScene: scene,
        previewRoot,
        worldHash: WORLD,
        bakeGeneration: 2,
        outputRoles: ["beauty", "validity"],
    });
    const snapshotHash = frozen.snapshotHash;
    const cloned = frozen.sceneHandle.scene.children.find((child) => child.userData.buildingId === "alpha");
    assert.ok(cloned);
    assert.equal(cloned.userData[VISUAL_PREVIEW_USERDATA.previewOnly], undefined);
    assert.equal(cloned.geometry, building.geometry);
    assert.notEqual(cloned.material, building.material);
    assert.equal(frozen.sceneHandle.role, "bake-snapshot");
    assert.equal(frozen.sceneHandle.generation, 2);
    assert.equal(frozen.sceneHandle.descriptionHash, snapshotHash);
    assert.equal(
        frozen.sceneHandle.scene.children.some((child) => child.userData.buildingId === "preview-building"),
        false,
    );

    building.position.x = 40;
    building.visible = false;
    building.material.color.setHex(0x0000ff);
    light.intensity = 9;
    cloned.material.opacity = 0.2;

    const again = buildBakeSourceSnapshot({
        sourceScene: scene,
        previewRoot,
        worldHash: WORLD,
        bakeGeneration: 2,
        outputRoles: ["beauty", "validity"],
    });
    assert.notEqual(again.snapshotHash, snapshotHash);
    assert.equal(frozen.snapshotHash, snapshotHash);
    assert.equal(cloned.position.x, 0);
    frozen.dispose();
    again.dispose();
});

test("changed GPU bytes change requestHash while recipeHash stays fixed", async () => {
    const catalog = new BakeRunCatalog();
    const config = jobConfig();
    const recipeHash = hashBakeRunConfig(config);
    const { scene } = sourceScene();
    const first = await runJob(catalog, {
        config,
        sourceScene: scene,
        worldHash: WORLD,
        captureAlignedProducts: captureWithFill(12),
    });
    const second = await runJob(catalog, {
        config,
        sourceScene: scene,
        worldHash: WORLD,
        captureAlignedProducts: captureWithFill(200),
        jobId: "job-bytes-2",
    });
    assert.equal(first.recipeHash, recipeHash);
    assert.equal(second.recipeHash, recipeHash);
    assert.notEqual(first.requestHash, second.requestHash);
    assert.equal(first.status.state, BAKE_JOB_STATES.completed);
});

test("unknown providers fail before the first capture", async () => {
    const catalog = new BakeRunCatalog();
    const { scene } = sourceScene();
    let captures = 0;
    await assert.rejects(
        () => runJob(catalog, {
            config: jobConfig({ provider: { id: "missing-model", version: 1 } }),
            sourceScene: scene,
            worldHash: WORLD,
            captureAlignedProducts: async () => {
                captures += 1;
                throw new Error("capture should not run");
            },
        }),
        (error) => error.code === "BAKE_PROVIDER_UNAVAILABLE",
    );
    assert.equal(captures, 0);
});

test("wrong output role, digest, request hash, dimensions, encoding, or generation fails explicitly", async () => {
    const catalog = new BakeRunCatalog();
    const { scene } = sourceScene();
    const job = await runJob(catalog, {
        config: jobConfig(),
        sourceScene: scene,
        worldHash: WORLD,
        captureAlignedProducts: captureWithFill(7),
        jobId: "job-validate",
    });
    const response = {
        ...job.response,
        outputs: job.response.outputs.map((entry) => (
            entry.role === "beauty" ? { ...entry, role: "world-position" } : entry
        )),
    };
    assert.throws(
        () => catalog.attachResponse(job.jobId, response),
        /terminal|extra role|missing/i,
    );

    const digestMismatch = {
        ...job.response,
        outputs: job.response.outputs.map((entry) => (
            entry.role === "beauty" ? { ...entry, sha256: "d".repeat(64) } : entry
        )),
    };
    const live = catalog.createJob(jobConfig(), { jobId: "job-live", generation: 3 });
    catalog.attachSnapshot(live.jobId, job.snapshot);
    catalog.attachPlan(live.jobId, job.plan);
    catalog.attachRequest(live.jobId, job.request);
    assert.throws(
        () => catalog.attachResponse(live.jobId, digestMismatch, { generation: 3 }),
        /digest/,
    );
    assert.throws(
        () => catalog.attachResponse(live.jobId, {
            ...job.response,
            requestHash: "e".repeat(64),
        }, { generation: 3 }),
        /requestHash/,
    );
    assert.throws(
        () => catalog.attachResponse(live.jobId, {
            ...job.response,
            outputs: job.response.outputs.map((entry) => (
                entry.role === "beauty" ? { ...entry, width: 8, byteSize: 32 } : entry
            )),
        }, { generation: 3 }),
        /dimension/,
    );
    assert.throws(
        () => catalog.attachResponse(live.jobId, {
            ...job.response,
            outputs: job.response.outputs.map((entry) => (
                entry.role === "beauty" ? { ...entry, encoding: "little-endian" } : entry
            )),
        }, { generation: 3 }),
        /encoding/,
    );
    assert.throws(
        () => catalog.attachResponse(live.jobId, job.response, { generation: 99 }),
        (error) => error.code === "BAKE_GENERATION_MISMATCH",
    );
});

test("cancelled and superseded jobs reject late provider responses", async () => {
    const catalog = new BakeRunCatalog();
    const cancelled = catalog.createJob(jobConfig(), { jobId: "late-cancel", generation: 4 });
    catalog.cancel(cancelled.jobId);
    assert.throws(
        () => catalog.attachResponse(cancelled.jobId, { kind: "cev-sim.bake-provider-response", version: 1 }),
        (error) => error.code === "BAKE_JOB_TERMINAL",
    );
    const superseded = catalog.createJob(jobConfig(), { jobId: "late-supersede", generation: 5 });
    catalog.supersede(superseded.jobId);
    assert.throws(
        () => catalog.attachResponse(superseded.jobId, { kind: "cev-sim.bake-provider-response", version: 1 }),
        (error) => error.code === "BAKE_JOB_TERMINAL",
    );
});

test("no-model v1 jobs make zero model, Google, Spark, health-check, clear, upload, or polling requests", async () => {
    const catalog = new BakeRunCatalog();
    const { scene } = sourceScene();
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        throw new Error(`unexpected fetch ${url}`);
    };
    try {
        const job = await runJob(catalog, {
            config: jobConfig(),
            sourceScene: scene,
            worldHash: WORLD,
            captureAlignedProducts: captureWithFill(15),
        });
        assert.equal(job.status.state, BAKE_JOB_STATES.completed);
        assert.equal(job.response.runtimeStack.kind, "local-no-model");
        assert.equal(calls.length, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("legacy BakeRunConfig still exposes the editor capture defaults used by start()", async () => {
    const config = createDefaultBakeRunConfig({ environmentId: "igvc", seed: 42 });
    assert.equal(config.views[0].passes[0].id, "beauty");
    assert.equal(config.passPolicy.activeBuildingMask, true);
    assert.equal(config.splat.projectedTexture.enabled, true);
    assert.equal(config.provider.id, "captured-appearance");
    assert.equal(config.roundTrip.useModel, false);
    const legacy = createLegacyCompatibleBakeRunConfig({ environmentId: "igvc", seed: 42 });
    assert.equal(legacy.roundTrip.useModel, true);
    assert.equal(legacy.debug.saveRawCaptures, true);
    const harnessSource = await readFile(new URL("app/3d/environment/visualization/BakeHarness.js", root), "utf8");
    assert.match(harnessSource, /async start\(/);
    assert.match(harnessSource, /async checkServer\(/);
    assert.match(harnessSource, /roundTrip\.useModel === true/);
    const sceneSource = await readFile(new URL("app/3d/Scene.js", root), "utf8");
    assert.match(sceneSource, /createLegacyCompatibleBakeRunConfig/);
    assert.match(sceneSource, /createPersistentBakeRunConfig/);
    assert.match(sceneSource, /runPersistentPromotion/);
    assert.match(sceneSource, /isLegacyModelBakeConfig/);
    assert.match(sceneSource, /harness\.start/);
});
