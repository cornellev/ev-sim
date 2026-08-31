import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { computeResolvedRunHash } from "../app/simulation/RunManifest.js";
import { isTrainingLogSampled, resolveArtifactPolicy } from "../server/headless/HeadlessArtifactSink.js";
import { HeadlessRunner } from "../server/headless/HeadlessRunner.js";
import { inspectSflog } from "../server/headless/Inspection.js";
import { verifyRunBundle } from "../server/headless/RunBundle.js";
import { StorageService } from "../server/storage/StorageService.js";
import {
    createHeadlessImu,
    createPortableHeadlessBundle,
    rehashRunBundle,
    successfulTape,
} from "./helpers/headlessRunnerBundle.js";

async function temporaryRoot(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-sim-runner-test-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    return directory;
}

test("artifact policy translation and training sampling are deterministic", () => {
    const manifest = { logging: { policy: "required", profileId: "telemetry-default" } };
    assert.equal(resolveArtifactPolicy(null, manifest, "out").logRequired, true);
    assert.equal(resolveArtifactPolicy(null, { logging: { policy: "optional" } }, "out").logRequired, false);
    assert.equal(resolveArtifactPolicy(null, { logging: { policy: "disabled" } }, "out").profile, "disabled");
    const explicit = resolveArtifactPolicy({ profile: "training", fullSflogSampleRate: 0.5 }, manifest, "out");
    assert.equal(explicit.logRequired, true);
    assert.equal(explicit.profile, "evaluation");
    assert.equal(explicit.signalProfileId, "simulation-run-full-sensors");
    const episodeHash = "a".repeat(64);
    assert.equal(isTrainingLogSampled(episodeHash, 0.5), isTrainingLogSampled(episodeHash, 0.5));
    assert.equal(isTrainingLogSampled(episodeHash, 0), false);
    assert.equal(isTrainingLogSampled(episodeHash, 1), true);
    assert.throws(() => resolveArtifactPolicy({ profile: "training", fullSflogSampleRate: 1.1 }, manifest, "out"));
});

test("portable bundle verification preserves storage hashes and rejects mutations", async () => {
    const exported = await new StorageService().exportRunManifest("igvc-default");
    assert.equal(verifyRunBundle(exported).resolvedHash, exported.resolvedHash);

    const mutated = structuredClone(exported);
    mutated.resolved.manifest.name = "Mutated";
    assert.throws(() => verifyRunBundle(mutated), (error) => error.code === "BUNDLE_INVALID" || error.code === "BUNDLE_HASH_MISMATCH");

    const mismatch = structuredClone(exported);
    mismatch.resolvedHash = "0".repeat(64);
    assert.throws(() => verifyRunBundle(mismatch), (error) => error.code === "BUNDLE_HASH_MISMATCH");

    const worldMismatch = structuredClone(exported);
    worldMismatch.resolved.world.description.bounds.minX -= 1;
    worldMismatch.resolved.resolvedHash = computeResolvedRunHash(worldMismatch.resolved);
    worldMismatch.resolvedHash = worldMismatch.resolved.resolvedHash;
    assert.throws(() => verifyRunBundle(worldMismatch), (error) => error.code === "BUNDLE_HASH_MISMATCH");
});

test("runner validates a real IGVC-derived state-only portable bundle", async () => {
    const runner = new HeadlessRunner();
    const result = await runner.validate(await createPortableHeadlessBundle(), { episodeSpec: { actionRepeat: 5 } });
    assert.equal(result.ok, true);
    assert.match(result.episodeHash, /^[0-9a-f]{64}$/);

    const unsupported = await createPortableHeadlessBundle({ sensors: [createHeadlessImu({ id: "camera", type: "camera" })] });
    await assert.rejects(() => runner.validate(unsupported), (error) => error.code === "UNSUPPORTED_CAPABILITY");
});

test("runner replay is deterministic and output policy does not change trajectory identity", async (t) => {
    const root = await temporaryRoot(t);
    const bundle = await createPortableHeadlessBundle();
    const runner = new HeadlessRunner();
    const first = await runner.replay(bundle, successfulTape(), {
        outputUri: path.join(root, "first"),
        artifactPolicy: { profile: "disabled", outputUri: path.join(root, "first") },
    });
    const runnerWithDifferentProvenance = new HeadlessRunner({
        provenanceProvider: async (resolved) => ({
            kind: "cev-sim.headless.provenance",
            version: 1,
            runtimeName: "cev-sim-test",
            runtimeVersion: "different-provenance",
            gitHash: null,
            nodeVersion: "test",
            platform: "test",
            architecture: "test",
            backendSelections: structuredClone(resolved.backendSelections),
        }),
    });
    const second = await runnerWithDifferentProvenance.replay(bundle, successfulTape(), {
        outputUri: path.join(root, "second"),
        artifactPolicy: { profile: "evaluation", outputUri: path.join(root, "second") },
    });
    const changedTape = successfulTape();
    changedTape.actions[0].action = [0.5, 0];
    const changed = await runner.replay(bundle, changedTape, {
        outputUri: path.join(root, "changed"),
        artifactPolicy: { profile: "disabled", outputUri: path.join(root, "changed") },
    });
    assert.equal(first.result.passed, true);
    assert.equal(first.result.episodeHash, second.result.episodeHash);
    assert.equal(first.result.trajectoryHash, second.result.trajectoryHash);
    assert.notEqual(first.result.trajectoryHash, changed.result.trajectoryHash);
    assert.equal(await fs.stat(path.join(root, "first", "run-results.json")).then(() => true), true);
    await assert.rejects(() => fs.access(path.join(root, "first", "run.sflog")));
    assert.equal(await fs.stat(path.join(root, "second", "run.sflog")).then(() => true), true);
});

