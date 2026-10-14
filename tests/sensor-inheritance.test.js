import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPluginPackage } from "../app/plugin/PluginPackage.js";
import {
    buildRevisionedSensorCatalog,
    pluginSensorCatalogEntryForType,
    stampInheritedPluginSelections,
    stampVehiclePluginSensorLock,
} from "../app/plugin/PluginSensorAuthoring.js";
import { PLUGIN_SENSOR_RANGE_IMAGE_CAPABILITY } from "../app/plugin/PluginSensorContract.js";
import {
    computeSimulationSemanticHash,
    simulationSemanticProjection,
} from "../app/simulation/kernel/SimulationHashes.js";
import {
    computeResolvedRunHash,
    createDefaultRunManifest,
    normalizeRunManifest,
} from "../app/simulation/RunManifest.js";
import {
    applySensorInheritance,
    clearSensorInheritanceMarkers,
    detachSensorInheritance,
    enableSensorInheritance,
    isInheritedSensorFieldLocked,
    resetSensorsToParentVehicle,
    resolveInheritedVehicleSelection,
} from "../app/simulation/sensors/SensorInheritance.js";
import { createSensorDefinitionRegistry } from "../app/simulation/sensors/SensorTypeRegistry.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";
import { createDefaultVehicleManifest, normalizeVehicleManifest } from "../app/vehicles/VehicleManifest.js";
import { StorageService } from "../server/storage/StorageService.js";
import { pluginSensorFixtureResource } from "./helpers/headlessRunnerBundle.js";

const FIXTURE_TYPE = "test.range-image-fixture.synthetic-3x4";

async function temporaryService() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-sensor-inheritance-"));
    return { dir, service: new StorageService(dir) };
}

test("inheritance off is a no-op and normalization drops inactive markers", () => {
    const manifest = createDefaultRunManifest();
    const applied = applySensorInheritance(manifest, {
        vehicleManifest: getBuiltInVehicleManifest("big-car"),
    });
    assert.equal(applied.manifest, manifest);
    assert.deepEqual(applied.issues, []);
    assert.equal(Object.hasOwn(manifest.sensorRig, "inheritance"), false);

    const dropped = normalizeRunManifest({
        ...manifest,
        sensorRig: {
            ...manifest.sensorRig,
            inheritance: { mode: "manual" },
            sensors: manifest.sensorRig.sensors.map((sensor, index) => (
                index === 0 ? { ...sensor, inheritedFrom: "nope" } : sensor
            )),
        },
    });
    assert.equal(dropped.sensorRig.inheritance, undefined);
    assert.equal(dropped.sensorRig.sensors[0].inheritedFrom, undefined);
    assert.equal(dropped.version, 11);

    const kept = normalizeRunManifest({
        ...manifest,
        sensorRig: {
            ...manifest.sensorRig,
            inheritance: { mode: "vehicle" },
            sensors: manifest.sensorRig.sensors.map((sensor, index) => (
                index === 0 ? { ...sensor, inheritedFrom: sensor.id } : sensor
            )),
        },
    });
    assert.deepEqual(kept.sensorRig.inheritance, { mode: "vehicle" });
    assert.equal(kept.sensorRig.sensors[0].inheritedFrom, "front-camera");
});

