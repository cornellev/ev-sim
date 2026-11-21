import { subscribeStorageEvents } from "../client/storageEvents.js";
import {
    BROWSER_SIM_HEARTBEAT_MS,
    assertBrowserSimCommand,
    browserSimError,
    browserSimSnapshot,
} from "./BrowserSimControl.js";

const TAB_KEY = "cev-sim.browser-sim.tab";
const LEASE_REQUEST_TIMEOUT_MS = 1_000;

/** App-lifetime HTTP/SSE adapter. The run controller remains the lifecycle owner. */
export class BrowserSimBridge {
    constructor({ controller, experiment, getContext, fetchImpl = (...args) => globalThis.fetch(...args), windowImpl = globalThis.window, documentImpl = globalThis.document, subscribeEvents = subscribeStorageEvents }) {
        Object.assign(this, { controller, experiment, getContext, fetchImpl, windowImpl, documentImpl, subscribeEvents });
        this.registration = null;
        this.activity = 0;
        this.reportSequence = 0;
        this.operations = new Map();
        this.active = false;
        this.syncing = null;
        this.syncAgain = false;
        this.visibilitySequence = 0;
    }

    snapshot() {
        return browserSimSnapshot(this.controller, this.experiment, this.getContext().navigationBlocked());
    }

    start() {
        this._claimTab();
        this.active = true;
        this.controller.setControlVisibility?.(this.documentImpl.visibilityState === "hidden");
        const interact = (event) => {
            if (!event.isTrusted) return;
            if (event.type === "focus" && event.target !== this.windowImpl) return;
            this.activity += 1;
            this.sync();
        };
        const visibility = () => {
            const hidden = this.documentImpl.visibilityState === "hidden";
            this.visibilitySequence++;
            this.controller.setControlVisibility?.(hidden);
            if (hidden && this.registration && this.controller.getSnapshot().controlOwnershipState === "backgrounded") {
                // Report the intentional pause even if the page freezes behind an in-flight request.
                this._heartbeat(this.registration, { keepalive: true }).catch(() => {});
            }
            if (!hidden && this.documentImpl.hasFocus()) this.activity += 1;
            this.sync();
        };
        const events = [[this.windowImpl, "focus"], ...["pointerdown", "keydown", "wheel"].map((type) => [this.documentImpl, type])];
        for (const [target, type] of events) target.addEventListener(type, interact, { capture: true, passive: true });
        this.documentImpl.addEventListener("visibilitychange", visibility);
        if (this.documentImpl.hasFocus()) this.activity += 1;
        const unsubscribeEvents = this.subscribeEvents((event) => {
            if (event.domain === "browser-sim" && event.id === this.registration?.browserId) this.sync();
        });
        const unsubscribeRun = this.controller.subscribe(() => this.sync());
        const unsubscribeExperiment = this.experiment?.subscribe(() => this.sync());
        let lastHeartbeat = Date.now();
        this.timer = setInterval(() => {
            if (this.controller.ownershipGuard?.lease || Date.now() - lastHeartbeat >= BROWSER_SIM_HEARTBEAT_MS) { lastHeartbeat = Date.now(); this.sync(); }
        }, 250);
        this.sync();
        return () => {
            this.active = false;
            clearInterval(this.timer);
            unsubscribeEvents();
            unsubscribeRun();
            unsubscribeExperiment?.();
            for (const [target, type] of events) target.removeEventListener(type, interact, true);
            this.documentImpl.removeEventListener("visibilitychange", visibility);
            if (this.registration) this._unregister(this.registration);
        };
    }

    sync() {
        if (!this.active) return Promise.resolve();
        if (this.syncing) {
            this.syncAgain = true;
            return this.syncing;
        }
        this.syncing = this._sync().then(() => { this.lastSyncError = null; }).catch((error) => {
            // Report a changed failure once; retry offline servers through the heartbeat.
            if (this.lastSyncError !== error.message) console.warn("[browser-sim] Bridge unavailable:", error.message);
            this.lastSyncError = error.message;
        }).finally(() => {
            this.syncing = null;
            if (this.syncAgain) {
                this.syncAgain = false;
                this.sync();
            }
        });
        return this.syncing;
    }

