import assert from "node:assert/strict";
import test from "node:test";

import {
    clearLaneHighlights,
    setDeviceVisualsVisible,
    setVehiclesVisible,
} from "../app/3d/runtimeVisibility.js";
import { PhysicsEngine } from "../app/physics/PhysicsEngine.js";

test("physics startup waits for Rapier initialization instead of timing out", async () => {
    let resolvePhysics;
    const loadPhysics = () => new Promise((resolve) => {
        resolvePhysics = resolve;
    });
    const physics = new PhysicsEngine({}, { loadPhysics });
    const start = physics.start();
    class World {
        constructor(gravity) {
            this.gravity = gravity;
        }
    }

    resolvePhysics({ World });
    await start;

    assert.ok(physics.world);
});

test("editor mode visibility hides vehicle and detached device visuals", () => {
    const vehicleRoot = { visible: true };
    const deviceRoots = [
        { visible: true },
        { visible: true },
        { visible: true },
        { visible: true },
    ];
    const laneMeshes = [{ visible: true }, { visible: true }];
    const data = {
        vehicles: () => ({ vehicles: [{ sceneObject: vehicleRoot }] }),
        devices: () => ({
            devices: [{
                _mesh: deviceRoots[0],
                pointsGroup: deviceRoots[1],
                lines: deviceRoots[2],
                sensorCamera: deviceRoots[3],
            }],
        }),
        city: () => ({
            roads: [{ laneMeshes: [laneMeshes[0]] }],
            intersections: [{ laneMeshes: [laneMeshes[1]] }],
        }),
    };

    setVehiclesVisible(data, false);
    setDeviceVisualsVisible(data, false);
    clearLaneHighlights(data);

    assert.equal(vehicleRoot.visible, false);
    assert.deepEqual(deviceRoots.map((root) => root.visible), [false, false, false, false]);
    assert.deepEqual(laneMeshes.map((mesh) => mesh.visible), [false, false]);
});

