import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { attachVehiclePlant, stepVehiclePlant } from "../app/3d/vehicles/VehiclePlantAdapter.js";
import { HeadlessVehicleManager } from "../app/simulation/headless/HeadlessVehicleManager.js";
import { createVehiclePlantDefinition, KinematicVehiclePlant } from "../app/simulation/vehicles/KinematicVehiclePlant.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import { VehicleDocumentSession } from "../app/vehicles/document/VehicleDocumentSession.js";
import { applyPlacementChange } from "../app/vehicles/document/vehicleCommands.js";
import {
    createBlankVehicleManifest,
    normalizeVehicleManifest,
} from "../app/vehicles/VehicleManifest.js";
import { createVehicleAcceptanceHarness } from "./helpers/vehicleAcceptanceHarness.js";
import { characterizationDigest, loadVehicleIdentityLedger } from "./helpers/vehicleIdentityLedger.js";

function operationId() {
    return randomBytes(32).toString("hex");
}

function initial(type) {
    return {
        id: "ego",
        type,
        pose: { position: { x: 1, y: 0, z: 2 }, rotation: { x: 0, y: 0.2, z: 0, order: "XYZ" } },
        linearVelocity: { x: 3, y: 0, z: 0 },
        linearAcceleration: { x: 0, y: 0, z: 0 },
        steeringAngle: 0.2,
    };
}

function mutableVector(source = {}, withOrder = false) {
    return {
        x: Number(source.x) || 0,
        y: Number(source.y) || 0,
        z: Number(source.z) || 0,
        ...(withOrder ? { order: source.order || "XYZ" } : {}),
        set(x, y, z, order = this.order) {
            Object.assign(this, { x, y, z });
            if (withOrder) this.order = order || "XYZ";
            return this;
        },
        copy(value) {
            return this.set(value.x, value.y, value.z, value.order);
        },
    };
}

async function stepped(manifest) {
    const entry = initial(manifest.id);
    const browser = {
        telemetryId: entry.id,
        position: mutableVector(entry.pose.position),
        rotation: mutableVector(entry.pose.rotation, true),
        velocity: mutableVector(entry.linearVelocity),
        acceleration: mutableVector(entry.linearAcceleration),
        steeringAngle: entry.steeringAngle,
        updatePosition(value) { this.position.copy(value); },
        updateRotation(value) { this.rotation.copy(value); },
    };
    attachVehiclePlant(browser, entry, { manifest });
    const headless = new HeadlessVehicleManager();
    await headless.configureFromManifest([entry], null, {
        resolvedVehicles: [{ actorId: entry.id, vehicleId: entry.type, manifest }],
    });
    stepVehiclePlant(browser, 0.5);
    headless.update(0.5);
    return {
        browser: browser.plant.getDeterministicState(),
        headless: headless.getDeterministicState()[0],
    };
}

function yawDelta(wheelbase) {
    const manifest = getBuiltInVehicleManifest("big-car");
    manifest.id = "yaw-car";
    manifest.kinematics.wheelbase = wheelbase;
    const entry = initial("yaw-car");
    entry.pose.rotation.y = 0;
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, { manifest }));
    plant.update(0.5);
    return plant.rotation.y;
}

test("VEH-09e a version 3 copy with the same kinematics matches the version 2 plant", async () => {
    const version2 = getBuiltInVehicleManifest("big-car");
    version2.kinematics.wheelbase = 1.2446;
    version2.kinematics.maxSteeringAngle = 0.6;
    const version3 = normalizeVehicleManifest({
        ...version2,
        id: "big-car-v3",
        version: 3,
        kinematics: { ...version2.kinematics, wheelbase: 1.2446, maxSteeringAngle: 0.6 },
    });
    version2.id = "big-car-v2";
    const left = await stepped(version2);
    const right = await stepped(version3);
    assert.equal(left.browser.rotation.y, right.browser.rotation.y);
    assert.equal(left.headless.rotation.y, right.headless.rotation.y);
    assert.equal(left.browser.position.x, right.headless.position.x);
    assert.equal(left.browser.position.z, right.headless.position.z);
    const ratio = yawDelta(1.5) / yawDelta(1.2446);
    assert.ok(Math.abs(ratio - (1.2446 / 1.5)) < 1e-9);
});

test("VEH-09e clearing a baked LiDAR zone changes the resolved geometry hash and not the plant", async () => {
    const harness = await createVehicleAcceptanceHarness();
    try {
        const baked = normalizeVehicleManifest({
            ...createBlankVehicleManifest({ id: "zone-car", name: "Zone" }),
            lidarZone: {
                params: { voxelSize: 0.2 },
                vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
                triangles: [[0, 1, 2]],
            },
        });
        const created = await harness.service.createVehicleManifest({
            manifest: baked,
            operationId: operationId(),
        });
        const before = await harness.snapshotIdentity("zone-car");
        const session = new VehicleDocumentSession({
            manifest: created,
            revision: created.revision,
            definitionHash: created.definitionHash,
        });
        const edited = session.execute(applyPlacementChange({ model: { scale: 1.1 } }));
        assert.equal(edited.ok, true);
        assert.deepEqual(session.draft.snapshot().lidarZone.vertices, []);
        assert.deepEqual(session.draft.snapshot().lidarZone.triangles, []);
        await harness.service.putVehicleManifest("zone-car", {
            manifest: session.draft.snapshot(),
            expectedRevision: created.revision,
        });
        const after = await harness.snapshotIdentity("zone-car");
        assert.notEqual(after.resolved.dependencyHashes.lidarGeometry, before.resolved.dependencyHashes.lidarGeometry);
        const bakedStep = await stepped(created);
        const clearedStep = await stepped(session.draft.snapshot());
        assert.equal(bakedStep.browser.rotation.y, clearedStep.browser.rotation.y);
        assert.equal(bakedStep.headless.position.x, clearedStep.headless.position.x);
    } finally {
        await harness.dispose();
    }
});

test("VEH-09e the committed headless characterization fixture stays pinned", async () => {
    const ledger = await loadVehicleIdentityLedger();
    assert.equal(await characterizationDigest(), ledger.characterizationSha256);
});
