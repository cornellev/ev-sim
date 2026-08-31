import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { measuredStateProfileRef, routeSafetyProfileRef } from "../app/simulation/headless/ProfileRegistry.js";
import { namedTensor, tensorMap } from "../app/simulation/headless/TensorProtocol.js";
import { createStateSensorBackendSelection } from "../app/simulation/sensors/StateSensorBackend.js";
import { canonicalStringify } from "../app/simulation/RunManifest.js";
import { loadHeadlessGrpcSchema } from "../server/headless/GrpcSchema.js";
import { HeadlessRunner } from "../server/headless/HeadlessRunner.js";
import { parseTcpAddress, resolveSupervisorConfig, SUPERVISOR_PRESETS } from "../server/headless/SupervisorConfig.js";
import { startHeadlessSupervisor } from "../server/headless/SupervisorServer.js";
import { createHeadlessImu, createPortableHeadlessBundle, rehashRunBundle } from "./helpers/headlessRunnerBundle.js";

const cliPath = path.resolve("bin/cev-sim.js");
const parentChildPath = path.resolve("tests/helpers/headlessSupervisorParentChild.js");

async function temporaryRoot(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-supervisor-test-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

function episode(environmentIndex, bundleId, bundle) {
    return {
        environmentIndex,
        environmentId: `environment-${environmentIndex}`,
        runBundleId: bundleId,
        resetSeed: String(100 + environmentIndex),
        actionRepeat: 5,
        maxEpisodeSteps: "0",
        observationProfile: measuredStateProfileRef(),
        rewardProfile: routeSafetyProfileRef(),
        backendSelections: [...bundle.resolved.backendSelections, createStateSensorBackendSelection()],
    };
}

function bundleEnvelope(bundleId, bundle) {
    return {
        bundleId,
        resolvedHash: bundle.resolvedHash,
        simulationSemanticHash: bundle.simulationSemanticHash,
        canonicalJson: Buffer.from(canonicalStringify(bundle)),
    };
}

function zeroAction(environmentIndex) {
    return {
        environmentIndex,
        action: tensorMap([namedTensor("action", "float32", [2], [0, 0])]),
    };
}

function clientCall(client, method, request) {
    return new Promise((resolve, reject) => client[method](request, (error, response) => error ? reject(error) : resolve(response)));
}

function runCli(args, input = "") {
    return new Promise((resolve, reject) => {
        const child = spawn(cliPath, args, { cwd: path.resolve("."), stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
        child.stdin.end(input);
    });
}

function firstLine(stream, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        let value = "";
        const timer = setTimeout(() => finish(new Error(`No output line arrived within ${timeoutMs} ms.`)), timeoutMs);
        const finish = (error, line = null) => {
            clearTimeout(timer);
            stream.removeListener("data", onData);
            stream.removeListener("error", onError);
            if (error) reject(error);
            else resolve(line);
        };
        const onError = (error) => finish(error);
        const onData = (chunk) => {
            value += chunk;
            const newline = value.indexOf("\n");
            if (newline >= 0) finish(null, value.slice(0, newline));
        };
        stream.setEncoding("utf8");
        stream.on("data", onData);
        stream.on("error", onError);
    });
}

function jsonLines(value) {
    return value.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function firstPackedBytes(tensorMapValue) {
    const packed = tensorMapValue.entries[0].tensor.payload.packedData;
    if (Buffer.isBuffer(packed) || packed instanceof Uint8Array) return Buffer.from(packed);
    return Buffer.from(packed.data, "base64");
}

function availableTcpPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

async function fixture(t, options = {}) {
    const root = await temporaryRoot(t);
    const socket = path.join(root, "supervisor.sock");
    const running = await startHeadlessSupervisor({ socket, ...options });
    const { grpc, service } = loadHeadlessGrpcSchema();
    const client = new service(`unix:${socket}`, grpc.credentials.createInsecure(), {
        "grpc.max_receive_message_length": running.config.maxRpcMessageBytes,
        "grpc.max_send_message_length": running.config.maxRpcMessageBytes,
    });
    t.after(async () => {
        client.close();
        await running.close();
    });
    return { root, socket, running, client, call: (method, request) => clientCall(client, method, request) };
}

function testConfig(overrides = {}) {
    return {
        kind: "cev-sim.headless-supervisor-config",
        version: 1,
        ...overrides,
    };
}

async function waitFor(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Condition was not met within ${timeoutMs} ms.`);
}

test("protocol 1.2, dynamic schema, presets, config precedence, and TCP protection", async () => {
    const { service } = loadHeadlessGrpcSchema();
    assert.ok(service.service.CreateBatch);
    assert.equal(SUPERVISOR_PRESETS.safety.maxRpcMessageBytes, 64 * 1024 * 1024);
    assert.equal(SUPERVISOR_PRESETS.permissive.limits.restartBudget, 3);
    const config = resolveSupervisorConfig({
        socket: "/tmp/cev-config-test.sock",
        preset: "permissive",
        config: {
            kind: "cev-sim.headless-supervisor-config",
            version: 1,
            maxWorkers: 7,
            defaultLimits: { maxSensorsPerEnvironment: 12 },
            hardCeilings: { maxSensorsPerEnvironment: 20 },
        },
    });
    assert.equal(config.preset, "permissive");
    assert.equal(config.maxWorkers, 7);
    assert.equal(config.defaultLimits.maxSensorsPerEnvironment, 12);
    assert.equal(config.defaultLimits.maxObservationBytes, 64 * 1024 * 1024);
    assert.throws(() => resolveSupervisorConfig({ socket: "/tmp/a", config: {} }), /config kind/);
    assert.throws(() => resolveSupervisorConfig({ tcp: "0.0.0.0:50051" }), /allow-remote-tcp/);
    assert.equal(resolveSupervisorConfig({ tcp: "127.0.0.1:50051" }).listener.kind, "tcp");
    assert.equal(parseTcpAddress("[::1]:50051").address, "[::1]:50051");
    assert.throws(() => resolveSupervisorConfig({ socket: "/tmp/a", tcp: "127.0.0.1:1" }), /Exactly one/);
});

test("real Unix-socket gRPC batches preserve stable ordering at 1, 8, 16, and 32 processes", { timeout: 120_000 }, async (t) => {
    const { root, running, call } = await fixture(t);
    const bundle = await createPortableHeadlessBundle();
    const bundleId = "portable";
    for (const count of [1, 8, 16, 32]) {
        const episodes = Array.from({ length: count }, (_, index) => episode(index, bundleId, bundle));
        const created = await call("createBatch", {
            clientProtocol: { major: 1, minor: 1 },
            runBundles: [bundleEnvelope(bundleId, bundle)],
            episodes,
            artifactPolicy: { profile: 3, outputUri: path.join(root, `artifacts-${count}`) },
        });
        assert.equal(created.error.code, 0, created.error.message);
        assert.deepEqual(created.batch.environments.map((entry) => entry.environmentIndex), episodes.map((entry) => entry.environmentIndex));
        const batchId = created.batch.batchId;
        const reset = await call("resetBatch", { batchId, episodes });
        assert.equal(reset.error.code, 0, reset.error.message);
        assert.deepEqual(reset.results.map((entry) => entry.environmentIndex), episodes.map((entry) => entry.environmentIndex));
        const stepped = await call("stepBatch", { batchId, actions: episodes.map((entry) => zeroAction(entry.environmentIndex)) });
        assert.equal(stepped.error.code, 0, stepped.error.message);
        assert.deepEqual(stepped.results.map((entry) => entry.environmentIndex), episodes.map((entry) => entry.environmentIndex));
        assert.ok(stepped.results.every((entry) => entry.terminated && entry.error.code === 0));
        const finalized = await call("finalizeBatch", { batchId, environmentIndices: [] });
        assert.equal(finalized.error.code, 0, finalized.error.message);
        assert.deepEqual(finalized.results.map((entry) => entry.environmentIndex), episodes.map((entry) => entry.environmentIndex));
        assert.ok(finalized.results.every((entry) => entry.passed));
        for (const result of finalized.results) {
            assert.ok(result.artifacts.every((artifact) => artifact.uri.includes(
                path.join(batchId, `env-${result.environmentIndex}`, `episode-1-${result.episodeHash.slice(0, 12)}`),
            )));
        }
        const pids = running.supervisor.batches.get(batchId).environments.map((entry) => entry.worker.pid);
        const closed = await call("closeBatch", { batchId, finalizeActiveEpisodes: false });
        assert.equal(closed.error.code, 0, closed.error.message);
        await waitFor(() => pids.every((pid) => {
            try { process.kill(pid, 0); return false; } catch { return true; }
        }));
    }
});

test("gRPC, direct runner, and CLI preserve episode hashes, trajectory hashes, and packed tensors", { timeout: 30_000 }, async (t) => {
    const { root, call } = await fixture(t);
    const bundle = await createPortableHeadlessBundle();
    const bundleId = "parity";
    const spec = episode(0, bundleId, bundle);
    const directEvents = [];
    const direct = await new HeadlessRunner().run(bundle, {
        episodeSpec: spec,
        actions: [{ policyStep: 1, action: [0, 0] }],
        outputUri: path.join(root, "direct"),
        artifactPolicy: { profile: "disabled", outputUri: path.join(root, "direct") },
        onEvent: (event) => directEvents.push(event),
    });
    const bundlePath = path.join(root, "bundle.json");
    const episodePath = path.join(root, "episode.json");
    await fs.writeFile(bundlePath, JSON.stringify(bundle));
    await fs.writeFile(episodePath, JSON.stringify(spec));
    const cli = await runCli([
        "run", "--bundle", bundlePath, "--episode", episodePath, "--output", path.join(root, "cli"), "--artifact-profile", "disabled",
    ], `${JSON.stringify({ policyStep: 1, action: [0, 0] })}\n`);
    assert.equal(cli.code, 0, cli.stderr);
    const cliEvents = jsonLines(cli.stdout);
    const created = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes: [spec],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "grpc") },
    });
    const batchId = created.batch.batchId;
    const grpcReset = await call("resetBatch", { batchId, episodes: [spec] });
    const resetBeforeFinalize = await call("resetBatch", { batchId, episodes: [spec] });
    assert.equal(resetBeforeFinalize.error.code, 0);
    assert.equal(resetBeforeFinalize.results[0].error.code, 1);
    const grpcStep = await call("stepBatch", { batchId, actions: [zeroAction(0)] });
    const grpcFinal = await call("finalizeBatch", { batchId, environmentIndices: [] });
    const grpcFinalAgain = await call("finalizeBatch", { batchId, environmentIndices: [0] });
    assert.equal(grpcFinalAgain.results[0].trajectoryHash, grpcFinal.results[0].trajectoryHash);
    assert.equal(direct.result.episodeHash, grpcFinal.results[0].episodeHash);
    assert.equal(direct.result.trajectoryHash, grpcFinal.results[0].trajectoryHash);
    assert.equal(cliEvents.at(-1).result.episodeHash, grpcFinal.results[0].episodeHash);
    assert.equal(cliEvents.at(-1).result.trajectoryHash, grpcFinal.results[0].trajectoryHash);
    assert.deepEqual(firstPackedBytes(directEvents[0].observation), firstPackedBytes(grpcReset.results[0].observation));
    assert.deepEqual(firstPackedBytes(cliEvents[0].observation), firstPackedBytes(grpcReset.results[0].observation));
    assert.deepEqual(firstPackedBytes(directEvents[1].observation), firstPackedBytes(grpcStep.results[0].observation));
    await call("closeBatch", { batchId });
});

test("insecure TCP requires opt-in for remote hosts and works on loopback", async (t) => {
    const port = await availableTcpPort();
    const running = await startHeadlessSupervisor({ tcp: `127.0.0.1:${port}` });
    const { grpc, service } = loadHeadlessGrpcSchema();
    const client = new service(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    t.after(async () => {
        client.close();
        await running.close();
    });
    const response = await clientCall(client, "getCapabilities", { clientProtocol: { major: 1, minor: 0 } });
    assert.equal(response.error.code, 0);
    assert.deepEqual(response.protocol, { major: 1, minor: 2 });
    const diagnostics = JSON.parse(Buffer.from(response.diagnosticJson).toString("utf8"));
    assert.equal(diagnostics.gpuProbe.available, false);
    assert.equal(diagnostics.gpuRenderer.browserLaunches, 0);
    const lidar = response.backends.find((backend) => backend.kind === 3);
    assert.equal(lidar.id, "deterministic-cpu-bvh-lidar");
    assert.equal(lidar.version, "1");
    assert.equal(lidar.available, true);
    assert.deepEqual(lidar.sensorTypes, ["lidar3d"]);
});

test("multiple batches coexist and malformed requests fail in response envelopes", { timeout: 30_000 }, async (t) => {
    const { root, call } = await fixture(t);
    const bundle = await createPortableHeadlessBundle();
    const make = (name, offset = 0) => call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope(name, bundle)],
        episodes: [0, 1].map((index) => ({ ...episode(index, name, bundle), resetSeed: String(index + offset) })),
        artifactPolicy: { profile: 3, outputUri: path.join(root, name) },
    });
    const [first, second] = await Promise.all([make("first"), make("second", 10)]);
    assert.equal(first.error.code, 0);
    assert.equal(second.error.code, 0);
    const health = await call("health", { includeEnvironments: true });
    assert.equal(health.activeBatches, 2);
    assert.equal(health.activeEnvironments, 4);
    assert.deepEqual(health.environments.map((entry) => `${entry.batchId}:${entry.environmentIndex}`), [...health.environments]
        .sort((left, right) => Buffer.from(left.batchId).compare(Buffer.from(right.batchId)) || left.environmentIndex - right.environmentIndex)
        .map((entry) => `${entry.batchId}:${entry.environmentIndex}`));
    const protocol = await call("getCapabilities", { clientProtocol: { major: 1, minor: 3 } });
    assert.equal(protocol.error.code, 2);
    const malformed = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("bad", bundle)],
        episodes: [episode(1, "bad", bundle)],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "bad") },
    });
    assert.equal(malformed.error.code, 1);
    const noncanonicalEnvelope = bundleEnvelope("noncanonical", bundle);
    noncanonicalEnvelope.canonicalJson = Buffer.from(JSON.stringify(bundle, null, 2));
    const noncanonical = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [noncanonicalEnvelope],
        episodes: [episode(0, "noncanonical", bundle)],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "noncanonical") },
    });
    assert.equal(noncanonical.error.code, 3);
    await Promise.all([first, second].map((created) => call("closeBatch", { batchId: created.batch.batchId })));
});

test("concurrent batch creation reserves capacity atomically", { timeout: 30_000 }, async (t) => {
    const { root, call } = await fixture(t, { config: testConfig({ maxWorkers: 1 }) });
    const bundle = await createPortableHeadlessBundle();
    const create = (name) => call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope(name, bundle)],
        episodes: [episode(0, name, bundle)],
        artifactPolicy: { profile: 3, outputUri: path.join(root, name) },
    });
    const responses = await Promise.all([create("capacity-a"), create("capacity-b")]);
    assert.deepEqual(responses.map((entry) => entry.error.code).sort((left, right) => left - right), [0, 10]);
    const created = responses.find((entry) => entry.error.code === 0);
    await call("closeBatch", { batchId: created.batch.batchId });
});

test("worker crashes restart without replay and exhausted budgets fault only that environment", { timeout: 30_000 }, async (t) => {
    const { root, running, call } = await fixture(t);
    const bundle = await createPortableHeadlessBundle();
    const bundleId = "recovery";
    const episodes = [0, 1].map((index) => episode(index, bundleId, bundle));
    const created = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes,
        resourceLimits: { restartBudget: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "recovery") },
    });
    assert.equal(created.error.code, 0, created.error.message);
    const batchId = created.batch.batchId;
    const reset = await call("resetBatch", { batchId, episodes });
    assert.ok(reset.results.every((entry) => entry.error.code === 0));
    const batch = running.supervisor.batches.get(batchId);
    batch.environments[0].worker.terminate("SIGKILL");
    await waitFor(() => batch.environments[0].state === "prepared");
    let health = await call("health", { includeEnvironments: true });
    const recovered = health.environments.find((entry) => entry.batchId === batchId && entry.environmentIndex === 0);
    assert.equal(recovered.restartCount, 1);
    assert.equal(recovered.requiresReset, true);
    const peerStep = await call("stepBatch", { batchId, actions: [zeroAction(1)] });
    assert.equal(peerStep.error.code, 0);
    assert.equal(peerStep.results[0].environmentIndex, 1);
    assert.equal(peerStep.results[0].terminated, true);
    const resetRecovered = await call("resetBatch", { batchId, episodes: [episodes[0]] });
    assert.equal(resetRecovered.results[0].error.code, 0);
    batch.environments[0].worker.terminate("SIGKILL");
    await waitFor(() => batch.environments[0].state === "faulted");
    health = await call("health", { includeEnvironments: true });
    const faulted = health.environments.find((entry) => entry.batchId === batchId && entry.environmentIndex === 0);
    assert.equal(health.state, 2);
    assert.equal(faulted.restartCount, 1);
    assert.equal(faulted.requiresReset, true);
    await call("closeBatch", { batchId, finalizeActiveEpisodes: false });
});

test("observation and queue breaches are infrastructure errors without RL transition payloads", { timeout: 30_000 }, async (t) => {
    const { root, call } = await fixture(t);
    const bundle = await createPortableHeadlessBundle();
    const bundleId = "limits";
    const spec = episode(0, bundleId, bundle);
    const created = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes: [spec],
        resourceLimits: { maxObservationBytes: 1, restartBudget: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "limits") },
    });
    assert.equal(created.error.code, 0, created.error.message);
    const reset = await call("resetBatch", { batchId: created.batch.batchId, episodes: [spec] });
    assert.equal(reset.error.code, 0);
    assert.equal(reset.results[0].error.code, 10);
    assert.equal(reset.results[0].observation, null);
    assert.equal(reset.results[0].info, null);
    await call("closeBatch", { batchId: created.batch.batchId });

    const queue = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("queue", bundle)],
        episodes: [episode(0, "queue", bundle)],
        resourceLimits: { maxQueueBytes: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "queue") },
    });
    assert.equal(queue.error.code, 10);
    assert.equal(queue.batch, null);
});

test("RSS and reported heap breaches reject or restart only the affected environment", { timeout: 30_000 }, async (t) => {
    const { root, running, call } = await fixture(t, { config: testConfig({ shutdownGraceMs: 50, killGraceMs: 50 }) });
    const bundle = await createPortableHeadlessBundle();
    const rss = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("rss", bundle)],
        episodes: [episode(0, "rss", bundle)],
        resourceLimits: { maxRssBytesPerEnvironment: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "rss") },
    });
    assert.equal(rss.error.code, 10);
    assert.equal(rss.batch, null);

    const created = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("heap", bundle)],
        episodes: [episode(0, "heap", bundle)],
        resourceLimits: { restartBudget: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "heap") },
    });
    const batch = running.supervisor.batches.get(created.batch.batchId);
    const environment = batch.environments[0];
    const oldPid = environment.worker.pid;
    const normalLimits = environment.batch.limits;
    environment.batch.limits = { ...environment.batch.limits, maxHeapBytesPerEnvironment: 1 };
    running.supervisor._observeHealth(environment, { ...environment.health, heapBytes: 2 });
    environment.batch.limits = normalLimits;
    await waitFor(() => environment.state === "prepared" && environment.restartCount === 1);
    assert.equal(environment.requiresReset, true);
    assert.notEqual(environment.worker.pid, oldPid);
    await call("closeBatch", { batchId: batch.id });
});

test("uncertain IPC backpressure restarts one worker while its peer completes", { timeout: 30_000 }, async (t) => {
    const { root, running, call } = await fixture(t, { config: testConfig({ shutdownGraceMs: 50, killGraceMs: 50 }) });
    const bundle = await createPortableHeadlessBundle();
    const bundleId = "backpressure";
    const episodes = [0, 1].map((index) => episode(index, bundleId, bundle));
    const created = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes,
        resourceLimits: { restartBudget: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "backpressure") },
    });
    const batchId = created.batch.batchId;
    await call("resetBatch", { batchId, episodes });
    const environment = running.supervisor.batches.get(batchId).environments[0];
    const send = environment.worker.child.send.bind(environment.worker.child);
    environment.worker.child.send = (message, callback) => {
        send(message, callback);
        return false;
    };
    const stepped = await call("stepBatch", { batchId, actions: [zeroAction(0), zeroAction(1)] });
    assert.equal(stepped.results[0].error.code, 10);
    assert.equal(stepped.results[0].observation, null);
    assert.equal(stepped.results[1].error.code, 0);
    await waitFor(() => environment.state === "prepared");
    assert.equal(environment.requiresReset, true);
    await call("closeBatch", { batchId });
});

test("client cancellation is a transport error and an uncertain worker is reset", { timeout: 30_000 }, async (t) => {
    if (process.platform === "win32") t.skip("SIGSTOP is POSIX-only.");
    const { grpc } = loadHeadlessGrpcSchema();
    const { root, running, client, call } = await fixture(t, { config: testConfig({ shutdownGraceMs: 50, killGraceMs: 50 }) });
    const bundle = await createPortableHeadlessBundle();
    const spec = episode(0, "cancel", bundle);
    const created = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("cancel", bundle)],
        episodes: [spec],
        resourceLimits: { restartBudget: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "cancel") },
    });
    const batchId = created.batch.batchId;
    await call("resetBatch", { batchId, episodes: [spec] });
    const environment = running.supervisor.batches.get(batchId).environments[0];
    process.kill(environment.worker.pid, "SIGSTOP");
    let rpc;
    const cancelled = new Promise((resolve) => {
        rpc = client.stepBatch({ batchId, actions: [zeroAction(0)] }, (error) => resolve(error));
    });
    await waitFor(() => environment.worker?.pending !== null);
    rpc.cancel();
    const error = await cancelled;
    assert.equal(error.code, grpc.status.CANCELLED);
    await waitFor(() => environment.state === "prepared");
    assert.equal(environment.requiresReset, true);
    await call("closeBatch", { batchId });
});

test("partial action failures let healthy peers finish and never fabricate transitions", { timeout: 30_000 }, async (t) => {
    const { root, call } = await fixture(t);
    const bundle = await createPortableHeadlessBundle();
    const bundleId = "partial";
    const episodes = [0, 1].map((index) => episode(index, bundleId, bundle));
    const created = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes,
        artifactPolicy: { profile: 3, outputUri: path.join(root, "partial") },
    });
    const batchId = created.batch.batchId;
    await call("resetBatch", { batchId, episodes });
    const stepped = await call("stepBatch", {
        batchId,
        actions: [
            { environmentIndex: 0, action: tensorMap([namedTensor("wrong", "float32", [2], [0, 0])]) },
            zeroAction(1),
        ],
    });
    assert.equal(stepped.error.code, 0);
    assert.equal(stepped.results[0].error.code, 1);
    assert.equal(stepped.results[0].observation, null);
    assert.equal(stepped.results[0].info, null);
    assert.equal(stepped.results[0].reward, 0);
    assert.equal(stepped.results[0].terminated, false);
    assert.equal(stepped.results[0].truncated, false);
    assert.equal(stepped.results[1].error.code, 0);
    assert.equal(stepped.results[1].terminated, true);
    await call("closeBatch", { batchId });
});

test("static sensor/actor limits, incompatible spaces, artifact limits, and episode watchdogs fail explicitly", { timeout: 30_000 }, async (t) => {
    const { root, running, call } = await fixture(t, { config: testConfig({ shutdownGraceMs: 50, killGraceMs: 50 }) });
    const twoSensors = await createPortableHeadlessBundle({
        sensors: [createHeadlessImu({ id: "imu-a" }), createHeadlessImu({ id: "imu-b" })],
    });
    const sensorLimited = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("sensor-limit", twoSensors)],
        episodes: [episode(0, "sensor-limit", twoSensors)],
        resourceLimits: { maxSensorsPerEnvironment: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "sensor-limit") },
    });
    assert.equal(sensorLimited.error.code, 10);

    const actors = await createPortableHeadlessBundle();
    actors.resolved.scenario.scenario.actors.push({ id: "npc", role: "npc", name: "NPC" });
    const actorBundle = rehashRunBundle(actors);
    const actorLimited = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("actor-limit", actorBundle)],
        episodes: [episode(0, "actor-limit", actorBundle)],
        resourceLimits: { maxActorsPerEnvironment: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "actor-limit") },
    });
    assert.equal(actorLimited.error.code, 10);

    const oneSensor = await createPortableHeadlessBundle();
    const incompatible = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("one", oneSensor), bundleEnvelope("two", twoSensors)],
        episodes: [episode(0, "one", oneSensor), episode(1, "two", twoSensors)],
        artifactPolicy: { profile: 3, outputUri: path.join(root, "incompatible") },
    });
    assert.equal(incompatible.error.code, 5);

    const artifactSpec = episode(0, "artifact", oneSensor);
    const artifact = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("artifact", oneSensor)],
        episodes: [artifactSpec],
        resourceLimits: { maxArtifactBytes: 1, restartBudget: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "artifact") },
    });
    await call("resetBatch", { batchId: artifact.batch.batchId, episodes: [artifactSpec] });
    await call("stepBatch", { batchId: artifact.batch.batchId, actions: [zeroAction(0)] });
    const artifactFinal = await call("finalizeBatch", { batchId: artifact.batch.batchId, environmentIndices: [] });
    assert.equal(artifactFinal.results[0].error.code, 10);
    assert.equal(artifactFinal.results[0].canonicalResultJson.length, 0);
    await call("closeBatch", { batchId: artifact.batch.batchId });

    const timeoutSpec = episode(0, "timeout", oneSensor);
    const timeout = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("timeout", oneSensor)],
        episodes: [timeoutSpec],
        resourceLimits: { episodeWallTimeoutMs: 20, restartBudget: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "timeout") },
    });
    const timeoutBatch = running.supervisor.batches.get(timeout.batch.batchId);
    await call("resetBatch", { batchId: timeout.batch.batchId, episodes: [timeoutSpec] });
    await waitFor(() => timeoutBatch.environments[0].state === "prepared");
    assert.equal(timeoutBatch.environments[0].restartCount, 1);
    assert.equal(timeoutBatch.environments[0].requiresReset, true);
    await call("closeBatch", { batchId: timeout.batch.batchId });
});

test("step watchdog kills an uncertain worker while a peer completes", { timeout: 30_000 }, async (t) => {
    if (process.platform === "win32") t.skip("SIGSTOP is POSIX-only.");
    const { root, running, call } = await fixture(t, { config: testConfig({ shutdownGraceMs: 50, killGraceMs: 50 }) });
    const bundle = await createPortableHeadlessBundle();
    const bundleId = "step-timeout";
    const episodes = [0, 1].map((index) => episode(index, bundleId, bundle));
    const created = await call("createBatch", {
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope(bundleId, bundle)],
        episodes,
        resourceLimits: { restartBudget: 1 },
        artifactPolicy: { profile: 3, outputUri: path.join(root, "step-timeout") },
    });
    const batchId = created.batch.batchId;
    await call("resetBatch", { batchId, episodes });
    const batch = running.supervisor.batches.get(batchId);
    batch.limits = { ...batch.limits, stepWallTimeoutMs: 250 };
    process.kill(batch.environments[0].worker.pid, "SIGSTOP");
    const stepped = await call("stepBatch", { batchId, actions: [zeroAction(0), zeroAction(1)] });
    assert.equal(stepped.results[0].error.code, 11);
    assert.equal(stepped.results[0].observation, null);
    assert.equal(stepped.results[0].info, null);
    assert.equal(stepped.results[1].error.code, 0);
    assert.equal(stepped.results[1].terminated, true);
    await waitFor(() => batch.environments[0].state === "prepared");
    assert.equal(batch.environments[0].requiresReset, true);
    await call("closeBatch", { batchId });
});

test("workers exit after abrupt supervisor-parent death", { timeout: 30_000 }, async (t) => {
    if (process.platform === "win32") t.skip("Process signals are POSIX-only.");
    const root = await temporaryRoot(t);
    const child = fork(parentChildPath, [root], {
        serialization: "advanced",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: ["--experimental-default-type=module"],
    });
    const workerPid = await new Promise((resolve, reject) => {
        child.once("message", (message) => message?.workerPid ? resolve(message.workerPid) : reject(new Error("Parent child did not report a worker PID.")));
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Parent child exited early with ${code}.`)));
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    await waitFor(() => {
        try { process.kill(workerPid, 0); return false; } catch { return true; }
    });
});

