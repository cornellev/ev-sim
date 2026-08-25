import { getRecordingController } from "../logging/RecordingController.js";
import { buildRecordingOptions } from "../logging/RecordingOptions.js";
import { builtInProfile } from "../logging/LogProfiles.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import { resolveRunManifest } from "./RunManifestClient.js";

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function formatDetail(value) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

const PREPARE_TIMEOUT_MS = 30_000;

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
            simulation: null,
        };
        this._launchSequence = 0;
        this._environmentHandler = null;
        this.recording = getRecordingController();
        this._recordingRunId = null;
        this._unsubscribeSimulation = null;
        this._autoFinalizing = false;
        this._pendingPrepare = null;
        this._scenarioDiagnosticsEnabled = false;
        this._loggingPolicyOverride = null;
        this._speedOverride = null;
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
        simulation?.setScenarioDiagnosticsEnabled?.(this._scenarioDiagnosticsEnabled);
        this.recording.attachSimulation(simulation);
        this._unsubscribeSimulation = simulation?.subscribe?.((simulationState) => {
            if (!this.snapshot.activeRunId) return;
            const assertionResults = simulationState.assertions || [];
            const terminalAssertion = assertionResults.some((result) => result.status === "failed" && result.severity === "error" && result.onFailure === "stop");
            const reachedLimit = simulationState.maxSteps !== null && simulationState.steps >= simulationState.maxSteps;
            const scenarioTerminal = simulationState.scenario?.terminal ?? null;
            if ((scenarioTerminal || terminalAssertion || reachedLimit) && !this._autoFinalizing && ["running", "paused", "ready"].includes(this.snapshot.status)) {
                this._autoFinalizing = true;
                this.stop({
                    status: scenarioTerminal?.status === "error"
                        ? "error"
                        : terminalAssertion
                            ? "failed"
                            : reachedLimit && simulationState.scenario?.active
                                ? "interrupted"
                                : "completed",
                })
                    .catch((error) => this._set({ status: "error", error: error.message }))
                    .finally(() => { this._autoFinalizing = false; });
                return;
            }
            const status = simulationState.status === "playing" ? "running" : simulationState.status;
            this._set({ status, assertionResults, simulation: simulationState });
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
        this._rejectPendingPrepare(new Error("Run preparation was superseded by a newer request."));
        const readiness = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this._pendingPrepare?.sequence !== launchSequence) return;
                this._pendingPrepare = null;
                const error = new Error(`Timed out waiting for environment "${resolved.manifest.environment.id}" to become ready.`);
                this._set({ status: "error", error: error.message, pendingResolved: null });
                reject(error);
            }, PREPARE_TIMEOUT_MS);
            this._pendingPrepare = { sequence: launchSequence, resolve, reject, timeout };
        });
        this._set({
            status: "preparing",
            selectedManifestId: resolved.manifest.id,
            pendingResolved: resolved,
            error: null,
            degraded: false,
            autoplay,
            runResult: null,
        });
        if (this.data?.environment?.()?.environmentId === resolved.manifest.environment.id) {
            this._applyPending(launchSequence).catch(() => {});
        } else {
            if (!this._environmentHandler) {
                const error = new Error(`Cannot load environment "${resolved.manifest.environment.id}" because no environment handler is attached.`);
                this._rejectPendingPrepare(error);
                this._set({ status: "error", error: error.message, pendingResolved: null });
            } else {
                this._environmentHandler(resolved.manifest.environment.id);
            }
        }
        return readiness;
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
            const snapshot = this.getSnapshot();
            this._resolvePendingPrepare(expectedSequence, snapshot);
            return snapshot;
        } catch (error) {
            this._set({ status: "error", error: error.message, pendingResolved: null });
            this._rejectPendingPrepare(error, expectedSequence);
            throw error;
        }
    }

    _resolvePendingPrepare(sequence, value) {
        const pending = this._pendingPrepare;
        if (!pending || pending.sequence !== sequence) return;
        clearTimeout(pending.timeout);
        this._pendingPrepare = null;
        pending.resolve(value);
    }

    _rejectPendingPrepare(error, sequence = null) {
        const pending = this._pendingPrepare;
        if (!pending || (sequence !== null && pending.sequence !== sequence)) return;
        clearTimeout(pending.timeout);
        this._pendingPrepare = null;
        pending.reject(error);
    }

    setRunState(patch) {
        this._set(patch);
    }

    async play() {
        if (!this.data || !this.snapshot.activeResolved) return null;
        await this._ensureRecording();
        this.applyRuntimeOverrides(this.snapshot.activeResolved);
        this.data.simulation?.()?.play?.();
        this._set({ status: "running" });
        return this.getSnapshot();
    }

    pause() {
        this.data?.simulation?.()?.pause?.();
        if (this.snapshot.activeRunId) this._set({ status: "paused" });
    }

    setScenarioDiagnosticsEnabled(enabled) {
        this._scenarioDiagnosticsEnabled = Boolean(enabled);
        const simulation = this.data?.simulation?.();
        if (!simulation?.setScenarioDiagnosticsEnabled) return false;
        simulation.setScenarioDiagnosticsEnabled(this._scenarioDiagnosticsEnabled);
        return true;
    }

    setLoggingPolicyOverride(policy = null) {
        if (policy === null || policy === undefined || policy === "") {
            this._loggingPolicyOverride = null;
            return null;
        }
        const normalized = String(policy);
        if (!["required", "optional", "disabled"].includes(normalized)) {
            throw new Error(`Unsupported logging policy override "${policy}".`);
        }
        this._loggingPolicyOverride = normalized;
        return this._loggingPolicyOverride;
    }

    setSpeedOverride(speed = null) {
        if (speed === null || speed === undefined || speed === "") {
            this._speedOverride = null;
            return null;
        }
        const next = Math.max(0, Number(speed) || 0);
        this._speedOverride = next;
        this.data?.simulation?.()?.setSpeed?.(next);
        return this._speedOverride;
    }

    applyRuntimeOverrides(resolved = this.snapshot.activeResolved) {
        const simulation = this.data?.simulation?.();
        if (!simulation) return;
        const requiresRealtime = Boolean(
            resolved?.manifest?.clock?.pacing === "realtime"
            && resolved?.scenario?.scenario?.routes?.some((route) => route.controller?.kind === "external-ros"),
        );
        const speed = requiresRealtime
            ? 1
            : (this._speedOverride ?? resolved?.manifest?.clock?.speed ?? 1);
        simulation.setSpeed?.(speed);
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
        simulation?.scenarioRuntime?.observeAssertions?.(finalized.results);
        const scenarioResult = simulation?.scenarioRuntime?.finalize?.({
            step: simulation?.steps || 0,
            timeNs: simulation?.timeNs || 0,
            assertions: finalized.results,
        }) ?? null;
        const errorAssertionFailures = finalized.results.filter((result) => result.status === "failed" && result.severity === "error");
        let finalStatus = status === "assertion-failed"
            ? "failed"
            : scenarioResult?.status === "error"
                ? "error"
                : status;
        if (scenarioResult && scenarioResult.completed !== true && !["error", "cancelled", "failed"].includes(finalStatus)) {
            finalStatus = scenarioResult.status === "error" ? "error" : "interrupted";
        }
        const completed = scenarioResult ? scenarioResult.completed : finalStatus === "completed";
        const passed = scenarioResult
            ? scenarioResult.passed && errorAssertionFailures.length === 0
            : completed && errorAssertionFailures.length === 0;
        const firstAssertionFailure = errorAssertionFailures[0] ?? null;
        const firstOutcomeFailure = scenarioResult?.outcomes?.find((outcome) => outcome.passed !== true) ?? null;
        const terminalDetail = formatDetail(scenarioResult?.terminalEvent?.detail);
        const failureReason = passed
            ? null
            : firstAssertionFailure
                ? `Assertion "${firstAssertionFailure.name || firstAssertionFailure.id}" failed${firstAssertionFailure.message ? `: ${firstAssertionFailure.message}` : "."}`
                : firstOutcomeFailure
                    ? `Expected outcome "${firstOutcomeFailure.name || firstOutcomeFailure.id}" failed${firstOutcomeFailure.detail ? `: ${firstOutcomeFailure.detail}` : "."}`
                    : terminalDetail
                        ? terminalDetail
                        : (scenarioResult?.terminationReason ?? finalStatus);
        let runResult = {
            runId: this.snapshot.activeRunId,
            manifestId: this.snapshot.activeResolved?.manifest?.id || null,
            resolvedHash: this.snapshot.activeResolved?.resolvedHash || null,
            scenarioId: this.snapshot.activeResolved?.scenario?.scenario?.id || null,
            status: finalStatus,
            completed,
            completedAt: new Date().toISOString(),
            step: simulation?.steps || 0,
            timeNs: simulation?.timeNs || 0,
            assertions: finalized.results,
            passed,
            terminationReason: scenarioResult?.terminationReason
                ?? (finalStatus === "failed" ? "fatal-assertion" : finalStatus),
            latestTrigger: scenarioResult?.latestTrigger ?? null,
            outcomes: scenarioResult?.outcomes ?? [],
            metrics: scenarioResult?.metrics ?? {
                completed: completed ? 1 : 0,
                passed: passed ? 1 : 0,
                duration: (simulation?.timeNs || 0) / 1e9,
                "assertion-failures": errorAssertionFailures.length,
            },
            terminalEvent: scenarioResult?.terminalEvent ?? null,
            failureReason,
            logId: this.recording?.session?.id ?? null,
        };
        if (this._recordingRunId === this.snapshot.activeRunId) {
            this.recording.addAttachment({ name: "run-results.json", mime: "application/json", bytes: JSON.stringify(runResult) });
            const metadata = await this.recording.stop({ runResult });
            runResult = { ...runResult, logId: metadata?.id ?? runResult.logId };
            this._recordingRunId = null;
        }
        simulation?.stop?.({ reset: false });
        this._set({ status: finalStatus, assertionResults: finalized.results, runResult });
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
        const policy = this._loggingPolicyOverride ?? resolved.manifest.logging.policy;
        if (policy === "disabled") {
            this._recordingRunId = runId;
            return;
        }
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
                haltSimulationOnError: policy === "required",
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
        this._rejectPendingPrepare(new Error("Run preparation was cleared."));
        this._loggingPolicyOverride = null;
        this._speedOverride = null;
        this._set({
            status: "idle",
            pendingResolved: null,
            activeResolved: null,
            activeRunId: null,
            error: null,
            degraded: false,
            assertionResults: [],
            runResult: null,
            simulation: null,
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
