import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import express from "express";
import { BrowserSimBridge } from "../app/simulation/BrowserSimBridge.js";
import { browserSimSnapshot } from "../app/simulation/BrowserSimControl.js";
import { BrowserSimService } from "../server/browser-sim/BrowserSimService.js";
import { createBrowserSimRouter } from "../server/routes/browserSimRouter.js";
import { createRequestSecurityMiddleware, resolveHttpSecurityConfig } from "../server/security/RequestSecurity.js";

function fixture(options = {}) {
    let now = 1_000_000;
    const resolved = [];
    const events = new EventEmitter();
    events.publish = (event) => events.emit("change", event);
    const storage = {
        async getRunManifest(id) { return { id, revision: resolved.length + 1 }; },
        async resolveRunManifest(id) {
            resolved.push(id);
            return { manifest: { id, revision: resolved.length, clock: { stepNs: 20_000_000 } }, resolvedHash: `hash-${resolved.length}` };
        },
    };
    const service = new BrowserSimService(storage, { events, now: () => now, ...options });
    let sequence = 0;
    const register = (snapshot = { status: "idle" }, activity = 0) => service.register({ snapshot, activity, sequence: ++sequence });
    const report = (browser, snapshot, activity = 0) => service.heartbeat(browser.browserId, browser.token, { snapshot, activity, sequence: ++sequence });
    return { service, storage, events, resolved, register, report, advance: (ms) => { now += ms; } };
}

async function tick() {
    await new Promise((resolve) => setImmediate(resolve));
}

function active(status = "running", runId = "run-1") {
    return { status, runId, manifestId: "manifest-1", timeNs: "9007199254740993", stepNs: "20000000" };
}

test("default tab follows reported human activity, never heartbeats or API calls", () => {
    const f = fixture();
    const a = f.register();
    const b = f.register();
    assert.equal(f.service.status().browserId, b.browserId, "registration is the fallback before any activity");
    f.report(a, { status: "idle" }, 1);
    const order = f.service.status().interactionOrder;
    f.report(b, { status: "idle" });
    assert.equal(f.service.status().browserId, a.browserId);
    assert.equal(f.service.status(b.browserId).browserId, b.browserId);
    assert.equal(f.service.status().interactionOrder, order);
    f.report(b, { status: "idle" }, 1);
    assert.equal(f.service.status().browserId, b.browserId);
    f.report(a, { status: "idle" }, 1);
    assert.equal(f.service.status().browserId, b.browserId, "repeated activity counters do not refresh ordering");
    const listing = f.service.list();
    assert.equal(listing.browserId, b.browserId);
    assert.deepEqual(listing.browsers.filter((browser) => browser.isDefault).map((browser) => browser.browserId), [b.browserId]);
    assert.equal(JSON.stringify(listing).includes(a.token), false);
    f.advance(15_000);
    assert.throws(() => f.service.status(), { code: "BROWSER_UNAVAILABLE" });
    f.report(a, { status: "idle" }, 1);
    assert.equal(f.service.status().browserId, a.browserId);
    assert.throws(() => f.service.status(b.browserId), { code: "BROWSER_UNAVAILABLE" });
    assert.throws(() => f.service.status("missing"), { code: "BROWSER_UNAVAILABLE" });
    assert.throws(() => f.service.status([a.browserId]), { code: "INVALID_REQUEST" });
});

