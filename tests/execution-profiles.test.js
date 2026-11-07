import assert from "node:assert/strict";
import test from "node:test";

import { isControlsCommandTopic } from "../app/autonomy/AutonomyContractCatalog.js";
import {
    buildComparisonBaseline,
    classifyConfiguration,
    compareOverrides,
    inferExecutionProfile,
    previewProfile,
} from "../app/config/executionProfiles.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { createDefaultScenario } from "../app/scenarios/ScenarioDocument.js";
import { getBuiltInVehicleManifest } from "../app/vehicles/BuiltInVehicleManifests.js";

const bigCar = getBuiltInVehicleManifest("big-car");

function localScenario(overrides = {}) {
    return createDefaultScenario(overrides);
}

function manifestFor(scenario, overrides = {}) {
    return createDefaultRunManifest({
        scenario: scenario ? { id: scenario.id, egoVehicleId: "big-car" } : null,
        ...overrides,
    });
}

test("standard patch changes only its leaves and keeps advanced customizations", () => {
    const scenario = localScenario();
    const scenarioSnapshot = structuredClone(scenario);
    const manifest = manifestFor(scenario);
    manifest.seed = "99";
    manifest.clock.pacing = "unbounded";
    manifest.clock.speed = 2;
    manifest.clock.maxSteps = 25;
    manifest.clock.publishClock = false;
    manifest.controls.watchdogNs = 50;
    manifest.controls.stalePolicy = "hold";
    manifest.controls.actuatorOverrides = { maxSpeed: 3 };
    manifest.logging.policy = "required";
    manifest.plugins = {
        enabled: true,
        artifacts: [{
            pluginId: "example.plant",
            expectedHash: "ab".repeat(32),
            capabilities: ["plant.step"],
        }],
    };
    manifest.sensorRig.sensors.push({ id: "extra-sensor", type: "imu" });
    manifest.initialState.vehicles.push({ id: "walker", type: "igvc-car", steeringAngle: 0.2 });
    const before = structuredClone(manifest);

    const preview = previewProfile(manifest, "standard", { scenario, vehicleManifest: bigCar });

    assert.equal(preview.ready, true);
    assert.equal(preview.controlSource.kind, "route-follower");
    assert.deepEqual(preview.issues, []);
    assert.deepEqual(preview.changes, [
        { path: "clock.pacing", before: "unbounded", after: "realtime" },
        { path: "clock.speed", before: 2, after: 1 },
        { path: "controls.authority", before: "candidate", after: "reference" },
        { path: "logging.policy", before: "required", after: "optional" },
    ]);
    assert.equal(preview.nextManifest.seed, "99");
    assert.equal(preview.nextManifest.clock.stepNs, before.clock.stepNs);
    assert.equal(preview.nextManifest.clock.maxSteps, 25);
    assert.equal(preview.nextManifest.clock.publishClock, false);
    assert.deepEqual(preview.nextManifest.clock.modules, before.clock.modules);
    assert.equal(preview.nextManifest.controls.watchdogNs, 50);
    assert.equal(preview.nextManifest.controls.stalePolicy, "hold");
    assert.deepEqual(preview.nextManifest.controls.actuatorOverrides, { maxSpeed: 3 });
    assert.equal(preview.nextManifest.logging.profileId, before.logging.profileId);
    assert.deepEqual(preview.nextManifest.plugins, before.plugins);
    assert.deepEqual(
        preview.nextManifest.sensorRig.sensors.map((sensor) => sensor.id),
        before.sensorRig.sensors.map((sensor) => sensor.id),
    );
    assert.equal(preview.nextManifest.initialState.vehicles[1].steeringAngle, 0.2);
    assert.deepEqual(preview.nextManifest.topics, before.topics);
    assert.deepEqual(preview.nextManifest.scenario, before.scenario);
    assert.notEqual(preview.nextManifest, manifest);
    preview.nextManifest.seed = "mutated";
    assert.equal(manifest.seed, "99");
    assert.equal(manifest.clock.pacing, "unbounded");
    assert.deepEqual(scenario, scenarioSnapshot);

    manifest.seed = 7;
    const numeric = previewProfile(manifest, "standard", { scenario });
    assert.equal(numeric.nextManifest.seed, 7);
    assert.equal(manifest.seed, 7);
});

