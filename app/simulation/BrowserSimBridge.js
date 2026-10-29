import { subscribeStorageEvents } from "../client/storageEvents.js";
import {
    BROWSER_SIM_HEARTBEAT_MS,
    assertBrowserSimCommand,
    browserSimError,
    browserSimSnapshot,
} from "./BrowserSimControl.js";

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
    }

    snapshot() {
        return browserSimSnapshot(this.controller, this.experiment, this.getContext().navigationBlocked());
    }

    start() {
        this.active = true;
        const interact = (event) => {
            if (!event.isTrusted) return;
            if (event.type === "focus" && event.target !== this.windowImpl) return;
            if (event.type === "visibilitychange" && (this.documentImpl.visibilityState !== "visible" || !this.documentImpl.hasFocus())) return;
            this.activity += 1;
            this.sync();
        };
        const events = [[this.windowImpl, "focus"], ...["visibilitychange", "pointerdown", "keydown", "wheel"].map((type) => [this.documentImpl, type])];
        for (const [target, type] of events) target.addEventListener(type, interact, { capture: true, passive: true });
        if (this.documentImpl.hasFocus()) this.activity += 1;
        const unsubscribeEvents = this.subscribeEvents((event) => {
            if (event.domain === "browser-sim" && event.id === this.registration?.browserId) this.sync();
        });
        const unsubscribeRun = this.controller.subscribe(() => this.sync());
        const unsubscribeExperiment = this.experiment?.subscribe(() => this.sync());
        const timer = setInterval(() => this.sync(), BROWSER_SIM_HEARTBEAT_MS);
        this.sync();
        return () => {
            this.active = false;
            clearInterval(timer);
            unsubscribeEvents();
            unsubscribeRun();
            unsubscribeExperiment?.();
            for (const [target, type] of events) target.removeEventListener(type, interact, true);
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

    async _sync() {
        if (!this.registration) {
            const registration = await this._request("/bridge/register", { snapshot: this.snapshot(), activity: this.activity, sequence: ++this.reportSequence });
            if (!this.active) {
                this._unregister(registration);
                return;
            }
            this.registration = registration;
        }
        const registration = this.registration;
        try {
            const heartbeat = await this._request(`/bridge/${registration.browserId}/heartbeat`, {
                snapshot: this.snapshot(), activity: this.activity, sequence: ++this.reportSequence,
            }, registration);
            if (!this.active || this.registration !== registration) return;
            const completed = new Set();
            for (const operation of this.operations.values()) {
                if (operation.completion && operation.registration === registration) {
                    await this._complete(operation);
                    completed.add(operation.commandId);
                }
            }
            if (heartbeat.command && !completed.has(heartbeat.command.commandId)) this._handle(heartbeat.command, registration);
        } catch (error) {
            if (error.code === "BROWSER_NOT_REGISTERED" && this.registration === registration) {
                this.registration = null;
                // The new server must not inherit executions or receipts from its predecessor.
                this.operations.clear();
            }
            throw error;
        }
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
            const command = await this._request(`/bridge/${registration.browserId}/commands/${summary.commandId}/claim`, { claimId: operation.claimId }, registration);
            if (!this.active || this.registration !== registration) return;
            let error = null;
            try {
                await this.execute(command);
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
            await this._request(`/bridge/${registration.browserId}/commands/${commandId}/complete`, operation.completion, registration);
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
                await controller.prepare(command.resolved, { autoplay: command.autoplay, manifestRevision: command.manifestRevision });
                break;
            case "pause":
                if (controller.getSnapshot().status !== "ready") await controller.pause();
                break;
            case "resume":
                if (controller.getSnapshot().status !== "running") await controller.play();
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
