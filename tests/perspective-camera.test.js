import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";

import { Settings } from "../app/3d/data/Settings.js";
import { ManifestCamera } from "../app/3d/devices/ManifestCamera.js";
import { selectVehicleCamera } from "../app/3d/camera/selectVehicleCamera.js";
import { copyVehicleCameraToView } from "../app/3d/camera/copyVehicleCameraToView.js";
import { PerspectiveViewController } from "../app/3d/camera/PerspectiveViewController.js";
import { AutonomyOverlay } from "../app/3d/overlay/AutonomyOverlay.js";

function manifestCamera(id) {
    const device = new ManifestCamera({
        id,
        type: "camera",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: {} },
        calibration: { products: {} },
    });
    device.sensorCamera = new THREE.PerspectiveCamera(48, 16 / 9, 0.2, 80);
    device.settings.position.set(1.5, 0.5, 0);
    device.settings.rotation.set(0, 0, 0);
    return device;
}

function mountOn(device, group) {
    device.parentVehicle = {
        sceneObject: group,
        position: group.position,
        rotation: group.rotation,
    };
    group.updateMatrixWorld(true);
}

function lookDirection(camera) {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
}

test("selectVehicleCamera prefers the target vehicle and skips disabled cameras", () => {
    const ego = manifestCamera("ego-cam");
    const disabled = manifestCamera("disabled-cam");
    disabled.enabled = false;
    const other = manifestCamera("other-cam");
    const data = {
        vehicles: () => ({
            vehicles: [
                { telemetryId: "traffic", devices: [other, { enabled: true, name: "lidar" }] },
                { telemetryId: "ego", devices: [disabled, { enabled: true, name: "lidar" }, ego] },
            ],
        }),
        simulation: () => ({ resolvedRun: null }),
    };

    assert.equal(selectVehicleCamera(data).device, ego);
    data.simulation = () => ({
        resolvedRun: { manifest: { controls: { targetVehicleId: "traffic" } } },
    });
    assert.equal(selectVehicleCamera(data).device, other);

    data.vehicles = () => ({
        vehicles: [{ telemetryId: "ego", devices: [{ enabled: true, name: "lidar" }] }],
    });
    assert.equal(selectVehicleCamera(data), null);
});

test("copyVehicleCameraToView matches a manifest camera pose without changing aspect", () => {
    const device = manifestCamera("front");
    const body = new THREE.Group();
    body.position.set(4, 1, -2);
    body.rotation.set(0, 0.4, 0);
    mountOn(device, body);

    const view = new THREE.PerspectiveCamera(75, 2.35, 0.1, 1000);
    view.position.set(0, 10, 10);
    const copied = copyVehicleCameraToView(view, device);

    device._applyPose();
    const expectedPosition = device.sensorCamera.getWorldPosition(new THREE.Vector3());
    const expectedQuaternion = device.sensorCamera.getWorldQuaternion(new THREE.Quaternion());
    assert.equal(copied, true);
    assert.ok(view.position.distanceTo(expectedPosition) < 1e-5);
    assert.ok(view.quaternion.angleTo(expectedQuaternion) < 1e-5);
    assert.equal(view.fov, 48);
    assert.equal(view.near, 0.2);
    assert.equal(view.far, 80);
    assert.equal(view.aspect, 2.35);
});

test("copyVehicleCameraToView aims a stereo camera along mount forward", () => {
    const position = new THREE.Vector3(1.5, 0.5, 0);
    const rotation = new THREE.Euler(0, 0, 0);
    const device = {
        name: "Front Stereo Camera",
        enabled: true,
        tags: ["distance", "pointcloud", "camera"],
        cameraSettings: { width: 320, height: 180, fov: 75, near: 0.1, far: 200 },
        getPosition: () => position.clone(),
        getRotation: () => rotation.clone(),
    };

    const view = new THREE.PerspectiveCamera(60, 1.6, 1, 50);
    assert.equal(copyVehicleCameraToView(view, device), true);

    const forward = lookDirection(view);
    assert.ok(forward.dot(new THREE.Vector3(1, 0, 0)) > 0.99);
    assert.ok(Math.abs(forward.z) < 1e-5);
    assert.ok(view.position.distanceTo(new THREE.Vector3(1.5, 0.5, 0)) < 1e-5);
    assert.equal(view.fov, 75);
    assert.equal(view.aspect, 1.6);
});

function harness(devices) {
    const settings = new Settings();
    const camera = new THREE.PerspectiveCamera(75, 2.5, 0.1, 1000);
    camera.position.set(0, 10, 10);
    camera.lookAt(0, 0, 0);
    const controls = {
        enabled: true,
        target: new THREE.Vector3(0, 0, 0),
        update() { this.updated = true; },
    };
    const body = new THREE.Group();
    for (const device of devices) mountOn(device, body);
    const ego = {
        telemetryId: "ego",
        devices,
        controlsEnabled: true,
        path: { visible: true },
    };
    const overlay = {
        hidden: false,
        setPredictedPathHidden(hidden) { this.hidden = hidden; },
    };
    const data = {
        camera,
        renderer: { domElement: { clientWidth: 800, clientHeight: 400 } },
        settings: () => settings,
        vehicles: () => ({ vehicles: [ego] }),
        simulation: () => ({ resolvedRun: null, controls, autonomyOverlay: overlay }),
    };
    const controller = new PerspectiveViewController({
        data,
        getCamera: () => camera,
        getControls: () => controls,
        getRenderer: () => data.renderer,
    });
    return { settings, camera, controls, body, data, controller, ego, overlay };
}

