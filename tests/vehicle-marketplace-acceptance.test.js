import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import {
    computeEpisodeHash,
    computeSimulationSemanticHash,
    defaultEpisodeIdentity,
} from "../app/simulation/kernel/SimulationHashes.js";
import { computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { createVehicleModelImportPlan } from "../app/vehicles/model/VehicleModelImportPlan.js";
import {
    createBlankVehicleManifest,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";
import { verifyVehicleBundle } from "../server/artifacts/VehicleBundle.js";
import { artifactAdapterRegistry } from "../server/marketplace/ArtifactAdapters.js";
import { MARKETPLACE_ARTIFACTS } from "../server/marketplace/MarketplaceContract.js";
import { createVehicleAcceptanceHarness } from "./helpers/vehicleAcceptanceHarness.js";
import { loadVehicleIdentityLedger } from "./helpers/vehicleIdentityLedger.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

const encoder = new TextEncoder();

function closure() {
    const json = encoder.encode(JSON.stringify({
        asset: { version: "2.0" },
        nodes: [{ name: "body" }],
        buffers: [{ uri: "mesh.bin", byteLength: 4 }],
    }));
    return createVehicleModelImportPlan([
        { path: "body.gltf", bytes: json },
        { path: "mesh.bin", bytes: new Uint8Array([9, 8, 7, 6]) },
    ], { entryPath: "body.gltf" });
}

async function stageBundle(bundle) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "veh09-market-"));
    const bytes = Buffer.from(JSON.stringify(bundle));
    const target = path.join(root, "vehicle.json");
    await fs.writeFile(target, bytes);
    return {
        root,
        handle: Object.freeze({
            path: target,
            mediaType: MARKETPLACE_ARTIFACTS.vehicle.mediaType,
            sha256: createHash("sha256").update(bytes).digest("hex"),
            sizeBytes: bytes.length,
        }),
    };
}

