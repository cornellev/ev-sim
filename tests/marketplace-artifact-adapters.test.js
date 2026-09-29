import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { simulationIdentityVersion } from "../app/simulation/kernel/RunIdentity.js";
import { createDefaultVehicleManifest, VEHICLE_BUNDLE_KIND, VEHICLE_BUNDLE_VERSION } from "../app/vehicles/VehicleManifest.js";
import { canonicalRunBundleStringify } from "../server/headless/RunBundle.js";
import { encodeRunPackage } from "../server/headless/VisualAssetPack.js";
import {
    ArtifactAdapterRegistry,
    ArtifactOperationUnsupportedError,
    MARKETPLACE_ARTIFACT_ADAPTERS,
    artifactAdapterRegistry,
    defineArtifactAdapter,
} from "../server/marketplace/ArtifactAdapters.js";
import { MARKETPLACE_ARTIFACTS } from "../server/marketplace/MarketplaceContract.js";
import { computeVehicleBundleHash } from "../server/artifacts/VehicleBundle.js";
import { exportRunTemplatePackage } from "../server/marketplace/RunTemplatePackage.js";
import { StorageService } from "../server/storage/StorageService.js";
import { createPluginPortableHeadlessBundle } from "./helpers/headlessRunnerBundle.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

async function workspace(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-marketplace-adapters-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

async function stage(root, name, bytes, contentKind) {
    const target = path.join(root, name);
    await fs.writeFile(target, bytes, { mode: 0o600 });
    return Object.freeze({
        path: target,
        mediaType: MARKETPLACE_ARTIFACTS[contentKind].mediaType,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sizeBytes: bytes.length,
    });
}

function releaseFor(inspection, overrides = {}) {
    return {
        contentKind: inspection.contentKind,
        artifact: { ...inspection.artifact },
        ...(inspection.contentKind === "plugin" ? {
            itemId: inspection.identity.pluginId,
            releaseVersion: inspection.identity.version,
            capabilities: [...inspection.identity.capabilities],
            compatibility: {
                cevSim: inspection.identity.engineRange,
                contracts: [{ kind: "cev-sim.plugin-package", versions: [1] }],
            },
        } : {}),
        ...overrides,
    };
}

test("MKT-02 plugin inspection is structural and never imports throwing module bodies", async (t) => {
    const root = await workspace(t);
    const resource = await pluginFixtureResource({
        mutateFiles(files) {
            files["runtime/index.js"] = new TextEncoder().encode("throw new Error('inspection imported runtime');\nexport default {};\n");
        },
    });
    const handle = await stage(root, "plugin.json", Buffer.from(JSON.stringify(resource)), "plugin");
    const inspection = await artifactAdapterRegistry.inspect("plugin", handle);
    assert.deepEqual(inspection.identity, {
        pluginId: "acme.example",
        version: "1.0.0",
        packageHash: resource.packageHash,
        runtimeHash: resource.runtimeHash,
        uiHash: resource.uiHash,
        engineRange: ">=0.1.0 <0.2.0",
        capabilities: [],
    });
    assert.equal(Object.isFrozen(inspection), true);
    assert.equal(artifactAdapterRegistry.validate("plugin", inspection, releaseFor(inspection)), inspection);
});

test("MKT-02 vehicle, run-template, and run-package inspections expose exact serializable identities", async (t) => {
    const root = await workspace(t);
    const vehicle = {
        kind: VEHICLE_BUNDLE_KIND,
        version: VEHICLE_BUNDLE_VERSION,
        exportedAt: "2026-09-26T12:00:00.000Z",
        manifest: createDefaultVehicleManifest({ id: "adapter-vehicle", name: "Adapter Vehicle" }),
        assets: { "model.glb": Buffer.from("vehicle-model").toString("base64") },
    };
    vehicle.bundleHash = computeVehicleBundleHash(vehicle);
    const vehicleHandle = await stage(root, "vehicle.json", Buffer.from(JSON.stringify(vehicle)), "vehicle");
    const vehicleInspection = await artifactAdapterRegistry.inspect("vehicle", vehicleHandle);
    assert.deepEqual(vehicleInspection.identity, {
        vehicleId: "adapter-vehicle",
        bundleHash: vehicle.bundleHash,
        assetCount: 1,
        assetBytes: 13,
        embeddedPlugins: [],
    });

    const storage = new StorageService(path.join(root, "storage"));
    const environment = await storage.createEnvironment({ id: "adapter-yard", name: "Adapter Yard", supportedEditorSourceVersions: [1] });
    const manifest = await storage.createRunManifest(createDefaultRunManifest({ id: "adapter-template", environment: { id: environment.environmentId, expectedHash: null } }));
    const templatePath = path.join(root, "run-template.tar");
    const exportedTemplate = await exportRunTemplatePackage({ storageService: storage, manifestId: manifest.id, expectedRevision: manifest.revision });
    await pipeline(exportedTemplate.stream, (await fs.open(templatePath, "wx")).createWriteStream());
    await exportedTemplate.completion;
    const templateBytes = await fs.readFile(templatePath);
    const templateHandle = await stage(root, "staged-run-template.tar", templateBytes, "run-template");
    const templateInspection = await artifactAdapterRegistry.inspect("run-template", templateHandle);
    assert.equal(templateInspection.identity.manifestId, manifest.id);
    assert.equal(templateInspection.identity.scenarioCount, 0);
    assert.equal(templateInspection.identity.scriptCount, 0);
    assert.deepEqual(templateInspection.identity.plugins, []);

    const resource = await pluginFixtureResource();
    const bundle = await createPluginPortableHeadlessBundle(resource);
    const bundleBytes = Buffer.from(canonicalRunBundleStringify(bundle));

    const encoded = encodeRunPackage({ bundleBytes, assets: [] });
    const packageHandle = await stage(root, "run-package.tar", encoded.bytes, "run-package");
    const stagingRoot = path.join(root, "inspection-staging");
    await fs.mkdir(stagingRoot);
    const packageInspection = await artifactAdapterRegistry.inspect("run-package", packageHandle, { stagingRoot });
    assert.deepEqual(packageInspection.identity, {
        manifestId: bundle.manifest.id,
        archiveHash: encoded.archiveHash,
        packageManifestHash: encoded.packageManifestHash,
        bundleBytesHash: encoded.bundleBytesHash,
        resolvedHash: bundle.resolvedHash,
        simulationSemanticHash: bundle.simulationSemanticHash,
        identityVersion: simulationIdentityVersion(bundle.resolved),
        assetCount: 0,
        assetBytes: 0,
    });
    assert.deepEqual(await fs.readdir(stagingRoot), [], "inspection must not retain staging");
    assert.doesNotThrow(() => JSON.stringify(packageInspection));
});

test("MKT-08 plugin validation binds release identity, capabilities, and compatibility to plugin.json", async (t) => {
    const root = await workspace(t);
    const resource = await pluginFixtureResource();
    const handle = await stage(root, "plugin.json", Buffer.from(JSON.stringify(resource)), "plugin");
    const inspection = await artifactAdapterRegistry.inspect("plugin", handle);
    const valid = releaseFor(inspection);
    assert.equal(artifactAdapterRegistry.validate("plugin", inspection, valid), inspection);
    for (const invalid of [
        { ...valid, itemId: "acme.other" },
        { ...valid, releaseVersion: "2.0.0" },
        { ...valid, capabilities: ["world.read"] },
        { ...valid, compatibility: { ...valid.compatibility, cevSim: ">=0.1.0" } },
        { ...valid, compatibility: { ...valid.compatibility, contracts: [] } },
        { ...valid, contentKind: "vehicle" },
        { ...valid, artifact: { ...valid.artifact, mediaType: MARKETPLACE_ARTIFACTS.vehicle.mediaType } },
        { ...valid, artifact: { ...valid.artifact, sha256: "0".repeat(64) } },
        { ...valid, artifact: { ...valid.artifact, sizeBytes: valid.artifact.sizeBytes + 1 } },
    ]) assert.throws(() => artifactAdapterRegistry.validate("plugin", inspection, invalid));
    await assert.rejects(
        artifactAdapterRegistry.inspect("plugin", { ...handle, sha256: "0".repeat(64) }),
        (error) => error.code === "ARTIFACT_HASH_MISMATCH",
    );
});

test("MKT-02 invalid vehicle, run-template, and run-package bytes fail without retained staging", async (t) => {
    const root = await workspace(t);
    const invalidVehicle = {
        kind: VEHICLE_BUNDLE_KIND,
        version: VEHICLE_BUNDLE_VERSION,
        manifest: createDefaultVehicleManifest({ id: "invalid-adapter-vehicle" }),
        assets: { "model.glb": "not base64" },
    };
    const vehicleHandle = await stage(root, "invalid-vehicle.json", Buffer.from(JSON.stringify(invalidVehicle)), "vehicle");
    await assert.rejects(artifactAdapterRegistry.inspect("vehicle", vehicleHandle), /canonical base64/);

    const templateHandle = await stage(root, "invalid-run-template.tar", Buffer.from("not a tar archive"), "run-template");
    await assert.rejects(artifactAdapterRegistry.inspect("run-template", templateHandle), /USTAR|[Aa]rchive/u);

    const resource = await pluginFixtureResource();
    const bundle = await createPluginPortableHeadlessBundle(resource);
    const validBundleBytes = Buffer.from(canonicalRunBundleStringify(bundle));
    const corruptedArchive = Buffer.from(encodeRunPackage({ bundleBytes: validBundleBytes, assets: [] }).bytes);
    corruptedArchive[148] ^= 1;
    const packageHandle = await stage(root, "invalid-run-package.tar", corruptedArchive, "run-package");
    const stagingRoot = path.join(root, "invalid-inspection-staging");
    await fs.mkdir(stagingRoot);
    await assert.rejects(artifactAdapterRegistry.inspect("run-package", packageHandle, { stagingRoot }));
    assert.deepEqual(await fs.readdir(stagingRoot), []);
});

test("MKT-02/MKT-09 registry rejects duplicate kinds and exposes deterministic unsupported operations", () => {
    assert.equal(MARKETPLACE_ARTIFACT_ADAPTERS.length, 7);
    assert.equal(artifactAdapterRegistry.get("asset-pack").id, "asset-pack@1");
    assert.equal(artifactAdapterRegistry.get("environment").id, "environment@1");
    assert.throws(
        () => new ArtifactAdapterRegistry([MARKETPLACE_ARTIFACT_ADAPTERS[0], MARKETPLACE_ARTIFACT_ADAPTERS[0]]),
        /Duplicate artifact adapter/,
    );
    for (const operation of ["plan", "commit", "createReceipt"]) {
        assert.throws(
            () => artifactAdapterRegistry.requireOperation("plugin", operation),
            (error) => error instanceof ArtifactOperationUnsupportedError
                && error.code === "ARTIFACT_OPERATION_UNSUPPORTED"
                && error.operation === operation,
        );
        assert.throws(() => artifactAdapterRegistry.get("plugin")[operation](), ArtifactOperationUnsupportedError);
    }
    assert.equal(artifactAdapterRegistry.hasLifecycle(), false);
    assert.equal(artifactAdapterRegistry.hasLifecycle("plugin"), false);
    assert.throws(() => artifactAdapterRegistry.requireLifecycle("plugin"), ArtifactOperationUnsupportedError);
    assert.throws(() => defineArtifactAdapter({
        id: "partial@1",
        contentKind: "plugin",
        inspect() {},
        plan() {},
    }), /plan, commit, and createReceipt together/u);
});
