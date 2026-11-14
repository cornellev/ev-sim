import assert from "node:assert/strict";
import test from "node:test";
import { HeadlessExternalSession } from "../server/headless/HeadlessExternalSession.js";
import { HeadlessSession } from "../server/headless/HeadlessSession.js";
import { HeadlessRunner } from "../server/headless/HeadlessRunner.js";
import { encodeMessage, decodeMessage } from "../app/interfaces/ProtobufSchema.js";
import { externalBundle, controllerSchema, fakeZenohBinding, zenohRuntimeFactory } from "./helpers/headlessZenoh.js";
import { zenohHostConfig } from "./helpers/zenohFixtures.js";
import { main } from "../server/headless/Cli.js";
import { HeadlessSupervisor } from "../server/headless/HeadlessSupervisor.js";
import { WorkerHandle } from "../server/headless/WorkerHandle.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const commandType = controllerSchema.root.lookupType("headless_test.Command");
const stateType = controllerSchema.root.lookupType("headless_test.State");
const sink = () => ({ async start() {}, async finalize(runResult) { return { runResult, artifacts: [], outputDirectory: null }; }, async abort() {} });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, "condition timed out"); await pause(2); } }

function sessionFor(binding = fakeZenohBinding(), options = {}) {
    return { binding, session: new HeadlessExternalSession({ artifactSinkFactory: sink,
        zenohTransport: zenohHostConfig(), zenohRuntimeFactory: zenohRuntimeFactory(binding), ...options }) };
}
function send(binding, session, overrides = {}) {
    const value = { run: session.runId, sequence: "1", capture: session.kernel.timeNs, deadline: 0, speed: 1.5, steering: 0.15, ...overrides };
    binding.sessions.at(-1).receive(encodeMessage(commandType, value));
}

test("external controls enter the next fixed step; identity, sequence, pause and reset are fenced", async (t) => {
    const { session, binding } = sessionFor();
    t.after(() => session.close());
    const bundle = await externalBundle({ maxSteps: 80 });
    await session.prepare(bundle); await session.start();
    const time = session.kernel.timeNs;
    send(binding, session, { run: "wrong-run" });
    assert.equal(session.kernel.inputQueue.queue.length, 0);
    send(binding, session);
    assert.equal(session.kernel.timeNs, time);
    assert.equal(session.kernel.inputQueue.queue.length, 1);
    await until(() => session.completedStep >= 3);
    const state = session.kernel.controlRuntime.states.get("ego");
    assert.equal(state.lastSequence, "1");
    assert.ok(state.applied.speedMps > 0);
    send(binding, session);
    await until(() => session.completedStep >= 5);
    assert.ok(session.kernel.telemetry.events().some((event) => event.name === "command-rejected"));
    await until(() => session.completedStep >= 20);
    assert.equal(state.timedOut, true);
    assert.equal(state.applied.speedMps, 0);
    await session.pause();
    const paused = session.completedStep;
    send(binding, session, { sequence: "2" });
    await pause(30); assert.equal(session.completedStep, paused);
    assert.equal(session.kernel.inputQueue.queue.length, 0);
    await session.resume();
    send(binding, session, { sequence: "2", capture: session.kernel.timeNs + 1e9 });
    assert.equal(session.kernel.inputQueue.queue.length, 0);
    await session.stop();
    const firstId = session.runId;
    await session.reset();
    assert.notEqual(session.runId, firstId); assert.equal(session.kernel.steps, 0);
    await session.start(); send(binding, session, { run: firstId });
    assert.equal(session.kernel.inputQueue.queue.length, 0);
    await session.stop();
});

test("paced execution delivers native state products without policy transitions", async (t) => {
    let now = 0;
    const { session, binding } = sessionFor(undefined, { scheduler: { now: () => now, async wait(ms) { now += ms; } } });
    t.after(() => session.close());
    await session.prepare(await externalBundle({ maxSteps: 6 })); await session.start();
    await session.waitForCompletion();
    const result = (await session.finalize()).runResult;
    assert.equal(result.completed, true); assert.equal(result.step, "6"); assert.equal(result.runId, session.runId);
    assert.equal(result.controllerMode, "external-realtime");
    const clocks = binding.sessions[0].packets.filter((packet) => packet.routeId === "clock").map((packet) => decodeMessage(stateType, packet.bytes));
    assert.equal(clocks.length, 7); assert.equal(clocks[0].time, "0");
    assert.ok(binding.sessions[0].packets.some((packet) => packet.routeId === "imu"));
    assert.equal(session.health().zenohQueueBytes, 0);
});

