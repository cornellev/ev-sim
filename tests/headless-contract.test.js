import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { generateHeadlessCharacterization } from "./helpers/headlessCharacterization.js";

const root = new URL("../", import.meta.url);
const protoUrl = new URL("proto/cev_sim/headless/v1/headless.proto", root);
const tapeUrl = new URL("tests/fixtures/headless/action-tape.v1.json", root);
const characterizationUrl = new URL("tests/fixtures/headless/characterization.v1.json", root);

async function readJson(url) {
    return JSON.parse(await readFile(url, "utf8"));
}

function declarationBody(source, kind, name) {
    const start = source.indexOf(`${kind} ${name}`);
    assert.notEqual(start, -1, `${kind} ${name} must exist`);
    const open = source.indexOf("{", start);
    assert.notEqual(open, -1, `${kind} ${name} must have a body`);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
        if (source[index] === "{") depth += 1;
        if (source[index] === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(open + 1, index);
        }
    }
    assert.fail(`${kind} ${name} has an unterminated body`);
}

test("headless protobuf v1 declares the complete lifecycle service", async () => {
    const proto = await readFile(protoUrl, "utf8");
    assert.match(proto, /syntax = "proto3";/);
    assert.match(proto, /package cev_sim\.headless\.v1;/);

    const service = declarationBody(proto, "service", "HeadlessSimulationService");
    for (const operation of [
        "GetCapabilities",
        "CreateBatch",
        "ResetBatch",
        "StepBatch",
        "FinalizeBatch",
        "CloseBatch",
        "Health",
    ]) {
        assert.match(service, new RegExp(`rpc ${operation}\\(`));
    }
});

test("episode semantics stay separate from operational and artifact policy", async () => {
    const proto = await readFile(protoUrl, "utf8");
    const episode = declarationBody(proto, "message", "EpisodeSpec");
    for (const field of [
        "environment_index",
        "run_bundle_id",
        "reset_seed",
        "action_repeat",
        "max_episode_steps",
        "observation_profile",
        "reward_profile",
        "backend_selections",
    ]) {
        assert.match(episode, new RegExp(`\\b${field}\\b`));
    }
    assert.doesNotMatch(episode, /\bResourceLimits\b|\bArtifactPolicy\b/);

    const create = declarationBody(proto, "message", "CreateBatchRequest");
    assert.match(create, /\bResourceLimits resource_limits\b/);
    assert.match(create, /\bArtifactPolicy artifact_policy\b/);
    const limits = declarationBody(proto, "message", "ResourceLimits");
    assert.match(limits, /uint64 max_shared_memory_bytes_per_environment = 11;/);
    assert.match(limits, /uint64 max_gpu_bytes_per_environment = 12;/);
    const capabilities = declarationBody(proto, "message", "GetCapabilitiesResponse");
    assert.match(capabilities, /bytes diagnostic_json = 11;/);

    const errors = declarationBody(proto, "enum", "ErrorCode");
    assert.match(errors, /ERROR_CODE_OK = 0;/);
    assert.match(errors, /ERROR_CODE_WORKER_CRASHED/);
    assert.match(proto, /message SharedMemoryRef/);
    assert.match(proto, /oneof storage/);
    const health = declarationBody(proto, "message", "EnvironmentHealth");
    assert.match(health, /string batch_id = 7;/);
    assert.match(health, /uint32 restart_count = 8;/);
    assert.match(health, /bool requires_reset = 9;/);
});

test("headless characterization fixture regenerates from the current runtime", async () => {
    const tape = await readJson(tapeUrl);
    const expected = await readJson(characterizationUrl);
    const generated = await generateHeadlessCharacterization(tape);

    assert.deepEqual(generated, expected);
    assert.equal(generated.verification.resetReplayMatches, true);
    assert.equal(generated.verification.freshRuntimeMatches, true);
    assert.equal(generated.snapshots.length, generated.run.maxSteps);
    assert.deepEqual(generated.phaseOrder, [
        "inputs",
        "scripts",
        "controls",
        "vehicles",
        "physics",
        "controls-achieved",
        "contacts",
        "clock",
        "transforms",
        "sensors",
        "delivery",
        "candidate-viz",
        "assertions",
    ]);
    assert.equal(generated.assertions[0].status, "passed");
    assert.equal(generated.metrics.commandsApplied, tape.actions.length);
    for (const hash of Object.values(generated.hashes)) {
        assert.match(hash, /^[a-f0-9]{64}$/);
    }
});
