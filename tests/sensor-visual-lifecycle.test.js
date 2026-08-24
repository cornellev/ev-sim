import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import Device from "../app/3d/devices/Device.js";
import {
    disposeObject3D,
    setDeviceVisualsEnabled,
    syncDeviceVisuals,
} from "../app/3d/devices/DeviceVisuals.js";

test("device visuals follow the parent vehicle world pose", () => {
    const scene = new THREE.Scene();
    const vehicleObject = new THREE.Group();
    vehicleObject.position.set(10, 0, 0);
    vehicleObject.rotation.set(0, Math.PI / 2, 0);
    scene.add(vehicleObject);
    scene.updateMatrixWorld(true);

    const device = new Device("test", {
        position: new THREE.Vector3(1, 2, 0),
        rotation: new THREE.Euler(0, Math.PI / 4, 0),
    });
    device.parentVehicle = {
        sceneObject: vehicleObject,
        position: vehicleObject.position,
        rotation: vehicleObject.rotation,
    };

    const marker = new THREE.Group();
    const debugRays = new THREE.Group();
    syncDeviceVisuals(device, [marker, debugRays]);

    const expectedPosition = new THREE.Vector3(10, 2, -1);
    assert.ok(marker.position.distanceTo(expectedPosition) < 1e-10);
    assert.ok(debugRays.position.distanceTo(expectedPosition) < 1e-10);

    const expectedRotation = vehicleObject.getWorldQuaternion(new THREE.Quaternion())
        .multiply(new THREE.Quaternion().setFromEuler(device.settings.rotation));
    assert.ok(marker.quaternion.angleTo(expectedRotation) < 1e-10);
    assert.ok(debugRays.quaternion.angleTo(expectedRotation) < 1e-10);
});

test("disabled device visuals are hidden and disposed visuals leave the scene", () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const geometry = new THREE.SphereGeometry(0.1);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    let geometryDisposed = false;
    let materialDisposed = false;
    geometry.addEventListener("dispose", () => { geometryDisposed = true; });
    material.addEventListener("dispose", () => { materialDisposed = true; });
    group.add(mesh);
    scene.add(group);

    setDeviceVisualsEnabled(false, [group]);
    assert.equal(group.visible, false);
    setDeviceVisualsEnabled(true, [group]);
    assert.equal(group.visible, true);

    disposeObject3D(group);
    assert.equal(group.parent, null);
    assert.equal(geometryDisposed, true);
    assert.equal(materialDisposed, true);
});
