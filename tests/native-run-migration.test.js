import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDefaultRunManifest, normalizeRunManifest, computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { planNativeRunMigration, validateNativeRunMigration, applyNativeRunMigration } from "../app/interfaces/NativeRunMigration.js";
import { StorageService } from "../server/storage/StorageService.js";
import { verifyRunBundleIntegrity, verifyRunBundle, canonicalRunBundleStringify, verifyRunBundleBytes } from "../server/headless/RunBundle.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { createHeadlessRuntimeContext } from "../app/simulation/headless/HeadlessRuntimeContext.js";
import { computeEpisodeHash, defaultEpisodeIdentity } from "../app/simulation/kernel/SimulationHashes.js";
import { recompileNativeGraph } from "../server/interfaces/NativeGraphCompiler.js";
import { createCpuLidarBackendSelection } from "../app/simulation/sensors/CpuLidarBackend.js";

function legacy() { return createDefaultRunManifest({ id: "native-migration", sensorRig: { sensors: [] }, scripts: { enabled: false } }); }

test("reviewed native migration preserves originals and blocks unknown graphs and types", () => {
    const manifest = legacy();
    const original = structuredClone(manifest);
    const plan = planNativeRunMigration({ manifest });
    assert.equal(plan.ok, true, JSON.stringify(plan.blocked));
    assert.deepEqual(manifest, original); assert.deepEqual(plan.original.manifest, original);
    assert.equal(applyNativeRunMigration(plan, { expectedRevision: 0 }).manifest.version, 13);
    assert.equal(normalizeRunManifest({ version: 12 }).version, 12);
    assert.throws(() => applyNativeRunMigration(plan, { expectedRevision: 1 }), /revision/);
    const tampered = structuredClone(plan); tampered.candidate.clock.stepNs++;
    assert.equal(validateNativeRunMigration(tampered).ok, false);
    manifest.topics[0].type = manifest.topics[0].schema.type = "custom/Message";
    assert.equal(planNativeRunMigration({ manifest }).ok, false);
    manifest.scripts.artifacts = [{ scriptId: "compiled" }];
    assert.equal(planNativeRunMigration({ manifest, scripts: [{ id: "compiled", sourceType: "artifact" }] }).ok, false);
});

test("native adoption recompiles supported graphs into new immutable artifacts", () => {
    const manifest = legacy(); manifest.scripts.artifacts = [{ scriptId: "number" }];
    manifest.scripts.embeddedBindings = [{ id: "number-binding", scriptId: "number", trigger: { kind: "fixed-update" }, inputs: [], outputs: [] }];
    manifest.scripts.expectedBindingsHash = computeResolvedRunHash(manifest.scripts.embeddedBindings);
    manifest.parameters = [{ id: "number-input", type: "float64", value: 1, target: { kind: "script-input", scriptId: "number", input: "value" } }];
    const graph = { head: "head", outputNodeConfig: { outputs: [{ id: "output", label: "output", type: "float64" }] }, nodes: [{ uuid: "number", type: "NumberUnitClass", storedData: 3, state: {} }], connections: [{ from: "number", output: "number", to: "head", input: "output", type: "float64" }] };
    const document = { id: "number", name: "Number", graph, sourceType: "editable", latestValidArtifact: { historical: true } };
    const plan = planNativeRunMigration({ manifest, scripts: [document] });
    assert.equal(plan.ok, true);
    assert.throws(() => applyNativeRunMigration(plan, { expectedRevision: 0 }), /recompilation/);
    const adopted = applyNativeRunMigration(plan, { expectedRevision: 0, recompile: recompileNativeGraph });
    assert.notEqual(adopted.scripts[0].id, document.id);
    assert.equal(adopted.scripts[0].artifact.kind, "cev-sim.visual-script.program");
    assert.equal(adopted.manifest.scripts.embeddedBindings[0].scriptId, adopted.scripts[0].id);
    assert.equal(adopted.manifest.parameters[0].target.scriptId, adopted.scripts[0].id);
    assert.equal(adopted.manifest.scripts.bindingSource, "embedded");
    assert.equal(adopted.manifest.scripts.expectedBindingsHash, computeResolvedRunHash(adopted.manifest.scripts.embeddedBindings));
    assert.deepEqual(document.latestValidArtifact, { historical: true });
});

