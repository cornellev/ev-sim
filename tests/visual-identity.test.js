import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { verifyRoute } from "../app/scenarios/route/Route.js";
import { createDefaultRunManifest, computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { normalizeEpisodeSpec } from "../app/simulation/headless/HeadlessEpisode.js";
import { canonicalEpisodeIdentity, computeEpisodeHash, computeSimulationSemanticHash, defaultEpisodeIdentity, simulationSemanticProjection } from "../app/simulation/kernel/SimulationHashes.js";
import { WORLD_BOUND_IDENTITY } from "../app/simulation/kernel/RunIdentity.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { ManagedHeadlessSession, managedEpisodeIdentity } from "../server/headless/ManagedHeadlessSession.js";
import { HeadlessSession } from "../server/headless/HeadlessSession.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { canonicalRunBundleStringify, runBundleBytes, verifyRunBundle, verifyRunBundleBytes, verifyRunBundleIntegrity } from "../server/headless/RunBundle.js";
import { StorageService } from "../server/storage/StorageService.js";
import { createPortableHeadlessBundle, rehashRunBundle } from "./helpers/headlessRunnerBundle.js";

const fixtureRoot = new URL("./fixtures/visual-layer/", import.meta.url);
const readFixture = async (name) => JSON.parse(await fs.readFile(new URL(name, fixtureRoot), "utf8"));

async function temporaryService(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vis-identity-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return { root, service: new StorageService(root) };
}

function bundleFor(resolved) {
    return { kind: "cev-sim.run-bundle", version: 1, manifest: resolved.manifest, resolved,
        resolvedHash: resolved.resolvedHash, simulationSemanticHash: resolved.simulationSemanticHash };
}

function identities(resolved) {
    return {
        semantic: computeSimulationSemanticHash(resolved),
        browser: computeEpisodeHash(defaultEpisodeIdentity(resolved)),
        headless: computeEpisodeHash({ ...normalizeEpisodeSpec(resolved), simulationSemanticHash: computeSimulationSemanticHash(resolved) }),
    };
}

function scenarioFor(environment, expectedHash) {
    const edge = environment.document.roads.edges[0];
    const nodes = new Map(environment.document.roads.nodes.map((node) => [node.id, node]));
    const verified = verifyRoute(environment, { id: "ego-route", actorId: "ego", waypoints:
        [edge.startNodeId, edge.endNodeId].map((id) => ({ id, position: { x: nodes.get(id).x, y: 0, z: nodes.get(id).z } })) });
    assert.equal(verified.ok, true);
    return createDefaultScenario({
        id: "identity-scenario", environment: { id: "igvc", expectedHash },
        routes: [{ id: "ego-route", actorId: "ego", initialSpeedMps: 0,
            controller: { kind: "route-follower" }, waypoints: verified.waypoints, verification: verified.verification }],
        completion: { conditions: [{ id: "limit", kind: "max-duration", durationNs: 1e9 }] },
    });
}

test("VIS-12a freezes v10 bytes, hashes and canonical episode identities", async () => {
    const vectors = await readFixture("legacy-bundles.v1.json");
    for (const [name, vector] of Object.entries(vectors)) {
        const bytes = await fs.readFile(new URL(`legacy-${name}.v10.json`, fixtureRoot));
        const verified = verifyRunBundleBytes(bytes, { expectedBundleBytesHash: vector.bundleBytesHash });
        assert.equal(bytes.length, vector.byteLength);
        assert.equal(verified.identityVersion, 1);
        assert.equal(verified.resolvedHash, vector.resolvedHash);
        assert.equal(verified.simulationSemanticHash, vector.simulationSemanticHash);
        assert.equal(identities(verified.resolved).browser, vector.browserEpisodeHash);
        assert.equal(identities(verified.resolved).headless, vector.headlessEpisodeHash);
        assert.deepEqual(Buffer.from(runBundleBytes(verified.bundle)), bytes);
        assert.equal(canonicalRunBundleStringify(verified.bundle), bytes.toString());
        const identity = defaultEpisodeIdentity(verified.resolved);
        assert.deepEqual(canonicalEpisodeIdentity(identity), identity);
    }
});

test("VIS-12a real direct resolution ignores refreshed visual locks for state, LiDAR and analytic cameras", async (t) => {
    const { service } = await temporaryService(t);
    const original = await service.getEnvironment("igvc");
    for (const type of ["imu", "lidar3d", "camera"]) {
        await service.putEnvironment("igvc", original);
        const manifest = createDefaultRunManifest({ id: `identity-${type}`, environment: {
            id: "igvc", expectedHash: computeResolvedRunHash(original),
        } });
        manifest.sensorRig.sensors.forEach((sensor) => { sensor.enabled = sensor.type === type; });
        const before = await service.resolveRunManifest(manifest.id, manifest);
        assert.deepEqual(before.identityProfile, WORLD_BOUND_IDENTITY);
        assert.equal(before.version, 11);
        assert.equal(defaultEpisodeIdentity(before).version, 2);
        verifyRunBundle(bundleFor(before));
        const changed = { ...original, visualLayer: { descriptorHash: "a".repeat(64) }, evidence: { reportHash: "b".repeat(64) } };
        await service.putEnvironment("igvc", changed);
        await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /Environment .* changed/);
        manifest.environment.expectedHash = computeResolvedRunHash(changed);
        const after = await service.resolveRunManifest(manifest.id, manifest);
        assert.equal(before.world.hash, after.world.hash);
        assert.equal(before.renderScene?.hash, after.renderScene?.hash);
        assert.notEqual(before.resolvedHash, after.resolvedHash);
        assert.deepEqual(identities(before), identities(after));
        manifest.environment.expectedHash = null;
        assert.deepEqual(identities(await service.resolveRunManifest(manifest.id, manifest)), identities(before));
    }
});

