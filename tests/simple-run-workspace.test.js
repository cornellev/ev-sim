import assert from "node:assert/strict";
import test from "node:test";

import { applyScenarioSelectionToManifest } from "../app/config/ConfigCatalogLoader.js";
import {
    applySimpleVehicleSelection,
    longitudinalSpeed,
    pluginGrantPreview,
    scenarioSelectionState,
    simpleCreatedManifest,
    simpleEnvironment,
    withHeading,
    withLongitudinalSpeed,
    withPositionAxis,
} from "../app/config/simpleRunModel.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";

test("heading and longitudinal speed edits keep the other pose and velocity components", () => {
    const vehicle = createDefaultRunManifest().initialState.vehicles[0];
    vehicle.pose.position = { x: 1, y: 2, z: 3 };
    vehicle.pose.rotation = { x: 0.1, y: 0.2, z: 0.3, order: "XYZ" };
    vehicle.linearVelocity = { x: 2, y: 0.4, z: 0.5 };

    const turned = withHeading(vehicle, 1.1);
    assert.equal(turned.pose.rotation.y, 1.1);
    assert.equal(turned.pose.rotation.x, 0.1);
    assert.equal(turned.pose.rotation.z, 0.3);
    assert.equal(turned.pose.rotation.order, "XYZ");
    assert.deepEqual(turned.pose.position, vehicle.pose.position);
    assert.deepEqual(turned.linearVelocity, vehicle.linearVelocity);

    const moved = withPositionAxis(vehicle, "z", 9);
    assert.equal(moved.pose.position.z, 9);
    assert.equal(moved.pose.position.x, 1);
    assert.equal(moved.pose.position.y, 2);
    assert.deepEqual(moved.pose.rotation, vehicle.pose.rotation);
    assert.deepEqual(moved.linearVelocity, vehicle.linearVelocity);

    const yaw = 0.2;
    const forwardX = Math.cos(yaw);
    const forwardZ = -Math.sin(yaw);
    const current = 2 * forwardX + 0.5 * forwardZ;
    assert.ok(Math.abs(longitudinalSpeed(vehicle) - current) < 1e-12);
    const sped = withLongitudinalSpeed(vehicle, 4);
    assert.ok(Math.abs(longitudinalSpeed(sped) - 4) < 1e-9);
    assert.equal(sped.linearVelocity.y, 0.4);
    assert.ok(Math.abs((sped.linearVelocity.x - 4 * forwardX) - (vehicle.linearVelocity.x - current * forwardX)) < 1e-9);
    assert.ok(Math.abs((sped.linearVelocity.z - 4 * forwardZ) - (vehicle.linearVelocity.z - current * forwardZ)) < 1e-9);
    assert.deepEqual(sped.pose, vehicle.pose);
});

test("vehicle changes keep extra sensors, orphan mounts, and other actors", () => {
    const draft = createDefaultRunManifest({ id: "veh", name: "Veh" });
    draft.sensorRig.inheritance = { mode: "vehicle" };
    draft.sensorRig.sensors.push({ id: "extra-camera", type: "camera" });
    draft.sensorRig.sensors.push({ id: "old-mount", type: "lidar3d", inheritedFrom: "missing-mount" });
    draft.initialState.vehicles.push({
        ...draft.initialState.vehicles[0],
        id: "trailer",
        type: "scenario-car",
    });

    const result = applySimpleVehicleSelection(draft, "igvc-car", getBuiltInVehicleManifest("igvc-car"));

    assert.equal(result.manifest.initialState.vehicles[0].type, "igvc-car");
    assert.equal(result.manifest.initialState.vehicles[1].type, "scenario-car");
    assert.equal(result.manifest.initialState.vehicles[1].id, "trailer");
    assert.ok(result.manifest.sensorRig.sensors.some((sensor) => sensor.id === "extra-camera" && !sensor.inheritedFrom));
    assert.ok(result.manifest.sensorRig.sensors.some((sensor) => sensor.inheritedFrom === "missing-mount"));
    assert.ok(result.issues.some((issue) => issue.message.includes("missing-mount")));
});

test("a plugin-owned inherited sensor requires a grant and stays on the manifest", () => {
    const manifest = createDefaultRunManifest({ id: "grant", name: "Grant" });
    manifest.sensorRig.sensors.push({
        id: "plugin-range",
        type: "example.range",
        inheritedFrom: "plugin-range",
    });
    const preview = pluginGrantPreview(manifest, {
        sensors: [{
            type: "example.range",
            ownership: {
                pluginId: "example.sensors",
                packageHash: "ab".repeat(32),
                version: "1.0.0",
            },
        }],
    });

    assert.equal(preview.required, true);
    assert.ok(preview.manifest.sensorRig.sensors.some((sensor) => sensor.id === "plugin-range"));
    assert.ok(preview.manifest.plugins.artifacts.some((artifact) => artifact.pluginId === "example.sensors"));
    assert.equal(pluginGrantPreview(manifest, { sensors: [] }).required, false);
});

test("simple-created runs inherit the built-in vehicle and keep unmatched constructor sensors", () => {
    const advanced = createDefaultRunManifest({ id: "new-run", name: "Untitled Run" });
    const simple = simpleCreatedManifest("new-run", "Untitled Run");
    const advancedIds = new Set(advanced.sensorRig.sensors.map((sensor) => sensor.id));

    assert.notDeepEqual(simple, advanced);
    assert.equal(simple.sensorRig.inheritance.mode, "vehicle");
    assert.ok(simple.sensorRig.sensors.some((sensor) => sensor.inheritedFrom === "roof-lidar"));
    assert.ok(simple.sensorRig.sensors.some((sensor) => !sensor.inheritedFrom && advancedIds.has(sensor.id)));
});

test("scenario selection leaves the vehicle pose untouched and keeps a missing scenario id", () => {
    const manifest = createDefaultRunManifest({ id: "pose", name: "Pose" });
    manifest.initialState.vehicles[0].pose.position.x = 4;
    manifest.initialState.vehicles[0].pose.rotation.y = 0.3;
    const pose = structuredClone(manifest.initialState.vehicles[0].pose);
    const selected = applyScenarioSelectionToManifest(manifest, {
        id: "lane",
        definitionHash: "abc",
        environment: { id: "igvc" },
    });

    assert.equal(selected.scenario.id, "lane");
    assert.deepEqual(selected.initialState.vehicles[0].pose, pose);
    assert.equal(scenarioSelectionState(selected, [], "ready").missing, true);
    assert.equal(scenarioSelectionState(selected, [], "ready").preserveSelected, true);
    assert.equal(scenarioSelectionState(selected, [{ id: "lane" }], "ready").missing, false);
});

test("environment summary reports a missing or stale reference without clearing it", () => {
    const draft = createDefaultRunManifest({ id: "env", name: "Env" });
    draft.environment = { id: "old-yard", expectedHash: "aaa" };
    const missing = simpleEnvironment(draft, [{ id: "igvc", name: "IGVC", definitionHash: "bbb" }]);
    assert.equal(missing.missing, true);
    assert.equal(missing.id, "old-yard");
    assert.equal(missing.editable, true);

    draft.environment = { id: "igvc", expectedHash: "aaa" };
    const stale = simpleEnvironment(draft, [{ id: "igvc", name: "IGVC", definitionHash: "bbb" }]);
    assert.equal(stale.missing, false);
    assert.equal(stale.stale, true);
    assert.equal(stale.name, "IGVC");
});