test("Big Car mounts project to REP-103 and preserve run overrides", () => {
    const vehicle = getBuiltInVehicleManifest("big-car");
    const enabled = enableSensorInheritance(createDefaultRunManifest(), vehicle);
    assert.deepEqual(enabled.issues, []);
    const ids = enabled.manifest.sensorRig.sensors.map((sensor) => sensor.id);
    assert.deepEqual(ids.slice(0, 2), ["roof-lidar", "front-stereo-camera"]);
    assert.ok(ids.includes("front-camera"));
    assert.ok(ids.includes("imu"));

    const lidar = enabled.manifest.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar");
    const camera = enabled.manifest.sensorRig.sensors.find((sensor) => sensor.id === "front-stereo-camera");
    assert.equal(lidar.inheritedFrom, "roof-lidar");
    assert.deepEqual(lidar.pose.position, { x: 0.35, y: 0, z: 0.8 });
    assert.equal(lidar.calibration.range, 20);
    assert.equal(lidar.calibration.azimuth.stepDeg, 2);
    assert.deepEqual(lidar.pose.rotation, { x: 0, y: 0, z: 0, order: "XYZ" });
    assert.equal(camera.calibration.width, 320);
    assert.equal(camera.calibration.height, 180);
    assert.equal(camera.calibration.verticalFovDeg, 75);
    assert.deepEqual(camera.pose.position, { x: 1.5, y: 0, z: 0.5 });
    assert.equal(camera.calibration.range, undefined);
    assert.equal(enabled.manifest.sensorRig.sensors.find((sensor) => sensor.id === "front-camera").pose.position.x, 1.5);

    const edited = structuredClone(enabled.manifest);
    const editedLidar = edited.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar");
    editedLidar.rateHz = 7;
    editedLidar.noise.model = "gaussian";
    editedLidar.noise.standardDeviation = 0.2;
    editedLidar.outputs.pointCloudTopicId = "custom-cloud";
    const moved = structuredClone(vehicle);
    moved.sensors[0].pose.position.y = 1.2;
    const again = applySensorInheritance(normalizeRunManifest(edited), { vehicleManifest: moved });
    const next = again.manifest.sensorRig.sensors.find((sensor) => sensor.inheritedFrom === "roof-lidar");
    assert.equal(next.rateHz, 7);
    assert.equal(next.noise.model, "gaussian");
    assert.equal(next.noise.standardDeviation, 0.2);
    assert.equal(next.outputs.pointCloudTopicId, "custom-cloud");
    assert.equal(next.pose.position.z, 1.2);
    assert.equal(next.calibration.range, 20);
    assert.equal(isInheritedSensorFieldLocked(next, ["pose", "position", "z"]), true);
    assert.equal(isInheritedSensorFieldLocked(next, ["rateHz"]), false);
    assert.equal(isInheritedSensorFieldLocked(next, ["calibration", "range"]), true);

    const detached = detachSensorInheritance(again.manifest, { vehicleManifest: moved });
    assert.equal(detached.manifest.sensorRig.inheritance, undefined);
    assert.ok(detached.manifest.sensorRig.sensors.every((sensor) => sensor.inheritedFrom === undefined));
    const detachedLidar = detached.manifest.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar");
    assert.equal(detachedLidar.rateHz, 7);
    assert.equal(detachedLidar.pose.position.z, 1.2);
});

