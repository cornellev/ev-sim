import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
    canonicalEpisodeIdentity,
    canonicalSimulationStringify,
    computeEpisodeHash,
    computeSimulationSemanticHash,
    simulationSemanticProjection,
    simulationSha256,
    TrajectoryHasher,
} from "../app/simulation/kernel/SimulationHashes.js";
import { createDefaultRunManifest } from "../app/simulation/RunManifest.js";

function resolved(overrides = {}) {
    return {
        kind: "cev-sim.run-manifest",
        version: 9,
        manifest: createDefaultRunManifest(overrides),
        environment: { hash: "environment", manifest: { environmentId: "igvc" } },
        scripts: [],
        bindings: { hash: "bindings", entries: [] },
        vehicles: [],
        dependencyHashes: {},
        resolvedHash: "f".repeat(64),
    };
}

function episode(overrides = {}) {
    return {
        protocolMajor: 1,
        simulationSemanticHash: "a".repeat(64),
        resetSeed: "42",
        actionRepeat: 2,
        maxEpisodeSteps: "100",
        observationProfile: { id: "state", version: 1, configHash: "b".repeat(64) },
        rewardProfile: { id: "route", version: 1, configHash: "c".repeat(64) },
        backendSelections: [
            { kind: 2, capabilityId: "state", version: "1", configHash: "d".repeat(64) },
            { kind: 1, capabilityId: "rapier", version: "0.19.3", configHash: "e".repeat(64) },
        ],
        ...overrides,
    };
}

test("simulation SHA-256 matches Node and canonicalizes binary values", () => {
    const value = {
        z: new Uint16Array([1, 513]),
        a: { "\u{1f600}": 2, "é": 1 },
    };
    const canonical = canonicalSimulationStringify(value);
    const expected = createHash("sha256").update(canonical).digest("hex");
    assert.equal(simulationSha256(value), expected);
    assert.match(canonical, /\$typedArray/);
    assert.equal(simulationSha256({ value: -0 }), simulationSha256({ value: 0 }));
    assert.throws(() => simulationSha256({ value: Number.NaN }), /finite numbers/);
});

test("simulation semantic hash excludes logging and wall pacing only", () => {
    const first = resolved({
        logging: { policy: "required", profileId: "evaluation" },
        clock: { pacing: "realtime", speed: 1 },
    });
    const second = resolved({
        logging: { policy: "disabled", profileId: "training" },
        clock: { pacing: "unbounded", speed: 20 },
    });
    assert.equal(computeSimulationSemanticHash(first), computeSimulationSemanticHash(second));

    second.manifest.clock.stepNs += 1;
    assert.notEqual(computeSimulationSemanticHash(first), computeSimulationSemanticHash(second));
    assert.equal(simulationSemanticProjection(first).resolved.manifest.logging, undefined);
});

test("episode identity is profile-complete and backend-order independent", () => {
    const first = episode();
    const second = episode({
        backendSelections: [...first.backendSelections].reverse(),
        artifactPolicy: { profile: "disabled" },
        resourceLimits: { maxRssBytes: 1 },
    });
    assert.deepEqual(
        canonicalEpisodeIdentity(first).backendSelections,
        canonicalEpisodeIdentity(second).backendSelections,
    );
    assert.equal(computeEpisodeHash(first), computeEpisodeHash(second));
    assert.notEqual(computeEpisodeHash(first), computeEpisodeHash(episode({ resetSeed: "43" })));
});

test("trajectory hash is bounded, deterministic, and action-sensitive", () => {
    const episodeHash = computeEpisodeHash(episode());
    const run = (speed) => {
        const hasher = new TrajectoryHasher(episodeHash);
        hasher.update({
            step: 1,
            timeNs: 10,
            actions: [{ topic: "/controls/command", value: { speed } }],
            state: { x: speed / 10 },
        });
        hasher.update({
            step: 2,
            timeNs: 20,
            state: { x: speed / 5 },
        });
        return hasher.snapshot();
    };
    assert.deepEqual(run(2), run(2));
    assert.notEqual(run(2).trajectoryHash, run(3).trajectoryHash);
    assert.throws(() => {
        const hasher = new TrajectoryHasher(episodeHash);
        hasher.update({ step: 1 });
        hasher.update({ step: 1 });
    }, /increase monotonically/);
});

test("canonicalSimulationStringify golden string stays stable for mixed keys", () => {
    const value = {
        z: 2,
        a: { m: 1, "\u{1f600}": 2 },
        nested: [{ b: 1, a: 2 }],
    };
    const canonical = canonicalSimulationStringify(value);
    assert.equal(canonical, '{"a":{"m":1,"😀":2},"nested":[{"a":2,"b":1}],"z":2}');
    assert.equal(simulationSha256(value), "85f52aca8ef9bdeb38e685ace34fc7a3955d8cd3b0afd0e542a7a330b01d3172");
});