test("VIS-12a checks original and nested scenario locks before projection and preserves behavior", async (t) => {
    const { service } = await temporaryService(t);
    const environment = await service.getEnvironment("igvc");
    let scenario = await service.createScenario(scenarioFor(environment, computeResolvedRunHash(environment)));
    const manifest = createDefaultRunManifest({ id: "scenario-identity", environment: {
        id: "igvc", expectedHash: computeResolvedRunHash(environment),
    }, scenario: { id: scenario.id, expectedHash: scenario.definitionHash, egoVehicleId: "big-car" } });
    manifest.sensorRig.sensors = [];
    const before = await service.resolveRunManifest(manifest.id, manifest);
    await service.putEnvironment("authoring-environment", { ...environment, id: "authoring-environment" });
    const authoredEnvironment = await service.getEnvironment("authoring-environment");
    const alternate = structuredClone(manifest);
    alternate.environment = { id: "authoring-environment", expectedHash: computeResolvedRunHash(authoredEnvironment) };
    assert.deepEqual(identities(await service.resolveRunManifest(alternate.id, alternate)), identities(before));
    const changedAuthoring = { ...authoredEnvironment, visualLayer: { descriptorHash: "d".repeat(64) } };
    await service.putEnvironment("authoring-environment", changedAuthoring);
    await assert.rejects(service.resolveRunManifest(alternate.id, alternate), /Environment "authoring-environment" changed/);
    alternate.environment.expectedHash = computeResolvedRunHash(changedAuthoring);
    assert.deepEqual(identities(await service.resolveRunManifest(alternate.id, alternate)), identities(before));
    const changed = { ...environment, visualLayer: { descriptorHash: "c".repeat(64) } };
    await service.putEnvironment("igvc", changed);
    await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /Environment .* changed/);
    manifest.environment.expectedHash = computeResolvedRunHash(changed);
    await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /Environment .* changed/);
    scenario = await service.putScenario(scenario.id, { scenario: { ...scenario,
        environment: { ...scenario.environment, expectedHash: manifest.environment.expectedHash },
    }, expectedRevision: scenario.revision });
    await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /Scenario .* changed/);
    manifest.scenario.expectedHash = scenario.definitionHash;
    const after = await service.resolveRunManifest(manifest.id, manifest);
    assert.notEqual(after.dependencyHashes.scenario, before.dependencyHashes.scenario);
    assert.deepEqual(identities(before), identities(after));
    assert.deepEqual(defaultEpisodeIdentity(before).rewardProfile, defaultEpisodeIdentity(after).rewardProfile);
    assert.equal(simulationSemanticProjection(after).resolved.scenario.dependencyHashes.scenario,
        simulationSemanticProjection(before).resolved.scenario.dependencyHashes.scenario);
    scenario = await service.putScenario(scenario.id, { scenario: { ...scenario,
        completion: { conditions: [{ id: "limit", kind: "max-duration", durationNs: 2e9 }] },
    }, expectedRevision: scenario.revision });
    manifest.scenario.expectedHash = scenario.definitionHash;
    const behavioral = await service.resolveRunManifest(manifest.id, manifest);
    assert.notEqual(identities(after).semantic, identities(behavioral).semantic);
    assert.notEqual(defaultEpisodeIdentity(after).rewardProfile.configHash, defaultEpisodeIdentity(behavioral).rewardProfile.configHash);
});

