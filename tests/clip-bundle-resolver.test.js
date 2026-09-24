import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { ClipBundleResolver, scaleCameraCalibration } from "../server/headless/ClipBundleResolver.js";

function storedManifest(authority = "candidate") {
    const manifest = createDefaultRunManifest({ id: "saved-run" });
    manifest.id = "saved-run";
    manifest.revision = 4;
    manifest.controls.authority = authority;
    return manifest;
}

function tape(count) {
    return {
        kind: "cev-sim.headless.policy-action-tape",
        version: 1,
        actions: Array.from({ length: count }, (_, index) => ({
            policyStep: index + 1,
            action: [1, 0],
        })),
    };
}

function storageFor(manifest, { puts = [] } = {}) {
    return {
        async getRunManifest() {
            return manifest;
        },
        async putRunManifest() {
            puts.push("put");
        },
        async resolveRunManifest(_id, input) {
            return {
                manifest: input.manifest,
                resolvedHash: "a".repeat(64),
                simulationSemanticHash: "b".repeat(64),
                world: { hash: "c".repeat(64) },
                environment: { manifest: { environmentId: input.manifest.environment.id } },
                renderScene: {
                    description: {
                        provider: input.manifest.sensorRig.sensors.find((sensor) => sensor.enabled !== false && sensor.type === "camera").render.provider,
                    },
                },
                visualLayer: { description: { kind: "cev-sim.visual-layer" } },
            };
        },
    };
}

test("derived clips scale calibration and do not save the manifest", async () => {
    const manifest = storedManifest();
    const before = structuredClone(manifest);
    const puts = [];
    const resolver = new ClipBundleResolver({ storage: storageFor(manifest, { puts }), assertRenderer: async () => {} });
    const camera = manifest.sensorRig.sensors.find((sensor) => sensor.id === "front-camera");
    const scaled = scaleCameraCalibration(camera, 1280, 720);
    assert.equal(scaled.calibration.verticalFovDeg, camera.calibration.verticalFovDeg);
    assert.equal(scaled.calibration.intrinsics.fx, camera.calibration.intrinsics.fx * (1280 / camera.calibration.width));
    const derived = await resolver.resolve({
        profile: "environment",
        manifestId: "saved-run",
        expectedManifestRevision: 4,
        camera: { kind: "manifest", cameraId: "front-camera" },
        renderer: "analytic",
        durationNs: 4_000_000_000,
        width: 1280,
        height: 720,
        actionTape: tape(240),
    });
    assert.equal(puts.length, 0);
    assert.deepEqual(manifest, before);
    assert.equal(derived.summary.frameCount, 120);
    assert.equal(derived.summary.authority, "candidate");
    assert.equal(derived.resolved.manifest.clock.pacing, "unbounded");
    assert.equal(derived.resolved.manifest.clock.maxSteps, 240);
    const clipCamera = derived.resolved.manifest.sensorRig.sensors.find((sensor) => sensor.id === "front-camera");
    assert.equal(clipCamera.calibration.width, 1280);
    assert.equal(clipCamera.calibration.products.depth, true);
    assert.equal(clipCamera.calibration.products.semantic, false);
    assert.equal(derived.actionTape.actions.length, 240);
});

test("candidate clips reject a missing, short, or episode-spec tape and reference clips reject a tape", async () => {
    const resolver = new ClipBundleResolver({
        storage: storageFor(storedManifest()),
        assertRenderer: async () => {},
    });
    const base = {
        profile: "environment",
        manifestId: "saved-run",
        expectedManifestRevision: 4,
        camera: { kind: "manifest", cameraId: "front-camera" },
        renderer: "analytic",
    };
    await assert.rejects(resolver.resolve(base), /action tape/);
    await assert.rejects(resolver.resolve({ ...base, actionTape: tape(3) }), /exactly 240/);
    await assert.rejects(resolver.resolve({
        ...base,
        actionTape: { ...tape(240), episodeSpec: { maxEpisodeSteps: "1" } },
    }), /episodeSpec/);
    const reference = new ClipBundleResolver({
        storage: storageFor(storedManifest("reference")),
        assertRenderer: async () => {},
    });
    await assert.rejects(reference.resolve({ ...base, actionTape: tape(240) }), /reject an action tape/);
    const derived = await reference.resolve({ ...base, renderer: "pbr", actionTape: null });
    assert.equal(derived.authority, "reference");
    assert.equal(derived.actionTape, null);
    assert.equal(derived.summary.renderer, "pbr");
});

test("stale manifest revisions are conflicts and viewport cameras stay map-fixed", async () => {
    const resolver = new ClipBundleResolver({
        storage: storageFor(storedManifest("reference")),
        assertRenderer: async () => {},
    });
    await assert.rejects(resolver.resolve({
        profile: "environment",
        manifestId: "saved-run",
        expectedManifestRevision: 3,
        camera: { kind: "manifest", cameraId: "front-camera" },
        renderer: "analytic",
    }), (error) => error.status === 409);
    const derived = await resolver.resolve({
        profile: "environment",
        manifestId: "saved-run",
        camera: {
            kind: "viewport",
            attachment: "map",
            environmentId: "igvc",
            mountPose: {
                position: { x: 1, y: 2, z: 3 },
                rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            },
            projection: { verticalFovDeg: 75, near: 0.1, far: 1000 },
        },
        renderer: "analytic",
    });
    const camera = derived.resolved.manifest.sensorRig.sensors.find((sensor) => sensor.id === "viewport-camera");
    assert.equal(camera.poseReference, "map");
    assert.equal(camera.parentId, null);
    assert.equal(derived.summary.frameCount, 120);
});
