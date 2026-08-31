import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    VEHICLE_BUNDLE_KIND,
    VEHICLE_MANIFEST_KIND,
    createDefaultVehicleManifest,
    deriveWheelbase,
    normalizeVehicleManifest,
    resolveVehicleModelUrl,
    validateVehicleManifest,
    vehicleAssetUrl,
} from "../app/vehicles/VehicleManifest.js";
import {
    isBuiltInVehicleType,
    matchesVehicleType,
    vehicleClassNameForType,
} from "../app/vehicles/vehicleTypeResolution.js";
import {
    getBuiltInVehicleManifest,
    isBuiltInVehicleManifest,
    listBuiltInVehicleManifests,
} from "../app/vehicles/BuiltInVehicleManifests.js";
import { StorageService } from "../server/storage/StorageService.js";

async function temporaryService() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-vehicle-manifest-"));
    return { dir, service: new StorageService(dir) };
}

test("vehicle manifest normalization supplies human-editable defaults", () => {
    const manifest = createDefaultVehicleManifest();
    assert.equal(manifest.kind, VEHICLE_MANIFEST_KIND);
    assert.equal(manifest.version, 2);
    assert.equal(manifest.wheels.length, 4);
    assert.equal(manifest.wheels.filter((wheel) => wheel.steerable).length, 2);
    assert.equal(manifest.kinematics.wheelbase, 1.5);
    assert.equal(manifest.kinematics.maxSpeed, 15);
    assert.equal(manifest.kinematics.responseDelayNs, 0);
    assert.equal(manifest.sensors[0].type, "lidar3d");
    assert.deepEqual(manifest.sensors[0].config.thetaRange, [-180, 180]);
    assert.equal(manifest.model.asset, null);
    assert.equal(validateVehicleManifest(manifest).ok, true);
});

test("vehicle manifest normalization derives wheelbase and drops malformed zone data", () => {
    const manifest = normalizeVehicleManifest({
        id: "truck",
        wheels: [
            { id: "fl", position: { x: 1.2, y: 0.3, z: 0.6 }, steerable: true },
            { id: "rl", position: { x: -0.8, y: 0.3, z: 0.6 } },
        ],
        lidarZone: {
            vertices: [[0, 0, 0], [1, 0, 0], "garbage", [0, 1, 0]],
            triangles: [[0, 1, 2], [0, 1], "junk"],
        },
    });
    assert.equal(manifest.kinematics.wheelbase, 2);
    assert.equal(deriveWheelbase(manifest.wheels), 2);
    assert.equal(manifest.lidarZone.vertices.length, 3);
    assert.deepEqual(manifest.lidarZone.triangles, [[0, 1, 2]]);
});

test("vehicle manifest validation rejects future versions, reserved ids, duplicates, and bad triangles", () => {
    assert.throws(() => normalizeVehicleManifest({ kind: VEHICLE_MANIFEST_KIND, version: 3 }), /version 3/);
    assert.throws(() => normalizeVehicleManifest({ kind: "cev-sim.run-manifest" }), /Unsupported vehicle manifest kind/);

    const reserved = validateVehicleManifest(createDefaultVehicleManifest({ id: "big-car" }));
    assert.equal(reserved.ok, false);
    assert.match(reserved.issues[0].message, /reserved/);

    const manifest = createDefaultVehicleManifest();
    manifest.wheels.push({ ...manifest.wheels[0] });
    manifest.sensors.push({ ...manifest.sensors[0] });
    manifest.lidarZone = { params: { voxelSize: 0.2 }, vertices: [[0, 0, 0]], triangles: [[0, 0, 7]] };
    const validation = validateVehicleManifest(manifest);
    assert.equal(validation.ok, false);
    const messages = validation.issues.map((issue) => issue.message).join(" ");
    assert.match(messages, /Duplicate id "front-left"/);
    assert.match(messages, /Duplicate id "roof-lidar"/);
    assert.match(messages, /vertex outside/);
});

test("vehicle manifest v1 migrates with permissive zero-delay actuator defaults", () => {
    const migrated = normalizeVehicleManifest({
        kind: VEHICLE_MANIFEST_KIND,
        version: 1,
        id: "legacy-car",
        wheels: [
            { id: "fl", position: { x: 1, y: 0.3, z: 0.5 }, steerable: true },
            { id: "rl", position: { x: -1, y: 0.3, z: 0.5 } },
        ],
        kinematics: { wheelbase: 2, maxSteeringAngle: 0.5 },
    });
    assert.equal(migrated.version, 2);
    assert.equal(migrated.kinematics.responseDelayNs, 0);
    assert.ok(migrated.kinematics.maxSpeed >= 15);
    assert.ok(migrated.kinematics.maxSteeringRate > 0);
});

test("built-in vehicles expose read-only manifest projections that can be copied", () => {
    const catalog = listBuiltInVehicleManifests();
    assert.deepEqual(catalog.map((entry) => entry.id), ["big-car", "igvc-car", "scenario-car"]);
    assert.equal(catalog.every((entry) => entry.builtIn && entry.revision === null), true);
    assert.equal(isBuiltInVehicleManifest("big-car"), true);
    assert.equal(isBuiltInVehicleManifest("custom-car"), false);

    const bigCar = getBuiltInVehicleManifest("big-car");
    assert.equal(bigCar.sensors.length, 2);
    assert.equal(bigCar.wheels.length, 4);
    assert.equal(bigCar.model.asset, "/shell/shell.gltf");
    assert.equal(resolveVehicleModelUrl("big-car", bigCar.model.asset), "/shell/shell.gltf");
    assert.equal(
        resolveVehicleModelUrl("custom", "model.glb", { cacheBust: 3 }),
        "/api/storage/vehicle-assets/custom/model.glb?v=3",
    );
    assert.equal(validateVehicleManifest(bigCar).ok, false, "the reserved built-in id remains read-only");

    const copy = { ...bigCar, id: "big-car-custom", name: "Big Car Copy" };
    assert.equal(validateVehicleManifest(copy).ok, true);
    assert.equal(resolveVehicleModelUrl(copy.id, copy.model.asset), "/shell/shell.gltf");

    const secondRead = getBuiltInVehicleManifest("big-car");
    bigCar.boundingBox.size.x = 99;
    assert.notEqual(secondRead.boundingBox.size.x, 99, "callers receive independent manifest copies");
});