test("VIS-12a projection exclusions are explicit and selected semantic inputs remain sensitive", async () => {
    const bundle = await createPortableHeadlessBundle();
    const original = structuredClone(bundle.resolved);
    for (const mutate of [
        (r) => { r.evidence = { digest: "a".repeat(64) }; r.dependencyHashes.evidence = "a".repeat(64); },
        (r) => { r.provenance = { host: "another GPU" }; },
        (r) => { r.manifest.provenance = { candidateModels: [{ digest: "a".repeat(64) }] }; },
        (r) => { r.resourceLimits = { maxRssBytes: 2 }; r.artifactPolicy = { profile: "training" }; },
        (r) => { r.manifest.clock.speed = 7; r.manifest.clock.pacing = "unbounded"; r.manifest.logging.policy = "disabled"; },
    ]) {
        const changed = structuredClone(original); mutate(changed);
        assert.deepEqual(identities(changed), identities(original));
        assert.notEqual(computeResolvedRunHash(changed), computeResolvedRunHash(original));
    }
    for (const mutate of [
        (r) => { r.manifest.controls.watchdogNs += 100; },
        (r) => { r.manifest.seed = "other-seed"; },
        (r) => { r.manifest.sensorRig.sensors[0].calibration.gravity += 1; },
        (r) => { r.backendSelections[0].configHash = "d".repeat(64); },
        (r) => { r.scripts.push({ artifact: { inputs: { evidence: "behavior", hash: "required", environment: "value" } } }); },
        (r) => { r.world.hash = "f".repeat(64); },
    ]) {
        const changed = structuredClone(original); mutate(changed);
        assert.notEqual(computeSimulationSemanticHash(changed), computeSimulationSemanticHash(original));
    }
    const projected = simulationSemanticProjection(original);
    assert.equal(projected.version, 2);
    assert.deepEqual(original, bundle.resolved);
    for (const overrides of [{ resetSeed: "987" }, { actionRepeat: 2 }, { maxEpisodeSteps: "8" },
        { rewardProfile: { id: "other", version: 1, configHash: "e".repeat(64) } }]) {
        assert.notEqual(computeEpisodeHash(defaultEpisodeIdentity(original, overrides)), identities(original).browser);
    }
    const identity = defaultEpisodeIdentity(original, { identityVersion: 1, version: 1 });
    assert.equal(identity.version, 2);
    assert.deepEqual(canonicalEpisodeIdentity(identity), identity);
});

