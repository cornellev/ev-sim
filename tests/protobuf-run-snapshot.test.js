import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDefaultRunManifest, normalizeRunManifest } from "../app/simulation/RunManifest.js";
import { RunSessionController } from "../app/simulation/RunSessionController.js";
import { SimulationEngine } from "../app/simulation/SimulationEngine.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { computeEpisodeHash, defaultEpisodeIdentity, computeSimulationSemanticHash } from "../app/simulation/kernel/SimulationHashes.js";
import { canonicalRunBundleStringify, verifyRunBundleBytes, verifyRunBundleIntegrity, verifyRunBundle } from "../server/headless/RunBundle.js";
import { verifyRunPackageArchive } from "../server/headless/VisualAssetPack.js";
import { StorageService } from "../server/storage/StorageService.js";
import { rehashRunBundle } from "./helpers/headlessRunnerBundle.js";
import { protobufRunFixture, runProto } from "./helpers/protobufRunFixture.js";
import { uploadedSource } from "./helpers/protobufFixtures.js";

async function serviceFor(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-zpb03-"));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    return { dir, service: new StorageService(dir) };
}

async function resolveFixture(t, { inbound = false } = {}) {
    const { dir, service } = await serviceFor(t);
    const { manifest, resource } = protobufRunFixture({ inbound });
    await service.putProtobufInterface(resource.document);
    await service.createRunManifest(manifest);
    const bundle = await service.exportRunManifest(manifest.id);
    return { dir, service, manifest, resource, bundle };
}

test("v12 migrates authoring while preserving v11 plugin gates and disabled defaults", () => {
    assert.deepEqual(createDefaultRunManifest().protobuf, { mode: "disabled", interfaceHash: null, externalController: false });
    for (let version = 1; version <= 11; version++) {
        assert.equal(normalizeRunManifest({ kind: "cev-sim.run-manifest", version }).version, 12);
    }
    const legacy = { ...createDefaultRunManifest(), version: 11, protobuf: undefined,
        plugins: { enabled: false, artifacts: [] } };
    assert.equal(normalizeRunManifest(legacy).version, 12);
    assert.throws(() => normalizeRunManifest({ ...legacy, version: 10 }), /Plugin selection.*11/);
    assert.throws(() => normalizeRunManifest({ ...legacy, protobuf: { mode: "disabled" } }), /version 12/);
});

test("resolution pins complete immutable interfaces and fails on missing or corrupt content", async (t) => {
    const { service, dir } = await serviceFor(t);
    const { manifest, resource } = protobufRunFixture();
    await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /interface.*unavailable/);
    const validation = await service.validateRunManifest(manifest.id, manifest);
    assert.equal(validation.ok, false);
    assert.equal(validation.issues[0].path, "protobuf.interfaceHash");
    await service.putProtobufInterface(resource.document);
    let reads = 0;
    const read = service.getProtobufInterface.bind(service);
    service.getProtobufInterface = async (hash) => { reads++; return read(hash); };
    const resolved = await service.resolveRunManifest(manifest.id, manifest);
    assert.equal(reads, 1);
    assert.deepEqual(resolved.protobufInterface, resource);
    assert.equal(resolved.dependencyHashes.protobufInterface, resource.hash);
    await fs.writeFile(path.join(dir, "protobuf-interfaces", "sha256", `${resource.hash}.json`), "{}");
    assert.deepEqual(resolved.protobufInterface, resource);
    await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /cannot be verified/);
});

test("interface source-pointer updates do not invalidate existing immutable pins", async (t) => {
    const { service, manifest, resource } = await resolveFixture(t);
    const tracked = await service.importProtobufSources({ sourceId: "run-source", schemaId: "main",
        source: uploadedSource(runProto), baseHash: resource.hash });
    const newer = structuredClone(resource.document);
    newer.bootstrap[0].value.wheelbase_m = 2;
    const published = await service.putProtobufInterface(newer, { sourceId: "run-source", expectedRevision: tracked.source.revision });
    assert.notEqual(published.hash, resource.hash);
    assert.equal((await service.getProtobufInterfaceSource("run-source")).interfaceHash, published.hash);
    const old = await service.resolveRunManifest(manifest.id);
    assert.equal(old.protobufInterface.hash, resource.hash);
});