    async _sync(retried = false) {
        if (this._superseded()) {
            this._stopReplaced();
            return;
        }
        if (!this.registration) {
            let registration;
            try {
                registration = await this._request("/bridge/register", {
                    snapshot: this.snapshot(), activity: this.activity, sequence: ++this.reportSequence, tabId: this.tabId, epoch: this.epoch,
                });
            } catch (error) {
                if (error.code === "BRIDGE_REPLACED" || this._superseded()) {
                    this._stopReplaced();
                    return;
                }
                throw error;
            }
            if (!this.active || this._superseded()) {
                this._unregister(registration);
                if (this._superseded()) this._stopReplaced();
                return;
            }
            this.registration = registration;
        }
        const registration = this.registration;
        try {
            const requestedAt = performance.now();
            const visibilitySequence = this.visibilitySequence;
            const heartbeat = await this._heartbeat(registration);
            if (!this.active || this.registration !== registration) return;
            if (heartbeat.controlLease) this.controller.updateControlOwnership?.(heartbeat.controlLease, {
                requestedAt, foreground: this.documentImpl.visibilityState === "visible" && this.visibilitySequence === visibilitySequence,
            });
            const completed = new Set();
            for (const operation of this.operations.values()) {
                if (operation.completion && operation.registration === registration) {
                    await this._complete(operation);
                    completed.add(operation.commandId);
                }
            }
            if (heartbeat.command && !completed.has(heartbeat.command.commandId)) this._handle(heartbeat.command, registration);
        } catch (error) {
            if (error.code === "BRIDGE_REPLACED" || this._superseded()) {
                this._stopReplaced();
                return;
            }
            if (!retried && error.code === "BROWSER_NOT_REGISTERED" && this.registration === registration) {
                const lease = this.controller.ownershipGuard?.lease;
                if (lease) this.controller.updateControlOwnership?.({ ...lease, status: "lost", remainingMs: 0 });
                this.registration = null;
                // The new server must not inherit executions or receipts from its predecessor.
                this.operations.clear();
                if (this.active) return this._sync(true);
                return;
            }
            throw error;
        }
    }

    _heartbeat(registration, options = {}) {
        return this._request(`/bridge/${registration.browserId}/heartbeat`, {
            snapshot: this.snapshot(), activity: this.activity, sequence: ++this.reportSequence,
        }, registration, { ...this._leaseRequestOptions(), ...options });
    }

    _leaseRequestOptions() {
        return this.controller.ownershipGuard?.lease ? { signal: AbortSignal.timeout(LEASE_REQUEST_TIMEOUT_MS) } : {};
    }

    // sessionStorage survives reload in this tab only; a newer epoch belongs to the replacement.
    _claimTab() {
        const storage = this.windowImpl?.sessionStorage;
        if (!storage) {
            if (!this.tabId) this.tabId = crypto.randomUUID();
            this.epoch = (this.epoch ?? 0) + 1;
            return;
        }
        let state = null;
        try { state = JSON.parse(storage.getItem(TAB_KEY) || "null"); } catch { state = null; }
        if (!state || typeof state.tabId !== "string" || !state.tabId) state = { tabId: crypto.randomUUID(), epoch: 0 };
        const epoch = Number.isSafeInteger(state.epoch) ? state.epoch : 0;
        storage.setItem(TAB_KEY, JSON.stringify({ tabId: state.tabId, epoch: epoch + 1 }));
        this.tabId = state.tabId;
        this.epoch = epoch + 1;
    }

    _superseded() {
        const storage = this.windowImpl?.sessionStorage;
        if (!storage || this.epoch == null) return false;
        try {
            const state = JSON.parse(storage.getItem(TAB_KEY) || "null");
            return state?.tabId === this.tabId && state.epoch > this.epoch;
        } catch {
            return false;
        }
    }