test("required transport failure needs reset and produces no completed result", async (t) => {
    const { session, binding } = sessionFor(); t.after(() => session.close());
    await session.prepare(await externalBundle()); await session.start();
    binding.sessions[0].rejected = true;
    const completion = await session.waitForCompletion();
    assert.equal(completion.state, "failed"); assert.equal(completion.error.requiresReset, true);
    await assert.rejects(session.finalize(), { code: "RESOURCE_LIMIT" });
    await assert.rejects(session.resume(), { code: "INVALID_REQUEST" });
    await session.reset(); assert.equal(session.state, "prepared");
});

test("external authority is rejected by Gym and requires explicit host configuration", async (t) => {
    const bundle = await externalBundle();
    const gym = new HeadlessSession(); t.after(() => gym.close());
    await assert.rejects(gym.prepare(bundle), { code: "UNSUPPORTED_CAPABILITY" });
    const external = new HeadlessExternalSession(); t.after(() => external.close());
    await assert.rejects(external.prepare(bundle), { code: "UNSUPPORTED_CAPABILITY" });
    const binding = fakeZenohBinding();
    const runner = new HeadlessRunner({ artifactSinkFactory: sink, externalSessionFactory: (options) => new HeadlessExternalSession({ ...options, zenohRuntimeFactory: zenohRuntimeFactory(binding) }) });
    const events = [];
    const result = await runner.runExternalController(await externalBundle({ maxSteps: 2 }), { zenohTransport: zenohHostConfig(), onEvent: (event) => events.push(event) });
    assert.equal(result.result.passed, true); assert.equal(events[0].kind, "cev-sim.headless.external-ready");
});

test("CLI selects explicit external mode, honors override and rejects policy inputs", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-external-cli-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bundlePath = path.join(root, "run.json"), configPath = path.join(root, "host.json"), zenohPath = path.join(root, "zenoh.json");
    await fs.writeFile(bundlePath, JSON.stringify(await externalBundle()));
    await fs.writeFile(configPath, JSON.stringify({ kind: "cev-sim.headless-supervisor-config", version: 1, controllerMode: "external-realtime", zenohTransport: zenohHostConfig() }));
    await fs.writeFile(zenohPath, JSON.stringify(zenohHostConfig()));
    const calls = [];
    const runner = { async runExternalController(bundle, options) { calls.push(options); return { result: { passed: true } }; },
        async validate(bundle, options) { calls.push(options); return { ok: true }; } };
    const stream = { write() {} };
    const io = { runner, supervisorRunner: runner, stdin: { isTTY: true }, stdout: stream, stderr: stream };
    const args = ["run", "--bundle", bundlePath, "--output", path.join(root, "result")];
    assert.equal(await main([...args, "--controller-mode", "external-realtime", "--zenoh-transport-config", zenohPath], io), 0);
    assert.ok(calls[0].zenohTransport); assert.equal(calls[0].actions, undefined);
    assert.equal(await main([...args, "--config", configPath], io), 0);
    assert.equal(await main([...args, "--config", configPath, "--controller-mode", "policy"], io), 2);
    for (const key of ["actions", "episode", "tape"]) assert.equal(await main([...args, "--controller-mode", "external-realtime", `--${key}`, "ignored"], io), 2);
    assert.equal(await main([...args, "--controller-mode", "invalid"], io), 3);
    assert.equal(await main(["validate", "--bundle", bundlePath, "--controller-mode", "external-realtime", "--zenoh-transport-config", zenohPath], io), 0);
    assert.equal(calls.at(-1).controllerMode, "external-realtime");
    assert.equal(await main([...args, "--config", configPath, "--zenoh-transport-config", zenohPath], io), 2);
});

test("external worker completion fences old run notifications and latches early completion", async () => {
    const handle = Object.assign(Object.create(WorkerHandle.prototype), { realtimeRunId: "new", realtimeCompletion: null, realtimeWaiter: null });
    handle._message({ kind: "cev-sim.worker-realtime-complete", runId: "old", state: "terminal" });
    assert.equal(handle.realtimeCompletion, null);
    handle._message({ kind: "cev-sim.worker-realtime-complete", runId: "new", state: "terminal" });
    assert.deepEqual(await handle.waitForRealtimeCompletion(), { state: "terminal", error: null });
});