test("external controller uses reference for external-ros and candidate for direct command", () => {
    const remote = localScenario({
        routes: [{ actorId: "ego", controller: { kind: "external-ros", topicId: "controls-command" } }],
    });
    const remoteManifest = manifestFor(remote);
    remoteManifest.clock.pacing = "unbounded";
    remoteManifest.clock.speed = 2;
    remoteManifest.clock.maxSteps = null;
    remoteManifest.clock.publishClock = false;
    remoteManifest.logging.policy = "required";
    remoteManifest.controls.watchdogNs = 80;
    const remoteBefore = structuredClone(remoteManifest);
    const remotePreview = previewProfile(remoteManifest, "external", { scenario: remote });

    assert.equal(remotePreview.ready, true);
    assert.equal(remotePreview.controlSource.kind, "external-ros");
    assert.equal(remotePreview.controlSource.topicId, "controls-command");
    assert.deepEqual(remotePreview.issues, []);
    assert.equal(remotePreview.nextManifest.controls.authority, "reference");
    assert.equal(remotePreview.nextManifest.clock.pacing, "realtime");
    assert.equal(remotePreview.nextManifest.clock.speed, 1);
    assert.equal(remotePreview.nextManifest.clock.publishClock, true);
    assert.equal(remotePreview.nextManifest.clock.maxSteps, null);
    assert.equal(remotePreview.nextManifest.logging.policy, "required");
    assert.equal(remotePreview.nextManifest.logging.profileId, remoteBefore.logging.profileId);
    assert.equal(remotePreview.nextManifest.controls.watchdogNs, 80);
    assert.deepEqual(remotePreview.nextManifest.topics, remoteBefore.topics);
    assert.equal(remote.routes[0].controller.kind, "external-ros");

    const direct = createDefaultRunManifest();
    direct.controls.authority = "reference";
    direct.clock.publishClock = false;
    direct.logging.policy = "disabled";
    const directPreview = previewProfile(direct, "external", {});
    assert.equal(directPreview.controlSource.kind, "direct-command");
    assert.equal(directPreview.issues.length, 0);
    assert.equal(directPreview.nextManifest.controls.authority, "candidate");
    assert.equal(directPreview.nextManifest.clock.publishClock, true);
    assert.equal(directPreview.nextManifest.logging.policy, "disabled");
});

test("presets explain missing controllers and topics without repairing them", () => {
    const local = localScenario({
        actors: [
            { id: "ego", name: "Ego", role: "ego" },
            { id: "walker", name: "Walker", role: "actor" },
        ],
        routes: [
            { actorId: "ego", controller: { kind: "script", scriptId: "follower" } },
            { actorId: "walker", controller: { kind: "script", scriptId: "walk" } },
        ],
    });
    const manifest = manifestFor(local);
    manifest.initialState.vehicles.push({ id: "walker", type: "igvc-car" });
    const preview = previewProfile(manifest, "external", { scenario: local });
    assert.equal(preview.ready, true);
    assert.equal(preview.controlSource.kind, "script");
    assert.equal(preview.controlSource.scriptId, "follower");
    assert.equal(preview.nextManifest.controls.authority, "candidate");
    assert.equal(preview.issues[0].code, "local-controller-ignores-candidate");
    assert.equal(preview.issues[0].path, "routes.0.controller");
    assert.equal(preview.issues[0].surface, "scenario");
    assert.equal(local.routes[0].controller.kind, "script");
    assert.equal(local.routes[1].controller.scriptId, "walk");
    assert.equal(preview.nextManifest.initialState.vehicles[1].id, "walker");

    const missingTopic = localScenario({
        routes: [{ actorId: "ego", controller: { kind: "external-ros", topicId: "not-a-topic" } }],
    });
    const topicManifest = manifestFor(missingTopic);
    const topicBefore = topicManifest.topics.length;
    const topicPreview = previewProfile(topicManifest, "external", { scenario: missingTopic });
    assert.equal(topicPreview.issues[0].code, "missing-external-topic");
    assert.equal(topicPreview.issues[0].surface, "topics");
    assert.equal(topicPreview.nextManifest.topics.length, topicBefore);
    assert.equal(missingTopic.routes[0].controller.topicId, "not-a-topic");

    const blankTopic = localScenario({
        routes: [{ actorId: "ego", controller: { kind: "external-ros", topicId: "" } }],
    });
    const blankPreview = previewProfile(manifestFor(blankTopic), "external", { scenario: blankTopic });
    assert.equal(blankPreview.issues[0].code, "missing-external-topic");
    assert.equal(blankPreview.issues[0].surface, "scenario");

    const direct = createDefaultRunManifest();
    direct.topics = direct.topics.filter((topic) => !isControlsCommandTopic(topic));
    const directPreview = previewProfile(direct, "external", {});
    assert.equal(directPreview.issues[0].code, "missing-controls-topic");
    assert.equal(directPreview.issues[0].path, "topics");
    assert.equal(directPreview.nextManifest.topics.length, direct.topics.length);

    const manifestOnly = previewProfile(createDefaultRunManifest(), "standard", {});
    assert.equal(manifestOnly.ready, true);
    assert.equal(manifestOnly.issues[0].code, "missing-local-controller");
    assert.equal(manifestOnly.nextManifest.controls.authority, "reference");
});

