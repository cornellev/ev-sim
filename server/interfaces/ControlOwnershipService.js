import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";

export const CONTROL_LEASE_TTL_MS = 750;
export const CONTROL_LEASE_RENEW_MS = 250;
const MODES = new Set(["observe", "autonomous", "drive-test"]);
const digest = (token) => createHash("sha256").update(token).digest();
const targetKey = (target) => JSON.stringify([target.kind, target.id, target.vehicleId ?? "ego"]);

function fail(code, message, statusCode = 409) {
    throw Object.assign(new Error(message), { code, statusCode });
}

function id(value, field) {
    if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 200) fail("CONTROL_LEASE_INVALID", `${field} must be a trimmed identifier.`, 400);
    return value;
}

/** Operational ownership only. These records never enter a resolved run or hash. */
export class ControlOwnershipService extends EventEmitter {
    constructor({ now = () => performance.now(), maxLeases = 256, startTimer = true } = {}) {
        super();
        this.now = now;
        this.maxLeases = maxLeases;
        this.leases = new Map();
        this.targets = new Map();
        this.closed = false;
        if (startTimer) { this.timer = setInterval(() => this.expire(), 50); this.timer.unref(); }
    }

    acquire({ target, mode = "observe" } = {}) {
        if (this.closed) fail("CONTROL_LEASE_CLOSED", "Control ownership is closed.", 503);
        if (!target || !["browser", "headless"].includes(target.kind) || Object.keys(target).some((key) => !["kind", "id", "vehicleId"].includes(key)) || !MODES.has(mode)) fail("CONTROL_LEASE_INVALID", "A browser/headless target and supported mode are required.", 400);
        const normalized = { kind: target.kind, id: id(target.id, "target.id"), vehicleId: id(target.vehicleId ?? "ego", "target.vehicleId") };
        const key = targetKey(normalized);
        this.expire();
        if (this.targets.has(key)) fail("CONTROL_LEASE_CONFLICT", "This vehicle already has a control owner.");
        for (const [leaseId, lease] of this.leases) if (this.leases.size >= this.maxLeases && lease.status !== "active") this.leases.delete(leaseId);
        if (this.leases.size >= this.maxLeases) fail("CONTROL_LEASE_LIMIT", "Control ownership capacity is exhausted.", 503);
        const token = randomBytes(32).toString("base64url");
        const lease = { leaseId: randomUUID(), target: normalized, key, mode, tokenHash: digest(token), expiresAt: this.now() + CONTROL_LEASE_TTL_MS, status: "active", runId: null, resolvedHash: null };
        this.leases.set(lease.leaseId, lease);
        this.targets.set(key, lease.leaseId);
        this.emit("change", this._snapshot(lease));
        return { ...this._snapshot(lease), token };
    }

    _authorized(leaseId, token) {
        this.expire();
        const lease = this.leases.get(leaseId);
        if (typeof token !== "string" || token.length > 200 || !lease || !timingSafeEqual(lease.tokenHash, digest(token))) fail("CONTROL_LEASE_UNAUTHORIZED", "Invalid control lease credential.", 403);
        if (lease.status !== "active") fail("CONTROL_LEASE_LOST", "Control ownership has ended.");
        return lease;
    }

    bindRun(leaseId, token, { target, runId, resolvedHash } = {}) {
        const lease = this._authorized(leaseId, token);
        if (!target || targetKey(target) !== lease.key) fail("CONTROL_LEASE_TARGET", "Prepared run does not match the lease target.");
        id(runId, "runId"); id(resolvedHash, "resolvedHash");
        if (lease.runId && (lease.runId !== runId || lease.resolvedHash !== resolvedHash)) fail("CONTROL_LEASE_RUN", "A lease cannot move to another run.");
        lease.runId = runId; lease.resolvedHash = resolvedHash;
        this.emit("change", this._snapshot(lease));
        return this._snapshot(lease);
    }

    renew(leaseId, token) {
        const lease = this._authorized(leaseId, token);
        lease.expiresAt = this.now() + CONTROL_LEASE_TTL_MS;
        const snapshot = this._snapshot(lease);
        this.emit("change", snapshot);
        return snapshot;
    }

    authorize(leaseId, token) { return this._snapshot(this._authorized(leaseId, token)); }

    release(leaseId, token) {
        const lease = this._authorized(leaseId, token);
        this._end(lease, "released");
        return this._snapshot(lease);
    }

    status(leaseId) {
        this.expire();
        const lease = this.leases.get(leaseId);
        if (!lease) fail("CONTROL_LEASE_NOT_FOUND", "Control lease was not found.", 404);
        return this._snapshot(lease);
    }

    forTarget(target) {
        this.expire();
        const leaseId = this.targets.get(targetKey(target));
        return leaseId ? this._snapshot(this.leases.get(leaseId)) : null;
    }

    _snapshot(lease) {
        return { leaseId: lease.leaseId, target: { ...lease.target }, mode: lease.mode, status: lease.status, runId: lease.runId, resolvedHash: lease.resolvedHash, remainingMs: lease.status === "active" ? Math.max(0, Math.floor(lease.expiresAt - this.now())) : 0 };
    }

    _end(lease, status) {
        lease.status = status;
        if (this.targets.get(lease.key) === lease.leaseId) this.targets.delete(lease.key);
        const snapshot = this._snapshot(lease);
        this.emit("lost", snapshot);
        this.emit("change", snapshot);
    }

    expire() {
        const now = this.now();
        for (const lease of this.leases.values()) if (lease.status === "active" && now >= lease.expiresAt) this._end(lease, "expired");
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        clearInterval(this.timer);
        for (const lease of this.leases.values()) if (lease.status === "active") this._end(lease, "closed");
        this.leases.clear(); this.targets.clear(); this.removeAllListeners();
    }
}