    _stopReplaced() {
        this.active = false;
        clearInterval(this.timer);
    }

    async _handle(summary, registration) {
        let operation = this.operations.get(summary.commandId);
        if (operation?.working || operation?.completion) return;
        if (!operation) {
            operation = { commandId: summary.commandId, claimId: crypto.randomUUID(), registration };
            this.operations.set(summary.commandId, operation);
        }
        operation.working = true;
        try {
            const leaseRequestedAt = performance.now();
            const command = await this._request(`/bridge/${registration.browserId}/commands/${summary.commandId}/claim`, { claimId: operation.claimId }, registration);
            if (!this.active || this.registration !== registration) return;
            let error = null;
            try {
                await this.execute({ ...command, leaseRequestedAt });
            } catch (failure) {
                error = { code: failure.code ?? "BROWSER_COMMAND_FAILED", message: String(failure.message).slice(0, 4096) };
            }
            operation.completion = { claimId: operation.claimId, snapshot: this.snapshot(), sequence: ++this.reportSequence, error };
            await this._complete(operation);
            this.sync();
        } catch (error) {
            if (["COMMAND_NOT_FOUND", "COMMAND_NOT_PENDING", "BROWSER_NOT_REGISTERED"].includes(error.code)) {
                this.operations.delete(summary.commandId);
            }
            // A lost claim/completion response is retried with the same claim ID.
        } finally {
            operation.working = false;
        }
    }

    async _complete(operation) {
        const { registration, commandId } = operation;
        try {
            const requestedAt = performance.now();
            const response = await this._request(`/bridge/${registration.browserId}/commands/${commandId}/complete`, operation.completion, registration, this._leaseRequestOptions());
            if (response.controlLease && this.active && this.registration === registration) this.controller.updateControlOwnership?.(response.controlLease, { requestedAt });
            this.operations.delete(commandId);
        } catch (error) {
            if (["COMMAND_NOT_FOUND", "BROWSER_NOT_REGISTERED"].includes(error.code)) this.operations.delete(commandId);
            else throw error;
        }
    }

    async execute(command) {
        assertBrowserSimCommand(command, this.snapshot());
        if (["start", "reset", "resume"].includes(command.action)) {
            if (!this.getContext().openSimulation()) {
                throw browserSimError("NAVIGATION_BLOCKED", "Save or discard workspace edits before launching this run.");
            }
            assertBrowserSimCommand(command, this.snapshot());
        }
        const controller = this.controller;
        switch (command.action) {
            case "start":
                await controller.prepare(command.resolved, { autoplay: command.autoplay, manifestRevision: command.manifestRevision, controlLease: command.controlLease, leaseRequestedAt: command.leaseRequestedAt });
                break;
            case "pause":
                if (controller.getSnapshot().status !== "ready") await controller.pause();
                break;
            case "resume":
                if (controller.getSnapshot().status !== "running") await controller.play();
                break;
            case "bind-ownership":
                controller.rebindControlOwnership(command.controlLease, { requestedAt: command.leaseRequestedAt });
                break;
            case "stop":
                await controller.stop();
                break;
            case "reset":
                await controller.reset(command.resolved, { manifestRevision: command.manifestRevision });
                break;
            default:
                throw browserSimError("INVALID_REQUEST", "Unsupported lifecycle command.", 400);
        }
    }

    async _request(path, body, registration = null, options = {}) {
        const response = await this.fetchImpl(`/api/browser-sim${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(registration ? { "X-CEV-Browser-Token": registration.token } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10_000),
            ...options,
        });
        const result = await response.json();
        if (!response.ok) throw browserSimError(result.code ?? "HTTP_ERROR", result.error ?? `Browser bridge HTTP ${response.status}.`, response.status);
        return result;
    }

    _unregister(registration) {
        this._request(`/bridge/${registration.browserId}`, undefined, registration, { method: "DELETE", keepalive: true }).catch(() => {});
    }
}
