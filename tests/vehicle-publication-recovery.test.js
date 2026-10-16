import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { writeGlb } from "../app/simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import {
    VEHICLE_MANIFEST_DOWNGRADE,
    createBlankVehicleManifest,
    createDefaultVehicleManifest,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";
import { StorageService } from "../server/storage/StorageService.js";

const BLANK_V3_HASH = "03716fbb799f0e92e5c7295f6f710f4dc2888e0fdc39a7d4d1921b29ffdc1d56";

function operationId() {
    return randomBytes(32).toString("hex");
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

async function temporaryDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "vehicle-publication-"));
}

function fault(name) {
    return {
        vehiclePublication: {
            faults: {
                [name]: () => {
                    const error = new Error(`stop ${name}`);
                    error.code = "INJECTED_FAULT";
                    throw error;
                },
            },
        },
    };
}

test("version 2 creates keep their identity and a version 3 blank is journaled", async () => {
    const dir = await temporaryDir();
    try {
        const service = new StorageService(dir);
        const created = await service.createVehicleManifest(createDefaultVehicleManifest({ id: "my-truck", name: "My Truck" }));
        assert.equal(created.revision, 1);
        assert.equal(created.version, 2);
        assert.equal(created.definitionHash, computeResolvedRunHash(createDefaultVehicleManifest({ id: "my-truck", name: "My Truck" })));
        assert.equal(created.model.dependencies, undefined);

        const blankId = operationId();
        const blank = await service.createVehicleManifest({
            manifest: createBlankVehicleManifest({ id: "blank", name: "Blank" }),
            operationId: blankId,
        });
        assert.equal(blank.version, 3);
        assert.deepEqual(blank.model.dependencies, []);
        assert.deepEqual(blank.model.hiddenNodeIndices, []);
        assert.equal(blank.definitionHash, computeResolvedRunHash(createBlankVehicleManifest({ id: "blank", name: "Blank" })));
        assert.equal(computeResolvedRunHash(createBlankVehicleManifest()), BLANK_V3_HASH);
        const replay = await service.createVehicleManifest({
            manifest: createBlankVehicleManifest({ id: "blank", name: "Blank" }),
            operationId: blankId,
        });
        assert.equal(replay.revision, blank.revision);
        assert.equal(replay.definitionHash, blank.definitionHash);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("publication faults recover before and after the manifest write", async () => {
    const dir = await temporaryDir();
    const manifest = createDefaultVehicleManifest({ id: "recover-me", name: "Recover" });
    const id = operationId();
    try {
        const during = {};
        const failing = new StorageService(dir, {
            vehiclePublication: {
                faults: {
                    "after-promote": async () => {
                        during.snapshot = await failing._readVehicleSnapshotUnlocked("recover-me");
                        const error = new Error("stop after-promote");
                        error.code = "INJECTED_FAULT";
                        throw error;
                    },
                },
            },
        });
        const stage = await failing.vehicleStages.createStage();
        await failing.vehicleStages.putMember(stage.stageId, "extra.bin", Buffer.from("extra"));
        await assert.rejects(() => failing.createVehicleManifest({
            manifest,
            operationId: id,
            stageId: stage.stageId,
        }), /stop after-promote/);
        assert.equal(during.snapshot.manifest, null);
        assert.deepEqual(during.snapshot.files.map((file) => file.name), []);

        const rolled = new StorageService(dir);
        assert.equal(await rolled.getVehicleManifest("recover-me"), null);
        assert.deepEqual(await rolled.listVehicleAssets("recover-me"), []);

        const committed = new StorageService(dir, fault("after-manifest"));
        await assert.rejects(() => committed.createVehicleManifest({ manifest, operationId: id }), /stop after-manifest/);
        const restarted = new StorageService(dir);
        const stored = await restarted.createVehicleManifest({ manifest, operationId: id });
        assert.equal(stored.revision, 1);
        assert.equal(stored.definitionHash, computeResolvedRunHash(manifest));
        const again = await restarted.createVehicleManifest({ manifest, operationId: id });
        assert.equal(again.revision, 1);
        await assert.rejects(
            () => restarted.createVehicleManifest({
                manifest: { ...manifest, description: "different" },
                operationId: id,
            }),
            (error) => error.code === "VEHICLE_PUBLICATION_CONFLICT",
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("import, duplicate, and marketplace publication recover without exposing partial assets", async () => {
    const sourceDir = await temporaryDir();
    const targetDir = await temporaryDir();
    try {
        const source = new StorageService(sourceDir);
        await source.createVehicleManifest(createDefaultVehicleManifest({
            id: "portable-truck",
            model: { asset: "model.glb", scale: 0.5, rotation: {}, offset: {} },
        }));
        const model = Buffer.from("model-bytes");
        await source.putVehicleAsset("portable-truck", "model.glb", model);
        const bundle = await source.exportVehicleBundle("portable-truck");
        assert.equal(bundle.bundleHash, "9c093454c448845a3ade39417d175c3a89c0b11d217d368d197d57d60c0c50cd");
        const sourceResolved = await source._resolveVehicleDependency("ego", "portable-truck");

        const target = new StorageService(targetDir, fault("after-promote"));
        const importId = operationId();
        await assert.rejects(() => target.importVehicleBundle({ ...bundle, operationId: importId }), /stop after-promote/);
        const restarted = new StorageService(targetDir);
        assert.equal(await restarted.getVehicleManifest("portable-truck"), null);
        assert.deepEqual(await restarted.listVehicleAssets("portable-truck"), []);
        const imported = await restarted.importVehicleBundle({ ...bundle, operationId: importId });
        assert.equal(imported.id, "portable-truck");
        assert.deepEqual(await restarted.readVehicleAsset("portable-truck", "model.glb"), model);

        const duplicateId = operationId();
        const duplicating = new StorageService(targetDir, fault("after-prepared"));
        await assert.rejects(() => duplicating.duplicateVehicleManifest("portable-truck", {
            id: "portable-copy",
            operationId: duplicateId,
        }), /stop after-prepared/);
        const afterDuplicate = new StorageService(targetDir);
        assert.equal(await afterDuplicate.getVehicleManifest("portable-copy"), null);
        assert.equal((await afterDuplicate._resolveVehicleDependency("ego", "portable-truck")).hash, (await restarted._resolveVehicleDependency("ego", "portable-truck")).hash);
        const copy = await afterDuplicate.duplicateVehicleManifest("portable-truck", {
            id: "portable-copy",
            operationId: duplicateId,
        });
        assert.equal(copy.id, "portable-copy");
        assert.deepEqual(await afterDuplicate.readVehicleAsset("portable-copy", "model.glb"), model);

        const market = new StorageService(targetDir);
        const bytes = Buffer.from("market-bytes");
        const digest = sha256(bytes);
        const parked = await market.commitMarketplaceVehicleAsset({
            vehicleId: "market-truck",
            fileName: "model.glb",
            bytes,
            sha256: digest,
            expectedVehicleRevision: 0,
            expectedVehicleContentHash: null,
        });
        assert.equal(parked.reused, false);
        await assert.rejects(() => market._resolveVehicleDependency("ego", "market-truck"), /does not exist/);
        assert.deepEqual(await market.listVehicleAssets("market-truck"), []);
        const candidate = normalizeVehicleManifest(createDefaultVehicleManifest({
            id: "market-truck",
            model: { asset: "model.glb", scale: 1, rotation: {}, offset: {} },
        }));
        const committed = await market.commitMarketplaceVehicle({
            vehicleId: "market-truck",
            manifest: candidate,
            expectedRevision: 0,
            contentHash: computeResolvedRunHash(candidate),
        });
        assert.equal(committed.reused, false);
        assert.deepEqual(await market.readVehicleAsset("market-truck", "model.glb"), bytes);
        assert.equal(sourceResolved.hash.length, 64);
    } finally {
        await fs.rm(sourceDir, { recursive: true, force: true });
        await fs.rm(targetDir, { recursive: true, force: true });
    }
});

test("a failed staged save preserves the version 2 hash and a legacy writer cannot downgrade version 3", async () => {
    const dir = await temporaryDir();
    try {
        const service = new StorageService(dir);
        await service.createVehicleManifest(createDefaultVehicleManifest({ id: "kept", name: "Kept" }));
        await service.putVehicleAsset("kept", "model.glb", Buffer.from("model-bytes"));
        const beforeBundle = await service.exportVehicleBundle("kept");
        const beforeResolved = await service._resolveVehicleDependency("ego", "kept");
        const beforeManifest = await service.getVehicleManifest("kept");

        let seen = null;
        const failing = new StorageService(dir, {
            vehiclePublication: {
                faults: {
                    "after-promote": async () => {
                        seen = await failing._readVehicleSnapshotUnlocked("kept");
                        const error = new Error("stop save");
                        error.code = "INJECTED_FAULT";
                        throw error;
                    },
                },
            },
        });
        const stage = await failing.vehicleStages.createStage();
        await failing.vehicleStages.putMember(stage.stageId, "extra.bin", Buffer.from("extra"));
        const current = await failing.getVehicleManifest("kept");
        await assert.rejects(() => failing.putVehicleManifest("kept", {
            manifest: { ...current, description: "Changed" },
            expectedRevision: current.revision,
            stageId: stage.stageId,
            operationId: operationId(),
        }), /stop save/);
        assert.equal(seen.manifest.description, "");
        assert.deepEqual(seen.files.map((file) => file.name), ["model.glb"]);

        const restarted = new StorageService(dir);
        assert.equal((await restarted.exportVehicleBundle("kept")).bundleHash, beforeBundle.bundleHash);
        assert.equal((await restarted._resolveVehicleDependency("ego", "kept")).hash, beforeResolved.hash);
        const after = await restarted.getVehicleManifest("kept");
        assert.equal(after.description, beforeManifest.description);
        assert.equal(after.definitionHash, beforeManifest.definitionHash);
        assert.deepEqual(await restarted.listVehicleAssets("kept"), ["model.glb"]);
        assert.deepEqual(await fs.readdir(path.join(dir, "vehicle-assets", "kept")), ["model.glb"]);

        const blank = await restarted.createVehicleManifest({
            manifest: createBlankVehicleManifest({ id: "v3-kept", name: "V3" }),
            operationId: operationId(),
        });
        await assert.rejects(
            () => restarted.putVehicleManifest("v3-kept", {
                manifest: createDefaultVehicleManifest({ id: "v3-kept", name: "V3" }),
                expectedRevision: blank.revision,
            }),
            (error) => error.code === VEHICLE_MANIFEST_DOWNGRADE,
        );

        const glb = writeGlb({
            asset: { version: "2.0" },
            buffers: [{ byteLength: 4 }],
        }, new Uint8Array([1, 2, 3, 4]));
        const name = `${sha256ExactBytes(glb)}.glb`;
        await restarted.putVehicleAsset("v3-kept", name, glb);
        await assert.rejects(() => restarted.putVehicleAsset("v3-kept", name, Buffer.from("different-bytes")), /immutable/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
