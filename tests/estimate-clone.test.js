import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";

import { eulerToQuaternion } from "../app/autonomy/CoordinateFrames.js";
import { createDefaultVehicleManifest } from "../app/vehicles/VehicleManifest.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

test("cloneVisualBody copies the body and wheels once the model is ready", async () => {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const { ManifestVehicle } = await import("../app/3d/vehicles/ManifestVehicle.js");
    const vehicle = new ManifestVehicle(
        new VehicleDatabase({ devices: () => ({ addDevice() {} }), bindings: () => null, scene: null }),
        createDefaultVehicleManifest({ id: "estimate-source", sensors: [], lidarZone: { vertices: [], triangles: [] } }),
        new THREE.Vector3(),
        new THREE.Euler(),
        { skipManifestDevices: true },
    );
    assert.equal(vehicle.cloneVisualBody(), null);

    await vehicle.addToScene({ add() {} });
    const body = vehicle.sceneObject.getObjectByName("vehicle-body");
    const origin = vehicle.sceneObject.getObjectByName("vehicle-origin-debug");
    const clone = vehicle.cloneVisualBody();

    assert.equal(clone.name, "estimate-clone");
    assert.equal(clone.getObjectByName("vehicle-body") != null, true);
    assert.equal(clone.getObjectByName("vehicle-origin-debug"), undefined);
    const cloneMeshes = [];
    clone.traverse((node) => {
        if (node.isMesh) cloneMeshes.push(node);
    });
    assert.equal(cloneMeshes.length, 1 + vehicle._wheels.length);
    assert.equal(cloneMeshes[0].material.color.getHex(), 0xf97316);
    assert.equal(body.material.color.getHex(), 0x64748b);
    assert.notEqual(cloneMeshes[0].geometry.uuid, body.geometry.uuid);
    assert.equal(origin.parent, vehicle.sceneObject);
    vehicle.dispose?.();
});

test("the estimate clone is posed in place and the status box returns when it is hidden", async () => {
    const { AutonomyOverlay } = await import("../app/3d/overlay/AutonomyOverlay.js");
    const overlay = new AutonomyOverlay();
    let clones = 0;
    const vehicle = {
        cloneVisualBody() {
            clones += 1;
            const group = new THREE.Group();
            group.name = "estimate-clone";
            group.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
            return group;
        },
    };
    const estimate = {
        threePosition: { x: 2, y: 0.4, z: -1 },
        orientation: eulerToQuaternion({ z: 0.5 }),
        covarianceEllipse: { sigmaX: 0.2, sigmaY: 0.2 },
        status: "ok",
    };
    const runtime = () => ({
        lastPerception: {},
        lastLocalization: { estimate, status: "ok" },
    });

    overlay.updateFromRuntime(runtime(), null, { estimateVehicle: vehicle });
    const clone = overlay.group.getObjectByName("estimate-clone");
    assert.equal(clones, 1);
    assert.equal(clone.parent, overlay.group);
    assert.equal(clone.position.x, 2);
    assert.equal(clone.position.y, 0.4);
    assert.equal(clone.position.z, -1);
    assert.ok(Math.abs(clone.rotation.y - 0.5) < 1e-6);
    assert.equal(overlay._ekf.children[0].visible, false);

    estimate.threePosition = { x: 3, y: 0.4, z: -1 };
    overlay.updateFromRuntime(runtime(), null, { estimateVehicle: vehicle });
    assert.equal(clones, 1);
    assert.equal(clone.position.x, 3);

    overlay.updateFromRuntime(runtime(), { estimateClone: false }, { estimateVehicle: vehicle });
    assert.equal(clone.visible, false);
    assert.equal(overlay._ekf.children[0].visible, true);
    assert.equal(overlay._ekf.children[0].position.y, 0.4 + 0.35);

    overlay.updateFromRuntime(runtime(), { estimateClone: true }, { estimateVehicle: vehicle });
    assert.equal(clones, 1);
    assert.equal(clone.visible, true);
    assert.equal(overlay._ekf.children[0].visible, false);

    overlay.updateFromRuntime({ lastPerception: {}, lastLocalization: {} }, null, { estimateVehicle: vehicle });
    assert.equal(clones, 1);
    assert.equal(clone.visible, false);
    assert.equal(clone.parent, overlay.group);

    overlay.clear();
    assert.equal(overlay.group.getObjectByName("estimate-clone"), undefined);
    overlay.updateFromRuntime(runtime(), null, { estimateVehicle: vehicle });
    assert.equal(clones, 2);
    overlay.disposeEstimateClone();
    assert.equal(overlay.group.getObjectByName("estimate-clone"), undefined);
});