test("reset to parent vehicle drops extras and run overrides", () => {
    const vehicle = getBuiltInVehicleManifest("big-car");
    const enabled = enableSensorInheritance(createDefaultRunManifest(), vehicle);
    const edited = structuredClone(enabled.manifest);
    const lidar = edited.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar");
    lidar.rateHz = 7;
    lidar.noise.model = "gaussian";
    lidar.noise.standardDeviation = 0.2;
    lidar.outputs.pointCloudTopicId = "custom-cloud";

    const reset = resetSensorsToParentVehicle(edited, vehicle);
    assert.deepEqual(reset.issues, []);
    assert.equal(reset.manifest.sensorRig.inheritance.mode, "vehicle");
    assert.equal(reset.manifest.sensorRig.vehicleId, edited.sensorRig.vehicleId);
    assert.deepEqual(reset.manifest.sensorRig.syncGroups, edited.sensorRig.syncGroups);
    assert.deepEqual(
        reset.manifest.sensorRig.sensors.map((sensor) => sensor.id),
        vehicle.sensors.map((sensor) => sensor.id),
    );
    const next = reset.manifest.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar");
    assert.equal(next.inheritedFrom, "roof-lidar");
    assert.equal(next.rateHz, 10);
    assert.equal(next.noise.model, "none");
    assert.equal(next.noise.standardDeviation, 0);
    assert.equal(next.outputs.pointCloudTopicId, undefined);
    assert.deepEqual(next.pose.position, { x: 0.35, y: 0, z: 0.8 });
    assert.equal(next.calibration.range, 20);
    const camera = reset.manifest.sensorRig.sensors.find((sensor) => sensor.id === "front-stereo-camera");
    assert.equal(camera.calibration.width, 320);
    assert.equal(camera.calibration.verticalFovDeg, 75);
    assert.equal(camera.inheritedFrom, "front-stereo-camera");

    const missing = resetSensorsToParentVehicle(edited, null);
    assert.equal(missing.manifest, edited);
    assert.match(missing.issues[0].message, /big-car/);
    assert.equal(edited.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar").rateHz, 7);
    assert.ok(edited.sensorRig.sensors.some((sensor) => sensor.id === "front-camera"));

    const off = resetSensorsToParentVehicle(createDefaultRunManifest(), vehicle);
    assert.equal(off.manifest.sensorRig.inheritance, undefined);
    assert.match(off.issues[0].message, /inheritance/);
    assert.ok(off.manifest.sensorRig.sensors.some((sensor) => sensor.id === "front-camera"));
});

test("a removed vehicle mount is reported and an empty vehicle adds nothing", () => {
    const vehicle = getBuiltInVehicleManifest("big-car");
    const enabled = enableSensorInheritance(createDefaultRunManifest(), vehicle);
    const removed = structuredClone(vehicle);
    removed.sensors = removed.sensors.filter((sensor) => sensor.id !== "roof-lidar");
    const applied = applySensorInheritance(enabled.manifest, { vehicleManifest: removed });
    assert.ok(applied.issues.some((issue) => issue.message.includes("roof-lidar")));
    assert.ok(applied.manifest.sensorRig.sensors.some((sensor) => sensor.inheritedFrom === "roof-lidar"));

    const empty = enableSensorInheritance(
        createDefaultRunManifest({ initialState: { vehicles: [{ id: "ego", type: "scenario-car" }] } }),
        getBuiltInVehicleManifest("scenario-car"),
    );
    assert.deepEqual(empty.issues, []);
    assert.deepEqual(
        empty.manifest.sensorRig.sensors.map((sensor) => sensor.id),
        createDefaultRunManifest().sensorRig.sensors.map((sensor) => sensor.id),
    );
    assert.equal(empty.manifest.sensorRig.inheritance.mode, "vehicle");
});

test("scenario ego selects the inherited vehicle and localization fields stay split", () => {
    const manifest = createDefaultRunManifest({
        scenario: { id: "loop", egoVehicleId: "igvc-car" },
        initialState: { vehicles: [{ id: "ego", type: "big-car" }] },
    });
    assert.deepEqual(resolveInheritedVehicleSelection(manifest), { actorId: "ego", vehicleId: "igvc-car" });
    assert.equal(
        resolveInheritedVehicleSelection(createDefaultRunManifest()).vehicleId,
        "big-car",
    );

    const vehicle = createDefaultVehicleManifest({
        id: "loc-car",
        sensors: [
            { id: "imu-roof", type: "imu", pose: { position: { x: 0, y: 0.4, z: 0 } }, config: { gravity: 1.62 } },
            { id: "gnss-roof", type: "gnss", pose: { position: { x: 0, y: 0.5, z: 0.1 } }, config: { datum: { latitude: 1, longitude: 2 } } },
            { id: "wheels", type: "wheel-odometry", pose: {}, config: { wheelRadius: 0.3, trackWidth: 1.4 } },
        ],
    });
    const enabled = enableSensorInheritance(createDefaultRunManifest({
        initialState: { vehicles: [{ id: "ego", type: "loc-car" }] },
    }), vehicle);
    const imu = enabled.manifest.sensorRig.sensors.find((sensor) => sensor.id === "imu-roof");
    imu.calibration.angularVelocitySaturation = 10;
    imu.noise.model = "gaussian";
    const again = applySensorInheritance(enabled.manifest, { vehicleManifest: vehicle });
    const nextImu = again.manifest.sensorRig.sensors.find((sensor) => sensor.id === "imu-roof");
    assert.equal(nextImu.calibration.gravity, 1.62);
    assert.equal(nextImu.calibration.angularVelocitySaturation, 10);
    assert.equal(nextImu.noise.model, "gaussian");
    const gnss = again.manifest.sensorRig.sensors.find((sensor) => sensor.id === "gnss-roof");
    assert.equal(gnss.calibration.datum.latitude, 1);
    assert.equal(gnss.calibration.datum.longitude, 2);
    assert.equal(gnss.calibration.datum.altitude, 200);
    assert.equal(gnss.pose.position.y, -0.1);
    assert.equal(gnss.pose.position.z, 0.5);
    const wheel = again.manifest.sensorRig.sensors.find((sensor) => sensor.id === "wheels");
    assert.equal(wheel.calibration.wheelRadius, 0.3);
    assert.equal(wheel.calibration.trackWidth, 1.4);
    assert.equal(wheel.calibration.ticksPerRevolution, 1024);
    assert.equal(isInheritedSensorFieldLocked(wheel, ["calibration", "ticksPerRevolution"]), false);
    assert.equal(isInheritedSensorFieldLocked(gnss, ["calibration", "datum", "altitude"]), false);
});

test("inheritance markers are not part of simulation identity", () => {
    const first = {
        kind: "cev-sim.run-manifest",
        version: 11,
        identityProfile: { id: "world-bound", version: 2 },
        world: { hash: "a".repeat(64) },
        manifest: createDefaultRunManifest(),
        environment: { hash: "environment", manifest: { environmentId: "igvc" } },
        scripts: [],
        bindings: { hash: "bindings", entries: [] },
        vehicles: [],
        dependencyHashes: {},
        resolvedHash: "f".repeat(64),
    };
    const second = structuredClone(first);
    second.manifest.sensorRig.inheritance = { mode: "vehicle" };
    second.manifest.sensorRig.sensors = second.manifest.sensorRig.sensors.map((sensor) => ({
        ...sensor,
        inheritedFrom: sensor.id,
    }));
    assert.equal(computeSimulationSemanticHash(first), computeSimulationSemanticHash(second));
    const projected = simulationSemanticProjection(second).resolved.manifest.sensorRig;
    assert.equal(projected.inheritance, undefined);
    assert.equal(projected.sensors[0].inheritedFrom, undefined);
    second.manifest.sensorRig.sensors[0].pose.position.x += 1;
    assert.notEqual(computeSimulationSemanticHash(first), computeSimulationSemanticHash(second));
    assert.equal(clearSensorInheritanceMarkers(second.manifest).sensorRig.inheritance, undefined);
});

test("resolve overlays inherited mounts and leaves inheritance-off runs unchanged", async () => {
    const { dir, service } = await temporaryService();
    try {
        await service.listRunManifests();
        const baseline = await service.resolveRunManifest("igvc-default");
        assert.deepEqual(
            baseline.manifest.sensorRig.sensors.map((sensor) => sensor.id),
            createDefaultRunManifest().sensorRig.sensors.map((sensor) => sensor.id),
        );
        assert.equal(baseline.manifest.sensorRig.inheritance, undefined);
        assert.equal(baseline.manifest.sensorRig.sensors[0].inheritedFrom, undefined);
        assert.deepEqual(
            baseline.manifest.sensorRig.sensors[0].pose.position,
            createDefaultRunManifest().sensorRig.sensors[0].pose.position,
        );

        const other = await temporaryService();
        try {
            await other.service.listRunManifests();
            const again = await other.service.resolveRunManifest("igvc-default");
            assert.equal(again.simulationSemanticHash, baseline.simulationSemanticHash);
            assert.equal(again.definitionHash, baseline.definitionHash);
        } finally {
            await fs.rm(other.dir, { recursive: true, force: true });
        }

        const vehicle = createDefaultVehicleManifest({
            id: "inherit-car",
            name: "Inherit Car",
            sensors: [{
                id: "roof-lidar",
                type: "lidar3d",
                pose: { position: { x: 0.2, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
                config: { range: 30 },
            }],
        });
        const createdVehicle = await service.createVehicleManifest(vehicle);
        const enabled = enableSensorInheritance(createDefaultRunManifest({
            id: "inherit-run",
            name: "Inherit Run",
            initialState: { vehicles: [{ id: "ego", type: "inherit-car" }] },
        }), vehicle);
        assert.deepEqual(enabled.issues, []);
        await service.createRunManifest(enabled.manifest);
        const first = await service.resolveRunManifest("inherit-run");
        const lidar = first.manifest.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar");
        assert.equal(lidar.pose.position.x, 0.2);
        assert.equal(lidar.pose.position.y, 0);
        assert.equal(lidar.pose.position.z, 1);
        assert.equal(lidar.calibration.range, 30);
        assert.equal(lidar.inheritedFrom, undefined);
        assert.equal(first.manifest.sensorRig.inheritance, undefined);
        assert.ok(first.manifest.sensorRig.sensors.some((sensor) => sensor.id === "front-camera"));
        const front = first.manifest.sensorRig.sensors.find((sensor) => sensor.id === "front-camera");
        assert.equal(front.pose.position.x, createDefaultRunManifest().sensorRig.sensors[0].pose.position.x);

        const stored = await service.getRunManifest("inherit-run");
        assert.equal(first.definitionHash, computeResolvedRunHash(normalizeRunManifest(stored)));
        const moved = structuredClone(await service.getVehicleManifest("inherit-car"));
        moved.sensors[0].pose.position.y = 2;
        moved.sensors[0].config.range = 40;
        await service.putVehicleManifest("inherit-car", {
            manifest: moved,
            expectedRevision: createdVehicle.revision,
        });
        const second = await service.resolveRunManifest("inherit-run");
        const movedLidar = second.manifest.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar");
        assert.equal(movedLidar.pose.position.z, 2);
        assert.equal(movedLidar.calibration.range, 40);
        assert.equal(second.definitionHash, first.definitionHash);
        assert.notEqual(second.simulationSemanticHash, first.simulationSemanticHash);

        const stripped = structuredClone(moved);
        stripped.sensors = [];
        await service.putVehicleManifest("inherit-car", {
            manifest: stripped,
            expectedRevision: (await service.getVehicleManifest("inherit-car")).revision,
        });
        await assert.rejects(service.resolveRunManifest("inherit-run"), /roof-lidar/);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("plugin mounts lock scan settings, keep run noise, and stamp the run grant", async () => {
    const resource = await pluginSensorFixtureResource();
    const verified = verifyPluginPackage(resource);
    const registry = createSensorDefinitionRegistry([verified]);
    const catalog = buildRevisionedSensorCatalog({
        library: {
            revision: 1,
            packages: [{
                pluginId: verified.document.id,
                version: verified.document.version,
                packageHash: verified.resource.packageHash,
                runtimeHash: verified.resource.runtimeHash,
            }],
        },
        documents: [{ document: verified.document, resource: verified.resource }],
    });
    const entry = pluginSensorCatalogEntryForType(catalog, FIXTURE_TYPE);
    const normalizedVehicle = normalizeVehicleManifest({
        ...createDefaultVehicleManifest({ id: "plugin-truck", sensors: [] }),
        sensors: [{
            id: "custom",
            type: FIXTURE_TYPE,
            pose: { position: { x: 1, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
            config: { rateHz: 12, products: { points: true } },
        }],
        pluginLocks: stampVehiclePluginSensorLock(undefined, entry),
    }, { sensorRegistry: registry });
    const enabled = enableSensorInheritance(createDefaultRunManifest({
        id: "plugin-run",
        initialState: { vehicles: [{ id: "ego", type: "plugin-truck" }] },
    }), normalizedVehicle, { registry });
    assert.deepEqual(enabled.issues, []);
    const custom = enabled.manifest.sensorRig.sensors.find((sensor) => sensor.id === "custom");
    assert.equal(custom.inheritedFrom, "custom");
    assert.equal(custom.rateHz, 12);
    assert.equal(custom.calibration.products.points, true);
    assert.equal(custom.pose.position.z, 2);
    assert.ok(custom.calibration.scanLayout);
    custom.noise.model = "gaussian";
    custom.outputs.pointCloudTopicId = "custom-points";
    const relayout = structuredClone(normalizedVehicle);
    relayout.sensors[0].config.rateHz = 15;
    const again = applySensorInheritance(enabled.manifest, { vehicleManifest: relayout, registry });
    const next = again.manifest.sensorRig.sensors.find((sensor) => sensor.id === "custom");
    assert.equal(next.rateHz, 15);
    assert.equal(next.noise.model, "gaussian");
    assert.equal(next.outputs.pointCloudTopicId, "custom-points");
    assert.equal(isInheritedSensorFieldLocked(next, ["rateHz"], registry.get(FIXTURE_TYPE)), true);
    assert.equal(isInheritedSensorFieldLocked(next, ["outputs", "pointCloudTopicId"], registry.get(FIXTURE_TYPE)), false);
    assert.equal(isInheritedSensorFieldLocked(next, ["calibration", "scanLayout"], registry.get(FIXTURE_TYPE)), true);

    const stamped = stampInheritedPluginSelections(again.manifest, catalog, registry);
    assert.deepEqual(stamped.issues, []);
    assert.equal(stamped.manifest.plugins.enabled, true);
    assert.equal(stamped.manifest.plugins.artifacts[0].pluginId, entry.ownership.pluginId);
    assert.equal(stamped.manifest.plugins.artifacts[0].expectedHash, entry.ownership.packageHash);
    assert.ok(stamped.manifest.plugins.artifacts[0].capabilities.includes(PLUGIN_SENSOR_RANGE_IMAGE_CAPABILITY));

    const missing = stampInheritedPluginSelections(again.manifest, { sensors: [] }, registry);
    assert.ok(missing.issues.some((issue) => issue.message.includes(FIXTURE_TYPE)));
});
