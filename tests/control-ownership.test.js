import assert from "node:assert/strict";
import test from "node:test";
import { ControlOwnershipService } from "../server/interfaces/ControlOwnershipService.js";
import { ControlOwnershipGuard } from "../app/autonomy/ControlOwnershipGuard.js";
import { ControlRuntime } from "../app/autonomy/ControlRuntime.js";

const target = { kind: "browser", id: "tab", vehicleId: "ego" };
const command = (leaseId, overrides = {}) => ({ runId: "run", leaseId, mode: "velocity", sequence: "1", captureTimeNs: 0, deadlineNs: 300_000_000, frameId: "base_link", speedMps: 0.1, accelerationMps2: 0, jerkMps3: 0, steeringRad: 0.1, steeringRateRadps: 0, ...overrides });

test("ownership is bounded, explicit, run-bound, and expiry cannot be renewed", () => {
    let now = 0;
    const service = new ControlOwnershipService({ now: () => now, startTimer: false, maxLeases: 1 });
    const lost = [];
    service.on("lost", (snapshot) => lost.push(snapshot));
    const grant = service.acquire({ target, mode: "drive-test" });
    assert.throws(() => service.acquire({ target }), /already has/);
    assert.throws(() => service.renew(grant.leaseId, "wrong"), /credential/);
    assert.equal(Object.hasOwn(service.status(grant.leaseId), "tokenHash"), false);
    service.bindRun(grant.leaseId, grant.token, { target: { vehicleId: "ego", id: "tab", kind: "browser" }, runId: "run", resolvedHash: "hash" });
    assert.throws(() => service.bindRun(grant.leaseId, grant.token, { target, runId: "other", resolvedHash: "hash" }), /another run/);
    now = 500;
    assert.equal(service.status(grant.leaseId).remainingMs, 250);
    assert.equal(service.renew(grant.leaseId, grant.token).remainingMs, 750);
    now = 1250;
    assert.equal(service.status(grant.leaseId).status, "expired");
    assert.equal(lost.length, 1);
    assert.throws(() => service.renew(grant.leaseId, grant.token), /ended/);
    const next = service.acquire({ target });
    assert.notEqual(next.leaseId, grant.leaseId);
    service.close();
});

test("local watchdog clears delayed controls and does not resume from a late status reply", () => {
    let now = 0;
    let losses = 0;
    const guard = new ControlOwnershipGuard({ now: () => now, startTimer: false, onLoss: () => losses++ });
    const snapshot = { leaseId: "lease", runId: "run", status: "active", mode: "drive-test", remainingMs: 750, target };
    guard.attach(snapshot);
    const runtime = new ControlRuntime({ runId: "run", manifest: { id: "manifest", version: 13 }, controls: { targetVehicleId: "ego", authority: "candidate", actuatorOverrides: { responseDelayNs: 10 }, stalePolicy: "fallback", fallbackCommand: { mode: "velocity", speedMps: 10 } }, ownershipGuard: guard });
    const ingest = (value, applyTimeNs = 0) => runtime.ingestCommand({ value, valueContract: { id: "cev.control-command", version: 2 } }, { applyTimeNs });
    assert.equal(ingest(command("old")).ok, false);
    assert.equal(ingest(command("lease", { speedMps: 0.2 })).ok, false);
    assert.equal(ingest(command("lease", { deadlineNs: 400_000_000 })).ok, false);
    assert.equal(ingest(command("lease")).ok, true);
    runtime.step({ step: 1, timeNs: 1, dt: 0.01 });
    assert.equal(runtime.delayQueues.get("ego").length, 1);
    now = 750;
    const applied = runtime.step({ step: 2, timeNs: 20, dt: 0.01 }).get("ego");
    assert.equal(applied.speedMps, 0);
    assert.equal(runtime.delayQueues.has("ego"), false);
    assert.equal(runtime.states.get("ego").selected, null);
    assert.equal(guard.update(snapshot), false);
    assert.equal(losses, 1);
    assert.equal(ingest(command("lease", { sequence: "2" })).ok, false);
    guard.close();
});

test("observe cannot actuate and drive-test ends after one simulation second", () => {
    const guard = new ControlOwnershipGuard({ now: () => 0, startTimer: false });
    const snapshot = { leaseId: "lease", runId: "run", status: "active", mode: "observe", remainingMs: 750, target };
    guard.attach(snapshot);
    assert.equal(guard.validate(command("lease"), { applyTimeNs: 0 }).code, "control-lease-observe");
    assert.equal(guard.validate(command("lease", { speedMps: 0, steeringRad: 0 }), { applyTimeNs: 0 }).ok, true);
    guard.attach({ ...snapshot, mode: "drive-test" });
    assert.equal(guard.validate(command("lease", { captureTimeNs: 1_000_000_000, deadlineNs: 1_300_000_000 }), { applyTimeNs: 1_000_000_000 }).code, "control-lease-drive-test");
    guard.close();
});

test("pending ownership stays paused until binding and expired watches cannot attach", () => {
    let now = 0;
    const guard = new ControlOwnershipGuard({ now: () => now, startTimer: false });
    const snapshot = { leaseId: "lease", runId: null, status: "active", mode: "autonomous", remainingMs: 750, target };
    guard.begin(snapshot);
    assert.equal(guard.check(), false);
    now = 250;
    assert.equal(guard.update(snapshot), true);
    assert.equal(guard.check(), false);
    const bound = { ...snapshot, runId: "run" };
    assert.equal(guard.update(bound), true);
    guard.attach(bound);
    assert.equal(guard.check(), true);
    now = 1000;
    assert.equal(guard.update(bound), false);
    assert.equal(guard.lost, true);
    guard.close();
});