test("commands and retries stay bound to the selected tab despite focus changes", async () => {
    const f = fixture();
    const a = f.register({ status: "idle" }, 1);
    const b = f.register();
    const input = { action: "start", manifestId: "saved", requestId: "launch-1" };
    const accepted = f.service.submit(input);
    assert.equal(accepted.browserId, a.browserId);
    assert.equal(accepted.state, "accepted");
    assert.throws(() => f.service.submit({ ...input, requestId: "another" }), { code: "BUSY" });
    f.report(b, { status: "idle" }, 1);
    assert.equal(f.service.status().browserId, b.browserId);
    assert.deepEqual(f.service.submit(input), accepted);
    assert.throws(() => f.service.submit({ ...input, manifestId: "different" }), { code: "REQUEST_ID_CONFLICT" });
    await tick();
    assert.equal(f.report(b, { status: "idle" }, 1).command, null);
    assert.equal(f.report(a, { status: "idle" }, 1).command.commandId, accepted.commandId);
    assert.throws(() => f.service.claim(b.browserId, b.token, accepted.commandId, { claimId: "claim" }), { code: "WRONG_BROWSER" });
    assert.throws(() => f.service.claim(a.browserId, b.token, accepted.commandId, { claimId: "claim" }), { code: "INVALID_BROWSER_TOKEN" });
    const claim = f.service.claim(a.browserId, a.token, accepted.commandId, { claimId: "claim" });
    assert.equal(claim.resolved.manifest.id, "saved");
    assert.equal(claim.autoplay, true);
    assert.equal(claim.manifestRevision, 1);
    assert.equal(f.service.claim(a.browserId, a.token, accepted.commandId, { claimId: "claim" }).commandId, claim.commandId);
    assert.throws(() => f.service.claim(a.browserId, a.token, accepted.commandId, { claimId: "other" }), { code: "COMMAND_NOT_PENDING" });
    const result = f.service.complete(a.browserId, a.token, accepted.commandId, { claimId: "claim", sequence: 100, snapshot: active(), error: null });
    assert.equal(result.state, "succeeded");
    assert.equal(result.snapshot.timeNs, "9007199254740993");
    assert.equal(f.service.submit(input).browserId, a.browserId);
    assert.deepEqual(f.resolved, ["saved"]);
});

test("admission rejects stale runs, active runs, experiments, edits, and malformed requests", () => {
    const f = fixture();
    const a = f.register(active());
    const reject = (input, code) => assert.throws(() => f.service.submit(input), { code });
    reject({ action: "start", manifestId: "saved" }, "RUN_ACTIVE");
    reject({ action: "pause", runId: "old" }, "RUN_ID_MISMATCH");
    reject({ action: "pause" }, "INVALID_REQUEST");
    reject({ action: "drive", runId: "run-1" }, "INVALID_REQUEST");
    reject({ action: "stop", runId: "run-1", autoplay: false }, "INVALID_REQUEST");
    reject({ action: "start", manifestId: "saved", typo: true }, "INVALID_REQUEST");
    f.report(a, { ...active(), transitioning: true });
    reject({ action: "pause", runId: "run-1" }, "BUSY");
    f.report(a, { ...active(), experimentActive: true });
    reject({ action: "stop", runId: "run-1" }, "EXPERIMENT_ACTIVE");
    f.report(a, { ...active("paused"), navigationBlocked: true });
    reject({ action: "resume", runId: "run-1" }, "NAVIGATION_BLOCKED");
    f.report(a, active("completed"));
    reject({ action: "resume", runId: "run-1" }, "RUN_TERMINAL");
});

test("late heartbeats cannot overwrite a newer completion or current run snapshot", () => {
    const f = fixture();
    const a = f.register(active());
    const command = f.service.submit({ action: "pause", runId: "run-1" });
    f.service.claim(a.browserId, a.token, command.commandId, { claimId: "claim" });
    const completion = { claimId: "claim", sequence: 10, snapshot: active("paused"), error: null };
    f.service.complete(a.browserId, a.token, command.commandId, completion);
    f.service.heartbeat(a.browserId, a.token, { sequence: 9, snapshot: active(), activity: 0 });
    assert.equal(f.service.status().status, "paused");
    f.service.heartbeat(a.browserId, a.token, { sequence: 11, snapshot: active("running", "run-new"), activity: 0 });
    f.service.complete(a.browserId, a.token, command.commandId, completion);
    assert.equal(f.service.status().runId, "run-new");
    assert.equal(f.service.get(command.commandId).snapshot.runId, "run-1");
});

test("resolution is asynchronous, reserved, and failures release the tab", async () => {
    const f = fixture();
    const a = f.register(active("completed"));
    let rejectResolution;
    f.storage.resolveRunManifest = () => new Promise((_resolve, reject) => { rejectResolution = reject; });
    const receipt = f.service.submit({ action: "reset", runId: "run-1" });
    await tick();
    assert.equal(f.report(a, active("completed")).command, null);
    assert.throws(() => f.service.submit({ action: "stop", runId: "run-1" }), { code: "BUSY" });
    rejectResolution(new Error("manifest missing"));
    await tick();
    assert.equal(f.service.get(receipt.commandId).state, "failed");
    assert.match(f.service.get(receipt.commandId).error.message, /manifest missing/);
    assert.equal(f.service.status().commandId, null);
});