test("perspective enter locks to the vehicle camera and exit restores orbit", () => {
    const device = manifestCamera("front");
    const { settings, camera, controls, body, controller, ego, overlay } = harness([device]);
    const savedPosition = camera.position.clone();
    const savedTarget = controls.target.clone();

    const entered = controller.enter();
    assert.equal(entered.active, true);
    assert.equal(entered.locked, true);
    assert.equal(entered.label, "Manifest Camera");
    assert.equal(settings.cameraControlsEnabled, false);
    assert.equal(controls.enabled, false);
    assert.equal(camera.fov, 48);
    assert.equal(ego.path.visible, false);
    assert.equal(overlay.hidden, true);
    assert.ok(camera.position.distanceTo(savedPosition) > 1);

    const tracked = camera.position.clone();
    body.position.set(12, 3, -6);
    body.updateMatrixWorld(true);
    controller.applyFrame(camera, controls);
    assert.ok(camera.position.distanceTo(tracked) > 1);
    assert.equal(controls.enabled, false);

    controls.target.set(8, 8, 8);
    camera.aspect = 1;
    const exited = controller.exit();
    assert.equal(exited.active, false);
    assert.equal(exited.locked, false);
    assert.equal(settings.cameraControlsEnabled, true);
    assert.equal(controls.enabled, true);
    assert.equal(controls.updated, true);
    assert.equal(camera.fov, 75);
    assert.equal(camera.aspect, 2);
    assert.ok(camera.position.distanceTo(savedPosition) < 1e-5);
    assert.ok(controls.target.distanceTo(savedTarget) < 1e-5);
    assert.equal(ego.path.visible, true);
    assert.equal(overlay.hidden, false);
});

test("perspective without a vehicle camera hides chrome state but leaves orbit", () => {
    const { settings, camera, controls, controller, ego, overlay } = harness([{ enabled: true, name: "lidar" }]);
    const savedPosition = camera.position.clone();

    const entered = controller.enter();
    assert.equal(entered.active, true);
    assert.equal(entered.locked, false);
    assert.equal(entered.label, "No vehicle camera");
    assert.equal(ego.path.visible, true);
    assert.equal(overlay.hidden, false);
    assert.equal(settings.cameraControlsEnabled, true);
    assert.equal(controls.enabled, true);
    controller.applyFrame(camera, controls);
    assert.ok(camera.position.distanceTo(savedPosition) < 1e-8);
    assert.equal(camera.fov, 75);

    controller.exit();
    assert.equal(controller.getSnapshot().active, false);
    assert.equal(settings.cameraControlsEnabled, true);
});

test("perspective releases orbit when the vehicle camera disappears", () => {
    const device = manifestCamera("front");
    const { settings, camera, controls, data, controller, ego, overlay } = harness([device]);
    controller.enter();
    assert.equal(settings.cameraControlsEnabled, false);
    assert.equal(ego.path.visible, false);
    assert.equal(overlay.hidden, true);

    data.vehicles = () => ({ vehicles: [ego] });
    ego.devices = [];
    controller.applyFrame(camera, controls);
    assert.equal(ego.path.visible, true);
    assert.equal(overlay.hidden, false);

    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.active, true);
    assert.equal(snapshot.locked, false);
    assert.equal(snapshot.label, "No vehicle camera");
    assert.equal(settings.cameraControlsEnabled, true);
    assert.equal(controls.enabled, true);
});

test("steering prediction ribbons stay hidden while perspective is locked", () => {
    const overlay = new AutonomyOverlay();
    const ribbons = overlay.group.children[3];
    overlay.setPredictedPathHidden(true);
    overlay.updateFromSnapshot({
        controls: {
            wheelbase: 1.5,
            applied: { steeringRad: 0.2, speedMps: 1 },
            achieved: { steeringRad: 0.1, speedMps: 1 },
        },
        vehiclePose: { position: { x: 0, y: 0, z: 0 }, yaw: 0, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
    });
    overlay.setLayers({ controls: true });
    assert.equal(ribbons.visible, false);
    assert.equal(ribbons.children.some((child) => child.isMesh && child.visible), false);

    overlay.setPredictedPathHidden(false);
    overlay.updateFromSnapshot({
        controls: {
            applyTimeNs: 1,
            wheelbase: 1.5,
            applied: { steeringRad: 0.2, speedMps: 1 },
            achieved: { steeringRad: 0.1, speedMps: 1 },
        },
        vehiclePose: { position: { x: 0, y: 0, z: 0 }, yaw: 0, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
    });
    assert.equal(ribbons.visible, true);
    assert.equal(ribbons.children.some((child) => child.isMesh && child.visible), true);
});