test("native previews block unreviewed library and topic binding consumers", () => {
    const manifest = legacy();
    const library = planNativeRunMigration({ manifest, resolvedRun: { bindings: { entries: [{ id: "global", scriptId: "old" }] } } });
    assert.equal(library.ok, false); assert.match(library.blocked[0].message, /library bindings/);
    manifest.scripts.artifacts = [{ scriptId: "old" }];
    manifest.scripts.embeddedBindings = [{ id: "topic", scriptId: "old", trigger: { kind: "topic", topic: "/old" }, inputs: [{ source: "message", field: "header.frame_id" }], outputs: [] }];
    const topic = planNativeRunMigration({ manifest, scripts: [{ id: "old", graph: { nodes: [] } }] });
    assert.equal(topic.ok, false); assert.ok(topic.blocked.some((issue) => /binding migration/.test(issue.message)));
});

test("native frozen vectors preserve publication-only semantics and physical motion", async () => {
    const root = new URL("./fixtures/protobuf/", import.meta.url);
    const vectors = JSON.parse(await readFile(new URL("run-snapshots.v13.json", root), "utf8"));
    for (const vector of Object.values(vectors)) {
        const bytes = await readFile(new URL(vector.file, root));
        const verified = verifyRunBundleBytes(bytes, { execution: false });
        assert.equal(verified.bundleBytesHash, vector.bundleBytesHash);
        assert.equal(verified.resolvedHash, vector.resolvedHash);
        assert.equal(verified.simulationSemanticHash, vector.simulationSemanticHash);
        assert.equal(computeEpisodeHash(defaultEpisodeIdentity(verified.resolved)), vector.episodeHash);
        assert.equal(canonicalRunBundleStringify(verified.bundle), bytes.toString());
    }
    assert.equal(vectors.disabled.simulationSemanticHash, vectors.publish.simulationSemanticHash);
    assert.notEqual(vectors.disabled.simulationSemanticHash, vectors.controls.simulationSemanticHash);
    const legacyBundle = JSON.parse(await readFile(new URL("run-disabled.v12.json", root), "utf8"));
    const nativeBundle = JSON.parse(await readFile(new URL("run-disabled.v13.json", root), "utf8"));
    assert.notEqual(nativeBundle.simulationSemanticHash, legacyBundle.simulationSemanticHash);
    const kernels = [legacyBundle, nativeBundle].map(() => new SimulationKernel(createHeadlessRuntimeContext().context));
    try {
        for (const [index, bundle] of [legacyBundle, nativeBundle].entries()) { await kernels[index].prepare(bundle.resolved); await kernels[index].reset(); }
        for (let step = 0; step < 5; step++) {
            for (const kernel of kernels) { kernel.controlRuntime.submitSiSpeedSteer("ego", { speedMps: 1, steeringRadRep103: 0.1, producer: "candidate", captureTimeNs: kernel.timeNs }); await kernel.advanceStepAsync(); }
            assert.deepEqual(kernels[1].actorPoses(), kernels[0].actorPoses());
            assert.deepEqual(kernels[1].lastStepPhases, kernels[0].lastStepPhases);
        }
    } finally { kernels.forEach((kernel) => kernel.dispose()); }
});

