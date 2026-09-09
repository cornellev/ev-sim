import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { verifyRoute } from "../app/scenarios/route/Route.js";
import { createDefaultRunManifest, computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { assertEnabledCameraRenderRuntime } from "../app/simulation/render/RenderSceneProviderRegistry.js";
import {
    computeEpisodeHash,
    computeSimulationSemanticHash,
    defaultEpisodeIdentity,
} from "../app/simulation/kernel/SimulationHashes.js";
import { normalizeEpisodeSpec } from "../app/simulation/headless/HeadlessEpisode.js";
import {
    GPU_SENSOR_BACKEND_V2_CONFIG_HASH,
    GPU_SENSOR_BACKEND_V2_VERSION,
} from "../app/simulation/sensors/GpuSensorBackend.js";
import {
    hashPbrRenderScene,
    defaultPbrRenderRecipe,
    hashPbrRunEvidence,
    normalizePbrRenderRecipe,
} from "../app/simulation/render/PbrRenderScene.js";
import { normalizeVisualLayer } from "../app/simulation/visual/VisualLayer.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { HeadlessSession } from "../server/headless/HeadlessSession.js";
import { inspectRunBundle, inspectTarget } from "../server/headless/Inspection.js";
import {
    canonicalRunBundleStringify,
    verifyRunBundle,
    verifyRunBundleBytes,
    verifyRunBundleIntegrity,
} from "../server/headless/RunBundle.js";
import { SupervisorRunner } from "../server/headless/SupervisorRunner.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { StorageService } from "../server/storage/StorageService.js";
import {
    makeNamedMaterialGlb,
    makePng,
    makeTriangleGltfWithBuffer,
    ownedGrant,
    publishAsset,
    restrictedGrant,
    sha256Hex,
    writeRegistry,
} from "./helpers/visual-assets.js";

function environmentV2(id = "yard") {
    return {
        environmentId: id,
        name: "Owned visual yard",
        schemaVersion: 2,
        templateId: "blank",
        roadStylePreset: "default",
        roadsAuthored: true,
        buildingsAuthored: true,
        featuresAuthored: false,
        document: {
            environmentId: id,
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
}

function pbrSelection() {
    return {
        provider: { id: "pbr-mesh", version: 1 },
        productProfile: { id: "measured-rgba-analytic-oracle", version: 1 },
    };
}

function scenarioFor(environment) {
    const edge = environment.document.roads.edges[0];
    const nodes = new Map(environment.document.roads.nodes.map((node) => [node.id, node]));
    const verified = verifyRoute(environment, {
        id: "ego-route",
        actorId: "ego",
        waypoints: [edge.startNodeId, edge.endNodeId].map((id) => ({
            id,
            position: { x: nodes.get(id).x, y: 0, z: nodes.get(id).z },
        })),
    });
    assert.equal(verified.ok, true);
    return createDefaultScenario({
        id: "visual-scenario",
        environment: { id: environment.environmentId, expectedHash: computeResolvedRunHash(environment) },
        actors: [{ id: "ego", name: "Ego", role: "ego", vehicleId: "big-car" }],
        routes: [{
            id: "ego-route",
            actorId: "ego",
            initialSpeedMps: 0,
            controller: { kind: "route-follower" },
            waypoints: verified.waypoints,
            verification: verified.verification,
        }],
        completion: { conditions: [{ id: "limit", kind: "max-duration", durationNs: 1e9 }] },
    });
}

function rehashOuterBundle(bundle) {
    const next = structuredClone(bundle);
    next.resolved.simulationSemanticHash = computeSimulationSemanticHash(next.resolved);
    next.resolved.resolvedHash = computeResolvedRunHash(next.resolved);
    next.manifest = structuredClone(next.resolved.manifest);
    next.resolvedHash = next.resolved.resolvedHash;
    next.simulationSemanticHash = next.resolved.simulationSemanticHash;
    return next;
}

async function fixture(t, { sources = [ownedGrant()] } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis12b-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const registryPath = await writeRegistry(directory, sources);
    const service = new StorageService(directory, { visualAssets: { registryPath } });
    const createdEnvironment = await service.createEnvironment({ id: "yard", name: "Owned visual yard", templateId: "blank" });
    let environment = await service.putEnvironment("yard", {
        manifest: { ...createdEnvironment, ...environmentV2("yard") },
        expectedRevision: createdEnvironment.revision,
    });
    const world = createWorldResource(environment);

    const texture = await publishAsset(service.visualAssets, makePng({ red: 32, green: 64, blue: 128 }), {
        mediaType: "image/png", role: "texture",
    });
    const binary = Buffer.alloc(42);
    binary.writeFloatLE(1, 12);
    binary.writeFloatLE(1, 28);
    binary.writeUInt16LE(0, 36);
    binary.writeUInt16LE(1, 38);
    binary.writeUInt16LE(2, 40);
    const buffer = await publishAsset(service.visualAssets, binary, {
        mediaType: "application/octet-stream", role: "buffer",
    });
    const meshBytes = makeTriangleGltfWithBuffer(buffer.use.asset.sha256);
    const mesh = await publishAsset(service.visualAssets, meshBytes, {
        mediaType: "model/gltf+json",
        role: "mesh",
        dependencies: { [`sha256:${buffer.use.asset.sha256}`]: buffer.useHash },
    });
    const lod = await publishAsset(service.visualAssets, makeNamedMaterialGlb("lod-surface"), {
        mediaType: "model/gltf-binary", role: "mesh",
    });
    const actor = await publishAsset(service.visualAssets, makeNamedMaterialGlb("actor-surface"), {
        mediaType: "model/gltf-binary", role: "actor",
    });
    const environmentMap = await publishAsset(service.visualAssets, makePng({ red: 5, green: 10, blue: 15 }), {
        mediaType: "image/png", role: "environment-map",
    });
    const descriptor = normalizeVisualLayer({
        sourceWorldHash: world.hash,
        assets: [mesh.use.asset, buffer.use.asset, lod.use.asset, texture.use.asset],
        materials: [{
            id: "surface",
            textures: [{ slot: "baseColor", assetUri: `sha256:${texture.use.asset.sha256}` }],
        }],
        chunks: [{
            id: "yard-chunk",
            instanceIds: ["building-visual"],
            dependencyUris: [`sha256:${buffer.use.asset.sha256}`],
        }],
        instances: [{
            id: "building-visual",
            assetUri: `sha256:${mesh.use.asset.sha256}`,
            lodLevels: [`sha256:${mesh.use.asset.sha256}`, `sha256:${lod.use.asset.sha256}`],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
            chunkIds: ["yard-chunk"],
            materialIds: ["surface"],
        }],
        bindings: [{ id: "building-binding", instanceId: "building-visual", truthEntityId: "building-0" }],
        appearanceDependencies: [`sha256:${texture.use.asset.sha256}`],
    });
    const layer = await service.publishVisualLayer({
        descriptor,
        assetUses: [mesh, buffer, lod, texture].map((entry) => ({
            sha256: entry.use.asset.sha256,
            useHash: entry.useHash,
        })),
    });
    environment = await service.putEnvironment("yard", {
        manifest: {
            ...environment,
            visualLayer: { descriptorHash: layer.descriptorHash, accessHash: layer.accessHash },
            evidence: { reportHash: "e".repeat(64) },
        },
        expectedRevision: environment.revision,
    });

    const manifest = createDefaultRunManifest({ id: "owned-pbr" });
    manifest.environment = { id: "yard", expectedHash: null };
    manifest.sensorRig.sensors.find((sensor) => sensor.type === "camera").render = pbrSelection();
    manifest.renderRecipe = normalizePbrRenderRecipe({
        background: {
            environmentMap: {
                asset: environmentMap.use.asset,
                useHash: environmentMap.useHash,
                intensity: 0.75,
                rotationRadians: 0.125,
            },
        },
        actors: [{
            actorId: "ego",
            mode: "visual-asset",
            asset: { asset: actor.use.asset, useHash: actor.useHash },
            material: { baseColorFactor: [0.8, 0.7, 0.6, 1], metallicFactor: 0.1, roughnessFactor: 0.7 },
        }],
    });
    await service.createRunManifest(manifest);
    return {
        directory,
        service,
        environment,
        manifest,
        descriptor,
        layer,
        assets: { texture, buffer, mesh, lod, actor, environmentMap },
    };
}

test("VIS-12b resolves an owned selected PBR scene with exact recipe, actor, IBL, and transitive asset closure", async (t) => {
    const { service } = await fixture(t);
    const resolved = await service.resolveRunManifest("owned-pbr");
    assert.equal(resolved.renderScene.description.provider.id, "pbr-mesh");
    assert.equal(resolved.visualLayer.hash, resolved.dependencyHashes.visualLayer);
    assert.equal(resolved.renderScene.hash, resolved.dependencyHashes.renderScene);
    assert.equal(resolved.evidence.correspondence.status, "unverified-reference");
    assert.equal(resolved.evidence.correspondence.reportHash, "e".repeat(64));
    assert.deepEqual(resolved.evidence.visualAssets.permissions.operations, ["display", "machine-interpretation"]);
    assert.equal(resolved.renderScene.description.assetClosure.assets.length, 6);
    assert.equal(resolved.evidence.visualAssets.uses.length, 6);
    assert.equal("useHash" in resolved.renderScene.description.recipe.background.environmentMap, false);
    assert.equal(JSON.stringify(resolved.renderScene).includes(resolved.evidence.visualAssets.accessHash), false);
    assert.equal(resolved.renderScene.description.analyticTruth.description.actors[0].actorId, "ego");
    assert.equal(resolved.renderScene.description.actors[0].mode, "visual-asset");

    const bundle = await service.exportRunManifest("owned-pbr");
    verifyRunBundleIntegrity(bundle);
    verifyRunBundle(bundle);
    const inspection = inspectRunBundle(bundle);
    assert.equal(inspection.execution.implementationSupported, true);
    assert.equal(inspection.execution.hostReady, null);
    assert.equal(inspection.renderScene.assetCount, 6);
    assert.equal(inspection.visualEvidence.correspondenceStatus, "unverified-reference");
    assert.match(inspection.visualEvidence.offlineLimitations.join(" "), /not establish current asset availability or rights/);
    const episode = normalizeEpisodeSpec(resolved);
    const gpu = episode.backendSelections.find((entry) => entry.kind === 4);
    assert.equal(gpu.version, GPU_SENSOR_BACKEND_V2_VERSION);
    assert.equal(gpu.configHash, GPU_SENSOR_BACKEND_V2_CONFIG_HASH);
});

test("VIS-12b exact PBR identity changes below legacy six-decimal numeric precision while evidence stays non-semantic", async (t) => {
    const { service, manifest } = await fixture(t);
    const before = await service.resolveRunManifest("owned-pbr");
    const changed = structuredClone(manifest);
    changed.renderRecipe.colorPipeline.exposure += 1e-8;
    const after = await service.resolveRunManifest(changed.id, changed);
    assert.notEqual(after.renderScene.description.recipeHash, before.renderScene.description.recipeHash);
    assert.notEqual(after.renderScene.hash, before.renderScene.hash);
    assert.equal(after.world.hash, before.world.hash);
    assert.equal(after.lidarGeometry.hash, before.lidarGeometry.hash);
    assert.notEqual(after.resolvedHash, before.resolvedHash);
    assert.notEqual(after.simulationSemanticHash, before.simulationSemanticHash);
    assert.notEqual(
        computeEpisodeHash(defaultEpisodeIdentity(after)),
        computeEpisodeHash(defaultEpisodeIdentity(before)),
    );

    const evidenceOnly = structuredClone(before);
    evidenceOnly.evidence.correspondence.reportHash = "f".repeat(64);
    evidenceOnly.dependencyHashes.evidence = hashPbrRunEvidence(evidenceOnly.evidence);
    assert.equal(computeSimulationSemanticHash(evidenceOnly), before.simulationSemanticHash);
    const resourceOnly = { ...structuredClone(before), resourceLimits: { maxGpuBytes: 1 } };
    assert.equal(computeSimulationSemanticHash(resourceOnly), before.simulationSemanticHash);
});

test("VIS-12b identity separates pixel, simulation, evidence, and authoring-only changes", async (t) => {
    const { service, environment, manifest, descriptor, assets } = await fixture(t);
    const before = await service.resolveRunManifest("owned-pbr");

    for (const mutate of [
        (value) => { value.renderRecipe.lighting.ambient.intensity += 1e-8; },
        (value) => { value.renderRecipe.actors[0].transform[12] += 1e-8; },
    ]) {
        const changed = structuredClone(manifest);
        mutate(changed);
        const after = await service.resolveRunManifest(changed.id, changed);
        assert.notEqual(after.renderScene.hash, before.renderScene.hash);
        assert.equal(after.world.hash, before.world.hash);
        assert.equal(after.lidarGeometry.hash, before.lidarGeometry.hash);
    }

    const alternateMap = await publishAsset(service.visualAssets, makePng({ red: 6, green: 10, blue: 15 }), {
        mediaType: "image/png",
        role: "environment-map",
    });
    const assetChanged = structuredClone(manifest);
    assetChanged.renderRecipe.background.environmentMap.asset = alternateMap.use.asset;
    assetChanged.renderRecipe.background.environmentMap.useHash = alternateMap.useHash;
    const alternatePixels = await service.resolveRunManifest(assetChanged.id, assetChanged);
    assert.notEqual(alternatePixels.renderScene.hash, before.renderScene.hash);

    const calibrationChanged = structuredClone(manifest);
    const cameraProducts = calibrationChanged.sensorRig.sensors.find(
        (sensor) => sensor.type === "camera",
    ).calibration.products;
    cameraProducts.depth = cameraProducts.depth !== true;
    const calibrated = await service.resolveRunManifest(calibrationChanged.id, calibrationChanged);
    assert.equal(calibrated.renderScene.hash, before.renderScene.hash);
    assert.notEqual(calibrated.simulationSemanticHash, before.simulationSemanticHash);

    const seeded = structuredClone(manifest);
    seeded.seed += 1;
    const seedResolved = await service.resolveRunManifest(seeded.id, seeded);
    assert.equal(seedResolved.renderScene.hash, before.renderScene.hash);
    assert.notEqual(seedResolved.simulationSemanticHash, before.simulationSemanticHash);

    const logging = structuredClone(manifest);
    logging.logging.policy = logging.logging.policy === "disabled" ? "required" : "disabled";
    const logged = await service.resolveRunManifest(logging.id, logging);
    assert.equal(logged.renderScene.hash, before.renderScene.hash);
    assert.equal(logged.simulationSemanticHash, before.simulationSemanticHash);
    assert.notEqual(logged.resolvedHash, before.resolvedHash);

    const materialDescriptor = structuredClone(descriptor);
    materialDescriptor.materials[0].parameters.baseColorFactor[0] = 0.75;
    const materialLayer = await service.publishVisualLayer({
        descriptor: materialDescriptor,
        assetUses: [assets.mesh, assets.buffer, assets.lod, assets.texture].map((entry) => ({
            sha256: entry.use.asset.sha256,
            useHash: entry.useHash,
        })),
    });
    await service.putEnvironment(environment.environmentId, {
        manifest: {
            ...environment,
            visualLayer: {
                descriptorHash: materialLayer.descriptorHash,
                accessHash: materialLayer.accessHash,
            },
            evidence: null,
        },
        expectedRevision: environment.revision,
    });
    const materialResolved = await service.resolveRunManifest(manifest.id, manifest);
    assert.notEqual(materialResolved.visualLayer.hash, before.visualLayer.hash);
    assert.notEqual(materialResolved.renderScene.hash, before.renderScene.hash);
    assert.equal(materialResolved.world.hash, before.world.hash);
    assert.equal(materialResolved.lidarGeometry.hash, before.lidarGeometry.hash);
});

test("VIS-12b preserves explicit recipes from older clients and requires null to reset", async (t) => {
    const { service } = await fixture(t);
    const stored = await service.getRunManifest("owned-pbr");
    const oldClient = structuredClone(stored);
    delete oldClient.renderRecipe;
    const preserved = await service.putRunManifest(stored.id, {
        manifest: oldClient,
        expectedRevision: stored.revision,
    });
    assert.deepEqual(preserved.renderRecipe, stored.renderRecipe);
    const reset = await service.putRunManifest(stored.id, {
        manifest: { ...preserved, renderRecipe: null },
        expectedRevision: preserved.revision,
    });
    assert.equal(Object.hasOwn(reset, "renderRecipe"), false);
    assert.deepEqual(defaultPbrRenderRecipe().background.colorRgba, [0, 0, 0, 1]);

    const source = await service.getRunManifest("owned-pbr");
    await service.putRunManifest(source.id, {
        manifest: { ...source, renderRecipe: stored.renderRecipe },
        expectedRevision: source.revision,
    });
    const duplicate = await service.duplicateRunManifest(source.id, { id: "owned-pbr-copy" });
    assert.deepEqual(duplicate.renderRecipe, stored.renderRecipe);
});

test("VIS-12b performs no PBR asset access for analytic runs or before a stale environment lock fails", async (t) => {
    const { service, assets } = await fixture(t);
    let validations = 0;
    const original = service.visualAssets.validateAccessSet.bind(service.visualAssets);
    service.visualAssets.validateAccessSet = async (...args) => {
        validations += 1;
        return original(...args);
    };
    const analytic = createDefaultRunManifest({ id: "analytic-no-assets" });
    analytic.environment = { id: "yard", expectedHash: null };
    await service.resolveRunManifest(analytic.id, analytic);
    assert.equal(validations, 0);

    const disabled = createDefaultRunManifest({ id: "disabled-pbr" });
    disabled.environment = { id: "yard", expectedHash: null };
    disabled.sensorRig.sensors.find((sensor) => sensor.type === "camera").enabled = false;
    disabled.sensorRig.sensors.push({
        ...structuredClone(disabled.sensorRig.sensors.find((sensor) => sensor.type === "camera")),
        id: "disabled-pbr-camera",
        enabled: false,
        render: pbrSelection(),
    });
    disabled.renderRecipe = normalizePbrRenderRecipe({
        actors: [{
            actorId: "ego",
            mode: "visual-asset",
            asset: { asset: assets.actor.use.asset, useHash: assets.actor.useHash },
        }],
    });
    const disabledWithRecipe = await service.resolveRunManifest(disabled.id, disabled);
    const disabledWithoutRecipe = structuredClone(disabled);
    delete disabledWithoutRecipe.renderRecipe;
    const disabledBaseline = await service.resolveRunManifest(disabledWithoutRecipe.id, disabledWithoutRecipe);
    assert.equal(disabledWithRecipe.simulationSemanticHash, disabledBaseline.simulationSemanticHash);
    assert.equal(validations, 0);

    const stale = await service.getRunManifest("owned-pbr");
    stale.environment.expectedHash = sha256Hex(Buffer.from("stale"));
    await assert.rejects(service.resolveRunManifest(stale.id, stale), /Environment .* changed/);
    assert.equal(validations, 0);
});

test("VIS-12b resolves scenario-backed PBR only after nested locks are current", async (t) => {
    const { service, environment } = await fixture(t);
    let scenario = await service.createScenario(scenarioFor(environment));
    const manifest = await service.getRunManifest("owned-pbr");
    manifest.scenario = {
        id: scenario.id,
        expectedHash: scenario.definitionHash,
        egoVehicleId: "big-car",
        sensorBindings: {},
        parameterValues: {},
    };
    const direct = await service.resolveRunManifest(manifest.id, { ...manifest, scenario: null });
    const selected = await service.resolveRunManifest(manifest.id, manifest);
    assert.equal(selected.renderScene.description.provider.id, "pbr-mesh");
    assert.equal(selected.renderScene.description.visualLayerHash, direct.visualLayer.hash);

    scenario = await service.putScenario(scenario.id, {
        scenario: {
            ...scenario,
            completion: { conditions: [{ id: "limit", kind: "max-duration", durationNs: 2e9 }] },
        },
        expectedRevision: scenario.revision,
    });
    let validations = 0;
    const original = service.visualAssets.validateAccessSet.bind(service.visualAssets);
    service.visualAssets.validateAccessSet = async (...args) => {
        validations += 1;
        return original(...args);
    };
    await assert.rejects(service.resolveRunManifest(manifest.id, manifest), /Scenario .* changed/);
    assert.equal(validations, 0);
    manifest.scenario.expectedHash = scenario.definitionHash;
    const refreshed = await service.resolveRunManifest(manifest.id, manifest);
    assert.equal(validations, 1);
    assert.equal(refreshed.renderScene.hash, selected.renderScene.hash);
    assert.notEqual(refreshed.simulationSemanticHash, selected.simulationSemanticHash);
});

test("VIS-12b re-evaluates selected rights and ancestry through the operator registry", async (t) => {
    const { directory, service } = await fixture(t);
    const cases = [
        ["unknown", []],
        ["restricted", [restrictedGrant("owned-lab", { permissions: { display: true } })]],
        ["expired", [ownedGrant("owned-lab", { expiresAt: "2020-01-01T00:00:00.000Z" })]],
        ["revoked", [ownedGrant("owned-lab", { status: "revoked" })]],
        ["derived", [
            ownedGrant("owned-lab", { ancestorIds: ["restricted-parent"] }),
            restrictedGrant("restricted-parent", { permissions: { display: true } }),
        ]],
    ];
    for (const [label, sources] of cases) {
        await writeRegistry(directory, sources);
        await assert.rejects(
            service.resolveRunManifest("owned-pbr"),
            (error) => error.code === "VISUAL_LAYER_RIGHTS_DENIED",
            label,
        );
    }
});

test("VIS-12b keeps source-specific use evidence when selected roots share identical bytes", async (t) => {
    const { directory, service, assets } = await fixture(t, {
        sources: [ownedGrant(), ownedGrant("owned-alt")],
    });
    const alternate = await publishAsset(service.visualAssets, makeNamedMaterialGlb("actor-surface"), {
        mediaType: "model/gltf-binary",
        role: "actor",
        sourceIds: ["owned-alt"],
    });
    assert.equal(alternate.use.asset.sha256, assets.actor.use.asset.sha256);
    assert.notEqual(alternate.useHash, assets.actor.useHash);

    const source = await service.getRunManifest("owned-pbr");
    const withNpc = structuredClone(source);
    withNpc.initialState.vehicles.push({
        ...structuredClone(withNpc.initialState.vehicles[0]),
        id: "npc",
        pose: {
            ...structuredClone(withNpc.initialState.vehicles[0].pose),
            position: { x: 4, y: 0, z: 0 },
        },
    });
    withNpc.renderRecipe.actors.push({
        ...structuredClone(withNpc.renderRecipe.actors[0]),
        actorId: "npc",
    });
    const owned = await service.resolveRunManifest(withNpc.id, withNpc);
    const alternateUse = structuredClone(withNpc);
    alternateUse.renderRecipe.actors.find((entry) => entry.actorId === "npc").asset.useHash = alternate.useHash;
    const shared = await service.resolveRunManifest(alternateUse.id, alternateUse);
    assert.equal(shared.renderScene.hash, owned.renderScene.hash);
    assert.equal(shared.simulationSemanticHash, owned.simulationSemanticHash);
    assert.equal(
        computeEpisodeHash(defaultEpisodeIdentity(shared)),
        computeEpisodeHash(defaultEpisodeIdentity(owned)),
    );
    assert.notEqual(shared.resolvedHash, owned.resolvedHash);
    assert.equal(shared.renderScene.description.assetClosure.assets.length, 6);
    assert.equal(shared.evidence.visualAssets.uses.length, 7);
    assert.ok(shared.evidence.visualAssets.permissions.evaluatedSourceIds.includes("owned-alt"));

    await writeRegistry(directory, [ownedGrant(), ownedGrant("owned-alt", { status: "revoked" })]);
    await assert.rejects(
        service.resolveRunManifest(alternateUse.id, alternateUse),
        (error) => error.code === "VISUAL_LAYER_RIGHTS_DENIED",
    );
});

test("VIS-12b resolution verifies CAS bytes and rejects incomplete transitive use graphs", async (t) => {
    const { service, assets } = await fixture(t);
    const actorBytes = makeNamedMaterialGlb("actor-surface");
    const actorPath = service.visualAssets._casPath(assets.actor.use.asset.sha256);
    await fs.writeFile(actorPath, Buffer.alloc(actorBytes.length, 0x5a));
    await assert.rejects(
        service.resolveRunManifest("owned-pbr"),
        (error) => error.code === "VISUAL_ASSET_CORRUPT",
    );
    await fs.writeFile(actorPath, actorBytes);

    await fs.rm(service.visualAssets._usePath(assets.buffer.useHash));
    await assert.rejects(
        service.resolveRunManifest("owned-pbr"),
        (error) => error.code === "VISUAL_ASSET_USE_NOT_FOUND",
    );
});

test("VIS-12b integrity rejects rehashed inner tampering, profile drift, and duplicate JSON keys", async (t) => {
    const { service } = await fixture(t);
    const bundle = await service.exportRunManifest("owned-pbr");

    const recipeTamper = structuredClone(bundle);
    recipeTamper.resolved.renderScene.description.recipe.colorPipeline.exposure += 1e-8;
    assert.throws(
        () => verifyRunBundleIntegrity(rehashOuterBundle(recipeTamper)),
        (error) => error.code === "BUNDLE_HASH_MISMATCH" && /recipeHash|render-scene hash/i.test(error.message),
    );

    const closureTamper = structuredClone(bundle);
    closureTamper.resolved.renderScene.description.assetClosure.assets.pop();
    assert.throws(
        () => verifyRunBundleIntegrity(rehashOuterBundle(closureTamper)),
        (error) => error.code === "BUNDLE_HASH_MISMATCH",
    );

    const profileTamper = structuredClone(bundle);
    profileTamper.resolved.renderScene.description.productProfile.version = 2;
    profileTamper.resolved.renderScene.hash = hashPbrRenderScene(profileTamper.resolved.renderScene.description);
    profileTamper.resolved.dependencyHashes.renderScene = profileTamper.resolved.renderScene.hash;
    assert.throws(
        () => verifyRunBundleIntegrity(rehashOuterBundle(profileTamper)),
        (error) => error.code === "BUNDLE_INVALID" && /product profile/i.test(error.message),
    );

    const canonical = canonicalRunBundleStringify(bundle);
    const duplicateKey = Buffer.from(canonical.replace(/^\{/, '{"kind":"cev-sim.run-bundle",'));
    assert.throws(
        () => verifyRunBundleBytes(duplicateKey, { execution: false }),
        (error) => error.code === "BUNDLE_INVALID" && /Duplicate JSON object key/.test(error.message),
    );

    const negativeZero = normalizePbrRenderRecipe({
        background: { environmentMap: null },
        colorPipeline: { exposure: -0 },
    });
    assert.equal(Object.is(negativeZero.colorPipeline.exposure, -0), false);
    assert.throws(() => normalizePbrRenderRecipe({ kind: "cev-sim.pbr-render-recipe", version: 2 }), /version 1/);
    assert.throws(() => normalizePbrRenderRecipe({ actors: [{ actorId: "e\u0301go" }] }), /NFC/);
});

test("VIS-15a inspection separates static PBR support from supervisor host readiness", async (t) => {
    const { directory, service } = await fixture(t);
    const bundle = await service.exportRunManifest("owned-pbr");
    const bundlePath = path.join(directory, "owned-pbr.bundle.json");
    await fs.writeFile(bundlePath, canonicalRunBundleStringify(bundle));
    const inspection = await inspectTarget(bundlePath);
    assert.equal(inspection.execution.implementationSupported, true);
    assert.equal(inspection.execution.hostReady, null);
    assert.match(inspection.execution.hostReadinessReason, /PBR probes/);
    assert.match(inspection.visualEvidence.offlineLimitations.join(" "), /does not establish current asset availability or rights/);

    assert.equal(assertEnabledCameraRenderRuntime(
        bundle.resolved.manifest.sensorRig.sensors,
        bundle.resolved.renderScene,
        { target: "browser" },
    ).provider.id, "pbr-mesh");
    assert.equal(assertEnabledCameraRenderRuntime(
        bundle.resolved.manifest.sensorRig.sensors,
        bundle.resolved.renderScene,
        { target: "headless" },
    ).provider.id, "pbr-mesh");

    const session = new HeadlessSession();
    await assert.rejects(session.prepare(bundle), (error) => error.code === "UNSUPPORTED_CAPABILITY");
    await session.close();

    let supervisorCreated = false;
    const runner = new SupervisorRunner({
        supervisorFactory: (options) => {
            supervisorCreated = true;
            return new HeadlessSupervisor({
                ...options,
                rendererAdapterFactory: () => ({
                    provenance: null,
                    async start() {
                        this.provenance = {
                            renderer: "hardware-test-gpu",
                            floatColorBuffer: true,
                            floatFramebufferComplete: true,
                            readbackCheck: true,
                            pbrRuntime: false,
                        };
                    },
                    async close() {},
                }),
            });
        },
    });
    await assert.rejects(runner.run(bundle, {
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            renderer: { chromiumExecutable: "/fake/chromium" },
        },
        outputUri: path.join(directory, "output"),
    }), (error) => error.code === "UNSUPPORTED_CAPABILITY");
    assert.equal(supervisorCreated, true);
});

test("VIS-12b JSON import rejects missing local dependencies without installing visual asset bytes", async (t) => {
    const { service } = await fixture(t);
    const bundle = await service.exportRunManifest("owned-pbr");
    const targetDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis12b-import-"));
    t.after(() => fs.rm(targetDirectory, { recursive: true, force: true }));
    const target = new StorageService(targetDirectory, {
        visualAssets: { registryPath: await writeRegistry(targetDirectory, [ownedGrant()]) },
    });
    await assert.rejects(
        target.importRunBundle(bundle),
        (error) => error.code === "VISUAL_LAYER_DESCRIPTOR_NOT_FOUND",
    );
    await target.visualAssets.initialize();
    assert.deepEqual(await fs.readdir(target.visualAssets.casDir), []);

    assert.equal(
        await target._visualLayerDescriptors.put(bundle.resolved.visualLayer.description),
        bundle.resolved.visualLayer.hash,
    );
    assert.equal(
        await target._visualLayerAccess.put(bundle.resolved.evidence.visualAssets.access),
        bundle.resolved.evidence.visualAssets.accessHash,
    );
    for (const { useHash } of bundle.resolved.evidence.visualAssets.uses) {
        await fs.copyFile(service.visualAssets._usePath(useHash), target.visualAssets._usePath(useHash));
        await fs.copyFile(service.visualAssets._validationPath(useHash), target.visualAssets._validationPath(useHash));
    }
    await assert.rejects(
        target.importRunBundle(bundle),
        (error) => error.code === "VISUAL_ASSET_CORRUPT",
    );
    assert.deepEqual(await fs.readdir(target.visualAssets.casDir), []);

    const installedDigests = new Set();
    for (const { use } of bundle.resolved.evidence.visualAssets.uses) {
        if (installedDigests.has(use.asset.sha256)) continue;
        installedDigests.add(use.asset.sha256);
        await fs.copyFile(
            service.visualAssets._casPath(use.asset.sha256),
            target.visualAssets._casPath(use.asset.sha256),
        );
    }
    const casEntriesBefore = await fs.readdir(target.visualAssets.casDir);
    const imported = await target.importRunBundle(bundle);
    assert.equal(imported.renderRecipe.kind, "cev-sim.pbr-render-recipe");
    assert.deepEqual(await fs.readdir(target.visualAssets.casDir), casEntriesBefore);
});
