import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { StorageService } from "../server/storage/StorageService.js";

function operationId() {
    return randomBytes(32).toString("hex");
}

async function temporaryDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "vehicle-id-change-"));
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

test("rename and delete honor the acknowledged revision", async () => {
    const dir = await temporaryDir();
    try {
        const service = new StorageService(dir);
        const created = await service.createVehicleManifest(createDefaultVehicleManifest({ id: "box", name: "Box" }));
        await assert.rejects(
            () => service.renameVehicleManifest("box", { name: "Crate", expectedRevision: 0, operationId: operationId() }),
            /revision conflict/,
        );
        const renamed = await service.renameVehicleManifest("box", {
            name: "Crate",
            expectedRevision: created.revision,
            operationId: operationId(),
        });
        assert.equal(renamed.name, "Crate");
        assert.equal(renamed.revision, created.revision + 1);
        await assert.rejects(() => service.deleteVehicleManifest("box", created.revision), /revision conflict/);
        assert.equal((await service.getVehicleManifest("box")).name, "Crate");
        assert.equal(await service.deleteVehicleManifest("box", renamed.revision), true);
        assert.equal(await service.getVehicleManifest("box"), null);
        assert.equal(await service.deleteVehicleManifest("box", 0), true);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("change-id copies assets, recovers around each boundary, and does not rewrite the source hash in place", async () => {
    const dir = await temporaryDir();
    try {
        const service = new StorageService(dir);
        await service.createVehicleManifest(createDefaultVehicleManifest({
            id: "portable-truck",
            name: "Portable",
            model: { asset: "model.glb", scale: 1, rotation: {}, offset: {} },
        }));
        const model = Buffer.from("model-bytes");
        await service.putVehicleAsset("portable-truck", "model.glb", model);
        const before = await service.getVehicleManifest("portable-truck");
        const op = operationId();

        const prepared = new StorageService(dir, fault("after-id-prepared"));
        await assert.rejects(() => prepared.changeVehicleId("portable-truck", {
            id: "portable-next",
            expectedRevision: before.revision,
            operationId: op,
        }), /stop after-id-prepared/);
        const afterPrepared = new StorageService(dir);
        assert.equal(await afterPrepared.getVehicleManifest("portable-next"), null);
        assert.deepEqual(await afterPrepared.listVehicleAssets("portable-next"), []);
        assert.deepEqual(await afterPrepared.readVehicleAsset("portable-truck", "model.glb"), model);

        const copied = new StorageService(dir, fault("after-id-assets"));
        await assert.rejects(() => copied.changeVehicleId("portable-truck", {
            id: "portable-next",
            expectedRevision: before.revision,
            operationId: op,
        }), /stop after-id-assets/);
        const afterAssets = new StorageService(dir);
        assert.equal(await afterAssets.getVehicleManifest("portable-next"), null);
        assert.deepEqual(await afterAssets.listVehicleAssets("portable-next"), []);
        assert.deepEqual(await afterAssets.readVehicleAsset("portable-truck", "model.glb"), model);

        const published = new StorageService(dir, fault("after-id-manifest"));
        await assert.rejects(() => published.changeVehicleId("portable-truck", {
            id: "portable-next",
            expectedRevision: before.revision,
            operationId: op,
        }), /stop after-id-manifest/);
        const afterManifest = new StorageService(dir);
        assert.deepEqual(await afterManifest.listVehicleAssets("portable-next"), ["model.glb"]);
        assert.equal(await afterManifest.getVehicleManifest("portable-truck"), null);
        const moved = await afterManifest.getVehicleManifest("portable-next");
        assert.equal(moved.id, "portable-next");
        assert.equal(moved.revision, 1);
        assert.deepEqual(await afterManifest.readVehicleAsset("portable-next", "model.glb"), model);

        const removed = new StorageService(dir, fault("after-id-source"));
        const sourceAgain = await (async () => {
            const fresh = await temporaryDir();
            const seeded = new StorageService(fresh);
            await seeded.createVehicleManifest(createDefaultVehicleManifest({
                id: "portable-truck",
                name: "Portable",
                model: { asset: "model.glb", scale: 1, rotation: {}, offset: {} },
            }));
            await seeded.putVehicleAsset("portable-truck", "model.glb", model);
            const current = await seeded.getVehicleManifest("portable-truck");
            const failing = new StorageService(fresh, fault("after-id-source"));
            const nextOp = operationId();
            await assert.rejects(() => failing.changeVehicleId("portable-truck", {
                id: "portable-next",
                expectedRevision: current.revision,
                operationId: nextOp,
            }), /stop after-id-source/);
            const restarted = new StorageService(fresh);
            const finished = await restarted.changeVehicleId("portable-truck", {
                id: "portable-next",
                expectedRevision: current.revision,
                operationId: nextOp,
            });
            assert.equal(finished.id, "portable-next");
            assert.equal(await restarted.getVehicleManifest("portable-truck"), null);
            const replay = await restarted.changeVehicleId("portable-truck", {
                id: "portable-next",
                expectedRevision: current.revision,
                operationId: nextOp,
            });
            assert.equal(replay.revision, finished.revision);
            await assert.rejects(() => restarted.changeVehicleId("portable-truck", {
                id: "other-truck",
                expectedRevision: current.revision,
                operationId: nextOp,
            }), (error) => error.code === "VEHICLE_PUBLICATION_CONFLICT");
            await fs.rm(fresh, { recursive: true, force: true });
        })();
        void sourceAgain;

        await assert.rejects(() => afterManifest.changeVehicleId("portable-next", {
            id: "portable-next",
            expectedRevision: 0,
            operationId: operationId(),
        }), /revision conflict/);
        await assert.rejects(() => afterManifest.changeVehicleId("portable-next", {
            id: "big-car",
            expectedRevision: moved.revision,
            operationId: operationId(),
        }), /Built-in/);
        const occupied = new StorageService(dir);
        await occupied.createVehicleManifest(createDefaultVehicleManifest({ id: "taken", name: "Taken" }));
        const current = await occupied.getVehicleManifest("portable-next");
        await assert.rejects(() => occupied.changeVehicleId("portable-next", {
            id: "taken",
            expectedRevision: current.revision,
            operationId: operationId(),
        }), /already exists/);
        assert.equal((await occupied.getVehicleManifest("portable-next")).id, "portable-next");
        assert.equal((await occupied.getVehicleManifest("taken")).id, "taken");
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