test("vehicle storage supports CRUD, optimistic revisions, and binary assets", async () => {
    const { dir, service } = await temporaryService();
    try {
        assert.deepEqual(await service.listVehicleManifests(), []);

        const created = await service.createVehicleManifest(createDefaultVehicleManifest({ id: "my-truck", name: "My Truck" }));
        assert.equal(created.revision, 1);
        assert.equal(created.definitionHash.length, 64);
        await assert.rejects(service.createVehicleManifest(createDefaultVehicleManifest({ id: "my-truck" })), /already exists/);

        const updated = await service.putVehicleManifest("my-truck", {
            manifest: { ...created, description: "Updated" },
            expectedRevision: 1,
        });
        assert.equal(updated.revision, 2);
        assert.equal(updated.description, "Updated");
        await assert.rejects(
            service.putVehicleManifest("my-truck", { manifest: created, expectedRevision: 1 }),
            /revision conflict/,
        );

        const model = Buffer.from("glTF-binary-bytes");
        await service.putVehicleAsset("my-truck", "model.glb", model);
        assert.deepEqual(await service.listVehicleAssets("my-truck"), ["model.glb"]);
        assert.deepEqual(await service.readVehicleAsset("my-truck", "model.glb"), model);
        assert.equal(vehicleAssetUrl("my-truck", "model.glb"), "/api/storage/vehicle-assets/my-truck/model.glb");
        await assert.rejects(service.putVehicleAsset("../escape", "model.glb", model), /Invalid storage id/);

        const duplicate = await service.duplicateVehicleManifest("my-truck", { id: "my-truck-2" });
        assert.equal(duplicate.id, "my-truck-2");
        assert.deepEqual(await service.readVehicleAsset("my-truck-2", "model.glb"), model);

        await service.deleteVehicleManifest("my-truck");
        assert.equal(await service.getVehicleManifest("my-truck"), null);
        assert.deepEqual(await service.listVehicleAssets("my-truck"), []);
        assert.deepEqual((await service.listVehicleManifests()).map((entry) => entry.id), ["my-truck-2"]);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("vehicle bundles round-trip manifests and assets, suffixing conflicting ids", async () => {
    const source = await temporaryService();
    const target = await temporaryService();
    try {
        await source.service.createVehicleManifest(createDefaultVehicleManifest({
            id: "portable-truck",
            model: { asset: "model.glb", scale: 0.5, rotation: {}, offset: {} },
        }));
        const model = Buffer.from("model-bytes");
        await source.service.putVehicleAsset("portable-truck", "model.glb", model);

        const bundle = await source.service.exportVehicleBundle("portable-truck");
        assert.equal(bundle.kind, VEHICLE_BUNDLE_KIND);
        assert.equal(bundle.bundleHash.length, 64);
        assert.equal(bundle.assets["model.glb"], model.toString("base64"));

        const imported = await target.service.importVehicleBundle(bundle);
        assert.equal(imported.id, "portable-truck");
        assert.equal(imported.model.asset, "model.glb");
        assert.deepEqual(await target.service.readVehicleAsset("portable-truck", "model.glb"), model);

        const again = await target.service.importVehicleBundle(bundle);
        assert.match(again.id, /^portable-truck-[a-f0-9]{8}$/);

        await assert.rejects(
            target.service.importVehicleBundle({ ...bundle, bundleHash: "0".repeat(64) }),
            /hash is invalid/,
        );
    } finally {
        await fs.rm(source.dir, { recursive: true, force: true });
        await fs.rm(target.dir, { recursive: true, force: true });
    }
});

test("custom manifest types resolve to ManifestVehicle while built-ins keep their classes", () => {
    assert.equal(isBuiltInVehicleType("big-car"), true);
    assert.equal(isBuiltInVehicleType("my-truck"), false);
    assert.equal(vehicleClassNameForType("big-car"), "BigCar");
    assert.equal(vehicleClassNameForType("igvc-car"), "IGVCCar");
    assert.equal(vehicleClassNameForType("scenario-car"), "ScenarioCar");
    assert.equal(vehicleClassNameForType("my-truck"), "ManifestVehicle");
    assert.equal(vehicleClassNameForType(""), "BigCar");

    class BigCar {}
    class ManifestVehicle {
        constructor(vehicleManifestId) {
            this.vehicleManifestId = vehicleManifestId;
        }
    }

    assert.equal(matchesVehicleType(new BigCar(), "big-car"), true);
    assert.equal(matchesVehicleType(new BigCar(), "my-truck"), false);
    assert.equal(matchesVehicleType(new ManifestVehicle("my-truck"), "my-truck"), true);
    // A vehicle spawned from a different manifest must be respawned.
    assert.equal(matchesVehicleType(new ManifestVehicle("other-truck"), "my-truck"), false);
    assert.equal(matchesVehicleType(new ManifestVehicle("my-truck"), "big-car"), false);
});
