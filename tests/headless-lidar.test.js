import { computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { computeSimulationSemanticHash } from "../app/simulation/kernel/SimulationHashes.js";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HeadlessEpisode } from "../app/simulation/headless/HeadlessEpisode.js";
import { createCpuLidarBackendSelection } from "../app/simulation/sensors/CpuLidarBackend.js";
import { createStateSensorBackendSelection } from "../app/simulation/sensors/StateSensorBackend.js";
import { verifyRunBundle } from "../server/headless/RunBundle.js";
import { inspectSflog } from "../server/headless/Inspection.js";
import { HeadlessRunner } from "../server/headless/HeadlessRunner.js";
import { StorageService } from "../server/storage/StorageService.js";
import {
    createHeadlessImu,
    createPortableHeadlessBundle,
    successfulTape,
} from "./helpers/headlessRunnerBundle.js";

async function lidarBundle() {
    const base = await new StorageService().resolveRunManifest("igvc-default");
    const lidar = structuredClone(base.manifest.sensorRig.sensors.find((sensor) => sensor.type === "lidar3d"));
    lidar.rateHz = 60;
    lidar.phaseNs = 0;
    lidar.calibration.azimuth = { startDeg: -45, endDeg: 46, stepDeg: 45 };
    lidar.calibration.elevation = { startDeg: 0, endDeg: 1, stepDeg: 1 };
    lidar.calibration.products.pointCloud = true;
    lidar.calibration.products.semanticPointCloud = true;
    lidar.noise = {
        ...lidar.noise,
        dropoutProbability: 0,
        pointDropoutProbability: 0,
        bias: 0,
        standardDeviation: 0,
    };
    return createPortableHeadlessBundle({
        sensors: [createHeadlessImu(), lidar],
        triggers: [{
            id: "finish", name: "Finish", enabled: true, once: true,
            condition: { kind: "step", step: 4 }, actions: [{ kind: "finish" }],
        }],
    });
}

test("headless LiDAR publishes deterministic products without changing measured observations", async () => {
    const bundle = await lidarBundle();
    const episode = new HeadlessEpisode();
    const descriptor = await episode.prepare(bundle.resolved, { actionRepeat: 1 });
    assert.deepEqual(episode.episodeSpec.backendSelections.map((entry) => entry.kind), [1, 2, 3]);
    assert.equal(descriptor.observationSpace.dictionary.entries.some((entry) => entry.key.includes("lidar")), false);

    const reset = episode.reset();
    assert.equal(reset.observation.entries.some((entry) => entry.name.includes("lidar")), false);
    const immutableScene = episode.runtime.devices.lidar.scene;
    episode.step([0, 0]);
    const lidar = episode.runtime.devices.lidar.devices[0];
    const firstMeasured = episode.runtime.signalStore.read(`devices.${lidar.id}.pointCloud`, { clone: true });
    const firstSemantic = episode.runtime.signalStore.read(`devices.${lidar.id}.semanticPointCloud`, { clone: true });
    assert.equal(firstMeasured.exists, true);
    assert.equal(firstSemantic.exists, true);
    assert.equal(firstMeasured.metadata.captureTimeNs, bundle.resolved.manifest.clock.stepNs);
    assert.equal(firstMeasured.metadata.syncGroupKey, firstSemantic.metadata.syncGroupKey);
    assert.equal(lidar.contractPublisher.getHealthSnapshot().errors, 0);

    episode.reset();
    assert.equal(episode.runtime.devices.lidar.scene, immutableScene, "reset reuses immutable BVHs");
    episode.step([0, 0]);
    const replayMeasured = episode.runtime.signalStore.read(`devices.${lidar.id}.pointCloud`, { clone: true });
    assert.deepEqual(replayMeasured.value, firstMeasured.value);
    episode.dispose();
    assert.equal(episode.runtime.devices.lidar.scene, null);
});

test("LiDAR capability validation rejects missing, duplicate, mismatched, and unused CPU selections", async () => {
    const bundle = await lidarBundle();
    const physics = bundle.resolved.backendSelections[0];
    const state = createStateSensorBackendSelection();
    const cpu = createCpuLidarBackendSelection();
    const prepare = (resolved, backendSelections) => new HeadlessEpisode().prepare(
        resolved,
        { backendSelections },
    );

    await assert.rejects(() => prepare(bundle.resolved, [physics, state]), /CPU LiDAR backend.*required/i);
    await assert.rejects(() => prepare(bundle.resolved, [physics, state, cpu, cpu]), /exactly one physics and state backend/i);
    await assert.rejects(() => prepare(bundle.resolved, [physics, state, { ...cpu, configHash: "0".repeat(64) }]), /backend mismatch/i);

    const stateOnly = await createPortableHeadlessBundle({ sensors: [createHeadlessImu()] });
    await assert.rejects(() => prepare(stateOnly.resolved, [physics, state, cpu]), /exactly one physics and state backend/i);
});

test("portable LiDAR bundles require intact persisted twins and explain legacy re-resolution", async () => {
    const bundle = await lidarBundle();
    const legacy = structuredClone(bundle);
    delete legacy.resolved.lidarGeometry;
    delete legacy.resolved.dependencyHashes.lidarGeometry;
    const seal = (value) => {
        value.resolved.simulationSemanticHash = computeSimulationSemanticHash(value.resolved);
        value.simulationSemanticHash = value.resolved.simulationSemanticHash;
        value.resolved.resolvedHash = computeResolvedRunHash(value.resolved);
        value.resolvedHash = value.resolved.resolvedHash;
    };
    seal(legacy);
    assert.throws(() => verifyRunBundle(legacy), /predates persisted geometry twins; re-resolve/i);

    const tampered = structuredClone(bundle);
    tampered.resolved.lidarGeometry.description.staticPrimitives[0].vertices[0].x += 1;
    seal(tampered);
    assert.throws(() => verifyRunBundle(tampered), /LiDAR geometry hash mismatch/i);
});

test("headless runner records LiDAR products and backend provenance in SFLog", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-lidar-runner-"));
    const output = path.join(root, "evaluation");
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const runner = new HeadlessRunner();
    const result = await runner.replay(await lidarBundle(), successfulTape(), {
        outputUri: output,
        artifactPolicy: { profile: "evaluation", outputUri: output },
    });
    assert.equal(result.result.passed, true);
    const inspected = await inspectSflog(path.join(output, "run.sflog"));
    assert.equal(inspected.signalPaths.some((entry) => entry.endsWith(".pointCloud")), true);
    assert.equal(inspected.signalPaths.some((entry) => entry.endsWith(".semanticPointCloud")), true);
    const provenance = JSON.parse(await fs.readFile(path.join(output, "provenance.json"), "utf8"));
    assert.deepEqual(provenance.backendSelections.map((entry) => entry.kind), [1, 2, 3]);
});