test("VIS-12a prospective camera selections are projected without activating provider support", async () => {
    const { resolved } = await createPortableHeadlessBundle();
    resolved.manifest.sensorRig.sensors.push({
        id: "future-camera",
        type: "camera",
        enabled: false,
        render: {
            provider: { id: "pbr-mesh", version: 1 },
            productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
        },
    });
    const before = identities(resolved);
    resolved.manifest.sensorRig.sensors.at(-1).render.provider.version = 2;
    assert.deepEqual(identities(resolved), before);
    resolved.manifest.sensorRig.sensors.at(-1).enabled = true;
    resolved.renderScene = { hash: "a".repeat(64), description: { provider: { id: "pbr-mesh", version: 1 } } };
    const selected = computeSimulationSemanticHash(resolved);
    resolved.renderScene.hash = "b".repeat(64);
    assert.notEqual(computeSimulationSemanticHash(resolved), selected);
});

test("VIS-12a exact byte integrity is independent of normalized hashes and never normalizes verification", async (t) => {
    const bundle = await createPortableHeadlessBundle();
    const bytes = Buffer.from(canonicalRunBundleStringify(bundle));
    const verified = verifyRunBundleBytes(bytes);
    assert.equal(verifyRunBundleBytes(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)).bundleBytesHash,
        verified.bundleBytesHash);
    assert.throws(() => verifyRunBundleBytes(bytes.toString()), /ArrayBuffer or typed-array/);
    const whitespace = Buffer.concat([bytes, Buffer.from("\n")]);
    assert.equal(verifyRunBundleBytes(whitespace).resolvedHash, verified.resolvedHash);
    assert.notEqual(verifyRunBundleBytes(whitespace).bundleBytesHash, verified.bundleBytesHash);
    assert.throws(() => verifyRunBundleBytes(whitespace, { expectedBundleBytesHash: verified.bundleBytesHash }), /byte digest/);
    const alias = structuredClone(bundle);
    alias.resolved.manifest.initialState.vehicles[0].pose.position.x += 1e-10;
    alias.manifest = structuredClone(alias.resolved.manifest);
    assert.equal(computeResolvedRunHash(alias.resolved), bundle.resolvedHash);
    assert.notEqual(sha256ExactBytes(Buffer.from(canonicalRunBundleStringify(alias))), verified.bundleBytesHash);
    for (const invalid of [Buffer.from('{"kind":1,"kind":2}'), Buffer.from([0xff]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), Buffer.from('{"x":NaN}'),
        Buffer.from('{"x":"\\ud800"}'), Buffer.from('{"x":1} trailing')]) {
        assert.throws(() => verifyRunBundleBytes(invalid), (error) => error.code === "BUNDLE_INVALID");
    }
    for (const profile of [undefined, null, { id: "unknown", version: 2 }, { id: "world-bound", version: 3 }]) {
        const invalid = structuredClone(bundle); invalid.resolved.identityProfile = profile;
        assert.throws(() => verifyRunBundle(invalid), /identityProfile/);
    }
    const { root, service } = await temporaryService(t);
    const corrupt = structuredClone(bundle); corrupt.resolvedHash = "0".repeat(64);
    await assert.rejects(service.importRunBundle(corrupt), /hash is invalid/);
    assert.deepEqual(await fs.readdir(root), []);
    const historical = await readFixture("legacy-state.v10.json");
    historical.resolved.version = 9; historical.resolved.manifest.version = 9;
    historical.manifest = historical.resolved.manifest;
    historical.resolved.simulationSemanticHash = computeSimulationSemanticHash(historical.resolved);
    historical.simulationSemanticHash = historical.resolved.simulationSemanticHash;
    historical.resolved.resolvedHash = computeResolvedRunHash(historical.resolved);
    historical.resolvedHash = historical.resolved.resolvedHash;
    verifyRunBundleIntegrity(historical);
    assert.throws(() => verifyRunBundle(historical), /re-resolution/);
});