test("disconnects expire unclaimed commands and leave claimed outcomes uncertain without replay", async () => {
    const f = fixture();
    const a = f.register(active());
    const pending = f.service.submit({ action: "pause", runId: "run-1" });
    f.advance(15_000);
    assert.equal(f.service.get(pending.commandId).state, "failed");
    assert.equal(f.report(a, active()).command, null);
    const running = f.service.submit({ action: "pause", runId: "run-1" });
    f.service.claim(a.browserId, a.token, running.commandId, { claimId: "claim" });
    f.advance(15_000);
    assert.equal(f.service.get(running.commandId).state, "unknown");
    assert.equal(f.report(a, active()).command, null);
    assert.throws(() => f.service.submit({ action: "stop", runId: "run-1" }), { code: "BUSY" });
    assert.throws(() => f.service.claim(a.browserId, a.token, running.commandId, { claimId: "claim" }), { code: "COMMAND_NOT_PENDING" });
    assert.equal(f.service.complete(a.browserId, a.token, running.commandId, {
        claimId: "claim", sequence: 100, snapshot: active("paused"), error: null,
    }).state, "succeeded", "the original execution may reconcile a lost acknowledgement");
    await tick();
});

test("registry bounds and receipt retention do not evict active commands", () => {
    const f = fixture({ maxBrowsers: 1, maxCommands: 1 });
    const a = f.register(active());
    assert.throws(() => f.register(), { code: "CAPACITY" });
    const pending = f.service.submit({ action: "pause", runId: "run-1" });
    f.service.claim(a.browserId, a.token, pending.commandId, { claimId: "claim" });
    f.service.complete(a.browserId, a.token, pending.commandId, { claimId: "claim", sequence: 100, snapshot: active("paused"), error: null });
    const next = f.service.submit({ action: "resume", runId: "run-1" });
    assert.notEqual(next.commandId, pending.commandId);
    assert.throws(() => f.service.get(pending.commandId), { code: "COMMAND_NOT_FOUND" });
    f.advance(15_000);
    assert.equal(f.service.get(next.commandId).state, "failed");
    f.advance(600_000);
    assert.throws(() => f.service.get(next.commandId), { code: "COMMAND_NOT_FOUND" });
    assert.equal(f.service.list().browsers.length, 0);
});

async function httpFixture(t) {
    const f = fixture();
    const app = express();
    app.use(createRequestSecurityMiddleware(resolveHttpSecurityConfig({})));
    app.use(express.json());
    app.use("/api/browser-sim", createBrowserSimRouter(f.service));
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { ...f, fetch: (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options) };
}