test("v12 bundles verify offline and detect inner tampering after outer hashes are recomputed", async (t) => {
    const { bundle } = await resolveFixture(t);
    const bytes = Buffer.from(canonicalRunBundleStringify(bundle));
    const verified = verifyRunBundleBytes(bytes, { execution: false });
    assert.equal(verified.resolved.protobufInterface.hash, bundle.resolved.protobufInterface.hash);
    verifyRunBundle(bundle);
    for (const mutate of [
        (resolved) => { delete resolved.protobufInterface; },
        (resolved) => { delete resolved.schemas; },
        (resolved) => { resolved.dependencyHashes.protobufInterface = "f".repeat(64); },
        (resolved) => { resolved.protobufInterface.document.schemas[0].fingerprint = "f".repeat(64); },
        (resolved) => { resolved.protobufInterface.document.bootstrap[0].value.wheelbase_m += 1e-10; },
        (resolved) => { resolved.protobufInterface.document.schemas[0].descriptorBase64 = "AAAA"; },
    ]) {
        const modified = structuredClone(bundle);
        mutate(modified.resolved);
        assert.throws(() => verifyRunBundleIntegrity(modified));
    }
    const staleDependency = structuredClone(bundle);
    staleDependency.resolved.dependencyHashes.protobufInterface = "f".repeat(64);
    assert.throws(() => verifyRunBundleIntegrity(rehashRunBundle(staleDependency)), /dependency/);
    const altered = structuredClone(bundle);
    altered.resolved.protobufInterface.document.bootstrap[0].value.wheelbase_m += 1e-10;
    assert.throws(() => verifyRunBundleIntegrity(rehashRunBundle(altered)), /pin/);
});

test("publication and operational changes preserve semantics; subscribed contracts change them exactly", async (t) => {
    const { service, manifest, bundle, resource } = await resolveFixture(t);
    const disabled = await service.resolveRunManifest(manifest.id, { ...manifest, protobuf: { mode: "disabled" } });
    assert.notEqual(disabled.resolvedHash, bundle.resolvedHash);
    assert.equal(disabled.simulationSemanticHash, bundle.simulationSemanticHash);
    assert.equal(computeEpisodeHash(defaultEpisodeIdentity(disabled)), computeEpisodeHash(defaultEpisodeIdentity(bundle.resolved)));
    const document = structuredClone(resource.document);
    document.bootstrap[0].value.wheelbase_m += 1e-10;
    const changed = await service.putProtobufInterface(document);
    const published = await service.resolveRunManifest(manifest.id, { ...manifest, protobuf: { ...manifest.protobuf, interfaceHash: changed.hash } });
    assert.notEqual(published.resolvedHash, bundle.resolvedHash);
    assert.equal(published.simulationSemanticHash, bundle.simulationSemanticHash);
    const { bundle: inbound, service: inputService, manifest: inputManifest } = await resolveFixture(t, { inbound: true });
    assert.notEqual(inbound.simulationSemanticHash, bundle.simulationSemanticHash);
    const inputDocument = structuredClone(inbound.resolved.protobufInterface.document);
    inputDocument.routes.find((route) => route.id === "command").mapping.fields[0].scale = 1 + 1e-10;
    const inputResource = await inputService.putProtobufInterface(inputDocument);
    const changedInput = await inputService.resolveRunManifest(inputManifest.id, { ...inputManifest,
        protobuf: { ...inputManifest.protobuf, interfaceHash: inputResource.hash } });
    assert.notEqual(changedInput.simulationSemanticHash, inbound.simulationSemanticHash);
    const publicationOnly = structuredClone(inbound.resolved.protobufInterface.document);
    publicationOnly.routes.find((route) => route.id === "state").key = "new/{run_id}/state";
    publicationOnly.bootstrap[0].value.wheelbase_m += 1e-10;
    const publicationResource = await inputService.putProtobufInterface(publicationOnly);
    const newPublication = await inputService.resolveRunManifest(inputManifest.id, { ...inputManifest,
        protobuf: { ...inputManifest.protobuf, interfaceHash: publicationResource.hash } });
    assert.equal(newPublication.simulationSemanticHash, inbound.simulationSemanticHash);
    const frozenInput = structuredClone(inbound.resolved.protobufInterface.document);
    frozenInput.routes.find((route) => route.id === "command").mapping.fields[0].from = "run.manifest.clock.speed";
    const frozenResource = await inputService.putProtobufInterface(frozenInput);
    const frozenManifest = { ...inputManifest, protobuf: { ...inputManifest.protobuf, interfaceHash: frozenResource.hash } };
    const first = await inputService.resolveRunManifest(inputManifest.id, frozenManifest);
    const second = await inputService.resolveRunManifest(inputManifest.id, { ...frozenManifest, clock: { ...frozenManifest.clock, speed: 2 } });
    assert.notEqual(first.simulationSemanticHash, second.simulationSemanticHash);
    const operational = structuredClone(inbound.resolved);
    operational.resourceLimits = { maxSharedMemoryBytes: 1 };
    operational.artifactPolicy = { profile: "disabled" };
    operational.manifest.clock.pacing = "unbounded";
    operational.manifest.logging.policy = "disabled";
    assert.equal(computeSimulationSemanticHash(operational), inbound.simulationSemanticHash);
});