test("VIS-12a direct and supervisor reset hashes agree for legacy and v11 with explicit negotiation", async (t) => {
    const { root } = await temporaryService(t);
    const supervisor = new HeadlessSupervisor({ socket: path.join(root, "supervisor.sock") });
    t.after(() => supervisor.close());
    const capabilities = await supervisor.getCapabilities({ clientProtocol: { major: 1, minor: 2 } });
    assert.equal(capabilities.protocol.minor, 3);
    assert.deepEqual(capabilities.identityProfiles, ["world-bound@2"]);
    assert.deepEqual(capabilities.assetAdmissionProfiles, []);
    const legacy = await readFixture("legacy-state.v10.json");
    for (const [bundle, minor] of [[legacy, 1], [legacy, 2], [await createPortableHeadlessBundle(), 2]]) {
        const direct = new HeadlessSession();
        t.after(() => direct.close());
        const spec = normalizeEpisodeSpec(bundle.resolved, { resetSeed: "77" });
        const descriptor = await direct.prepare(bundle, spec);
        const request = {
            clientProtocol: { major: 1, minor },
            runBundles: [{ bundleId: spec.runBundleId, resolvedHash: bundle.resolvedHash,
                simulationSemanticHash: bundle.simulationSemanticHash, canonicalJson: Buffer.from(canonicalRunBundleStringify(bundle)) }],
            episodes: [spec], artifactPolicy: { profile: 3, outputUri: path.join(root, `output-${bundle.resolved.version}`) },
        };
        if (bundle.resolved.version === 11) {
            const rejected = await supervisor.createBatch(request);
            assert.equal(rejected.error.code, 6, rejected.error.message);
            assert.equal(supervisor.activeEnvironmentCount, 0);
            request.clientProtocol.minor = 3;
        }
        const created = await supervisor.createBatch(request);
        assert.equal(created.error.code, 0, created.error.message);
        assert.equal(created.batch.environments[0].episodeHash, descriptor.episodeHash);
        const reset = await supervisor.resetBatch({ batchId: created.batch.batchId, episodes: [{ ...spec, resetSeed: "78" }] });
        assert.equal(reset.results[0].error.code, 0, reset.results[0].error.message);
        const expected = computeEpisodeHash(defaultEpisodeIdentity(bundle.resolved, { ...spec, resetSeed: "78" }));
        assert.equal(reset.results[0].info.episodeHash, expected);
        await supervisor.closeBatch({ batchId: created.batch.batchId, finalizeActiveEpisodes: true });
    }
});


test("VIS-12a managed execution retains legacy and v11 episode identities", async (t) => {
    const { root } = await temporaryService(t);
    for (const source of [await readFixture("legacy-state.v10.json"), await createPortableHeadlessBundle()]) {
        source.resolved.manifest.controls.authority = "reference";
        source.resolved.manifest.clock.maxSteps = 3;
        source.resolved.scenario.scenario.routes[0].controller = { kind: "route-follower" };
        const bundle = rehashRunBundle(source);
        const session = new ManagedHeadlessSession();
        t.after(() => session.close());
        const prepared = await session.prepare(bundle);
        assert.equal(session.episodeIdentity.version, bundle.resolved.version === 11 ? 2 : 1);
        assert.equal(prepared.episodeHash, computeEpisodeHash(managedEpisodeIdentity(bundle.resolved)));
        const result = await session.run({ outputUri: path.join(root, `managed-${bundle.resolved.version}`),
            artifactPolicy: { profile: "disabled" } });
        assert.equal(result.runResult.episodeHash, prepared.episodeHash);
        assert.equal(result.runResult.completed, true);
        await session.close();
    }
});


