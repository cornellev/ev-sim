import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

test("vehicle rotation keeps a plain pose order", async () => {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const { Vehicle } = await import("../app/3d/vehicles/Vehicle.js");
    const database = new VehicleDatabase({
        devices: () => ({ addDevice() {} }),
        bindings: () => null,
    });
    const vehicle = new Vehicle(database);
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.join(" "));
    try {
        vehicle.updateRotation({ x: 0.1, y: -1.2, z: 0.3, order: "XYZ" });
    } finally {
        console.warn = original;
    }

    assert.equal(warnings.some((line) => line.includes("unknown order")), false);
    assert.equal(vehicle.rotation.order, "XYZ");
    assert.equal(vehicle.rotation.y, -1.2);
    assert.equal(vehicle.sceneObject.rotation.order, "XYZ");
    const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, -1.2, 0.3, "XYZ"));
    assert.ok(vehicle.sceneObject.quaternion.angleTo(expected) < 1e-8);
    vehicle.dispose();
});