test("HTTP routes return asynchronous receipts and preserve host/origin protections", async (t) => {
    const f = await httpFixture(t);
    const a = f.register();
    const response = await f.fetch("/api/browser-sim/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "start", manifestId: "saved" }) });
    assert.equal(response.status, 202);
    const receipt = await response.json();
    assert.equal(receipt.browserId, a.browserId);
    const status = await f.fetch("/api/browser-sim/status");
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.equal((await status.json()).browserId, a.browserId);
    assert.equal((await f.fetch(`/api/browser-sim/commands/${receipt.commandId}`)).status, 200);
    const rejected = await f.fetch("/api/browser-sim/commands", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json" }, body: "{}" });
    assert.equal(rejected.status, 403);
    const bad = await f.fetch("/api/browser-sim/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"pause"}' });
    assert.equal(bad.status, 400);
});

class Surface {
    constructor() { this.listeners = new Map(); this.visibilityState = "visible"; }
    hasFocus() { return false; }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    fire(type, isTrusted = true, target = this) { for (const listener of this.listeners.get(type) ?? []) listener({ type, isTrusted, target }); }
}

function fakeController() {
    const listeners = new Set();
    const simulation = { timeNs: 0, steps: 0, stepNs: 20_000_000 };
    const controller = {
        calls: [],
        data: { simulation: () => simulation },
        state: { status: "idle" },
        getSnapshot() { return this.state; },
        subscribe(listener) { listeners.add(listener); listener(); return () => listeners.delete(listener); },
        emit() { for (const listener of listeners) listener(); },
        async prepare(resolved, { autoplay }) {
            this.calls.push(["prepare", resolved]);
            this.state = { status: autoplay ? "running" : "ready", activeResolved: resolved, activeRunId: `run-${this.calls.length}` };
            this.emit();
        },
        async play() { this.calls.push(["play"]); this.state.status = "running"; },
        async pause() { this.calls.push(["pause"]); this.state.status = "paused"; },
        async stop() { this.calls.push(["stop"]); this.state.status = "stopped"; },
        async reset(resolved) { this.calls.push(["reset", resolved]); await this.prepare(resolved, { autoplay: false }); },
    };
    return controller;
}

async function waitFor(predicate) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail("Timed out waiting for browser bridge.");
}

test("bridge recovers missed SSE and lost claim/completion replies without executing twice", async (t) => {
    const f = await httpFixture(t);
    const controller = fakeController();
    const windowImpl = new Surface();
    const documentImpl = new Surface();
    let loseClaim = true;
    let loseCompletion = true;
    const bridge = new BrowserSimBridge({
        controller, windowImpl, documentImpl,
        getContext: () => ({ navigationBlocked: () => false, openSimulation: () => true }),
        subscribeEvents: () => () => {},
        fetchImpl: async (path, options) => {
            const response = await f.fetch(path, options);
            if (path.endsWith("/claim") && loseClaim) { loseClaim = false; throw new Error("lost claim response"); }
            if (path.endsWith("/complete") && loseCompletion) { loseCompletion = false; throw new Error("lost completion response"); }
            return response;
        },
    });
    const stop = bridge.start();
    t.after(stop);
    await waitFor(() => bridge.registration && !bridge.syncing);
    const other = f.register();
    documentImpl.fire("keydown", false);
    assert.equal(f.service.status().browserId, other.browserId, "synthetic activity does not select a tab");
    documentImpl.fire("pointerdown");
    await waitFor(() => f.service.status().browserId === bridge.registration.browserId);
    const accepted = f.service.submit({ action: "start", manifestId: "saved", autoplay: false });
    await tick();
    await bridge.sync();
    await waitFor(() => !loseClaim);
    await waitFor(() => !bridge.operations.get(accepted.commandId)?.working);
    await bridge.sync();
    await waitFor(() => controller.calls.length === 1);
    await waitFor(() => !bridge.operations.get(accepted.commandId)?.working);
    await bridge.sync();
    await waitFor(() => f.service.get(accepted.commandId).state === "succeeded");
    assert.equal(controller.calls.length, 1);
    assert.equal(f.service.get(accepted.commandId).snapshot.status, "ready");
    assert.equal(f.service.get(accepted.commandId).snapshot.timeNs, "0");
    assert.deepEqual(f.resolved, ["saved"]);
    documentImpl.fire("wheel");
    windowImpl.fire("focus");
    windowImpl.fire("focus", true, documentImpl);
    await bridge.sync();
    assert.equal(bridge.activity, 3);
    const oldBrowserId = bridge.registration.browserId;
    f.service.commands.clear();
    f.service.browsers.clear();
    await bridge.sync();
    await waitFor(() => bridge.registration === null);
    await bridge.sync();
    await waitFor(() => bridge.registration && !bridge.syncing);
    assert.notEqual(bridge.registration.browserId, oldBrowserId);
    assert.equal(controller.calls.length, 1, "server restart does not replay a previous launch");
    assert.equal(f.service.status().runId, controller.state.activeRunId);
});

test("browser repeats admission against live state and rejects navigation without launching later", async () => {
    const controller = fakeController();
    let blocked = false;
    let navigation = false;
    const bridge = new BrowserSimBridge({
        controller,
        getContext: () => ({ navigationBlocked: () => blocked, openSimulation: () => navigation }),
    });
    const command = { action: "start", resolved: { manifest: { id: "saved", clock: {} }, resolvedHash: "frozen" }, autoplay: true };
    await assert.rejects(bridge.execute(command), { code: "NAVIGATION_BLOCKED" });
    navigation = true;
    blocked = true;
    await assert.rejects(bridge.execute(command), { code: "NAVIGATION_BLOCKED" });
    assert.equal(controller.calls.length, 0);
    blocked = false;
    await bridge.execute(command);
    await assert.rejects(bridge.execute(command), { code: "RUN_ACTIVE" });
    await assert.rejects(bridge.execute({ action: "pause", runId: "wrong" }), { code: "RUN_ID_MISMATCH" });
    const runId = controller.state.activeRunId;
    await bridge.execute({ action: "pause", runId });
    await bridge.execute({ action: "resume", runId });
    await bridge.execute({ action: "stop", runId });
    await bridge.execute({ action: "reset", runId, resolved: command.resolved });
    assert.equal(controller.state.status, "ready");
    assert.notEqual(controller.state.activeRunId, runId);
    assert.equal(browserSimSnapshot(controller).resolvedHash, "frozen");
});
