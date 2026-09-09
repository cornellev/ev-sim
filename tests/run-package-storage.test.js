import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { normalizeEpisodeSpec } from "../app/simulation/headless/HeadlessEpisode.js";
import { canonicalRunBundleStringify } from "../server/headless/RunBundle.js";
import { ERROR_CODE, HEADLESS_PROTOCOL } from "../server/headless/HeadlessProtocol.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { stageRunPackage } from "../server/headless/VisualAssetAdmission.js";
import { createWorldResource } from "../app/simulation/world/WorldDescription.js";
import { normalizePbrRenderRecipe } from "../app/simulation/render/PbrRenderScene.js";
import { normalizeVisualLayer, VISUAL_SOURCE_OPERATIONS } from "../app/simulation/visual/VisualLayer.js";
import { RUN_PACKAGE_ERROR_CODES, VISUAL_ASSET_ERROR_CODES } from "../server/storage/StorageErrors.js";
import { StorageService } from "../server/storage/StorageService.js";
import {
    makeNamedMaterialGlb,
    makePng,
    makeTriangleGltfWithBuffer,
    ownedGrant,
    publishAsset,
    restrictedGrant,
    writeRegistry,
} from "./helpers/visual-assets.js";

async function exportPackage(service, input) {
    const exported = await service.exportRunPackage(input);
    const chunks = [];
    for await (const chunk of exported.stream) chunks.push(Buffer.from(chunk));
    return { ...await exported.completion, bytes: Buffer.concat(chunks) };
}

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

function grantWithout(operation) {
    return restrictedGrant("owned-lab", {
        permissions: Object.fromEntries(
            VISUAL_SOURCE_OPERATIONS.filter((entry) => entry !== operation).map((entry) => [entry, true]),
        ),
    });
}

