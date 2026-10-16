import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import * as THREE from "three";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

import {
    applyMeasuredPlacement,
    captureModelRest,
    clearPresentedWheels,
    presentBoundWheels,
    restoreModelRest,
} from "../app/3d/vehicles/presentBoundWheels.js";
import { measurePlacedVehicleModel } from "../app/vehicles/model/measurePlacedVehicle.js";
import { normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { buildBoxGlb, symmetricWheelParts } from "./helpers/vehicle-wheel-glb.js";

function closeTo(actual, expected, epsilon = 1e-5) {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} is not within ${epsilon} of ${expected}`);
}

function worldPosition(object) {
    const position = new THREE.Vector3();
    object.updateWorldMatrix(true, false);
    object.getWorldPosition(position);
    return position;
}

test("bound wheel pivots keep the placed mesh pose and hide a detached subtree", () => {
    const glb = buildBoxGlb(symmetricWheelParts());
    const model = {
        asset: `${"ab".repeat(32)}.glb`,
        dependencies: [],
        hiddenNodeIndices: [],
        scale: 1,
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        offset: { x: 0, y: 0, z: 0 },
    };
    const manifest = normalizeVehicleManifest({
        version: 3,
        id: "presented",
        model,
        wheels: [
            { id: "front-left", axle: "front", side: "left", position: { x: 0, y: 0, z: 0 }, radius: 0.25, width: 0.25, steerable: true, visual: { kind: "model-node", nodeIndex: 0 } },
            { id: "front-right", axle: "front", side: "right", position: { x: 0, y: 0, z: 0 }, radius: 0.25, width: 0.25, steerable: true, visual: { kind: "model-node", nodeIndex: 1 } },
            { id: "spare", position: { x: -1, y: 0.25, z: 0 }, radius: 0.2, width: 0.1, steerable: false },
        ],
    });
    const measurement = measurePlacedVehicleModel({
        glbBytes: glb,
        model: manifest.model,
        boundingBox: manifest.boundingBox,
    });
    manifest.wheels[0].position = measurement.nodes[0].center;
    manifest.wheels[1].position = measurement.nodes[1].center;

    const root = new THREE.Group();
    root.name = "body";
    const left = new THREE.Group();
    left.name = "wheel-left";
    const right = new THREE.Group();
    right.name = "wheel-right";
    root.add(left, right);
    const mappings = new Map([
        [root, { nodeIndex: 4 }],
        [left, { nodeIndex: 0 }],
        [right, { nodeIndex: 1 }],
    ]);
    const wheelsGroup = new THREE.Group();
    const scene = new THREE.Group();
    scene.add(root, wheelsGroup);
    applyMeasuredPlacement(root, measurement.placement);
    const beforeLeft = worldPosition(left);
    const beforeRoot = root.position.clone();
    const rest = captureModelRest(root, mappings);

    const presented = presentBoundWheels({
        root,
        wheelsGroup,
        manifest,
        nodeMappings: mappings,
        THREE,
    });
    const afterLeft = worldPosition(left);
    closeTo(afterLeft.x, beforeLeft.x);
    closeTo(afterLeft.y, beforeLeft.y);
    closeTo(afterLeft.z, beforeLeft.z);
    closeTo(root.position.x, beforeRoot.x);
    closeTo(root.position.y, beforeRoot.y);
    closeTo(root.position.z, beforeRoot.z);
    assert.equal(left.parent.userData.boundWheel, true);
    assert.equal(root.children.includes(left), false);
    assert.equal(root.children.includes(right), false);
    assert.equal(presented.pivots.length, 2);
    assert.equal(presented.cylinders.length, 1);
    assert.equal(presented.pivots[0].pivot.userData.pick.id, "front-left");
    assert.equal(wheelsGroup.children.filter((child) => child.userData.generatedWheel || child.children.some((entry) => entry.userData.generatedWheel)).length, 1);

    restoreModelRest(rest);
    clearPresentedWheels(wheelsGroup);
    const detached = normalizeVehicleManifest({
        ...manifest,
        model: { ...manifest.model, hiddenNodeIndices: [0] },
        wheels: manifest.wheels.map((wheel) => wheel.id === "front-left" ? { ...wheel, visual: undefined } : wheel),
    });
    delete detached.wheels.find((wheel) => wheel.id === "front-left").visual;
    const rootAfterDetach = root.position.clone();
    presentBoundWheels({
        root,
        wheelsGroup,
        manifest: detached,
        nodeMappings: mappings,
        THREE,
    });
    assert.equal(left.visible, false);
    assert.equal(left.parent, root);
    assert.equal(right.parent.userData.boundWheel, true);
    closeTo(root.position.x, rootAfterDetach.x);
    closeTo(root.position.y, rootAfterDetach.y);
    closeTo(root.position.z, rootAfterDetach.z);
    const cylinderIds = wheelsGroup.children.filter((child) => child.children.some((entry) => entry.userData.generatedWheel)).map((child) => child.userData.pick.id);
    assert.deepEqual(cylinderIds.sort(), ["front-left", "spare"]);
    assert.equal(root.children.filter((child) => child.name === "wheel-left").length, 1);
});

test("a bound tire yaws about its mesh center when the stored position is the origin", () => {
    const root = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.2));
    tire.geometry.translate(1.2, 0.3, 0.75);
    root.add(tire);
    const wheelsGroup = new THREE.Group();
    const scene = new THREE.Group();
    scene.add(root, wheelsGroup);
    scene.updateMatrixWorld(true);
    const before = new THREE.Box3().setFromObject(tire).getCenter(new THREE.Vector3());

    presentBoundWheels({
        root,
        wheelsGroup,
        manifest: {
            wheels: [{
                id: "front-left",
                position: { x: 0, y: 0, z: 0 },
                radius: 0.25,
                width: 0.2,
                steerable: true,
                visual: { kind: "model-node", nodeIndex: 0 },
            }],
        },
        nodeMappings: new Map([[tire, { nodeIndex: 0 }]]),
        THREE,
    });

    closeTo(tire.parent.position.x, before.x);
    closeTo(tire.parent.position.y, before.y);
    closeTo(tire.parent.position.z, before.z);
    const rest = new THREE.Box3().setFromObject(tire).getCenter(new THREE.Vector3());
    closeTo(rest.x, before.x);
    closeTo(rest.y, before.y);
    closeTo(rest.z, before.z);
    tire.parent.rotation.y = 0.5;
    tire.parent.updateMatrixWorld(true);
    const yawed = new THREE.Box3().setFromObject(tire).getCenter(new THREE.Vector3());
    closeTo(yawed.x, before.x);
    closeTo(yawed.y, before.y);
    closeTo(yawed.z, before.z);
    tire.geometry.dispose();
});

test("ManifestVehicle presents a canonical binding and keeps a legacy load on cylinders", async () => {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const { ManifestVehicle } = await import("../app/3d/vehicles/ManifestVehicle.js");
    const glb = buildBoxGlb(symmetricWheelParts());
    const database = new VehicleDatabase({
        devices: () => ({ addDevice() {} }),
        bindings: () => null,
        scene: null,
    });
    const model = {
        asset: `${"cd".repeat(32)}.glb`,
        dependencies: [],
        hiddenNodeIndices: [],
        scale: 1,
        rotation: { x: 0, y: 0, z: 0, order: "XYZ" },
        offset: { x: 0, y: 0, z: 0 },
    };
    const base = normalizeVehicleManifest({ version: 3, id: "bound", model, wheels: [] });
    const measurement = measurePlacedVehicleModel({ glbBytes: glb, model, boundingBox: base.boundingBox });
    const manifest = normalizeVehicleManifest({
        ...base,
        wheels: [
            { id: "front-left", axle: "front", side: "left", position: measurement.nodes[0].center, radius: measurement.nodes[0].radius, width: measurement.nodes[0].width, steerable: true, visual: { kind: "model-node", nodeIndex: 0 } },
            { id: "front-right", axle: "front", side: "right", position: measurement.nodes[1].center, radius: measurement.nodes[1].radius, width: measurement.nodes[1].width, steerable: true, visual: { kind: "model-node", nodeIndex: 1 } },
        ],
    });
    const root = new THREE.Group();
    root.name = "canonical-root";
    root.position.set(9, 9, 9);
    const left = new THREE.Group();
    left.name = "left-mesh";
    const right = new THREE.Group();
    right.name = "right-mesh";
    root.add(left, right);
    const vehicle = new ManifestVehicle(database, manifest, new THREE.Vector3(), new THREE.Euler(), {
        skipManifestDevices: true,
        modelLoader: {
            async load() {
                return {
                    stale: false,
                    root,
                    glbBytes: glb,
                    nodeMappings: new Map([[left, { nodeIndex: 0 }], [right, { nodeIndex: 1 }]]),
                    alignment: { x: 0, y: 0, z: 0 },
                    dispose() {},
                };
            },
            dispose() {},
        },
    });
    await vehicle.addToScene({ add() {} });
    const placed = measurement.placement;
    closeTo(root.position.x, placed.alignment.x + placed.offset.x);
    closeTo(root.position.y, placed.alignment.y + placed.offset.y);
    closeTo(root.position.z, placed.alignment.z + placed.offset.z);
    assert.equal(root.children.includes(left), false);
    assert.equal(left.parent.userData.boundWheel, true);
    assert.equal(vehicle.sceneObject.children.some((child) => child.userData?.generatedWheel || child.children?.some((entry) => entry.userData?.generatedWheel)), false);
    vehicle.steeringAngle = 0.4;
    vehicle.update(0);
    assert.ok(Math.abs(left.parent.rotation.y) > 0);

    const legacyRoot = new THREE.Group();
    legacyRoot.name = "legacy-root";
    legacyRoot.position.set(1, 2, 3);
    const legacy = normalizeVehicleManifest({ version: 2, id: "legacy", model: { asset: "model.glb" } });
    const legacyVehicle = new ManifestVehicle(database, legacy, new THREE.Vector3(), new THREE.Euler(), {
        skipManifestDevices: true,
        modelLoader: {
            async load() {
                return {
                    stale: false,
                    root: legacyRoot,
                    glbBytes: glb,
                    nodeMappings: new Map(),
                    alignment: { x: 1, y: 2, z: 3 },
                    dispose() {},
                };
            },
            dispose() {},
        },
    });
    await legacyVehicle.addToScene({ add() {} });
    closeTo(legacyRoot.position.x, 1);
    closeTo(legacyRoot.position.y, 2);
    closeTo(legacyRoot.position.z, 3);
    const cylinders = legacyVehicle.sceneObject.children.filter((child) => child.children?.some((entry) => entry.geometry?.type === "CylinderGeometry"));
    assert.equal(cylinders.length, legacy.wheels.length);
    assert.equal(legacyVehicle.sceneObject.children.some((child) => child.userData?.boundWheel), false);
    vehicle.dispose();
    legacyVehicle.dispose();
});

test("ManifestVehicle ignores a stale canonical load", async () => {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const { ManifestVehicle } = await import("../app/3d/vehicles/ManifestVehicle.js");
    const glb = buildBoxGlb(symmetricWheelParts());
    const database = new VehicleDatabase({
        devices: () => ({ addDevice() {} }),
        bindings: () => null,
        scene: null,
    });
    const manifest = normalizeVehicleManifest({
        version: 3,
        id: "stale",
        model: { asset: `${"ef".repeat(32)}.glb`, dependencies: [], hiddenNodeIndices: [] },
    });
    let releaseFirst;
    const gate = new Promise((resolve) => { releaseFirst = resolve; });
    let calls = 0;
    const vehicle = new ManifestVehicle(database, manifest, new THREE.Vector3(), new THREE.Euler(), {
        skipManifestDevices: true,
        modelLoader: {
            async load() {
                const which = ++calls;
                if (which === 1) await gate;
                const root = new THREE.Group();
                root.name = `model-${which}`;
                return {
                    stale: false,
                    root,
                    glbBytes: which === 1 ? glb : null,
                    nodeMappings: new Map(),
                    alignment: { x: 0, y: 0, z: 0 },
                    dispose() {},
                };
            },
            dispose() {},
        },
    });
    const scene = { add() {} };
    const first = vehicle.addToScene(scene);
    const second = vehicle.addToScene(scene);
    await second;
    releaseFirst();
    await first;
    assert.equal(vehicle.sceneObject.children.some((child) => child.name === "model-2"), true);
    assert.equal(vehicle.sceneObject.children.some((child) => child.name === "model-1"), false);
    vehicle.dispose();
});

function editorDatabase() {
    return {
        devices: () => ({ addDevice() {} }),
        bindings: () => null,
        getParent() { return null; },
        scene: null,
    };
}

function wheel(id, axle, side, x, steerable) {
    return {
        id,
        ...(axle ? { axle, side } : {}),
        position: { x, y: 0.25, z: side === "right" ? -0.55 : 0.55 },
        radius: 0.25,
        width: 0.15,
        steerable,
    };
}

async function spawn(manifest) {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const { ManifestVehicle } = await import("../app/3d/vehicles/ManifestVehicle.js");
    const database = new VehicleDatabase(editorDatabase());
    const vehicle = new ManifestVehicle(database, manifest, new THREE.Vector3(), new THREE.Euler(), {
        skipManifestDevices: true,
    });
    await vehicle.addToScene({ add() {} });
    return vehicle;
}

function yaw(vehicle, id) {
    return vehicle._wheels.find((wheel) => wheel.wheelId === id).pivot.rotation.y;
}

function settleDisplay(vehicle) {
    for (let step = 0; step < 30; step += 1) vehicle.update(0);
}

test("ideal front yaw does not change the plant step", async () => {
    const { applyManualDrive } = await import("../app/3d/vehicles/VehiclePlantAdapter.js");
    const { createVehiclePlantDefinition, KinematicVehiclePlant } = await import("../app/simulation/vehicles/KinematicVehiclePlant.js");
    const manifest = normalizeVehicleManifest({
        version: 3,
        id: "ideal-yaw",
        wheels: [
            wheel("front-left", "front", "left", 1.3, true),
            wheel("front-right", "front", "right", 1.3, true),
            wheel("rear-left", "rear", "left", -0.2, false),
            wheel("rear-right", "rear", "right", -0.2, false),
        ],
        kinematics: { wheelbase: 1.5, maxSteeringAngle: 0.6 },
    });
    const shifted = normalizeVehicleManifest({
        ...manifest,
        wheels: manifest.wheels.map((entry) => ({
            ...entry,
            position: { ...entry.position, x: entry.position.x + 0.4 },
        })),
        kinematics: { ...manifest.kinematics, wheelbase: 1.5 },
    });
    const vehicle = await spawn(manifest);
    const other = await spawn(shifted);
    applyManualDrive(vehicle, { speedMps: 2, steeringRad: 0.25 });
    applyManualDrive(other, { speedMps: 2, steeringRad: 0.25 });
    const reference = new KinematicVehiclePlant(createVehiclePlantDefinition({}, null, {
        manifest,
        motionModel: "bicycle",
    }));
    reference.velocity.x = 2;
    reference.steeringAngle = 0.25;
    vehicle.update(0.05);
    other.update(0.05);
    reference.update(0.05);
    closeTo(vehicle.position.x, reference.position.x);
    closeTo(vehicle.position.z, reference.position.z);
    closeTo(vehicle.rotation.y, reference.rotation.y);
    closeTo(other.position.x, reference.position.x);
    closeTo(other.position.z, reference.position.z);
    closeTo(other.rotation.y, reference.rotation.y);
    const pose = { x: vehicle.position.x, z: vehicle.position.z, yaw: vehicle.rotation.y };
    settleDisplay(vehicle);
    closeTo(vehicle.position.x, pose.x);
    closeTo(vehicle.position.z, pose.z);
    closeTo(vehicle.rotation.y, pose.yaw);
    const left = yaw(vehicle, "front-left");
    const right = yaw(vehicle, "front-right");
    assert.ok(right > left);
    assert.ok(left > 0);
    assert.equal(yaw(vehicle, "rear-left"), 0);
    vehicle.dispose();
    other.dispose();
});

test("version 2 steerable wheels share one visual yaw", async () => {
    const { applyManualDrive } = await import("../app/3d/vehicles/VehiclePlantAdapter.js");
    const manifest = normalizeVehicleManifest({
        version: 2,
        id: "legacy-yaw",
        wheels: [
            wheel("front-left", null, "left", 0.75, true),
            wheel("front-right", null, "right", 0.75, true),
        ],
        kinematics: { wheelbase: 1.5, maxSteeringAngle: 0.6 },
    });
    const vehicle = await spawn(manifest);
    applyManualDrive(vehicle, { steeringRad: 0.25 });
    settleDisplay(vehicle);
    closeTo(yaw(vehicle, "front-left"), vehicle.displaySteeringAngle);
    closeTo(yaw(vehicle, "front-right"), vehicle.displaySteeringAngle);
    closeTo(vehicle.displaySteeringAngle, 0.25, 1e-3);
    vehicle.dispose();
});

test("a singular Ackermann layout falls back to the shared angle", async () => {
    const { applyManualDrive } = await import("../app/3d/vehicles/VehiclePlantAdapter.js");
    const manifest = normalizeVehicleManifest({
        version: 3,
        id: "singular-yaw",
        wheels: [
            wheel("front-left", "front", "left", 0.75, true),
            wheel("front-right", "front", "right", 0.75, true),
            wheel("rear-left", "rear", "left", -0.75, false),
            wheel("rear-right", "rear", "right", -0.75, false),
        ],
        kinematics: { wheelbase: 1.5, maxSteeringAngle: 1.4 },
    });
    const vehicle = await spawn(manifest);
    applyManualDrive(vehicle, { steeringRad: 1.4 });
    settleDisplay(vehicle);
    closeTo(yaw(vehicle, "front-left"), vehicle.displaySteeringAngle);
    closeTo(yaw(vehicle, "front-right"), vehicle.displaySteeringAngle);
    closeTo(vehicle.displaySteeringAngle, 1.4, 1e-3);
    vehicle.dispose();
});