test("v13 resolution, offline verification and reviewed storage adoption are complete", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cev-zpb04-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const service = new StorageService(dir);
    const stored = await service.createRunManifest(legacy());
    const preview = await service.planNativeRunMigration(stored.id);
    assert.equal(preview.ok, true, JSON.stringify(preview.blocked));
    const resolve = service.resolveRunManifest.bind(service);
    service.resolveRunManifest = async (...args) => ({ ...await resolve(...args), resolvedHash: "changed" });
    await assert.rejects(service.applyNativeRunMigration(stored.id, { plan: preview, expectedRevision: stored.revision }), /dependencies changed/);
    await assert.rejects(readFile(path.join(dir, "native-run-migrations", `${preview.originalHash}.json`)), { code: "ENOENT" });
    service.resolveRunManifest = resolve;
    const adopted = await service.applyNativeRunMigration(stored.id, { plan: preview, expectedRevision: stored.revision });
    assert.equal(adopted.manifest.version, 13); assert.equal(adopted.manifest.revision, stored.revision + 1);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, "native-run-migrations", `${adopted.archiveHash}.json`))), preview.original);
    const bundle = await service.exportRunManifest(stored.id);
    assert.equal(bundle.resolved.schemas, undefined); assert.equal(bundle.resolved.autonomyCatalog, undefined);
    assert.equal(bundle.resolved.manifest.topics.every((topic) => topic.type === undefined && topic.schema === undefined), true);
    verifyRunBundleIntegrity(bundle); verifyRunBundle(bundle);
    verifyRunBundleBytes(new TextEncoder().encode(canonicalRunBundleStringify(bundle)), { execution: false });
    const altered = structuredClone(bundle); altered.resolved.nativeTopicContracts.document.contracts[0].shape = {};
    assert.throws(() => verifyRunBundleIntegrity(altered), /contract/);
    await assert.rejects(service.applyNativeRunMigration(stored.id, { plan: preview, expectedRevision: stored.revision }), /source changed/);
    const kernel = new SimulationKernel(createHeadlessRuntimeContext().context);
    await kernel.prepare(bundle.resolved); await kernel.reset(); await kernel.advanceStepAsync(); kernel.dispose();
});

test("native CPU LiDAR delivers owned products without a ROS codec", async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cev-zpb04-lidar-")); t.after(() => rm(dir, { recursive: true, force: true }));
    const service = new StorageService(dir);
    const base = await service.resolveRunManifest("igvc-default");
    const lidar = structuredClone(base.manifest.sensorRig.sensors.find((sensor) => sensor.type === "lidar3d"));
    lidar.rateHz = 60; lidar.phaseNs = 0;
    lidar.calibration.azimuth = { startDeg: -45, endDeg: 46, stepDeg: 45 };
    lidar.calibration.elevation = { startDeg: 0, endDeg: 1, stepDeg: 1 };
    lidar.latency.fixedNs = 0; lidar.latency.jitterNs = 0;
    lidar.noise.dropoutProbability = 0;
    const manifest = createDefaultRunManifest({ id: "native-lidar", sensorRig: { sensors: [lidar] }, scripts: { enabled: false } });
    const plan = planNativeRunMigration({ manifest });
    assert.equal(plan.ok, true, JSON.stringify(plan.blocked));
    const native = applyNativeRunMigration(plan, { expectedRevision: 0 }).manifest;
    const resolved = await service.resolveRunManifest(native.id, native);
    const delivered = [];
    const runtime = createHeadlessRuntimeContext({ publicationPort: (envelope) => { delivered.push(envelope); return true; }, messageCodec: {
        encodeTopicValue() { throw new Error("ROS codec called"); }, registerMsgDefinition() { throw new Error("ROS registry called"); },
    } });
    const kernel = new SimulationKernel(runtime.context);
    try {
        await kernel.prepare(resolved, { episode: { backendSelections: [...resolved.backendSelections, createCpuLidarBackendSelection()] } });
        await kernel.reset(); await kernel.advanceStepAsync();
        const signal = runtime.signalStore.read(`devices.${lidar.id}.pointCloud`);
        assert.equal(signal.exists, true); assert.ok(signal.value.positions instanceof Float32Array);
        const packet = delivered.find((envelope) => envelope.topicId === lidar.outputs.pointCloudTopicId);
        assert.ok(packet); assert.equal(packet.metadata.runId, native.id);
        const retained = structuredClone(packet.value);
        await kernel.advanceStepAsync(); assert.deepEqual(packet.value, retained);
        assert.equal(runtime.devices.lidar.devices[0].contractPublisher.getHealthSnapshot().errors, 0);
    } finally { kernel.dispose(); }
});
