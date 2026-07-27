import { getRecordingController } from "../logging/RecordingController.js";
import { buildRecordingOptions } from "../logging/RecordingOptions.js";
import { builtInProfile } from "../logging/LogProfiles.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import { resolveRunManifest } from "./RunManifestClient.js";

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

export class RunSessionController {
    constructor() {
        this.listeners = new Set();
        this.data = null;
        this.snapshot = {
            status: "idle",
            selectedManifestId: null,
            pendingResolved: null,
            activeResolved: null,
            activeRunId: null,
            error: null,
            degraded: false,
            assertionResults: [],
        };
        this._launchSequence = 0;
        this._environmentHandler = null;
        this.recording = getRecordingController();
        this._recordingRunId = null;
        this._unsubscribeSimulation = null;
        this._autoFinalizing = false;
    }

    getSnapshot() {
        return clone(this.snapshot);
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    selectManifest(id) {
        this._set({ selectedManifestId: id || null });
    }

    setEnvironmentHandler(handler = null) {
        this._environmentHandler = typeof handler === "function" ? handler : null;
        return () => {
            if (this._environmentHandler === handler) this._environmentHandler = null;
        };
    }

    attachData(data) {
        this._unsubscribeSimulation?.();
        this.data = data;
        const simulation = data?.simulation?.();
        this.recording.attachSimulation(simulation);
        this._unsubscribeSimulation = simulation?.subscribe?.((simulationState) => {
            if (!this.snapshot.activeRunId) return;
            const assertionResults = simulationState.assertions || [];
            const terminalAssertion = assertionResults.some((result) => result.status === "failed" && result.severity === "error" && result.onFailure === "stop");
            const reachedLimit = simulationState.maxSteps !== null && simulationState.steps >= simulationState.maxSteps;
            if ((terminalAssertion || reachedLimit) && !this._autoFinalizing && ["running", "paused", "ready"].includes(this.snapshot.status)) {
                this._autoFinalizing = true;
                this.stop({ status: terminalAssertion ? "assertion-failed" : "completed" })
                    .catch((error) => this._set({ status: "error", error: error.message }))
                    .finally(() => { this._autoFinalizing = false; });
                return;
            }
            const status = simulationState.status === "playing" ? "running" : simulationState.status;
            this._set({ status, assertionResults });
        }) || null;
        if (this.snapshot.pendingResolved) this._applyPending().catch(() => {});
        return () => {
            if (this.data === data) {
                this._unsubscribeSimulation?.();
                this._unsubscribeSimulation = null;
                this.data = null;
            }
        };
    }

    async prepare(resolved, { autoplay = false } = {}) {
        if (!resolved?.manifest || !resolved?.resolvedHash) throw new Error("A resolved run manifest is required.");
        if (this.snapshot.activeRunId && ["running", "paused", "ready"].includes(this.snapshot.status)) {
            await this.stop({ status: "superseded" });
        }
        const launchSequence = ++this._launchSequence;
        this._set({
            status: "preparing",
            selectedManifestId: resolved.manifest.id,
            pendingResolved: resolved,
            error: null,
            degraded: false,
            autoplay,
        });
        if (this.data?.environment?.()?.environmentId === resolved.manifest.environment.id) {
            await this._applyPending(launchSequence);
        } else {
            this._environmentHandler?.(resolved.manifest.environment.id);
        }
        return { environmentId: resolved.manifest.environment.id, resolvedHash: resolved.resolvedHash };
    }

    async _applyPending(expectedSequence = this._launchSequence) {
        const resolved = this.snapshot.pendingResolved;
        if (!resolved || !this.data || expectedSequence !== this._launchSequence) return null;
        if (this.data.environment?.()?.environmentId !== resolved.manifest.environment.id) return null;
        try {
            const simulation = this.data.simulation?.();
            await simulation?.applyRunManifest?.(resolved);
            if (expectedSequence !== this._launchSequence) return null;
            const runId = `run-${new Date().toISOString().replace(/[-:.]/g, "").replace("Z", "Z")}-${resolved.resolvedHash.slice(0, 8)}`;
            this._set({
                status: "ready",
                pendingResolved: null,
                activeResolved: resolved,
                activeRunId: runId,
                error: null,
            });
            if (this.snapshot.autoplay) await this.play();
            return this.getSnapshot();
        } catch (error) {
            this._set({ status: "error", error: error.message, pendingResolved: null });
            throw error;
        }
    }

    setRunState(patch) {
        this._set(patch);
    }

    async play() {
        if (!this.data || !this.snapshot.activeResolved) return null;
        await this._ensureRecording();
        this.data.simulation?.()?.play?.();
        this._set({ status: "running" });
        return this.getSnapshot();
    }

    pause() {
        this.data?.simulation?.()?.pause?.();
        if (this.snapshot.activeRunId) this._set({ status: "paused" });
    }

    async step(count = 1) {
        if (!this.data || !this.snapshot.activeResolved) return null;
        await this._ensureRecording();
        this.data.simulation?.()?.step?.(count);
        this._set({ status: "paused", assertionResults: this.data.simulation?.()?.assertionEngine?.snapshot?.() || [] });
        return this.getSnapshot();
    }

    async stop({ status = "stopped" } = {}) {
        const simulation = this.data?.simulation?.();
        const finalized = simulation?.assertionEngine?.finalize?.(simulation.steps || 0) || { results: [] };
        const runResult = {
            runId: this.snapshot.activeRunId,
            manifestId: this.snapshot.activeResolved?.manifest?.id || null,
            resolvedHash: this.snapshot.activeResolved?.resolvedHash || null,
            status,
            completedAt: new Date().toISOString(),
            step: simulation?.steps || 0,
            timeNs: simulation?.timeNs || 0,
            assertions: finalized.results,
            passed: finalized.results.every((result) => result.status !== "failed"),
        };
        if (this._recordingRunId === this.snapshot.activeRunId) {
            this.recording.addAttachment({ name: "run-results.json", mime: "application/json", bytes: JSON.stringify(runResult) });
            await this.recording.stop({ runResult });
            this._recordingRunId = null;
        }
        simulation?.stop?.({ reset: false });
        this._set({ status, assertionResults: finalized.results, runResult });
        return runResult;
    }

    async reset() {
        const manifestId = this.snapshot.selectedManifestId || this.snapshot.activeResolved?.manifest?.id;
        if (!manifestId) return null;
        await this.stop({ status: "reset" });
        const resolved = await resolveRunManifest(manifestId);
        return this.prepare(resolved, { autoplay: false });
    }

    async _ensureRecording() {
        const resolved = this.snapshot.activeResolved;
        const runId = this.snapshot.activeRunId;
        if (!resolved || !runId || this._recordingRunId === runId) return;
        const policy = resolved.manifest.logging.policy;
        if (policy === "disabled") return;
        const renderer = this.data?.renderer;
        const gl = renderer?.getContext?.();
        const debugInfo = gl?.getExtension?.("WEBGL_debug_renderer_info");
        const provenance = {
            appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "0.1.0",
            gitHash: process.env.NEXT_PUBLIC_GIT_HASH || null,
            orchestratorCatalogHash: this.data?.client?.()?.catalogHash || null,
            userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
            platform: typeof navigator !== "undefined" ? navigator.platform : null,
            webglVendor: debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) : null,
            webglRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : null,
        };
        try {
            await this.recording.start(buildRecordingOptions({
                data: this.data,
                store: getTelemetryStore(),
                profile: builtInProfile(resolved.manifest.logging.profileId),
                name: `${resolved.manifest.name}: ${runId}`,
                runId,
                resolvedRun: resolved,
                provenance,
            }));
            this._recordingRunId = runId;
        } catch (error) {
            if (policy === "required") throw error;
            this._recordingRunId = runId;
            this._set({ degraded: true, error: `Optional logging unavailable: ${error.message}` });
            getTelemetryStore().emitTelemetryEvent({
                category: "logging",
                name: "optional-recording-unavailable",
                severity: "warning",
                payload: { runId, error: error.message },
            });
        }
    }

    clear() {
        this._launchSequence += 1;
        this._set({
            status: "idle",
            pendingResolved: null,
            activeResolved: null,
            activeRunId: null,
            error: null,
            degraded: false,
            assertionResults: [],
        });
    }

    _set(patch) {
        this.snapshot = { ...this.snapshot, ...patch };
        const value = this.getSnapshot();
        for (const listener of this.listeners) listener(value);
    }
}

let sharedController;

export function getRunSessionController() {
    if (!sharedController) sharedController = new RunSessionController();
    return sharedController;
}
