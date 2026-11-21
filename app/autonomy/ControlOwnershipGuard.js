export const ONBOARDING_COMMAND_FRESHNESS_NS = 300_000_000;
export const CONTROL_LEASE_TTL_MS = 750;
export const BROWSER_CONTROL_LEASE_TTL_MS = 5_000;

/** A local watchdog survives loss of the server connection and never renews ownership. */
export class ControlOwnershipGuard {
    constructor({ now = () => performance.now(), onLoss = () => {}, startTimer = true, ttlMs = CONTROL_LEASE_TTL_MS } = {}) {
        Object.assign(this, { now, onLoss, ttlMs });
        this.lease = null;
        this.lost = false;
        this.deadline = 0;
        this.holdUntil = null;
        this.commandAfterNs = -1;
        this.startTimeNs = 0;
        if (startTimer) this.timer = setInterval(() => this.check(), 50);
        this.timer?.unref?.();
    }

    _active(snapshot) {
        return snapshot?.status === "active" && ["observe", "autonomous", "drive-test"].includes(snapshot.mode)
            && Number.isFinite(snapshot.remainingMs) && snapshot.remainingMs > 0 && snapshot.remainingMs <= this.ttlMs;
    }

    attach(snapshot, { requestedAt = this.now(), startTimeNs = 0 } = {}) {
        if (!snapshot?.leaseId || !snapshot.runId || !snapshot.target?.vehicleId || !this._active(snapshot) || !Number.isSafeInteger(startTimeNs) || startTimeNs < 0) throw new Error("A live, run-bound control lease is required.");
        const deadline = requestedAt + snapshot.remainingMs;
        const sameLease = this.lease?.leaseId === snapshot.leaseId;
        this.deadline = sameLease ? Math.max(this.deadline, deadline) : deadline;
        if (!sameLease) this.commandAfterNs = -1;
        this.lease = { leaseId: snapshot.leaseId, runId: snapshot.runId, mode: snapshot.mode, vehicleId: snapshot.target.vehicleId };
        this.startTimeNs = startTimeNs;
        this.lost = false;
        this.check();
    }

    begin(snapshot, { requestedAt = this.now() } = {}) {
        if (!snapshot?.leaseId || snapshot.runId || !snapshot.target?.vehicleId || !this._active(snapshot)) throw new Error("A live unbound control lease is required for preparation.");
        this.lease = { leaseId: snapshot.leaseId, runId: null, mode: snapshot.mode, vehicleId: snapshot.target.vehicleId };
        this.lost = false;
        this.deadline = requestedAt + snapshot.remainingMs;
        this.commandAfterNs = -1;
    }

    suspend(timeNs = -1) {
        if (this.lease && !this.lost) {
            this.holdUntil = Infinity;
            // Buffered transport samples can arrive after verification with the frozen clock.
            this.commandAfterNs = Math.max(this.commandAfterNs, timeNs);
        }
    }

    recheck() {
        if (this.holdUntil === Infinity) this.holdUntil = this.now() + this.ttlMs;
    }

    update(snapshot, { requestedAt = this.now(), foreground = false } = {}) {
        if (this.lost || !this.lease || snapshot?.leaseId !== this.lease.leaseId || (this.lease.runId && snapshot.runId !== this.lease.runId)) return false;
        const now = this.now();
        if (now >= (this.holdUntil ?? this.deadline)) return this._lose("lease-expired");
        if (!this._active(snapshot) || snapshot.mode !== this.lease.mode || snapshot.target?.vehicleId !== this.lease.vehicleId) return this._lose("lease-lost");
        const deadline = requestedAt + snapshot.remainingMs;
        if (this.holdUntil !== null) {
            if (!this.lease.runId) return true; // Let preparation bind the run while keeping it paused.
            if (!foreground || requestedAt < this.holdUntil - this.ttlMs || deadline <= now) return false;
            this.holdUntil = null;
            this.deadline = deadline;
        } else {
            this.deadline = Math.max(this.deadline, deadline);
        }
        return true;
    }

    check() {
        if (!this.lease) return true;
        if (this.lost) return false;
        if (this.now() >= (this.holdUntil ?? this.deadline)) return this._lose("lease-expired");
        return this.holdUntil === null && Boolean(this.lease.runId);
    }

    validate(command, { applyTimeNs } = {}) {
        if (!this.lease) return { ok: true };
        if (!this.check()) return !this.lost && this.holdUntil !== null
            ? { ok: false, code: "control-lease-checking", message: "Waiting to verify control ownership." }
            : { ok: false, code: "control-lease-lost", message: "Control ownership has ended." };
        if (command?.leaseId !== this.lease.leaseId || command.runId !== this.lease.runId) return { ok: false, code: "control-lease-mismatch", message: "Command does not belong to the active control lease." };
        if (!["velocity", "stop"].includes(command.mode)) return { ok: false, code: "control-lease-command-mode", message: "Onboarding commands require velocity or stop mode." };
        if (command.mode !== "stop" && command.captureTimeNs <= this.commandAfterNs) return { ok: false, code: "control-lease-command-stale", message: "Motion commands must use a new simulation sample after a tab pause." };
        if (!Number.isSafeInteger(applyTimeNs) || !Number.isSafeInteger(command.captureTimeNs) || !Number.isSafeInteger(command.deadlineNs) || command.captureTimeNs > applyTimeNs || applyTimeNs - command.captureTimeNs > ONBOARDING_COMMAND_FRESHNESS_NS || command.deadlineNs < command.captureTimeNs || command.deadlineNs - command.captureTimeNs > ONBOARDING_COMMAND_FRESHNESS_NS || applyTimeNs > command.deadlineNs) return { ok: false, code: "control-lease-command-stale", message: "Onboarding command exceeds its 300 ms validity window." };
        if (this.lease.mode === "observe" && command.mode !== "stop" && ["speedMps", "steeringRad", "accelerationMps2", "jerkMps3", "steeringRateRadps"].some((field) => command[field] !== 0)) return { ok: false, code: "control-lease-observe", message: "Observe ownership cannot actuate." };
        if (this.lease.mode === "drive-test" && (Math.abs(command.speedMps) > 0.1 || Math.abs(command.steeringRad) > 0.1 || applyTimeNs - this.startTimeNs >= 1_000_000_000)) return { ok: false, code: "control-lease-drive-test", message: "Drive-test limits are 0.1 m/s, 0.1 rad, and one simulation second." };
        return { ok: true };
    }

    _lose(reason) {
        if (this.lost) return false;
        this.lost = true;
        this.onLoss({ reason, leaseId: this.lease?.leaseId, runId: this.lease?.runId });
        return false;
    }

    close() { clearInterval(this.timer); this.lease = null; this.lost = false; this.holdUntil = null; }
}
