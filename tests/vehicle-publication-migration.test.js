import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeGlb } from "../app/simulation/visual/GlbContainer.js";
import { sha256ExactBytes } from "../app/simulation/visual/VisualLayer.js";
import { reviewModelWheelPair } from "../app/vehicles/axle/reviewModelWheels.js";
import { measurePlacedVehicleModel } from "../app/vehicles/model/measurePlacedVehicle.js";
import { VEHICLE_MANIFEST_DOWNGRADE, createDefaultVehicleManifest, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { StorageService } from "../server/storage/StorageService.js";
import { buildBoxGlb, symmetricWheelParts } from "./helpers/vehicle-wheel-glb.js";

function operationId() {
    return randomBytes(32).toString("hex");
}

async function temporaryDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "vehicle-migration-publish-"));
}

test("migration publishes a canonical closure and a failed attempt preserves the version 2 identity", async () => {
    const dir = await temporaryDir();
    try {
        const service = new StorageService(dir);
        await service.createVehicleManifest(createDefaultVehicleManifest({
            id: "local",
            name: "Local",
            model: { asset: "model.glb", scale: 1, rotation: {}, offset: {} },
        }));
        const legacy = Buffer.from("legacy-model");
        await service.putVehicleAsset("local", "model.glb", legacy);
        const beforeBundle = await service.exportVehicleBundle("local");
        const beforeResolved = await service._resolveVehicleDependency("ego", "local");
        const before = await service.getVehicleManifest("local");

        const glb = writeGlb({
            asset: { version: "2.0" },
            buffers: [{ byteLength: 4 }],
            nodes: [{ name: "body" }],
        }, new Uint8Array([1, 2, 3, 4]));
        const assetName = `${sha256ExactBytes(glb)}.glb`;
        const candidate = normalizeVehicleManifest({
            ...before,
            version: 3,
            model: {
                asset: assetName,
                dependencies: [],
                hiddenNodeIndices: [],
                scale: 1,
                rotation: {},
                offset: {},
            },
        });

        const failing = new StorageService(dir, {
            vehiclePublication: {
                faults: {
                    "after-promote": () => {
                        const error = new Error("stop migration");
                        error.code = "INJECTED_FAULT";
                        throw error;
                    },
                },
            },
        });
        const blockedStage = await failing.vehicleStages.createStage();
        await failing.vehicleStages.putMember(blockedStage.stageId, assetName, glb);
        await assert.rejects(() => failing.publishVehicleMigration({
            vehicleId: "local",
            manifest: candidate,
            expectedRevision: before.revision,
            operationId: operationId(),
            stageId: blockedStage.stageId,
        }), /stop migration/);
        await assert.rejects(() => failing.publishVehicleMigration({
            vehicleId: "local",
            manifest: { ...candidate, model: { ...candidate.model, asset: `${"ab".repeat(32)}.glb` } },
            expectedRevision: before.revision,
            operationId: operationId(),
            stageId: blockedStage.stageId,
        }), /Missing model file|byte identity|not a GLB|version 3 model/);

        const restarted = new StorageService(dir);
        const afterFailure = await restarted.getVehicleManifest("local");
        assert.equal(afterFailure.version, 2);
        assert.equal(afterFailure.definitionHash, before.definitionHash);
        assert.deepEqual(await fs.readdir(path.join(dir, "vehicle-assets", "local")), ["model.glb"]);
        assert.equal((await restarted.exportVehicleBundle("local")).bundleHash, beforeBundle.bundleHash);
        assert.equal((await restarted._resolveVehicleDependency("ego", "local")).hash, beforeResolved.hash);
        await assert.rejects(() => fs.access(path.join(dir, "vehicle-migrations", "local.pre-v3.json")), { code: "ENOENT" });

        const stage = await restarted.vehicleStages.createStage();
        await restarted.vehicleStages.putMember(stage.stageId, assetName, glb);
        const published = await restarted.publishVehicleMigration({
            vehicleId: "local",
            manifest: candidate,
            expectedRevision: before.revision,
            operationId: operationId(),
            stageId: stage.stageId,
        });
        assert.equal(published.version, 3);
        assert.equal(published.revision, before.revision + 1);
        assert.equal(published.model.asset, assetName);
        const names = await restarted.listVehicleAssets("local");
        assert.deepEqual(names, ["model.glb", assetName].sort());
        const snapshot = JSON.parse(await fs.readFile(path.join(dir, "vehicle-migrations", "local.pre-v3.json"), "utf8"));
        assert.equal(snapshot.kind, "cev-sim.vehicle-pre-migration");
        assert.equal(snapshot.manifest.version, 2);
        assert.equal(snapshot.assets["model.glb"], sha256ExactBytes(legacy));
        assert.equal((await fs.readdir(path.join(dir, "vehicle-migrations"))).some((name) => name.startsWith(".")), false);

        await assert.rejects(
            () => restarted.putVehicleManifest("local", {
                manifest: createDefaultVehicleManifest({ id: "local", name: "Local" }),
                expectedRevision: published.revision,
            }),
            (error) => error.code === VEHICLE_MANIFEST_DOWNGRADE,
        );
        await assert.rejects(
            () => restarted.deleteVehicleAsset("local", assetName),
            /published version 3 model closure/,
        );
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("publication accepts a measured binding and rejects an asymmetric one", async () => {
    const dir = await temporaryDir();
    try {
        const service = new StorageService(dir);
        const created = await service.createVehicleManifest(normalizeVehicleManifest({
            ...createDefaultVehicleManifest({ id: "bound-car", name: "Bound" }),
            version: 3,
            model: { asset: null },
        }));
        const parts = [
            ...symmetricWheelParts(),
            { name: "body", center: { x: 0, y: 0.5, z: 0 }, size: { x: 2, y: 1, z: 1 } },
        ];
        const glb = buildBoxGlb(parts);
        const assetName = `${sha256ExactBytes(glb)}.glb`;
        await service.putVehicleAsset("bound-car", assetName, glb);
        const model = {
            asset: assetName,
            dependencies: [],
            hiddenNodeIndices: [2],
            scale: 1,
            rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
            offset: { x: 0, y: 0, z: 0 },
        };
        const boundingBox = created.boundingBox;
        const measurement = measurePlacedVehicleModel({ glbBytes: glb, model, boundingBox });
        const review = reviewModelWheelPair({
            left: measurement.nodes.find((node) => node.nodeIndex === 0),
            right: measurement.nodes.find((node) => node.nodeIndex === 1),
            axle: "front",
        });
        assert.equal(review.withinTolerance, true);
        const proposed = review.proposed;
        const rearX = proposed.x - 1.5;
        const candidate = normalizeVehicleManifest({
            ...created,
            version: 3,
            model,
            boundingBox,
            wheels: [
                { id: "front-left", axle: "front", side: "left", position: { x: proposed.x, y: proposed.y, z: proposed.z }, radius: proposed.radius, width: proposed.width, steerable: true, visual: { kind: "model-node", nodeIndex: 0 } },
                { id: "front-right", axle: "front", side: "right", position: { x: proposed.x, y: proposed.y, z: -proposed.z }, radius: proposed.radius, width: proposed.width, steerable: true, visual: { kind: "model-node", nodeIndex: 1 } },
                { id: "rear-left", axle: "rear", side: "left", position: { x: rearX, y: proposed.y, z: proposed.z }, radius: proposed.radius, width: proposed.width, steerable: false },
                { id: "rear-right", axle: "rear", side: "right", position: { x: rearX, y: proposed.y, z: -proposed.z }, radius: proposed.radius, width: proposed.width, steerable: false },
            ],
            kinematics: { ...created.kinematics, wheelbase: 1.5 },
        });
        const published = await service.putVehicleManifest("bound-car", {
            manifest: candidate,
            expectedRevision: created.revision,
            operationId: operationId(),
        });
        assert.equal(published.wheels[0].visual.nodeIndex, 0);
        assert.deepEqual(published.model.hiddenNodeIndices, [2]);

        const exported = await service.exportVehicleBundle("bound-car");
        const imported = await service.importVehicleBundle(exported);
        assert.equal(imported.wheels[0].visual.nodeIndex, 0);
        assert.equal(imported.wheels[1].visual.nodeIndex, 1);
        assert.deepEqual(imported.model.hiddenNodeIndices, [2]);
        assert.notEqual(imported.id, "bound-car");

        const shifted = symmetricWheelParts();
        shifted[1] = { ...shifted[1], center: { x: 0.875, y: 0.25, z: -0.5 } };
        const asymmetric = buildBoxGlb([
            ...shifted,
            { name: "body", center: { x: 0, y: 0.5, z: 0 }, size: { x: 2, y: 1, z: 1 } },
        ]);
        const asymmetricName = `${sha256ExactBytes(asymmetric)}.glb`;
        await service.putVehicleAsset("bound-car", asymmetricName, asymmetric);
        const before = await service.getVehicleManifest("bound-car");
        await assert.rejects(() => service.putVehicleManifest("bound-car", {
            manifest: {
                ...published,
                model: { ...published.model, asset: asymmetricName, hiddenNodeIndices: [2] },
            },
            expectedRevision: before.revision,
            operationId: operationId(),
        }), /asymmetric|measurement|tolerance|Wheel/);
        const after = await service.getVehicleManifest("bound-car");
        assert.equal(after.revision, before.revision);
        assert.equal(after.definitionHash, before.definitionHash);
        assert.equal(after.model.asset, assetName);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
