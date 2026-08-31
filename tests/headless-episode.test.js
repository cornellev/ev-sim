import assert from "node:assert/strict";
import test from "node:test";

import {
    createRouteSafetyRewardTerms,
    HeadlessEpisode,
    resolveEpisodeOutcome,
    TERMINATION_REASON,
    TRUNCATION_REASON,
} from "../app/simulation/headless/HeadlessEpisode.js";
import { HeadlessEpisodeError } from "../app/simulation/headless/HeadlessErrors.js";
import { verifyRoute } from "../app/scenarios/route/Route.js";
import {
    createMeasuredStateObservationSpace,
    measureTaskSignals,
} from "../app/simulation/headless/MeasuredStateObservation.js";
import {
    DEFAULT_ROUTE_SAFETY_CONFIG_HASH,
    measuredStateProfileRef,
    ROUTE_SAFETY_PRESETS,
    routeSafetyProfileRef,
} from "../app/simulation/headless/ProfileRegistry.js";
import { assertCompatibleSpaces } from "../app/simulation/headless/SpaceCompatibility.js";
import {
    ACTION_SPACE,
    ACTION_SPACE_HASH,
    namedTensor,
    normalizeAction,
    tensorMap,
    unpackTensor,
} from "../app/simulation/headless/TensorProtocol.js";
import { StorageService } from "../server/storage/StorageService.js";

function imuSensor(overrides = {}) {
    return {
        id: "imu",
        type: "imu",
        enabled: true,
        parentId: "ego",
        pose: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, order: "XYZ" } },
        rateHz: 60,
        phaseNs: 0,
        calibration: {
            gravity: 9.80665,
            noise: {},
            angularVelocityStdDev: { x: 0, y: 0, z: 0 },
            linearAccelerationStdDev: { x: 0, y: 0, z: 0 },
            angularRandomWalk: { x: 0, y: 0, z: 0 },
            accelerationRandomWalk: { x: 0, y: 0, z: 0 },
            turnOnBias: { randomize: false, angular: { x: 0, y: 0, z: 0 }, acceleration: { x: 0, y: 0, z: 0 } },
        },
        latency: { fixedNs: 0, jitterNs: 0 },
        noise: { dropoutProbability: 0 },
        maxQueueFrames: 8,
        ...overrides,
    };
}

async function episodeBundle({ sensors = [imuSensor()], completion = { conditions: [] }, triggers = [] } = {}) {
    const resolved = await new StorageService().resolveRunManifest("igvc-default");
    resolved.manifest.sensorRig.sensors = sensors;
    resolved.manifest.clock.modules.physics = true;
    resolved.manifest.clock.modules.sensors = true;
    resolved.manifest.clock.maxSteps = null;
    resolved.manifest.controls.authority = "candidate";
    const initial = resolved.manifest.initialState.vehicles.find((entry) => entry.id === "ego")
        ?? resolved.manifest.initialState.vehicles[0];
    const roads = resolved.environment.manifest.document.roads;
    const edge = roads.edges[0];
    const nodes = new Map(roads.nodes.map((node) => [node.id, node]));
    const start = nodes.get(edge.startNodeId);
    const finish = nodes.get(edge.endNodeId);
    const verified = verifyRoute(resolved.environment.manifest, {
        id: "ego-route",
        actorId: initial.id,
        waypoints: [
            { id: "start", position: { x: start.x, y: 0, z: start.z } },
            { id: "finish", position: { x: finish.x, y: 0, z: finish.z } },
        ],
    });
    assert.equal(verified.ok, true);
    resolved.scenario = {
        scenario: {
            kind: "cev-sim.scenario",
            version: 1,
            id: "headless-episode-test",
            actors: [{ id: initial.id, role: "ego", name: "Ego" }],
            routes: [{
                id: "ego-route",
                actorId: initial.id,
                waypoints: verified.waypoints,
                verification: verified.verification,
            }],
            zones: [],
            triggers,
            completion,
            expectedOutcomes: [],
        },
    };
    return resolved;
}

test("packed action tensors are strict little-endian float32[2]", () => {
    const action = tensorMap([namedTensor("action", "float32", [2], [-0.5, 0.25])]);
    assert.deepEqual(Array.from(normalizeAction(action)), [-0.5, 0.25]);
    assert.deepEqual(unpackTensor(action.entries[0].tensor), [-0.5, 0.25]);
    assert.throws(() => normalizeAction([1.01, 0]), (error) => error.code === "INVALID_REQUEST");
    assert.throws(() => normalizeAction([Number.NaN, 0]), (error) => error.code === "INVALID_REQUEST");
    assert.match(ACTION_SPACE_HASH, /^[0-9a-f]{64}$/);
});

test("profile registry covers every safety and smoothness combination", () => {
    assert.equal(ROUTE_SAFETY_PRESETS.length, 16);
    assert.equal(new Set(ROUTE_SAFETY_PRESETS.map((entry) => entry.configHash)).size, 16);
    assert.equal(routeSafetyProfileRef().configHash, DEFAULT_ROUTE_SAFETY_CONFIG_HASH);
    assert.equal(measuredStateProfileRef().id, "measured-state");
});