test("VEH-09d marketplace publication keeps intake out of identity and replays the same content", async () => {
    const ledger = await loadVehicleIdentityLedger();
    assert.equal(computeResolvedRunHash(createBlankVehicleManifest()), ledger.legacy.blankV3Definition);

    const harness = await createVehicleAcceptanceHarness();
    const staged = [];
    try {
        const resource = await pluginFixtureResource({ fixture: "test.plant-fixture" });
        const verified = verifyPluginPackage(resource);
        await harness.service.plugins.putPackage(resource);
        const plan = closure();
        const manifest = normalizeVehicleManifest({
            ...createBlankVehicleManifest({ id: "plugin-car", name: "Plugin Car" }),
            model: {
                asset: plan.asset.name,
                dependencies: plan.dependencies.map((file) => file.name),
                hiddenNodeIndices: [],
                scale: 1,
                rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
                offset: { x: 0, y: 0, z: 0 },
            },
            dynamics: { plant: "test.plant-fixture.bicycle" },
            pluginLocks: [{
                pluginId: verified.document.id,
                version: verified.document.version,
                packageHash: verified.resource.packageHash,
                runtimeHash: verified.resource.runtimeHash,
                sensorTypes: [],
                plants: ["test.plant-fixture.bicycle"],
            }],
        });
        const files = [plan.asset, ...plan.dependencies];
        for (const file of files) {
            const parked = await harness.service.commitMarketplaceVehicleAsset({
                vehicleId: "plugin-car",
                fileName: file.name,
                bytes: file.bytes,
                sha256: file.sha256,
                expectedVehicleRevision: 0,
                expectedVehicleContentHash: null,
            });
            assert.equal(parked.reused, false);
        }
        assert.equal(await harness.service.getVehicleManifest("plugin-car"), null);
        assert.deepEqual(await harness.service.listVehicleAssets("plugin-car"), []);
        const intake = await fs.readdir(harness.service.vehiclePublicationIntakeDir);
        assert.equal(intake.includes("plugin-car"), true);

        let hidden = null;
        const failing = harness.restart({
            vehiclePublication: {
                faults: {
                    "after-promote": async () => {
                        hidden = await failing._readVehicleSnapshotUnlocked("plugin-car");
                        const error = new Error("stop after-promote");
                        error.code = "INJECTED_FAULT";
                        throw error;
                    },
                },
            },
        });
        const contentHash = computeResolvedRunHash(manifest);
        await assert.rejects(() => failing.commitMarketplaceVehicle({
            vehicleId: "plugin-car",
            manifest,
            expectedRevision: 0,
            contentHash,
        }), /after-promote/);
        assert.equal(hidden.manifest, null);
        assert.deepEqual(hidden.files.map((file) => file.name), []);

        const restarted = harness.restart();
        assert.equal(await restarted.getVehicleManifest("plugin-car"), null);
        const committed = await restarted.commitMarketplaceVehicle({
            vehicleId: "plugin-car",
            manifest,
            expectedRevision: 0,
            contentHash,
        });
        assert.equal(committed.reused, false);
        const again = await restarted.commitMarketplaceVehicle({
            vehicleId: "plugin-car",
            manifest,
            expectedRevision: 0,
            contentHash,
        });
        assert.equal(again.reused, true);
        assert.equal(again.revision, committed.revision);

        const dependency = await harness.service._resolveVehicleDependency("ego", "plugin-car");
        assert.equal(Object.hasOwn(dependency.assetHashes, plan.asset.name), true);
        assert.equal(Object.keys(dependency.assetHashes).some((name) => name.includes("intake")), false);
        const bundle = await harness.service.exportVehicleBundle("plugin-car");
        const roundTrip = verifyVehicleBundle(bundle);
        assert.equal(roundTrip.computedBundleHash, bundle.bundleHash);
        assert.equal(roundTrip.verifiedPluginPackages[0].document.id, "test.plant-fixture");
        const stagedBundle = await stageBundle(bundle);
        staged.push(stagedBundle.root);
        const inspection = await artifactAdapterRegistry.inspect("vehicle", stagedBundle.handle);
        assert.equal(inspection.identity.vehicleId, "plugin-car");
        assert.equal(inspection.identity.bundleHash, bundle.bundleHash);
        assert.equal(inspection.identity.embeddedPlugins[0].packageHash, verified.resource.packageHash);

        const blank = await harness.service.createVehicleManifest({
            manifest: createBlankVehicleManifest({ id: "untitled-vehicle", name: "Untitled Vehicle" }),
            operationId: "ab".repeat(32),
        });
        assert.equal(blank.definitionHash, ledger.legacy.blankV3Definition);
        const base = await harness.snapshotIdentity("untitled-vehicle");
        const locked = structuredClone(base.resolved);
        const ego = locked.vehicles.find((entry) => entry.actorId === "ego");
        ego.manifest = { ...ego.manifest, pluginLocks: dependency.manifest.pluginLocks };
        const semantic = computeSimulationSemanticHash(locked);
        const cleared = structuredClone(locked);
        delete cleared.vehicles.find((entry) => entry.actorId === "ego").manifest.pluginLocks;
        assert.notEqual(computeSimulationSemanticHash(cleared), semantic);
        const packageChanged = structuredClone(locked);
        packageChanged.vehicles.find((entry) => entry.actorId === "ego").manifest.pluginLocks[0].packageHash = "f".repeat(64);
        assert.equal(computeSimulationSemanticHash(packageChanged), semantic);
        const runtimeChanged = structuredClone(locked);
        runtimeChanged.vehicles.find((entry) => entry.actorId === "ego").manifest.pluginLocks[0].runtimeHash = "e".repeat(64);
        assert.notEqual(computeSimulationSemanticHash(runtimeChanged), semantic);
        const episode = computeEpisodeHash(defaultEpisodeIdentity(locked));
        const moved = computeEpisodeHash(defaultEpisodeIdentity({
            ...locked,
            simulationSemanticHash: "ab".repeat(32),
        }));
        assert.notEqual(moved, episode);
    } finally {
        await harness.dispose();
        await Promise.all(staged.map((root) => fs.rm(root, { recursive: true, force: true })));
    }
});
