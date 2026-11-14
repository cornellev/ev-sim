import assert from "node:assert/strict";
import test from "node:test";

import { TopicContractRouter } from "../app/simulation/TopicContractRouter.js";
import {
    GOAL_TOPIC,
    GoalPublisher,
    scenarioGoalPose,
} from "../app/simulation/GoalPublisher.js";
import { createSimulationRuntimeContext } from "../app/simulation/kernel/SimulationRuntimeContext.js";
import { SimulationKernel } from "../app/simulation/kernel/SimulationKernel.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";
import { SignalStore } from "../app/scripting/runtime/SignalStore.js";
import { topicSignalPath } from "../app/scripting/runtime/SignalPaths.js";

function waypoint(x, y, z) {
    return { kind: "finish", position: { x, y, z } };
}

function route(actorId, waypoints, polyline = null) {
    return {
        actorId,
        waypoints,
        verification: polyline ? { polyline } : null,
    };
}

function resolvedRun(routes, { targetVehicleId = "ego", topics = null } = {}) {
    const manifest = createDefaultRunManifest({
        clock: {
            stepNs: 20_000_000,
            pacing: "unbounded",
            maxSteps: 2,
            modules: { physics: true, sensors: false },
        },
        sensorRig: { sensors: [] },
        assertions: [],
        controls: { targetVehicleId },
    });
    if (topics) manifest.topics = topics;
    return {
        version: 13,
        manifest,
        definitionHash: "a".repeat(64),
        resolvedHash: "b".repeat(64),
        environment: { manifest: { environmentId: manifest.environment.id } },
        bindings: { entries: [] },
        scripts: [],
        vehicles: [],
        scenario: routes ? { scenario: { routes } } : null,
    };
}

function poseTopic(valueContract = { id: "cev.goal", version: 1 }) {
    return {
        id: "goal",
        contractId: "goal",
        name: GOAL_TOPIC,
        direction: "output",
        valueContract,
        required: false,
        producer: "oracle",
        authority: "oracle",
        routeDownstream: false,
    };
}

function publisherFor(run, { topics = [] } = {}) {
    const telemetry = new SignalStore({}, { sourceId: "goal-publisher-test" });
    const published = [];
    run.manifest.topics = topics;
    const topicRouter = new TopicContractRouter(run.manifest, { telemetry, publicationPort(product) { published.push(product); return { ok: true }; } });
    return { published, telemetry, topicRouter, publisher: new GoalPublisher({ topicRouter, resolvedRun: run }) };
}

test("scenario goal pose is the ego route's final waypoint in REP-103", () => {
    const run = resolvedRun([
        route("other", [waypoint(99, 0, 0)]),
        route("ego", [
            waypoint(0, 0, 0),
            waypoint(10, 2, 4),
        ], [
            { x: 10, y: 0, z: 0 },
            { x: 10, y: 0, z: 4 },
        ]),
    ]);
    const pose = scenarioGoalPose(run);
    assert.deepEqual(pose.position, { x: 10, y: -4, z: 2 });
    assert.equal(pose.orientation.x, 0);
    assert.equal(pose.orientation.y, 0);
    assert.ok(Math.abs(pose.orientation.z - (-Math.SQRT1_2)) < 1e-12);
    assert.ok(Math.abs(pose.orientation.w - Math.SQRT1_2) < 1e-12);
});

test("scenario goal pose is identity when the route has no polyline", () => {
    const pose = scenarioGoalPose(resolvedRun([
        route("ego", [waypoint(3, 0, -1)]),
    ]));
    assert.deepEqual(pose, {
        position: { x: 3, y: 1, z: 0 },
        orientation: { x: 0, y: 0, z: 0, w: 1 },
    });
});

test("scenario goal pose uses the first route when the target actor has none", () => {
    const pose = scenarioGoalPose(resolvedRun([
        route("lead", [waypoint(4, 0, 0)]),
    ], { targetVehicleId: "ego" }));
    assert.equal(pose.position.x, 4);
});

test("scenario goal pose publishes nothing without a finish waypoint", () => {
    assert.equal(scenarioGoalPose(resolvedRun(null)), null);
    assert.equal(scenarioGoalPose(resolvedRun([])), null);
    assert.equal(scenarioGoalPose(resolvedRun([
        route("ego", []),
        route("other", [waypoint(8, 0, 0)]),
    ])), null);
    assert.equal(scenarioGoalPose(resolvedRun([
        route("ego", [{ id: "finish" }]),
    ])), null);
});