test("reward term goldens and outcome precedence match the v1 route-safety contract", () => {
    const values = {
        "route-progress-ratio": 0.1,
        completion: 1,
        collision: 1,
        "off-road": 1,
        "wrong-way": 1,
        "acceleration-smoothness": 0.5,
        "jerk-smoothness": 0.25,
    };
    assert.deepEqual(createRouteSafetyRewardTerms(values, true), [
        { id: "route-progress-ratio", value: 0.1, weight: 1, weightedValue: 0.1 },
        { id: "completion", value: 1, weight: 1, weightedValue: 1 },
        { id: "collision", value: 1, weight: -1, weightedValue: -1 },
        { id: "off-road", value: 1, weight: -1, weightedValue: -1 },
        { id: "wrong-way", value: 1, weight: -0.25, weightedValue: -0.25 },
        { id: "acceleration-smoothness", value: 0.5, weight: -0.05, weightedValue: -0.025 },
        { id: "jerk-smoothness", value: 0.25, weight: -0.01, weightedValue: -0.0025 },
    ]);
    const all = { collision: true, offRoad: true, wrongWay: true, assertion: true, scenarioFailure: true, success: true };
    const config = { terminateOnCollision: true, terminateOnOffRoad: true, terminateOnWrongWay: true };
    assert.equal(resolveEpisodeOutcome(all, config, null, { policyLimitReached: true }).terminationReason, TERMINATION_REASON.COLLISION);
    assert.equal(resolveEpisodeOutcome({ ...all, collision: false }, config, null).terminationReason, TERMINATION_REASON.OFF_ROAD);
    assert.equal(resolveEpisodeOutcome({ ...all, collision: false, offRoad: false }, config, null).terminationReason, TERMINATION_REASON.WRONG_WAY);
    assert.equal(resolveEpisodeOutcome({ ...all, collision: false, offRoad: false, wrongWay: false }, config, null).terminationReason, TERMINATION_REASON.ASSERTION_FAILURE);
    assert.equal(resolveEpisodeOutcome({ scenarioFailure: true, success: true }, config, null).terminationReason, TERMINATION_REASON.SCENARIO_FAILURE);
    assert.equal(resolveEpisodeOutcome({ success: true }, config, null, { simulationLimitReached: true }).terminationReason, TERMINATION_REASON.SUCCESS);
    assert.equal(resolveEpisodeOutcome({}, config, null, { policyLimitReached: true, simulationLimitReached: true }).truncationReason, TRUNCATION_REASON.MAX_EPISODE_STEPS);
});

test("observation space is order-independent but sensor identity and type are semantic", () => {
    const left = createMeasuredStateObservationSpace([{ id: "z", type: "imu" }, { id: "a", type: "gnss" }]);
    const reordered = createMeasuredStateObservationSpace([{ id: "a", type: "gnss" }, { id: "z", type: "imu" }]);
    assert.doesNotThrow(() => assertCompatibleSpaces({ actionSpace: ACTION_SPACE, observationSpace: left }, { actionSpace: ACTION_SPACE, observationSpace: reordered }));
    const changed = createMeasuredStateObservationSpace([{ id: "a", type: "imu" }, { id: "z", type: "imu" }]);
    assert.throws(
        () => assertCompatibleSpaces({ actionSpace: ACTION_SPACE, observationSpace: left }, { actionSpace: ACTION_SPACE, observationSpace: changed }),
        (error) => error instanceof HeadlessEpisodeError && error.code === "INCOMPATIBLE_SPACE",
    );
});

test("task tensors are route-relative and observation names exclude oracle state", () => {
    const polyline = [{ x: 0, y: 0, z: 0 }, { x: 100, y: 0, z: 0 }];
    const route = { totalLength: 100, sections: [{ index: 0, polyline, length: 100 }] };
    const task = measureTaskSignals(route, {
        position: { x: 10, y: 0, z: 2 },
        rotation: { y: 0 },
    }, { metrics: { "route-progress-ratio": 0.1, "off-road": 0, "wrong-way": 0 } });
    assert.deepEqual(task.value, [0.1, 0.9, 2, 0, 90, 0, 0]);
    assert.deepEqual(task.validity, [true, true, true, true, true, true, true]);
    const space = createMeasuredStateObservationSpace([{ id: "imu", type: "imu" }]);
    assert.equal(space.dictionary.entries.some((entry) => /oracle|truth|pose|orientation|perception/.test(entry.key)), false);
});