test("VIS-12a v11 golden bytes and hashes are independent of legacy goldens", async () => {
    const expected = await readFixture("world-bound-state.v2.json");
    const bytes = await fs.readFile(new URL("world-bound-state.v11.json", fixtureRoot));
    const { bundle, resolved, bundleBytesHash } = verifyRunBundleBytes(bytes);
    assert.equal(bundleBytesHash, expected.bundleBytesHash);
    assert.equal(bytes.length, expected.byteLength);
    assert.equal(resolved.world.hash, expected.worldHash);
    assert.equal(resolved.resolvedHash, expected.resolvedHash);
    assert.equal(computeSimulationSemanticHash(resolved), expected.simulationSemanticHash);
    assert.deepEqual(identities(resolved), { semantic: expected.simulationSemanticHash,
        browser: expected.browserEpisodeHash, headless: expected.headlessEpisodeHash });
    assert.equal(canonicalRunBundleStringify(await createPortableHeadlessBundle()), bytes.toString());
    bundle.manifest.name = "mutated";
    assert.throws(() => runBundleBytes(bundle), /immutable bundle content changed/);
    const unsafe = structuredClone(resolved);
    unsafe.manifest.clock.stepNs = Number.MAX_SAFE_INTEGER + 1;
    assert.throws(() => computeSimulationSemanticHash(unsafe), /safe integer/);
    const unsafeScenario = structuredClone(resolved);
    unsafeScenario.scenario.scenario.triggers[0].condition.step = Number.MAX_SAFE_INTEGER + 1;
    assert.throws(() => computeSimulationSemanticHash(unsafeScenario), /safe integer/);
});


test("VIS-12a legacy authoring import re-resolves as v11 without changing source bytes", async (t) => {
    const { service } = await temporaryService(t);
    const bytes = await fs.readFile(new URL("legacy-analytic.v10.json", fixtureRoot));
    const { bundle } = verifyRunBundleBytes(bytes);
    // Re-resolution of an unchanged ID/world; conflicting IDs are a separate import case.
    await service.putEnvironment(bundle.manifest.environment.id, bundle.resolved.environment.manifest);
    const imported = await service.importRunBundle(bundle);
    assert.equal(imported.version, 11);
    const resolved = await service.resolveRunManifest(imported.id);
    assert.deepEqual(resolved.identityProfile, WORLD_BOUND_IDENTITY);
    assert.equal(resolved.world.hash, bundle.resolved.world.hash);
    assert.notEqual(resolved.simulationSemanticHash, bundle.simulationSemanticHash);
    assert.deepEqual(Buffer.from(runBundleBytes(bundle)), bytes);
});

test("VIS-12a validates script and embedded-binding locks before semantic projection", async (t) => {
    const { service } = await temporaryService(t);
    const artifact = { kind: "compiled-test", version: 1, value: "initial" };
    await service.putScript({ id: "identity-script", latestValidArtifact: artifact });
    const binding = { id: "identity-binding", enabled: true, scriptId: "identity-script",
        trigger: { kind: "fixed-update", everyN: 1 }, inputs: [], outputs: [] };
    const manifest = createDefaultRunManifest({ id: "script-locks", scripts: {
        enabled: true, artifacts: [{ scriptId: "identity-script", expectedHash: computeResolvedRunHash(artifact) }],
        embeddedBindings: [binding], expectedBindingsHash: computeResolvedRunHash([binding]),
    } });
    manifest.sensorRig.sensors = [];
    const before = await service.resolveRunManifest(manifest.id, manifest);
    await service.putScript({ id: "identity-script", latestValidArtifact: { ...artifact, value: "changed" } });
    await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /Script .* changed/);
    manifest.scripts.artifacts[0].expectedHash = computeResolvedRunHash({ ...artifact, value: "changed" });
    manifest.scripts.expectedBindingsHash = "0".repeat(64);
    await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /Script bindings changed/);
    manifest.scripts.expectedBindingsHash = computeResolvedRunHash([binding]);
    const after = await service.resolveRunManifest(manifest.id, manifest);
    assert.notEqual(before.simulationSemanticHash, after.simulationSemanticHash);
});