test("emitted SFLog is readable by existing replay data code and contains provenance attachments", async (t) => {
    const root = await temporaryRoot(t);
    const output = path.join(root, "evaluation");
    const runner = new HeadlessRunner();
    await runner.replay(await createPortableHeadlessBundle(), successfulTape(), {
        outputUri: output,
        artifactPolicy: { profile: "evaluation", outputUri: output },
    });
    const inspected = await inspectSflog(path.join(output, "run.sflog"));
    const names = inspected.attachments.map((entry) => entry.name);
    for (const name of ["run-manifest.json", "run-bundle.json", "calibration.json", "provenance.json", "run-results.json"]) {
        assert.equal(names.includes(name), true, `${name} should be attached`);
    }
    assert.equal(inspected.runResult.passed, true);
    assert.equal(inspected.signalPaths.includes("vehicles.ego.pose"), true);
    const provenance = JSON.parse(await fs.readFile(path.join(output, "provenance.json"), "utf8"));
    assert.deepEqual(provenance.backendSelections.map((entry) => entry.kind), [1, 2]);
});

test("training artifacts discard unselected successes and promote failures", async (t) => {
    const root = await temporaryRoot(t);
    const runner = new HeadlessRunner();
    const successOutput = path.join(root, "training-success");
    await runner.replay(await createPortableHeadlessBundle(), successfulTape(), {
        outputUri: successOutput,
        artifactPolicy: { profile: "training", fullSflogSampleRate: 0, outputUri: successOutput },
    });
    await assert.rejects(() => fs.access(path.join(successOutput, "run.sflog")));

    const failureOutput = path.join(root, "training-failure");
    const failing = await createPortableHeadlessBundle({
        assertions: [{
            id: "must-reach-step-99",
            name: "Must reach step 99",
            source: "signal",
            path: "simulation.step",
            selector: null,
            operator: "gte",
            expected: 99,
            tolerance: 0,
            mode: "eventually",
            window: { startStep: 1, endStep: 1 },
            severity: "error",
            onFailure: "stop",
        }],
    });
    const failed = await runner.replay(failing, successfulTape(), {
        outputUri: failureOutput,
        artifactPolicy: { profile: "training", fullSflogSampleRate: 0, fullSflogOnFailure: true, outputUri: failureOutput },
    });
    assert.equal(failed.result.passed, false);
    assert.equal(await fs.stat(path.join(failureOutput, "run.sflog")).then(() => true), true);
});

test("malformed actions do not publish a partial destination and existing outputs are refused", async (t) => {
    const root = await temporaryRoot(t);
    const bundle = await createPortableHeadlessBundle();
    const runner = new HeadlessRunner();
    const invalidOutput = path.join(root, "invalid");
    await assert.rejects(() => runner.run(bundle, {
        actions: [{ policyStep: 2, action: [0, 0] }],
        outputUri: invalidOutput,
        artifactPolicy: { profile: "disabled", outputUri: invalidOutput },
    }), (error) => error.code === "INVALID_REQUEST");
    await assert.rejects(() => fs.access(invalidOutput));

    const existingOutput = path.join(root, "existing");
    await fs.mkdir(existingOutput);
    await assert.rejects(() => runner.replay(bundle, successfulTape(), {
        outputUri: existingOutput,
        artifactPolicy: { profile: "disabled", outputUri: existingOutput },
    }), (error) => error.code === "ARTIFACT_FAILURE");
});

test("action EOF publishes an interrupted semantic result with complete core evidence", async (t) => {
    const root = await temporaryRoot(t);
    const output = path.join(root, "eof");
    const final = await new HeadlessRunner().run(await createPortableHeadlessBundle(), {
        episodeSpec: { actionRepeat: 5 },
        actions: [],
        outputUri: output,
        artifactPolicy: { profile: "disabled", outputUri: output },
    });
    assert.equal(final.result.passed, false);
    assert.equal(final.result.completed, false);
    assert.equal(final.result.interrupted, true);
    assert.equal(await fs.stat(path.join(output, "run-results.json")).then(() => true), true);
});

test("replay expectations fail semantically without changing the generated trajectory", async (t) => {
    const root = await temporaryRoot(t);
    const bundle = rehashRunBundle(await createPortableHeadlessBundle());
    const tape = successfulTape();
    tape.expect.trajectoryHash = "0".repeat(64);
    const result = await new HeadlessRunner().replay(bundle, tape, {
        outputUri: path.join(root, "mismatch"),
        artifactPolicy: { profile: "disabled", outputUri: path.join(root, "mismatch") },
    });
    assert.equal(result.result.passed, false);
    assert.deepEqual(result.result.expectationMismatches.map((entry) => entry.field), ["trajectoryHash"]);
});
