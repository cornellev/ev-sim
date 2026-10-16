import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { StorageService } from "../server/storage/StorageService.js";

async function temporaryService(options = {}) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vehicle-stage-"));
    return { dir, service: new StorageService(dir, options) };
}

function sha256(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

test("a stage reports server digests and abandon leaves a saved vehicle unchanged", async () => {
    const { dir, service } = await temporaryService();
    try {
        const created = await service.createVehicleManifest(createDefaultVehicleManifest({ id: "kept", name: "Kept" }));
        const model = Buffer.from("model-bytes");
        await service.putVehicleAsset("kept", "model.glb", model);
        const beforeBundle = await service.exportVehicleBundle("kept");
        const beforeResolved = await service._resolveVehicleDependency("ego", "kept");

        const stage = await service.vehicleStages.createStage();
        assert.match(stage.stageId, /^[0-9a-f-]{36}$/i);
        const member = await service.vehicleStages.putMember(stage.stageId, "notes.bin", Buffer.from("staged-bytes"));
        assert.equal(member.sha256, sha256(Buffer.from("staged-bytes")));
        assert.equal(member.size, Buffer.from("staged-bytes").length);
        assert.equal(member.mediaType, "application/octet-stream");
        const loaded = await service.vehicleStages.readMember(stage.stageId, "notes.bin");
        assert.equal(loaded.sha256, member.sha256);
        assert.deepEqual(Buffer.from(loaded.bytes), Buffer.from("staged-bytes"));

        const renewed = await service.vehicleStages.renewStage(stage.stageId);
        assert.ok(Date.parse(renewed.expiresAt) >= Date.parse(stage.expiresAt));
        assert.equal(await service.vehicleStages.abandonStage(stage.stageId), true);
        await assert.rejects(() => service.vehicleStages.readMember(stage.stageId, "notes.bin"), /does not exist/);

        const after = await service.getVehicleManifest("kept");
        assert.equal(after.revision, created.revision);
        assert.equal(after.definitionHash, created.definitionHash);
        assert.deepEqual(await service.listVehicleAssets("kept"), ["model.glb"]);
        assert.equal((await service.exportVehicleBundle("kept")).bundleHash, beforeBundle.bundleHash);
        assert.equal((await service._resolveVehicleDependency("ego", "kept")).hash, beforeResolved.hash);
        const stagedRoot = path.join(dir, "vehicle-stages");
        const published = await fs.readdir(path.join(dir, "vehicle-assets", "kept"));
        assert.deepEqual(published, ["model.glb"]);
        assert.deepEqual(await fs.readdir(stagedRoot).catch(() => []), []);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("stage uploads reject empty bodies, path names, digest mismatches, and expired leases", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const { dir, service } = await temporaryService({
        vehicleStages: {
            now: () => new Date(now),
            limits: { abandonedStageTtlMs: 1000 },
        },
    });
    try {
        const stage = await service.vehicleStages.createStage();
        await assert.rejects(() => service.vehicleStages.putMember(stage.stageId, "empty.bin", Buffer.alloc(0)), /empty/);
        await assert.rejects(() => service.vehicleStages.putMember(stage.stageId, "../escape.bin", Buffer.from("x")), /Invalid vehicle stage member/);
        const digest = sha256(Buffer.from("not-these-bytes"));
        await assert.rejects(
            () => service.vehicleStages.putMember(stage.stageId, `${digest}.glb`, Buffer.from("other-bytes")),
            /byte identity/,
        );
        const text = Buffer.from("not-a-glb");
        await assert.rejects(
            () => service.vehicleStages.putMember(stage.stageId, `${sha256(text)}.glb`, text),
            /not a GLB/,
        );

        now += 1001;
        await service.vehicleStages.recover();
        await assert.rejects(() => service.vehicleStages.readMember(stage.stageId, "notes.bin"), /does not exist/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
