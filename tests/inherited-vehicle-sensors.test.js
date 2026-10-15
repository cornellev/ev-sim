import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";

register(new URL("./helpers/resolve-app-modules.js", import.meta.url));

function entry() {
    return {
        id: "ego",
        type: "big-car",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
    };
}

function dependency(manifest) {
    return {
        actorId: "ego",
        vehicleId: "big-car",
        hash: "vehicle-hash",
        manifest,
    };
}

async function database() {
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    return new VehicleDatabase({
        devices: () => ({ addDevice() {} }),
        bindings: () => null,
        scene: null,
    });
}

test("inherited vehicle spawn does not clone vehicle-owned sensors", async () => {
    const manifest = getBuiltInVehicleManifest("big-car");
    const vehicles = await database();
    await vehicles.configureFromManifest([entry()], null, {
        skipManifestDevices: true,
        resolvedVehicles: [dependency(manifest)],
    });
    const vehicle = vehicles.vehicles.find((candidate) => candidate.telemetryId === "ego");
    assert.ok(vehicle);
    assert.equal(vehicle.devices.filter((device) => device.vehicleOwned).length, 0);

    const again = await database();
    await again.configureFromManifest([entry()], null, {
        resolvedVehicles: [dependency(manifest)],
    });
    const mounted = again.vehicles.find((candidate) => candidate.telemetryId === "ego");
    assert.ok(mounted.devices.some((device) => device.vehicleOwned));
    const ids = mounted.devices.filter((device) => device.vehicleOwned).map((device) => device.telemetryId || device.name);
    await again.configureFromManifest([entry()], null, {
        skipManifestDevices: true,
        resolvedVehicles: [dependency(manifest)],
    });
    assert.equal(mounted.devices.filter((device) => device.vehicleOwned).length, 0);
    assert.ok(ids.length > 0);
});

test("resolved rig without inheritance markers does not spawn disabled twins", async () => {
    const { SimulationKernel } = await import("../app/simulation/kernel/SimulationKernel.js");
    const { createSimulationRuntimeContext } = await import("../app/simulation/kernel/SimulationRuntimeContext.js");
    const { SignalStore } = await import("../app/scripting/runtime/SignalStore.js");
    const { VehicleDatabase } = await import("../app/3d/data/VehicleDatabase.js");
    const { DeviceDatabase } = await import("../app/3d/data/DeviceDatabase.js");
    const vehicleOptions = [];
    const telemetry = new SignalStore({}, { sourceId: "inherited-sensors" });
    const scripts = {
        signalStore: telemetry,
        setTopicScheduler() {},
        setTopicRouter() {},
        async setManifest() {},
        async prepareResolvedScripts() {},
        update() {},
    };
    const context = createSimulationRuntimeContext({
        telemetry,
        inputs: { update() {} },
        scripts,
        vehicles: {
            vehicles: [],
            async configureFromManifest(_entries, _scene, options) {
                vehicleOptions.push(options);
            },
            update() {},
        },
        devices: { devices: [], configureFromManifest() {}, resetSchedule() {}, update() {}, deliver() {} },
        physics: {
            async configureRun() {},
            resetRun() {},
            beginStep() {},
            step() {},
            syncAndPublishContacts() { return { started: [], active: [], ended: [] }; },
        },
        scenarios: {
            active: false,
            configure() {},
            reset() {},
            getSnapshot() { return null; },
            preMotion() { return null; },
            postTelemetry() { return null; },
            applyExternalTopic() { return false; },
            observeAssertions() { return null; },
            dispose() {},
        },
    });
    const manifest = createDefaultRunManifest({
        sensorRig: {
            sensors: [
                { id: "car-imu", type: "imu", enabled: true, parentId: "ego" },
                { id: "gnss", type: "gnss", enabled: true, parentId: "ego" },
                { id: "wheel-odo", type: "wheel-odometry", enabled: true, parentId: "ego" },
                { id: "camera", type: "camera", enabled: true, parentId: "ego" },
            ],
        },
        assertions: [],
    });
    delete manifest.sensorRig.inheritance;
    const kernel = new SimulationKernel(context);
    await kernel.prepare({
        manifest,
        definitionHash: "a".repeat(64),
        resolvedHash: "b".repeat(64),
        environment: { manifest: { environmentId: manifest.environment.id } },
        bindings: { entries: [] },
        scripts: [],
        vehicles: [],
    });
    assert.equal(manifest.sensorRig.inheritance, undefined);
    assert.equal(vehicleOptions[0]?.skipManifestDevices, true);

    const parent = { scene: null, bindings: () => null };
    const vehicles = new VehicleDatabase(parent);
    const devices = new DeviceDatabase(parent);
    parent.vehicles = () => vehicles;
    parent.devices = () => devices;
    await vehicles.configureFromManifest([entry()], null, {
        ...vehicleOptions[0],
        resolvedVehicles: [dependency(getBuiltInVehicleManifest("big-car"))],
    });
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } };
    devices.configureFromManifest({
        sensors: ["car-imu", "gnss", "wheel-odo", "camera"].map((id) => ({
            id,
            type: id === "wheel-odo" ? "wheel-odometry" : id === "car-imu" ? "imu" : id,
            enabled: true,
            parentId: "ego",
            pose,
            calibration: { products: {} },
        })),
    });
    const vehicle = vehicles.vehicles.find((candidate) => candidate.telemetryId === "ego");
    assert.equal(vehicle.devices.filter((device) => device.vehicleOwned).length, 0);
    assert.deepEqual(vehicle.devices.map((device) => device.name).sort(), ["camera", "car-imu", "gnss", "wheel-odo"]);
    assert.ok(vehicle.devices.every((device) => device.enabled !== false));
    kernel.dispose();
});

