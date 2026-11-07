import assert from "node:assert/strict";
import test from "node:test";

import { applyScenarioSelectionToManifest } from "../app/config/ConfigCatalogLoader.js";
import {
    applySimpleVehicleSelection,
    longitudinalSpeed,
    pluginGrantPreview,
    scenarioSelectionState,
    overrideEditTarget,
    simpleCreatedManifest,
    validationIssueTarget,
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

test("override edit targets focus simple fields or open an advanced tab", () => {
    assert.deepEqual(overrideEditTarget("clock.pacing"), { surface: "simple", field: "pacing" });
    assert.deepEqual(overrideEditTarget("logging.policy"), { surface: "simple", field: "recording" });
    assert.deepEqual(
        overrideEditTarget("initialState.vehicles[ego].pose.position.z"),
        { surface: "simple", field: "position-z" },
    );
    assert.deepEqual(
        overrideEditTarget("initialState.vehicles[ego].pose.position.z", { scenarioOwned: true }),
        { surface: "advanced", tab: "Initial State" },
    );
    assert.deepEqual(
        overrideEditTarget("plugins.artifacts[example.plant]"),
        { surface: "advanced", tab: "Scripts" },
    );
    assert.deepEqual(
        overrideEditTarget("sensorTransports.bindings[lidar/points/cloud/udp].endpointId"),
        { surface: "advanced", tab: "Sensors" },
    );
    assert.deepEqual(overrideEditTarget("renderRecipe.shadows.enabled"), { surface: "advanced", tab: "Sensors" });
    assert.deepEqual(overrideEditTarget("seed"), { surface: "advanced", tab: "Overview" });
    assert.deepEqual(overrideEditTarget("future.setting"), { surface: "advanced", tab: "JSON" });
});

test("validation issues point at a simple field or an advanced section", () => {
    const draft = {
        scenario: null,
        controls: { targetVehicleId: "ego" },
        initialState: { vehicles: [{ id: "ego" }, { id: "other" }] },
        sensorRig: { sensors: [{ id: "lidar" }] },
        sensorTransports: { bindings: [{ sensorId: "lidar" }] },
        topics: [{ schema: { type: "std_msgs/String" } }],
    };
    const before = structuredClone(draft);
    const read = (path) => validationIssueTarget({ path }, draft);

    assert.equal(read("name").simpleFocusId, "simple-field-name");
    assert.equal(read("scenario.id").simpleFocusId, "simple-field-scenario");
    assert.equal(read("scenario.egoVehicleId").simpleFocusId, "simple-field-vehicle");
    assert.equal(read("environment.id").simpleFocusId, "simple-field-environment");
    assert.equal(read("clock.pacing").simpleFocusId, "simple-field-pacing");
    assert.equal(read("clock.speed").simpleFocusId, "simple-field-speed");
    assert.equal(read("logging.policy").simpleFocusId, "simple-field-recording");
    assert.equal(read("initialState.vehicles.0.pose.position.z").simpleFocusId, "simple-field-position-z");
    assert.equal(read("initialState.vehicles.0.pose.rotation.y").simpleFocusId, "simple-field-heading");
    assert.equal(read("initialState.vehicles.0.linearVelocity.x").simpleFocusId, "simple-field-longitudinal-speed");
    assert.equal(read("initialState.vehicles.1.pose.position.x").simpleFocusId, null);

    const owned = validationIssueTarget(
        { path: "initialState.vehicles.0.pose.position.x" },
        { ...draft, scenario: { id: "loop" } },
    );
    assert.equal(owned.simpleFocusId, null);
    assert.equal(owned.tab, "Initial State");
    assert.equal(owned.advancedFocusId, "run-focus-tab-Initial State");

    const plugin = read("plugins.artifacts.0.expectedHash");
    assert.equal(plugin.explanation, "Plugin selection");
    assert.equal(plugin.tab, "Scripts");
    assert.equal(plugin.advancedFocusId, "run-focus-plugins");
    assert.equal(plugin.simpleFocusId, null);

    const transport = read("sensorTransports.bindings.0.endpointId");
    assert.equal(transport.explanation, "Sensor transport");
    assert.equal(transport.tab, "Sensors");
    assert.equal(transport.advancedFocusId, "run-focus-transport-lidar");
    const thrownTransport = validationIssueTarget({
        path: "",
        message: "sensorTransports.bindings.0.adapter is unsupported.",
    }, draft);
    assert.equal(thrownTransport.path, "sensorTransports.bindings.0.adapter");
    assert.equal(thrownTransport.advancedFocusId, "run-focus-transport-lidar");
    assert.equal(read("sensorTransports.bindings.3.endpointId").advancedFocusId, "run-focus-sensors");

    const parameter = read("parameters.0.target.path");
    assert.equal(parameter.explanation, "Run parameter");
    assert.equal(parameter.tab, "Scenario");
    assert.equal(parameter.advancedFocusId, "run-focus-parameter-0");

    const schema = read("sensorRig.sensors.0.schema.points");
    assert.equal(schema.explanation, "Schema");
    assert.equal(schema.tab, "Sensors");
    assert.equal(schema.advancedFocusId, "run-focus-sensor-lidar");

    const topic = read("topics.0.schema.type");
    assert.equal(topic.explanation, "Schema");
    assert.equal(topic.tab, "Topics");
    assert.equal(topic.advancedFocusId, "run-focus-topic-0-schema");

    const recipe = read("renderRecipe.shadows.enabled");
    assert.equal(recipe.explanation, "Render recipe");
    assert.equal(recipe.tab, "Sensors");
    assert.equal(recipe.advancedFocusId, "run-focus-render-recipe");
    const thrownRecipe = validationIssueTarget({
        path: "",
        message: "renderRecipe.shadows.enabled must be boolean.",
    }, draft);
    assert.equal(thrownRecipe.path, "renderRecipe.shadows.enabled");
    assert.equal(thrownRecipe.advancedFocusId, "run-focus-render-recipe");

    const unknown = read("future.setting");
    assert.equal(unknown.tab, "JSON");
    assert.equal(unknown.advancedFocusId, "run-focus-json");
    assert.equal(unknown.simpleFocusId, null);
    assert.equal(read("dependencies").tab, "JSON");
    assert.deepEqual(draft, before);
});