async function pbrFixture(t, { sources = [ownedGrant()], faults = {} } = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis13a-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const registryPath = await writeRegistry(directory, sources);
    const service = new StorageService(directory, {
        faults,
        visualAssets: { registryPath, faults },
    });
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
    const mesh = await publishAsset(service.visualAssets, makeTriangleGltfWithBuffer(buffer.use.asset.sha256), {
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
    return { directory, service };
}

test("G-PACKAGE empty analytic export and import round-trip without assets", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis13a-empty-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const service = new StorageService(directory);
    const encoded = await exportPackage(service, { manifestId: "igvc-default" });
    assert.equal(encoded.assetCount, 0);
    const laterBundle = await service.exportRunManifest("igvc-default");
    const again = await exportPackage(service, {
        bundleBytes: Buffer.from(canonicalRunBundleStringify(laterBundle)),
    });
    assert.notEqual(again.archiveHash, encoded.archiveHash);
    const verified = await service.verifyRunPackage(encoded.bytes);
    assert.equal(verified.archiveHash, encoded.archiveHash);
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis13a-empty-in-"));
    t.after(() => fs.rm(targetDir, { recursive: true, force: true }));
    const imported = await new StorageService(targetDir).importRunPackage(encoded.bytes);
    assert.equal(imported.archiveHash, encoded.archiveHash);
    assert.ok(imported.runManifest.id.startsWith("igvc-default"));
});

test("G-PACKAGE owned PBR packages include transitive GLTF buffers, textures, LODs, actors, and environment maps", async (t) => {
    const { service } = await pbrFixture(t);
    const bundle = await service.exportRunManifest("owned-pbr");
    const pretty = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`);
    const first = await exportPackage(service, { bundleBytes: pretty });
    const second = await exportPackage(service, { bundleBytes: Buffer.from(pretty) });
    assert.equal(first.assetCount, 6);
    assert.deepEqual(first.bytes, second.bytes);
    const laterBundle = structuredClone(bundle);
    laterBundle.exportedAt = "2099-01-01T00:00:00.000Z";
    const later = await exportPackage(service, { bundleBytes: Buffer.from(JSON.stringify(laterBundle)) });
    assert.notEqual(later.archiveHash, first.archiveHash);

    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis13a-pbr-in-"));
    t.after(() => fs.rm(targetDir, { recursive: true, force: true }));
    const registryPath = await writeRegistry(targetDir, [ownedGrant()]);
    const target = new StorageService(targetDir, { visualAssets: { registryPath } });
    const imported = await target.importRunPackage(first.bytes);
    assert.equal(imported.assetCount, 6);
    assert.ok(imported.root?.ownerId.startsWith("run-package:"));
    for (const asset of first.manifest.assets) {
        assert.equal((await target.visualAssets.readPublishedBytes(asset.sha256)).length, asset.sizeBytes);
    }
    await assert.rejects(
        () => target.verifyRunPackage(Buffer.concat([
            first.bytes.subarray(0, first.bytes.length - 1024),
            Buffer.from("x"),
        ])),
        (error) => error.code === RUN_PACKAGE_ERROR_CODES.HOSTILE,
    );
});

test("G-RIGHTS deny unknown, revoked, expired, derived-restricted, and export-less sources at package boundaries", async (t) => {
    const { service } = await pbrFixture(t, { sources: [grantWithout("export")] });
    await assert.rejects(
        () => service.exportRunPackage({ manifestId: "owned-pbr" }),
        (error) => error.code === RUN_PACKAGE_ERROR_CODES.RIGHTS_DENIED || error.code === VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
    );

    const owned = await pbrFixture(t);
    const encoded = await exportPackage(owned.service, { manifestId: "owned-pbr" });
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis13a-rights-"));
    t.after(() => fs.rm(targetDir, { recursive: true, force: true }));

    const cases = [
        [restrictedGrant("owned-lab", { permissions: { display: true } })],
        [restrictedGrant("owned-lab", { status: "revoked" })],
        [restrictedGrant("owned-lab", { expiresAt: "2020-01-01T00:00:00.000Z" })],
        [restrictedGrant("owned-lab", {
            kind: "google-derived",
            permissions: { "live-preview-display": true },
        })],
        [
            restrictedGrant("owned-lab", { ancestorIds: ["google"] }),
            restrictedGrant("google", { kind: "google-derived", permissions: { "live-preview-display": true } }),
        ],
        [],
    ];
    for (const sources of cases) {
        const registryPath = await writeRegistry(targetDir, sources);
        const target = new StorageService(targetDir, {
            visualAssets: { registryPath, now: () => new Date("2026-09-08T00:00:00.000Z") },
        });
        await assert.rejects(
            () => target.importRunPackage(encoded.bytes),
            (error) => error.code === RUN_PACKAGE_ERROR_CODES.RIGHTS_DENIED || error.code === VISUAL_ASSET_ERROR_CODES.RIGHTS_DENIED,
        );
    }
});

test("G-LIFECYCLE package faults, abandoned staging, and restart recovery", async (t) => {
    const { service, directory } = await pbrFixture(t);
    const encoded = await exportPackage(service, { manifestId: "owned-pbr" });

    service.faults.write = async () => {
        throw Object.assign(new Error("short"), { code: VISUAL_ASSET_ERROR_CODES.SHORT_WRITE });
    };
    await assert.rejects(
        () => service.verifyRunPackage(encoded.bytes),
        (error) => error.code === VISUAL_ASSET_ERROR_CODES.SHORT_WRITE,
    );
    delete service.faults.write;

    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis13a-fault-in-"));
    t.after(() => fs.rm(targetDir, { recursive: true, force: true }));
    const registryPath = await writeRegistry(targetDir, [ownedGrant()]);
    const publishFaults = {};
    const target = new StorageService(targetDir, {
        visualAssets: { registryPath, faults: publishFaults },
    });
    publishFaults.write = async () => {
        throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    };
    await assert.rejects(
        () => target.importRunPackage(encoded.bytes),
        (error) => error.code === VISUAL_ASSET_ERROR_CODES.DISK_FULL,
    );
    delete publishFaults.write;
    assert.equal(await target.getRunManifest("owned-pbr"), null);

    const stagingRoot = path.join(directory, "visual-packages", "staging");
    await fs.mkdir(path.join(stagingRoot, "abandoned"), { recursive: true });
    await fs.writeFile(path.join(stagingRoot, "abandoned", "meta.json"), `${JSON.stringify({
        id: "abandoned",
        createdAt: "2000-01-01T00:00:00.000Z",
        phase: "created",
    })}\n`);
    const recovered = await service.recoverRunPackages();
    assert.equal(recovered.removed >= 1, true);
    await assert.rejects(() => fs.access(path.join(stagingRoot, "abandoned")));

    const restarted = new StorageService(directory, {
        visualAssets: { registryPath: path.join(directory, "visual-source-registry.json") },
    });
    await restarted.visualAssets.initialize();
    await restarted.recoverRunPackages();
    assert.equal((await exportPackage(restarted, { manifestId: "owned-pbr" })).assetCount, 6);
});

test("G-PACKAGE holds an export pin and never embeds admission handles", async (t) => {
    const { service } = await pbrFixture(t);
    const original = service.visualAssets.acquirePin.bind(service.visualAssets);
    let operations = null;
    service.visualAssets.acquirePin = async (input) => {
        operations = input.operations;
        return original(input);
    };
    const exported = await exportPackage(service, { manifestId: "owned-pbr" });
    assert.deepEqual(operations, ["export"]);
    assert.equal(exported.manifest.kind, "cev-sim.run-package");
    assert.equal(JSON.stringify(exported).includes("asset_admission"), false);
    const originalRelease = service.visualAssets.releasePin.bind(service.visualAssets);
    let announceRelease;
    let permitRelease;
    const releaseStarted = new Promise((resolve) => { announceRelease = resolve; });
    const releasePermitted = new Promise((resolve) => { permitRelease = resolve; });
    service.visualAssets.releasePin = async (input) => {
        announceRelease();
        await releasePermitted;
        return originalRelease(input);
    };
    const abandoned = await service.exportRunPackage({ manifestId: "owned-pbr" });
    assert.equal(Object.keys(service.visualAssets._pins.pins).length, 1);
    const closing = abandoned.close();
    await releaseStarted;
    let closeSettled = false;
    closing.then(() => { closeSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closeSettled, false);
    permitRelease();
    await closing;
    await assert.rejects(() => abandoned.completion, (error) => error.code === RUN_PACKAGE_ERROR_CODES.IO);
    assert.equal(Object.keys(service.visualAssets._pins.pins).length, 0);
});

test("G-LIFECYCLE import journals reconcile roots and authoring manifests after late failure", async (t) => {
    const { service: source } = await pbrFixture(t);
    const targetDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vis13a-journal-target-"));
    t.after(() => fs.rm(targetDir, { recursive: true, force: true }));
    const encoded = await exportPackage(source, { manifestId: "owned-pbr" });
    const registryPath = await writeRegistry(targetDir, [ownedGrant()]);
    const target = new StorageService(targetDir, { visualAssets: { registryPath } });
    const original = target.importRunBundle.bind(target);
    target.importRunBundle = async () => {
        throw new Error("late authoring failure");
    };
    await assert.rejects(() => target.importRunPackage(encoded.bytes), /late authoring failure/);
    assert.equal(await target.visualAssets.getRoot(`run-package:${encoded.archiveHash}`), null);
    assert.equal(await target.getRunManifest("owned-pbr"), null);
    target.importRunBundle = original;

    const restarted = new StorageService(targetDir, { visualAssets: { registryPath } });
    const recovered = await restarted.recoverRunPackages();
    assert.equal(recovered.imports.recovered, 1);
    assert.ok(await restarted.visualAssets.getRoot(`run-package:${encoded.archiveHash}`));
    assert.ok(await restarted.getRunManifest("owned-pbr"));
});

test("VIS-13b admits a rights-valid PBR package but rejects execution before worker creation", async (t) => {
    const { service, directory } = await pbrFixture(t);
    const bundle = await service.exportRunManifest("owned-pbr");
    const exported = await exportPackage(service, {
        bundleBytes: Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`),
    });
    const packagePath = path.join(directory, "owned-pbr.run-package");
    await fs.writeFile(packagePath, exported.bytes);
    const socket = path.join(directory, "pbr-supervisor.sock");
    const supervisor = new HeadlessSupervisor({
        socket,
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            assetAdmission: {
                registryPath: path.join(directory, "visual-source-registry.json"),
            },
        },
    });
    t.after(() => supervisor.close());
    const staged = await stageRunPackage(packagePath, supervisor.config.assetAdmission.inboxDir);
    const admitted = await supervisor.admitRunPackage({
        clientProtocol: HEADLESS_PROTOCOL,
        stagingId: staged.stagingId,
        archiveHash: staged.archiveHash,
    });
    assert.equal(admitted.error.code, ERROR_CODE.OK, admitted.error.message);
    const episode = normalizeEpisodeSpec(bundle.resolved, {});
    const createRequest = {
        clientProtocol: HEADLESS_PROTOCOL,
        runBundles: [{
            bundleId: episode.runBundleId,
            resolvedHash: bundle.resolvedHash,
            simulationSemanticHash: bundle.simulationSemanticHash,
            canonicalJson: Buffer.from(canonicalRunBundleStringify(bundle)),
            assetAdmission: admitted.admission,
        }],
        episodes: [episode],
        artifactPolicy: { profile: 3, outputUri: path.join(directory, "pbr-run") },
    };
    await writeRegistry(directory, [restrictedGrant("owned-lab", { status: "revoked" })]);
    const rightsDenied = await supervisor.createBatch(createRequest);
    assert.equal(rightsDenied.error.code, ERROR_CODE.UNSUPPORTED_CAPABILITY);
    assert.match(rightsDenied.error.message, /rights deny/i);
    assert.equal(supervisor.workers.size, 0);
    await writeRegistry(directory, [ownedGrant()]);
    const created = await supervisor.createBatch(createRequest);
    assert.equal(created.error.code, ERROR_CODE.UNSUPPORTED_CAPABILITY);
    assert.equal(supervisor.workers.size, 0);
    await supervisor.releaseAssetAdmission({ handle: admitted.admission.handle });
});