test("run sensor devices use the sensor id as their name", async () => {
    const { ManifestCamera } = await import("../app/3d/devices/ManifestCamera.js");
    const { ManifestImu } = await import("../app/3d/devices/ManifestImu.js");
    const { ManifestGnss } = await import("../app/3d/devices/ManifestGnss.js");
    const { ManifestWheelOdometry } = await import("../app/3d/devices/ManifestWheelOdometry.js");
    const { ManifestLidar3d } = await import("../app/3d/devices/ManifestLidar3d.js");
    const pose = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } };
    const calibration = {
        range: 10,
        azimuth: { startDeg: 0, endDeg: 360, stepDeg: 1 },
        elevation: { startDeg: -15, endDeg: 15, stepDeg: 1 },
        products: {},
    };
    assert.equal(new ManifestCamera({ id: "camera", pose, calibration }).name, "camera");
    assert.equal(new ManifestImu({ id: "car-imu", pose, calibration }).name, "car-imu");
    assert.equal(new ManifestGnss({ id: "gnss", pose, calibration }).name, "gnss");
    assert.equal(new ManifestWheelOdometry({ id: "wheel-odo", pose, calibration }).name, "wheel-odo");
    assert.equal(new ManifestLidar3d({ id: "roof-lidar", pose, calibration }).name, "roof-lidar");
    for (const device of [
        new ManifestImu({ id: "car-imu", pose, calibration }),
        new ManifestGnss({ id: "gnss", pose, calibration }),
        new ManifestWheelOdometry({ id: "wheel-odo", pose, calibration }),
    ]) {
        assert.equal(typeof device.onParentUpdate, "function");
    }

    const { PluginSensorDevice } = await import("../app/simulation/sensors/PluginSensorAdapter.js");
    const helios = new PluginSensorDevice({
        sensor: { id: "helios", type: "vendor.robosense.helios32.lidar", calibration: {} },
        products: [],
    }, {
        factory: {
            pluginId: "helios",
            packageHash: "hash",
            type: "vendor.robosense.helios32.lidar",
            create() {
                return {
                    prepare() {},
                    reset() {},
                    captureAt() {},
                    getDeterministicState() { return null; },
                    hydrateDeterministicState() {},
                    finalize() {},
                    dispose() {},
                };
            },
        },
        Publisher: class { constructor() {} },
    });
    assert.equal(helios.name, "helios");
    assert.equal(typeof helios.onParentUpdate, "function");
});
