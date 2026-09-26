import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { computeEpisodeHash, defaultEpisodeIdentity } from "../app/simulation/kernel/SimulationHashes.js";
import { encodeRunPackage, hashRunPackageManifest } from "../server/headless/VisualAssetPack.js";
import { StorageService } from "../server/storage/StorageService.js";
import { createPluginPortableHeadlessBundle } from "./helpers/headlessRunnerBundle.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const fixtureRoot = new URL("./fixtures/marketplace/", import.meta.url);
const compatibility = JSON.parse(await fs.readFile(new URL("compatibility.v1.json", fixtureRoot), "utf8"));
const runPackage = JSON.parse(await fs.readFile(new URL("../visual-layer/run-package.canonical.v1.json", fixtureRoot), "utf8"));

test("MKT-01 preserves plugin package and plugin-enabled run identities", async () => {
    const resource = await pluginFixtureResource();
    const bundle = await createPluginPortableHeadlessBundle(resource);
    assert.equal(resource.packageHash, compatibility.plugin.packageHash);
    assert.equal(resource.runtimeHash, compatibility.plugin.runtimeHash);
    assert.equal(bundle.resolvedHash, compatibility.plugin.resolvedHash);
    assert.equal(bundle.simulationSemanticHash, compatibility.plugin.simulationSemanticHash);
    assert.equal(computeEpisodeHash(defaultEpisodeIdentity(bundle.resolved)), compatibility.plugin.episodeHash);
    assert.equal(bundle.resolved.world.hash, compatibility.plugin.worldHash);
});

test("MKT-01 preserves deterministic vehicle-bundle identity", async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-compat-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const service = new StorageService(directory);
    await service.createVehicleManifest(createDefaultVehicleManifest({
        id: compatibility.vehicle.id,
        name: compatibility.vehicle.name,
        description: compatibility.vehicle.description,
    }));
    await service.putVehicleAsset(
        compatibility.vehicle.id,
        compatibility.vehicle.assetName,
        Buffer.from(compatibility.vehicle.assetUtf8),
    );
    const bundle = await service.exportVehicleBundle(compatibility.vehicle.id);
    assert.equal(bundle.bundleHash, compatibility.vehicle.bundleHash);
});

test("MKT-01 preserves run-package manifest and archive vectors", () => {
    const bundleBytes = Buffer.from(runPackage.bundleUtf8);
    const assets = [{ ...runPackage.asset, bytes: Buffer.from(runPackage.assetUtf8) }];
    const encoded = encodeRunPackage({ bundleBytes, assets });
    assert.equal(hashRunPackageManifest(encoded.manifest), runPackage.withAsset.packageManifestHash);
    assert.equal(encoded.archiveHash, runPackage.withAsset.archiveHash);
    assert.equal(encoded.bytes.length, runPackage.withAsset.archiveBytes);
});