test("a missing scenario document withholds the patch", () => {
    const manifest = createDefaultRunManifest({ scenario: { id: "missing-scenario" } });
    manifest.controls.authority = "reference";
    manifest.clock.publishClock = false;
    const snapshot = structuredClone(manifest);
    const external = previewProfile(manifest, "external", {});
    const standard = previewProfile(manifest, "standard", {});
    assert.equal(external.ready, false);
    assert.equal(standard.ready, false);
    assert.equal(external.nextManifest, manifest);
    assert.equal(standard.nextManifest, manifest);
    assert.deepEqual(external.changes, []);
    assert.deepEqual(standard.changes, []);
    assert.equal(external.issues[0].code, "scenario-not-loaded");
    assert.deepEqual(manifest, snapshot);
    assert.equal(inferExecutionProfile(manifest, {}).profileId, null);
    assert.equal(inferExecutionProfile(manifest, {}).comparisonProfileId, "standard");

    const baseline = buildComparisonBaseline(manifest, "external", {});
    assert.equal(baseline.manifest.controls.authority, "candidate");
    assert.equal(baseline.manifest.clock.publishClock, true);
    assert.equal(baseline.manifest.clock.speed, 1);
    assert.ok(baseline.issues.some((entry) => entry.code === "scenario-not-loaded"));
});

test("bounded and unbounded scenarios stay eligible and keep the manifest step limit", () => {
    const unbounded = localScenario();
    const bounded = localScenario({
        completion: { conditions: [{ id: "limit", name: "Limit", kind: "max-duration", durationNs: 30e9 }] },
    });
    assert.equal(unbounded.completion.conditions.length, 0);
    assert.equal(bounded.completion.conditions[0].durationNs, 30e9);
    const manifest = manifestFor(unbounded);
    manifest.clock.maxSteps = 40;
    manifest.seed = "keep-me";

    for (const scenario of [unbounded, bounded]) {
        for (const profileId of ["standard", "external"]) {
            const preview = previewProfile(manifest, profileId, { scenario });
            assert.equal(preview.ready, true, profileId);
            assert.equal(preview.nextManifest.clock.maxSteps, 40);
            assert.equal(preview.nextManifest.seed, "keep-me");
            assert.equal(preview.nextManifest.clock.stepNs, manifest.clock.stepNs);
            assert.ok(!preview.issues.some((entry) => /duration/i.test(entry.message)));
        }
    }
    assert.equal(bounded.completion.conditions[0].durationNs, 30e9);
    assert.deepEqual(previewProfile(manifest, "standard", { scenario: unbounded }).issues, []);
});

test("inference checks external first and leaves unusual runs custom", () => {
    const scenario = localScenario();
    const manifest = manifestFor(scenario);
    manifest.controls.authority = "reference";
    manifest.clock.pacing = "realtime";
    manifest.clock.speed = 1;
    manifest.clock.publishClock = false;
    manifest.logging.policy = "optional";
    manifest.seed = 7;
    assert.equal(inferExecutionProfile(manifest, { scenario }).profileId, "standard");

    manifest.logging.policy = "required";
    assert.equal(inferExecutionProfile(manifest, { scenario }).profileId, null);
    manifest.logging.policy = "optional";
    manifest.clock.pacing = "unbounded";
    assert.equal(inferExecutionProfile(manifest, { scenario }).profileId, null);
    manifest.clock.pacing = "realtime";
    manifest.clock.speed = 2;
    const unusual = classifyConfiguration(manifest, { scenario, vehicleManifest: bigCar });
    assert.equal(unusual.profileId, null);
    assert.equal(unusual.label, "Custom");
    assert.equal(unusual.baselineName, "Standard Simulation");
    assert.equal(unusual.comparisonProfileId, "standard");

    manifest.clock.speed = 1;
    manifest.controls.authority = "candidate";
    manifest.clock.publishClock = true;
    assert.equal(inferExecutionProfile(manifest, { scenario }).profileId, null);

    const remote = localScenario({
        routes: [{ actorId: "ego", controller: { kind: "external-ros", topicId: "controls-command" } }],
    });
    const remoteManifest = manifestFor(remote);
    remoteManifest.controls.authority = "reference";
    remoteManifest.clock.publishClock = true;
    remoteManifest.logging.policy = "required";
    assert.equal(inferExecutionProfile(remoteManifest, { scenario: remote }).profileId, "external");
    remoteManifest.clock.publishClock = false;
    assert.equal(inferExecutionProfile(remoteManifest, { scenario: remote }).profileId, null);

    const direct = createDefaultRunManifest();
    assert.equal(inferExecutionProfile(direct, {}).profileId, "external");
    direct.controls.authority = "reference";
    direct.logging.policy = "optional";
    assert.equal(inferExecutionProfile(direct, {}).profileId, null);

    const scripted = localScenario({
        routes: [{ actorId: "ego", controller: { kind: "script-with-route", scriptId: "drive" } }],
    });
    const scriptedManifest = manifestFor(scripted);
    scriptedManifest.controls.authority = "reference";
    scriptedManifest.logging.policy = "optional";
    assert.equal(inferExecutionProfile(scriptedManifest, { scenario: scripted }).profileId, "standard");
    assert.equal(inferExecutionProfile(scriptedManifest, { scenario: scripted }).controlSource.scriptId, "drive");

    assert.throws(() => previewProfile(direct, "test-ci"), TypeError);
});

