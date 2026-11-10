import assert from "node:assert/strict";
import test from "node:test";

import { rearOdometryGeometry, reviewOdometryGeometry } from "../app/vehicles/axle/odometryGeometry.js";
import { VehicleEditorController } from "../app/vehicles/editor/VehicleEditorController.js";
import { createBlankVehicleManifest } from "../app/vehicles/VehicleManifest.js";

function vehicle() {
    return createBlankVehicleManifest({
        id: "odometry-test",
        sensors: [true, false].map((enabled, index) => ({
            id: `odo-${index}`, type: "wheel-odometry", enabled,
            config: { wheelRadius: 0.15, trackWidth: 1.2 },
        })),
    });
}

function editor() {
    const controller = new VehicleEditorController();
    const requests = [];
    controller.open(vehicle());
    controller.client = { async saveVehicleManifest(id, manifest) {
        requests.push({ id, manifest });
        return { ...manifest, revision: 2, definitionHash: "saved" };
    } };
    return { controller, requests };
}

test("rear axle geometry uses the actual separation and mean radius, with standard-pair tolerance", () => {
    const manifest = vehicle();
    const rear = manifest.wheels.filter((wheel) => wheel.axle === "rear");
    const geometry = rearOdometryGeometry(manifest.wheels);
    manifest.sensors[1].enabled = false;
    assert.equal(geometry.trackWidth, Math.abs(rear[0].position.z - rear[1].position.z));
    assert.equal(geometry.wheelRadius, (rear[0].radius + rear[1].radius) / 2);
    assert.equal(reviewOdometryGeometry(manifest).sensors.length, 2);
    for (const sensor of manifest.sensors) Object.assign(sensor.config, geometry, { trackWidth: geometry.trackWidth + 0.0005 });
    assert.equal(reviewOdometryGeometry(manifest), null);
    rear[1].position.x += 0.01;
    assert.equal(rearOdometryGeometry(manifest.wheels), null);
    assert.equal(rearOdometryGeometry(rear.slice(0, 1)), null);
});

test("save reviews before any request, stale consent re-reviews, and sync is one undoable command", async () => {
    const { controller, requests } = editor();
    controller.editField(["name"], "Pending name");
    const first = await controller.save();
    assert.equal(first.ok, false);
    assert.equal(requests.length, 0);
    controller.editField(["description"], "Edited after review");
    const stale = await controller.save({ odometryReview: first.odometryReview, syncOdometry: true });
    assert.equal(stale.ok, false);
    assert.notEqual(stale.odometryReview.generation, first.odometryReview.generation);
    assert.equal(requests.length, 0);
    const previous = structuredClone(controller.snapshot.manifest.sensors);
    await controller.save({ odometryReview: stale.odometryReview, syncOdometry: true });
    assert.equal(requests.length, 1);
    const sensors = controller.snapshot.manifest.sensors;
    for (const sensor of sensors) {
        assert.equal(sensor.config.wheelRadius, stale.odometryReview.geometry.wheelRadius);
        assert.equal(sensor.config.trackWidth, stale.odometryReview.geometry.trackWidth);
        assert.deepEqual(sensor.pose, previous.find((entry) => entry.id === sensor.id).pose);
    }
    assert.equal(sensors[1].enabled, previous[1].enabled);
    controller.undo();
    assert.deepEqual(controller.snapshot.manifest.sensors, previous);
});

test("skip saves unchanged sensor constants; unavailable geometry cannot sync; conflicts retain synced edits", async () => {
    const { controller, requests } = editor();
    controller.editField(["name"], "Skip sync");
    const first = await controller.save();
    await controller.save({ odometryReview: first.odometryReview });
    assert.equal(requests[0].manifest.sensors[0].config.wheelRadius, 0.15);
    controller.editField(["wheels"], []);
    const unavailable = await controller.save();
    assert.equal(unavailable.odometryReview.geometry, null);
    await assert.rejects(() => controller.save({ odometryReview: unavailable.odometryReview, syncOdometry: true }), /Cannot verify/);
    assert.equal(requests.length, 1);

    const conflict = editor().controller;
    conflict.editField(["name"], "Keep synced");
    conflict.client.saveVehicleManifest = async () => { throw new Error("revision conflict"); };
    const review = await conflict.save();
    await assert.rejects(() => conflict.save({ odometryReview: review.odometryReview, syncOdometry: true }), /revision conflict/);
    assert.equal(conflict.snapshot.saveState, "conflict");
    assert.equal(conflict.snapshot.manifest.name, "Keep synced");
    assert.equal(reviewOdometryGeometry(conflict.snapshot.manifest), null);
});

test("an invalid pending physical field blocks review and publication without losing the input", async () => {
    const { controller, requests } = editor();
    controller.editField(["dynamics"], { model: "contact-bicycle-v2", mass: 3 });
    assert.equal(controller.editField(["dynamics", "mass"], "0").ok, false);
    await assert.rejects(() => controller.save(), /Fix validation errors/);
    assert.equal(controller.fieldValue(["dynamics", "mass"]), "0");
    assert.equal(requests.length, 0);
});

test("reopening the same vehicle cannot reuse consent from the previous editor session", async () => {
    const { controller, requests } = editor();
    const first = await controller.save();
    controller.open(vehicle());
    const reopened = await controller.save({ odometryReview: first.odometryReview, syncOdometry: true });
    assert.equal(reopened.ok, false);
    assert.notEqual(first.odometryReview.sessionGeneration, reopened.odometryReview.sessionGeneration);
    assert.equal(requests.length, 0);
});