test("JSON and run-package imports carry interface closure into an empty offline store", async (t) => {
    const { service, bundle } = await resolveFixture(t);
    const { service: target, dir } = await serviceFor(t);
    const imported = await target.importRunBundle(bundle);
    const again = await target.importRunBundle(bundle);
    assert.equal(again.id, imported.id);
    assert.deepEqual(await target.getProtobufInterface(bundle.resolved.protobufInterface.hash), bundle.resolved.protobufInterface.document);
    await assert.rejects(fs.access(path.join(dir, "protobuf-interfaces", "sources")), /ENOENT/);
    const offline = await target.resolveRunManifest(imported.id);
    assert.deepEqual(offline.protobufInterface, bundle.resolved.protobufInterface);
    const archive = await service.exportRunPackage({ bundle });
    const chunks = [];
    for await (const chunk of archive.stream) chunks.push(chunk);
    const complete = await archive.completion;
    assert.equal(complete.assetCount, 0);
    const bytes = Buffer.concat(chunks);
    const verified = await verifyRunPackageArchive(bytes);
    t.after(verified.cleanup);
    assert.deepEqual(verified.bundleBytes, Buffer.from(canonicalRunBundleStringify(bundle)));
    assert.equal(verified.resolvedHash, bundle.resolvedHash);
    assert.equal(verified.assets.length, 0);
    const { service: packageTarget } = await serviceFor(t);
    const result = await packageTarget.importRunPackage(bytes);
    assert.ok(result);
    assert.deepEqual(await packageTarget.getProtobufInterface(bundle.resolved.protobufInterface.hash), bundle.resolved.protobufInterface.document);
});

test("frozen v12 snapshots retain exact bytes and identity vectors", async () => {
    const root = new URL("./fixtures/protobuf/", import.meta.url);
    const vectors = JSON.parse(await fs.readFile(new URL("run-snapshots.v12.json", root), "utf8"));
    for (const [name, vector] of Object.entries(vectors)) {
        const bytes = await fs.readFile(new URL(vector.file, root));
        const verified = verifyRunBundleBytes(bytes, { execution: false });
        assert.equal(verified.bundleBytesHash, vector.bundleBytesHash);
        assert.equal(canonicalRunBundleStringify(verified.bundle), bytes.toString());
        assert.equal(verified.resolvedHash, vector.resolvedHash);
        assert.equal(verified.simulationSemanticHash, vector.simulationSemanticHash);
        assert.equal(verified.resolved.definitionHash, vector.definitionHash);
        assert.equal(computeEpisodeHash(defaultEpisodeIdentity(verified.resolved)), vector.episodeHash);
        if (name !== "disabled") assert.equal(verified.resolved.protobufInterface.hash, vector.interfaceHash);
    }
    assert.equal(vectors.disabled.simulationSemanticHash, vectors.publish.simulationSemanticHash);
    assert.equal(vectors.disabled.episodeHash, vectors.publish.episodeHash);
    assert.notEqual(vectors.publish.episodeHash, vectors.controls.episodeHash);
});

test("Zenoh preparation fails before browser replacement and shared-kernel work", async (t) => {
    const { bundle } = await resolveFixture(t);
    const controller = new RunSessionController();
    controller.snapshot.status = "running";
    controller.snapshot.activeRunId = "original";
    controller.stop = () => assert.fail("active run must stay intact");
    await assert.rejects(controller.prepare(bundle.resolved), (error) => error.code === "UNSUPPORTED_CAPABILITY");
    assert.equal(controller.snapshot.activeRunId, "original");
    assert.equal(controller.snapshot.status, "running");
    await assert.rejects(SimulationEngine.prototype.applyRunManifest.call({ pause() { assert.fail("must not pause"); } }, bundle.resolved), /Zenoh execution/);
    await assert.rejects(SimulationKernel.prototype.prepare.call({}, bundle.resolved), /Zenoh execution/);
});