test("supervised external execution passes host config, stops on cancellation and frees capacity", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-external-supervisor-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
    for (const cancelled of [false, true]) {
        const commands = [];
        const controller = new AbortController();
        let complete;
        const completion = new Promise((resolve) => { complete = resolve; });
        const supervisor = new HeadlessSupervisor({ socket: path.join(root, `${cancelled}.sock`), config: { kind: "cev-sim.headless-supervisor-config", version: 1, zenohTransport: zenohHostConfig() },
            workerFactory: () => ({ pid: 123, pendingBytes: 0, async dispatch(name, payload) {
                commands.push(name);
                if (name === "initialize") { assert.equal(payload.mode, "external-realtime"); assert.ok(payload.zenohTransport); return { descriptor: { runId: "test" } }; }
                if (name === "realtime-start") { if (!cancelled) complete({ state: "terminal" }); return { descriptor: { runId: "test" } }; }
                if (name === "realtime-stop") { assert.equal(payload.interruptedBySignal, true); complete({ state: "stopped" }); }
                if (name === "finalize") return { finalized: { runResult: { interruptedBySignal: cancelled } } };
                return {};
            }, waitForRealtimeCompletion: () => completion, async close() { commands.push("close"); } }) });
        try {
            const result = await supervisor.runExternalController({ bundle: await externalBundle(), outputUri: path.join(root, `${cancelled}-output`) }, {
                signal: controller.signal, onReady: () => { if (cancelled) controller.abort(); } });
            assert.equal(result.runResult.interruptedBySignal, cancelled);
            assert.equal(commands.includes("realtime-stop"), cancelled);
            assert.equal(commands.at(-1), "close"); assert.equal(supervisor.reservedWorkers, 0); assert.equal(supervisor.workers.size, 0);
        } finally { await supervisor.close(); }
    }
});

test("owned headless preparation stays paused and lease loss clears queued motion", async (t) => {
    let now = 0;
    const lease = { leaseId: "lease-1", status: "active", mode: "autonomous", remainingMs: 750, target: { kind: "headless", id: "external-test", vehicleId: "ego" }, runId: null, resolvedHash: null };
    const { session, binding } = sessionFor(undefined, { controlLease: lease, scheduler: { now: () => now } });
    t.after(() => session.close());
    const bundle = await externalBundle({ leased: true, maxSteps: 80 });
    await session.prepare(bundle); await session.start({ paused: true });
    assert.equal(session.state, "paused"); assert.equal(session.kernel.steps, 0);
    await assert.rejects(session.resume(), /ownership/);
    const bound = { ...lease, runId: session.runId, resolvedHash: session.descriptor().resolvedHash };
    session.updateOwnership({ snapshot: bound, runId: session.runId, sentAtMonotonicNs: process.hrtime.bigint().toString() });
    await session.resume();
    send(binding, session, { lease: "other", deadline: 300000000 });
    assert.equal(session.kernel.inputQueue.queue.length, 0);
    send(binding, session, { lease: "lease-1", deadline: 300000000 });
    assert.equal(session.kernel.inputQueue.queue.length, 1);
    now = 751;
    session.ownershipGuard.check();
    assert.equal(session.kernel.inputQueue.queue.length, 0);
    assert.equal(session.kernel.controlRuntime.states.get("ego").applied.speedMps, 0);
    await until(() => session.state === "paused");
    await assert.rejects(session.resume(), /ownership/);
    assert.throws(() => session.updateOwnership({ snapshot: bound, runId: "old-run", sentAtMonotonicNs: process.hrtime.bigint().toString() }), /another run/);
    await session.stop();
    const unowned = sessionFor().session; t.after(() => unowned.close());
    await assert.rejects(unowned.prepare(bundle), /ownership/);
});

test("external finalization waits for a stop acknowledgement after realtime completion", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-stop-ack-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    let complete;
    let stopping = false;
    let stopped;
    const completion = new Promise((resolve) => { complete = resolve; });
    const supervisor = new HeadlessSupervisor({ socket: path.join(root, "test.sock"),
        config: { kind: "cev-sim.headless-supervisor-config", version: 1, zenohTransport: zenohHostConfig() },
        workerFactory: () => ({ pid: 123, pendingBytes: 0, async dispatch(name) {
            if (name === "initialize" || name === "realtime-start") return { descriptor: { runId: "run" } };
            if (name === "realtime-stop") {
                stopping = true;
                complete({ state: "stopped" });
                await new Promise((resolve) => setTimeout(resolve, 10));
                stopping = false;
                return {};
            }
            if (name === "finalize") {
                assert.equal(stopping, false, "finalization must wait for the stop IPC response");
                return { finalized: { runResult: { passed: true } } };
            }
            return {};
        }, waitForRealtimeCompletion: () => completion, async close() {} }) });
    t.after(() => supervisor.close());
    const result = await supervisor.runExternalController({ bundle: await externalBundle(), outputUri: path.join(root, "output") }, {
        signal: new AbortController().signal,
        onReady: (_descriptor, controls) => { stopped = controls.command("stop"); },
    });
    await stopped;
    assert.equal(result.runResult.passed, true);
});