test("a matching profile with a different seed is custom against that baseline", () => {
    const scenario = localScenario();
    const context = { scenario, vehicleManifest: bigCar };
    const draft = manifestFor(scenario);
    const built = buildComparisonBaseline(draft, "standard", context);
    assert.equal(built.manifest.controls.authority, "reference");
    assert.equal(built.manifest.logging.policy, "optional");
    assert.equal(built.manifest.sensorRig.inheritance.mode, "vehicle");
    const sensorIds = built.manifest.sensorRig.sensors.map((sensor) => sensor.id);
    assert.ok(sensorIds.includes("roof-lidar"));
    assert.ok(sensorIds.includes("front-stereo-camera"));
    assert.ok(!sensorIds.includes("front-camera"));
    assert.deepEqual(built.issues, []);

    const clean = classifyConfiguration(built.manifest, context);
    assert.equal(clean.profileId, "standard");
    assert.equal(clean.label, "Standard Simulation");
    assert.equal(clean.baselineName, "Standard Simulation");
    assert.deepEqual(clean.overrides, []);

    const seeded = structuredClone(built.manifest);
    seeded.seed = "99";
    const custom = classifyConfiguration(seeded, context);
    assert.equal(custom.profileId, "standard");
    assert.equal(custom.label, "Custom");
    assert.equal(custom.baselineName, "Standard Simulation");
    assert.deepEqual(custom.overrides.map((entry) => entry.path), ["seed"]);
    assert.equal(custom.overrides[0].before, "42");
    assert.equal(custom.overrides[0].after, "99");

    const externalDraft = createDefaultRunManifest();
    externalDraft.logging.policy = "required";
    externalDraft.logging.profileId = "custom-profile";
    const external = classifyConfiguration(externalDraft, { vehicleManifest: bigCar });
    assert.equal(external.profileId, "external");
    assert.equal(external.label, "Custom");
    assert.equal(external.baselineName, "External Controller");
    assert.equal(external.baseline.logging.policy, "required");
    assert.equal(external.baseline.logging.profileId, "simulation-run-full-sensors");
    assert.ok(!external.overrides.some((entry) => entry.path === "logging.policy"));
    assert.ok(external.overrides.some((entry) => entry.path === "logging.profileId"));

    const externalBaseline = buildComparisonBaseline(externalDraft, "external", { vehicleManifest: bigCar });
    const matchedExternal = classifyConfiguration(externalBaseline.manifest, { vehicleManifest: bigCar });
    assert.equal(matchedExternal.profileId, "external");
    assert.equal(matchedExternal.label, "External Controller");
    assert.deepEqual(matchedExternal.overrides, []);
});