test("goal publisher routes a declared native goal through the publication port", () => {
    const run = resolvedRun([route("ego", [waypoint(1, 0, 0)])]);
    const harness = publisherFor(run, { topics: [poseTopic()] });
    const pose = harness.publisher.publish(0);
    assert.deepEqual(harness.telemetry.read("oracle.topics.goal").value, { pose });
    assert.equal(harness.telemetry.read("oracle.topics.goal").exists, true);
    assert.equal(harness.published.length, 1);
    assert.equal(harness.published[0].topicId, "goal");
    assert.deepEqual(harness.published[0].valueContract, { id: "cev.goal", version: 1 });
    assert.deepEqual(harness.published[0].value, { pose });
    assert.equal(harness.published[0].metadata.frameId, "map");
});

test("goal publisher publishes nothing when the goal topic is not declared", () => {
    const run = resolvedRun([route("ego", [waypoint(1, 0, 2)])]);
    const harness = publisherFor(run);
    const pose = harness.publisher.publish(0);
    assert.ok(pose);
    assert.equal(harness.telemetry.read("oracle.topics.goal").exists, false);
    assert.equal(harness.telemetry.read("oracle.topics.goal").exists, false);
    assert.equal(harness.published.length, 0);
});

test("goal publisher leaves a differently typed /goal topic untouched", () => {
    const run = resolvedRun([route("ego", [waypoint(1, 0, 0)])]);
    const harness = publisherFor(run, { topics: [poseTopic({ id: "cev.vector3", version: 1 })] });
    assert.equal(harness.publisher.publish(0), null);
    assert.equal(harness.telemetry.read("oracle.topics.goal").exists, false);
    assert.equal(harness.telemetry.read("oracle.topics.goal").exists, false);
    assert.deepEqual(harness.published, []);
});

test("kernel publishes /goal once at episode start and not on later steps or stop", async () => {
    const published = [];
    const telemetry = new SignalStore({}, { sourceId: "goal-kernel-test" });
    const vehicle = {
        telemetryId: "ego",
        position: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        rotation: { x: 0, y: 0, z: 0, order: "XYZ", set(x, y, z, order) { Object.assign(this, { x, y, z, order }); } },
        velocity: { x: 0, y: 0, z: 0, set(x, y, z) { Object.assign(this, { x, y, z }); } },
        acceleration: { x: 0, y: 0, z: 0 },
        steeringAngle: 0,
        updatePosition() {},
        updateRotation() {},
    };
    const context = createSimulationRuntimeContext({
        telemetry,
        publicationPort(product) { published.push(product); return { ok: true }; },
        inputs: { update() {} },
        scripts: {
            signalStore: telemetry,
            setTopicScheduler() {},
            setTopicRouter() {},
            async setManifest() {},
            async prepareResolvedScripts() {},
            applyTopicUpdate() {},
            update() {},
        },
        vehicles: { vehicles: [vehicle], async configureFromManifest() {} },
        devices: { devices: [], configureFromManifest() {}, resetSchedule() {}, update() {}, deliver() {} },
        physics: { async configureRun() {}, resetRun() {}, beginStep() {}, step() {}, syncAndPublishContacts() { return { started: [], active: [], ended: [] }; } },
        scenarios: { configure() {}, reset() {}, setControlRuntime() {}, getSnapshot() { return null; } },
    });
    const kernel = new SimulationKernel(context);
    const run = resolvedRun([route("ego", [waypoint(6, 1, -2)])], { topics: [poseTopic()] });
    await kernel.configureRun(run);

    assert.equal(published.length, 1);
    assert.equal(published[0].topicId, "goal");
    assert.deepEqual(published[0].valueContract, { id: "cev.goal", version: 1 });
    assert.deepEqual(published[0].value.pose.position, { x: 6, y: 2, z: 1 });
    assert.deepEqual(telemetry.read("oracle.topics.goal").value, published[0].value);

    kernel.step(1);
    assert.equal(published.length, 1);

    kernel.reset();
    assert.equal(published.length, 2);
    assert.equal(telemetry.read("oracle.topics.goal").exists, true);

    kernel.reset(null, { episodePhase: "stop" });
    assert.equal(published.length, 2);
    assert.equal(telemetry.read("oracle.topics.goal").exists, false);
});