test("forced shutdown kills stopped workers and removes sockets and known staging paths", { timeout: 30_000 }, async (t) => {
    if (process.platform === "win32") t.skip("SIGSTOP is POSIX-only.");
    const root = await temporaryRoot(t);
    const socket = path.join(root, "forced.sock");
    const running = await startHeadlessSupervisor({
        socket,
        config: testConfig({ shutdownGraceMs: 50, killGraceMs: 50 }),
    });
    t.after(() => running.close());
    const bundle = await createPortableHeadlessBundle();
    const spec = episode(0, "forced", bundle);
    const outputUri = path.join(root, "forced-artifacts");
    const created = await running.supervisor.createBatch({
        clientProtocol: { major: 1, minor: 1 },
        runBundles: [bundleEnvelope("forced", bundle)],
        episodes: [spec],
        artifactPolicy: { profile: 3, outputUri },
    });
    const batch = running.supervisor.batches.get(created.batch.batchId);
    const pid = batch.environments[0].worker.pid;
    const partial = path.join(outputUri, batch.id, "env-0", ".episode-test.tmp-partial");
    await fs.mkdir(partial, { recursive: true });
    await fs.writeFile(path.join(partial, "partial.json"), "{}");
    process.kill(pid, "SIGSTOP");
    await running.close();
    await assert.rejects(fs.access(socket));
    await assert.rejects(fs.access(partial));
    await waitFor(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
    });
});

test("the supervisor CLI shuts down cleanly and removes its Unix socket", { timeout: 30_000 }, async (t) => {
    const root = await temporaryRoot(t);
    const socket = path.join(root, "cli.sock");
    const child = spawn(cliPath, ["supervisor", "--socket", socket], {
        cwd: path.resolve("."),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const listening = JSON.parse(await firstLine(child.stdout));
    assert.equal(listening.protocol.minor, 2);
    assert.equal(listening.transport, "socket");
    await fs.access(socket);
    child.kill("SIGTERM");
    const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(result, { code: 0, signal: null }, stderr);
    await assert.rejects(fs.access(socket));
});