test("override comparison uses stable ids and ignores selection identity", () => {
    const scenario = localScenario();
    const context = { scenario, vehicleManifest: bigCar };
    const baseline = buildComparisonBaseline(manifestFor(scenario), "standard", context).manifest;
    const reordered = structuredClone(baseline);
    reordered.sensorRig.sensors.reverse();
    assert.deepEqual(compareOverrides(reordered, baseline, { actorId: "ego", scenarioOwnsInitialState: true }), []);

    const edited = structuredClone(baseline);
    const lidar = edited.sensorRig.sensors.find((sensor) => sensor.id === "roof-lidar");
    const previousRange = lidar.calibration.range;
    lidar.calibration.range = previousRange === 99 ? 100 : 99;
    const rangeOverride = compareOverrides(edited, baseline, { actorId: "ego" });
    assert.deepEqual(rangeOverride.map((entry) => entry.path), ["sensorRig.sensors[roof-lidar].calibration.range"]);
    assert.equal(rangeOverride[0].groupId, "sensorRig.sensors[roof-lidar]");
    assert.equal(rangeOverride[0].before, previousRange);
    assert.equal(rangeOverride[0].after, lidar.calibration.range);

    const extra = structuredClone(baseline);
    const added = structuredClone(extra.sensorRig.sensors[0]);
    added.id = "extra-sensor";
    delete added.inheritedFrom;
    extra.sensorRig.sensors.push(added);
    const extraClass = classifyConfiguration(extra, context);
    assert.equal(extraClass.profileId, "standard");
    assert.equal(extraClass.label, "Custom");
    assert.ok(extraClass.overrides.some((entry) => entry.path === "sensorRig.sensors[extra-sensor]"));

    const typed = structuredClone(baseline);
    typed.initialState.vehicles[0].type = "igvc-car";
    typed.initialState.vehicles[0].pose.position.x = 4;
    assert.deepEqual(compareOverrides(typed, baseline, {
        actorId: "ego",
        scenarioOwnsInitialState: true,
    }), []);
    const poseOverride = compareOverrides(typed, baseline, { actorId: "ego" });
    assert.ok(poseOverride.some((entry) => entry.path.includes("pose")));
    assert.ok(!poseOverride.some((entry) => entry.path.endsWith(".type")));

    const other = structuredClone(baseline);
    other.initialState.vehicles.push({ id: "walker", type: "igvc-car" });
    assert.ok(compareOverrides(other, baseline).some((entry) => entry.path === "initialState.vehicles[walker]"));

    assert.deepEqual(compareOverrides(
        { scripts: { bindingIds: ["b", "a"] } },
        { scripts: { bindingIds: ["a", "b"] } },
    ), []);
    assert.deepEqual(compareOverrides(
        { topics: [{ id: "b", name: "B" }, { id: "a", name: "A" }] },
        { topics: [{ id: "a", name: "A" }, { id: "b", name: "B" }] },
    ), []);
    const duplicate = compareOverrides(
        { topics: [{ id: "a", name: "one" }, { id: "a", name: "two" }] },
        { topics: [{ id: "a", name: "two" }, { id: "a", name: "one" }] },
    );
    assert.ok(duplicate.some((entry) => entry.path === "topics.0.name"));

    const plugins = structuredClone(baseline);
    plugins.plugins = {
        enabled: true,
        artifacts: [{ pluginId: "example.plant", expectedHash: "ab".repeat(32), capabilities: ["plant.step"] }],
    };
    assert.ok(compareOverrides(plugins, baseline).some((entry) => entry.path === "plugins.artifacts[example.plant]"));
    const transport = compareOverrides({
        sensorTransports: {
            bindings: [{ sensorId: "lidar", productId: "points", streamId: "cloud", adapter: "udp", endpointId: "a" }],
        },
    }, {
        sensorTransports: {
            bindings: [{ sensorId: "lidar", productId: "points", streamId: "cloud", adapter: "udp", endpointId: "b" }],
        },
    });
    assert.deepEqual(transport.map((entry) => entry.path), [
        "sensorTransports.bindings[lidar/points/cloud/udp].endpointId",
    ]);

    const missingVehicle = buildComparisonBaseline(createDefaultRunManifest(), "standard", {});
    assert.equal(missingVehicle.manifest.sensorRig.sensors.length, 0);
    assert.equal(missingVehicle.manifest.sensorRig.inheritance, undefined);
    assert.ok(missingVehicle.issues.some((entry) => entry.code === "missing-vehicle"));
});

test("an already applied profile is a no-op and normalization is visible", () => {
    const scenario = localScenario();
    const manifest = manifestFor(scenario);
    const first = previewProfile(manifest, "standard", { scenario });
    const second = previewProfile(first.nextManifest, "standard", { scenario });
    assert.equal(second.nextManifest, first.nextManifest);
    assert.deepEqual(second.changes, []);

    const normalized = manifestFor(scenario);
    normalized.controls.authority = "reference";
    normalized.logging.policy = "optional";
    normalized.controls.keyboardDrive = false;
    const preview = previewProfile(normalized, "standard", { scenario });
    assert.deepEqual(preview.changes, [
        { path: "controls.keyboardDrive", before: false, after: undefined },
    ]);
    assert.equal(preview.nextManifest.controls.keyboardDrive, undefined);
    assert.equal(normalized.controls.keyboardDrive, false);
});