test("episode maps signed actions, repeats commands, and counts policy steps", async () => {
    const resolved = await episodeBundle();
    const episode = new HeadlessEpisode();
    await episode.prepare(resolved, { actionRepeat: 3, maxEpisodeSteps: 1 });
    const reset = episode.reset();
    const initialSensorEntries = reset.observation.entries.filter((entry) => entry.name.startsWith("sensors/imu/"));
    assert.equal(initialSensorEntries.every((entry) => entry.tensor.payload.packedData.every((byte) => byte === 0)), true);
    assert.deepEqual(
        reset.observation.entries.map((entry) => entry.name),
        [...reset.observation.entries.map((entry) => entry.name)].sort((left, right) => Buffer.from(left).compare(Buffer.from(right))),
    );
    const unchanged = episode.kernel.getCanonicalState();
    assert.throws(() => episode.step([Number.NaN, 0]), (error) => error.code === "INVALID_REQUEST");
    assert.deepEqual(episode.kernel.getCanonicalState(), unchanged);
    const before = episode.runtime.vehicles.vehicles[0].position.x;
    const result = episode.step([1, 0.5]);
    assert.equal(result.info.diagnostics.advancedSubsteps, 3);
    assert.equal(episode.kernel.steps, 3);
    assert.ok(episode.runtime.vehicles.vehicles[0].position.x > before);
    assert.equal(episode.kernel.controlRuntime.getSnapshot("ego", { applyTimeNs: episode.kernel.timeNs }).flags.timedOut, false);
    assert.equal(result.truncated, true);
    assert.equal(result.info.truncationReason, TRUNCATION_REASON.MAX_EPISODE_STEPS);
    assert.deepEqual(result.info.rewardTerms.map((term) => term.id), [
        "route-progress-ratio", "completion", "collision", "off-road", "wrong-way", "acceleration-smoothness", "jerk-smoothness",
    ]);
    assert.equal(result.info.rewardTerms[5].weight, 0);
    assert.throws(() => episode.step([0, 0]), (error) => error.code === "EPISODE_TERMINAL");
});

test("action changes are represented in authoritative trajectory hashes", async () => {
    const resolved = await episodeBundle();
    const forward = new HeadlessEpisode();
    await forward.prepare(resolved);
    forward.reset();
    const forwardHash = forward.step([0.5, 0]).info.trajectoryHash;
    const reverse = new HeadlessEpisode();
    await reverse.prepare(resolved);
    reverse.reset();
    const reverseHash = reverse.step([-0.5, 0]).info.trajectoryHash;
    assert.notEqual(forwardHash, reverseHash);
});

test("finish and simulation-time terminals stop partial repeats with Gym semantics", async () => {
    const successBundle = await episodeBundle({
        triggers: [{
            id: "finish",
            name: "Finish",
            enabled: true,
            once: true,
            condition: { kind: "step", step: 2 },
            actions: [{ kind: "finish" }],
        }],
    });
    const success = new HeadlessEpisode();
    await success.prepare(successBundle, { actionRepeat: 5, maxEpisodeSteps: 1 });
    success.reset();
    const finished = success.step([0, 0]);
    assert.equal(finished.terminated, true);
    assert.equal(finished.truncated, false);
    assert.equal(finished.info.terminationReason, TERMINATION_REASON.SUCCESS);
    assert.equal(finished.info.diagnostics.advancedSubsteps, 2);

    const durationBundle = await episodeBundle({ completion: {
        conditions: [{ id: "duration", name: "Duration", kind: "max-duration", durationNs: 2 * 16_666_667 }],
    } });
    const duration = new HeadlessEpisode();
    await duration.prepare(durationBundle, { actionRepeat: 5 });
    duration.reset();
    const bounded = duration.step([0, 0]);
    assert.equal(bounded.terminated, false);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.info.truncationReason, TRUNCATION_REASON.MAX_SIMULATION_TIME);
    assert.equal(bounded.info.diagnostics.advancedSubsteps, 2);
});

test("scenario script failures map to failure termination", async () => {
    const resolved = await episodeBundle({
        triggers: [{
            id: "bad-script",
            name: "Bad script",
            enabled: true,
            once: true,
            condition: { kind: "step", step: 1 },
            actions: [{ kind: "run-script", scriptId: "missing", onError: "fail" }],
        }],
    });
    const episode = new HeadlessEpisode();
    await episode.prepare(resolved, { actionRepeat: 4 });
    episode.reset();
    const result = episode.step([0, 0]);
    assert.equal(result.terminated, true);
    assert.equal(result.info.terminationReason, TERMINATION_REASON.SCENARIO_FAILURE);
    assert.equal(result.info.diagnostics.advancedSubsteps, 1);
});

test("unsupported graphics sensors and reset profile changes fail before mutation", async () => {
    const unsupported = await episodeBundle({ sensors: [imuSensor({ id: "camera", type: "camera" })] });
    const episode = new HeadlessEpisode();
    await assert.rejects(() => episode.prepare(unsupported), (error) => error.code === "UNSUPPORTED_CAPABILITY");
    assert.equal(episode.kernel.lifecycleState, "idle");

    const valid = await episodeBundle();
    await episode.prepare(valid);
    episode.reset();
    const before = episode.kernel.getCanonicalState();
    assert.throws(() => episode.reset({
        ...episode.episodeSpec,
        observationProfile: { ...measuredStateProfileRef(), configHash: "bad" },
    }), (error) => error.code === "UNSUPPORTED_CAPABILITY");
    assert.deepEqual(episode.kernel.getCanonicalState(), before);
});
