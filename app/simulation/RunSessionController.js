import { getRecordingController } from "../logging/RecordingController.js";
import { assertProtobufExecutionCapabilities } from "../interfaces/ProtobufRunBinding.js";
import { buildRecordingOptions } from "../logging/RecordingOptions.js";
import { builtInProfile } from "../logging/LogProfiles.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import { CEV_SIM_VERSION } from "../version.js";
import { resolveRunManifest } from "./RunManifestClient.js";
import { assertEnabledCameraRenderRuntime } from "./render/RenderSceneProviderRegistry.js";
import { ControlOwnershipGuard } from "../autonomy/ControlOwnershipGuard.js";

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function assertionSignature(results = []) {
    if (!Array.isArray(results) || results.length === 0) return "";
    return results.map((result) => `${result.id}:${result.status}:${result.evaluations ?? 0}`).join("|");
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
            manifestRevision: null,
            error: null,
            degraded: false,
            assertionResults: [],
            simulation: null,
            transport: { state: "disabled", lastError: null, diagnostics: {} },
        };
        this._launchSequence = 0;
        this._environmentHandler = null;
        this.recording = getRecordingController();
        this._recordingRunId = null;
        this._recordingEvidenceContext = null;
        this._unsubscribeSimulation = null;
        this._autoFinalizing = false;
        this._pendingPrepare = null;
        this._prepareEpisodePhase = "start";
        this._scenarioDiagnosticsEnabled = false;
        this._loggingPolicyOverride = null;
        this._speedOverride = null;
        this._stopPromise = null;
        this._unsubscribeTransport = null;
        this._pendingRunId = null;
        this._recoveryPromise = null;
        this._recoveryGeneration = 0;
        this._recoveryTimer = null;
        this._recoveryWaitResolve = null;
        this._resumeAfterReconnect = false;
        this._reconnectAttempt = 0;
    }

    getSnapshot() {
        // Shallow copy: activeResolved / pendingResolved stay by reference (immutable after prepare).
        return { ...this.snapshot, transitioning: Boolean(this._pendingPrepare || this._stopPromise) };
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
        this._unsubscribeTransport?.();
        this._cancelRecovery();
        this.data = data;
        const simulation = data?.simulation?.();
        simulation?.setScenarioDiagnosticsEnabled?.(this._scenarioDiagnosticsEnabled);
        this.recording.attachSimulation(simulation);
        this._unsubscribeTransport = data?.client?.()?.subscribeTransport?.((state) => this._handleTransportState(state)) ?? null;
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
            const previous = this.snapshot.simulation;
            const assertionsChanged = assertionSignature(assertionResults) !== assertionSignature(this.snapshot.assertionResults);
            // A prepared run rests with the engine paused at step zero. Copy that
            // clock only after the operator has started the episode.
            const mirrorsClock = this.snapshot.status === "running" || this.snapshot.status === "paused";
            const statusChanged = mirrorsClock && status !== this.snapshot.status;
            if (statusChanged || assertionsChanged || scenarioTerminal) {
                this._set({
                    ...(statusChanged ? { status } : {}),
                    assertionResults,
                    simulation: simulationState,
                });
                return;
            }
            // Time/step HUD updates come from SimulationEngine.subscribe; keep a live pointer
            // without cloning activeResolved or notifying run-session listeners every frame.
            if (!previous
                || previous.steps !== simulationState.steps
                || previous.time !== simulationState.time
                || previous.timeNs !== simulationState.timeNs) {
                this.snapshot.simulation = simulationState;
            }
        }) || null;
        if (this.snapshot.pendingResolved) this._applyPending().catch(() => {});
        return () => {
            if (this.data === data) {
                const switchingEnvironment = this.snapshot.pendingResolved
                    && this.snapshot.pendingResolved.manifest.environment.id !== data.environment?.()?.environmentId;
                if (!switchingEnvironment) {
                    this._launchSequence += 1;
                    this._rejectPendingPrepare(new Error("Run preparation was detached from the simulation."));
                }
                this._unsubscribeSimulation?.();
                this._unsubscribeSimulation = null;
                this._unsubscribeTransport?.();
                this._unsubscribeTransport = null;
                this._cancelRecovery();
                this.data = null;
            }
        };
    }

    async prepare(resolved, { autoplay = false, episodePhase = "start", manifestRevision = null, controlLease = null, leaseRequestedAt } = {}) {
        if (!resolved?.manifest || !resolved?.resolvedHash) throw new Error("A resolved run manifest is required.");
        if (resolved.version !== 13) throw Object.assign(new Error("Historical runs require reviewed native migration before execution."), { code: "UNSUPPORTED_CAPABILITY" });
        const needsLease = resolved.manifest.topics?.some((topic) => topic.direction === "input" && topic.valueContract?.id === "cev.control-command" && topic.valueContract.version === 2);
        if (needsLease && (!controlLease || autoplay)) throw new Error("Control-command@2 requires a live lease and paused preparation.");
        assertProtobufExecutionCapabilities(resolved, { target: "browser", transport: "zenoh-browser", controlOwnership: Boolean(controlLease) });
        if (controlLease && (resolved.manifest.controls?.authority !== "candidate" || controlLease.target?.vehicleId !== resolved.manifest.controls.targetVehicleId || ["inputs", "controls", "vehicles"].some((key) => resolved.manifest.clock.modules[key] === false))) throw new Error("Owned runs require enabled candidate controls on the leased vehicle.");
        // Reject unsupported measured providers before replacing or stopping an
        // active browser run and before loading any environment/sensor state.
        assertEnabledCameraRenderRuntime(resolved.manifest.sensorRig?.sensors, resolved.renderScene, {
            target: "browser",
        });
        if (this.snapshot.activeRunId && ["running", "paused", "ready"].includes(this.snapshot.status)) {
            await this.stop({ status: "superseded" });
        }
        if (controlLease) this._beginControlOwnership(controlLease, { requestedAt: leaseRequestedAt });
        else { this.ownershipGuard?.close(); this.ownershipGuard = null; }
        const launchSequence = ++this._launchSequence;
        const runId = `run-${new Date().toISOString().replace(/[-:.]/g, "")}-${globalThis.crypto.randomUUID()}`;
        this._pendingRunId = runId;
        this._prepareEpisodePhase = episodePhase === "stop" ? "stop" : "start";
        this._rejectPendingPrepare(new Error("Run preparation was superseded by a newer request."));
        const readiness = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (this._pendingPrepare?.sequence !== launchSequence) return;
                this._pendingPrepare = null;
                this._launchSequence += 1;
                const error = new Error(`Timed out waiting for environment "${resolved.manifest.environment.id}" to become ready.`);
                this._set({ status: "error", error: error.message, pendingResolved: null });
                this.data?.client?.()?.closeRun?.({ runId }).catch?.(() => {});
                reject(error);
            }, PREPARE_TIMEOUT_MS);
            this._pendingPrepare = { sequence: launchSequence, resolve, reject, timeout };
        });
        this._set({
            status: "preparing",
            manifestRevision,
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
            const clientManager = this.data.client?.();
            const runId = this._pendingRunId;
            const preflight = await clientManager?.preflight?.(resolved, { runId });
            if (expectedSequence !== this._launchSequence) { await clientManager?.closeRun?.({ runId }); return null; }
            if (preflight && preflight.ok === false) {
                const detail = preflight.issues?.map((issue) => issue.message).join(" ") || "Run preflight failed.";
                throw new Error(detail);
            }
            const episodePhase = this._prepareEpisodePhase === "stop" ? "stop" : "start";
            this._prepareEpisodePhase = "start";
            if (simulation) simulation.ownershipGuard = this.ownershipGuard ?? null;
            await simulation?.applyRunManifest?.(resolved, { episodePhase, runId });
            if (this.ownershipGuard) this._installControlOwnership();
            if (expectedSequence !== this._launchSequence) { await clientManager?.closeRun?.({ runId }); return null; }
            await clientManager?.activateRoutes?.(simulation?.protobufRoutes);
            if (expectedSequence !== this._launchSequence) { await clientManager?.closeRun?.({ runId }); return null; }
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
            if (expectedSequence !== this._launchSequence) return null;
            await this.data?.client?.()?.closeRun?.({ runId: this._pendingRunId });
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
        if (this.ownershipGuard && !this.ownershipGuard.check()) throw new Error("A live run-bound control lease is required before resuming.");
        if (this.snapshot.transport?.state === "reconnecting") { this._resumeAfterReconnect = true; return this.getSnapshot(); }
        await this._ensureRecording();
        this.applyRuntimeOverrides(this.snapshot.activeResolved);
        this.data.simulation?.()?.play?.();
        this._set({ status: "running" });
        return this.getSnapshot();
    }

    _beginControlOwnership(snapshot, options) {
        this.ownershipGuard?.close();
        this.ownershipGuard = new ControlOwnershipGuard({ onLoss: () => {
            this._resumeAfterReconnect = false;
            this.pause().catch(() => {});
            const simulation = this.data?.simulation?.();
            simulation?.inputQueue?.reset();
            const vehicleId = this.ownershipGuard?.lease?.vehicleId || "ego";
            const stopped = simulation?.controlRuntime?.revokeOwnership(vehicleId, { timeNs: simulation.timeNs });
            if (stopped) simulation?.runtimeContext?.controls?.applySetpoints?.(new Map([[vehicleId, stopped]]));
        } });
        this.ownershipGuard.begin(snapshot, options);
    }

    updateControlOwnership(snapshot, options = {}) {
        const guard = this.ownershipGuard;
        if (!guard?.lease || guard.lease.leaseId !== snapshot?.leaseId) return false;
        if (!guard.lease.runId && snapshot.runId) {
            if (snapshot.runId !== this.snapshot.activeRunId || guard.lost || !guard.update(snapshot, options)) return false;
            guard.attach(snapshot, { ...options, startTimeNs: this.data?.simulation?.()?.timeNs ?? 0 });
            this._installControlOwnership();
            return true;
        }
        return guard.update(snapshot, options);
    }

    rebindControlOwnership(snapshot, options = {}) {
        if (!["ready", "paused"].includes(this.snapshot.status) || !this.ownershipGuard?.lease || this.ownershipGuard.lease.vehicleId !== snapshot.target?.vehicleId) throw new Error("Pause the owned vehicle before changing its control lease.");
        this._beginControlOwnership(snapshot, options);
        const simulation = this.data?.simulation?.();
        simulation?.inputQueue?.reset();
        simulation?.protobufRoutes?.resetControlSequences();
        const stopped = simulation?.controlRuntime?.revokeOwnership(snapshot.target.vehicleId, { timeNs: simulation.timeNs });
        if (stopped) {
            simulation.runtimeContext.controls.applySetpoints(new Map([[snapshot.target.vehicleId, stopped]]));
            simulation.controlRuntime._state(snapshot.target.vehicleId).lastSequence = -1;
        }
        if (simulation) simulation.ownershipGuard = this.ownershipGuard;
        this._installControlOwnership();
    }

    _installControlOwnership() {
        const simulation = this.data?.simulation?.();
        if (simulation?.controlRuntime) simulation.controlRuntime.ownershipGuard = this.ownershipGuard;
        if (simulation?.inputQueue) simulation.inputQueue.validateInput = (info) => info.valueContract?.id === "cev.control-command" ? this.ownershipGuard.validate(info.value, { applyTimeNs: simulation.timeNs }) : { ok: true };
    }

    async pause() {
        this._resumeAfterReconnect = false;
        const simulation = this.data?.simulation?.();
        const wasReady = this.snapshot.status === "ready";
        simulation?.pause?.();
        if (this.snapshot.activeRunId && !wasReady) this._set({ status: "paused" });
        await simulation?.whenIdle?.();
        return this.getSnapshot();
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
        if (this.snapshot.transport?.state === "reconnecting") throw new Error("Cannot step while Zenoh is reconnecting.");
        await this._ensureRecording();
        await this.data.simulation?.()?.step?.(count);
        this._set({ status: "paused", assertionResults: this.data.simulation?.()?.assertionEngine?.snapshot?.() || [] });
        return this.getSnapshot();
    }

    stop(options = {}) {
        this._cancelRecovery();
        if (this._stopPromise) return this._stopPromise;
        if (this.snapshot.runResult?.runId && this.snapshot.runResult.runId === this.snapshot.activeRunId) {
            return Promise.resolve(this.snapshot.runResult);
        }
        this._stopPromise = Promise.resolve().then(() => this._stop(options)).catch((error) => {
            this._set({ status: "error", error: error.message });
            throw error;
        }).finally(() => {
            this._stopPromise = null;
        });
        this.data?.simulation?.()?.pause?.();
        return this._stopPromise;
    }

    async _stop({ status = "stopped" } = {}) {
        if (this._pendingPrepare) {
            this._launchSequence++;
            this._rejectPendingPrepare(new Error("Run preparation was stopped."));
            this._set({ pendingResolved: null });
        }
        const simulation = this.data?.simulation?.();
        await simulation?.whenIdle?.();
        await this.data?.client?.()?.closeRun?.();
        simulation?.protobufRoutes?.invalidateBindings?.();
        const canFinalize = Boolean(simulation?.resolvedRun) && simulation.lifecycleState !== "disposed";
        const kernelFinalization = canFinalize ? simulation.finalize({ status }) : null;
        const finalized = kernelFinalization
            ? {
                results: kernelFinalization.assertions || [],
                shouldStop: kernelFinalization.assertionShouldStop,
            }
            : simulation?.assertionEngine?.finalize?.(simulation.steps || 0) || { results: [] };
        if (!kernelFinalization) {
            simulation?.scenarioRuntime?.observeAssertions?.(finalized.results);
        }
        const scenarioResult = kernelFinalization?.scenario
            ?? simulation?.scenarioRuntime?.finalize?.({
                step: simulation?.steps || 0,
                timeNs: simulation?.timeNs || 0,
                assertions: finalized.results,
            })
            ?? null;
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
            simulationSemanticHash: kernelFinalization?.simulationSemanticHash
                ?? simulation?.simulationSemanticHash
                ?? this.snapshot.activeResolved?.simulationSemanticHash
                ?? null,
            episodeHash: kernelFinalization?.episodeHash ?? simulation?.episodeHash ?? null,
            trajectoryHash: kernelFinalization?.trajectoryHash ?? simulation?.trajectoryHash ?? null,
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
        const loggingPolicy = this._loggingPolicyOverride
            ?? this.snapshot.activeResolved?.manifest?.logging?.policy
            ?? "optional";
        if (this._recordingRunId === this.snapshot.activeRunId) {
            if (loggingPolicy !== "disabled") {
                this.recording.addAttachment({ name: "run-results.json", mime: "application/json", bytes: JSON.stringify(runResult) });
                try {
                    const metadata = await this.recording.stop({ runResult });
                    runResult = { ...runResult, logId: metadata?.id ?? runResult.logId };
                    if (metadata?.incomplete && loggingPolicy === "optional") {
                        this._set({
                            degraded: true,
                            error: `Optional logging incomplete${metadata.loggingError ? `: ${metadata.loggingError}` : "."}`,
                        });
                    }
                } catch (error) {
                    if (loggingPolicy === "required") throw error;
                    runResult = { ...runResult, logId: null };
                    this._set({ degraded: true, error: `Optional log finalization failed: ${error.message}` });
                    getTelemetryStore().emitTelemetryEvent({
                        category: "logging",
                        name: "optional-recording-finalization-failed",
                        severity: "warning",
                        payload: { runId: this.snapshot.activeRunId, error: error.message },
                    });
                }
            }
            this._recordingRunId = null;
        }
        simulation?.stop?.({
            reset: false,
            dispatchEpisode: status !== "reset",
        });
        this._set({ status: finalStatus, assertionResults: finalized.results, runResult });
        return runResult;
    }

    async reset(resolved = null, { manifestRevision = null } = {}) {
        const manifestId = resolved?.manifest?.id || this.snapshot.selectedManifestId || this.snapshot.activeResolved?.manifest?.id;
        if (!manifestId) return null;
        await this.stop({ status: "reset" });
        const next = resolved ?? await resolveRunManifest(manifestId);
        return this.prepare(next, { autoplay: false, episodePhase: "stop", manifestRevision });
    }

    _cancelRecovery() {
        this._recoveryGeneration++;
        this._resumeAfterReconnect = false;
        clearTimeout(this._recoveryTimer);
        this._recoveryWaitResolve?.();
        this._recoveryTimer = null;
        this._recoveryWaitResolve = null;
    }

    _handleTransportState(transport) {
        if (this._recoveryPromise && this._activeRecoveryGeneration === this._recoveryGeneration) {
            this._set({ transport: { ...transport, state: "reconnecting", attempt: this._reconnectAttempt } });
            return;
        }
        this._set({ transport });
        if (transport.state !== "reconnecting" || this._stopPromise || this._pendingPrepare
            || !this.snapshot.activeRunId || !["running", "paused", "ready"].includes(this.snapshot.status)) return;
        const data = this.data;
        const runId = this.snapshot.activeRunId;
        const generation = ++this._recoveryGeneration;
        this._activeRecoveryGeneration = generation;
        this._resumeAfterReconnect = this.snapshot.status === "running";
        data.simulation?.()?.pause?.();
        if (this._resumeAfterReconnect) this._set({ status: "paused" });
        const current = () => generation === this._recoveryGeneration && data === this.data && runId === this.snapshot.activeRunId && !this._stopPromise;
        const recovery = Promise.resolve().then(async () => {
            await data.simulation?.()?.whenIdle?.();
            if (!current()) return;
            const runtime = data.simulation?.()?.protobufRoutes;
            if (runtime) data.client?.()?.stageGeneration?.(runtime.invalidateBindings());
            this._reconnectAttempt = 0;
            while (current()) {
                const delay = [500, 1000, 2000, 4000, 5000][Math.min(this._reconnectAttempt++, 4)];
                this._set({ transport: { ...this.snapshot.transport, state: "reconnecting", attempt: this._reconnectAttempt } });
                await new Promise((resolve) => { this._recoveryWaitResolve = resolve; this._recoveryTimer = setTimeout(resolve, delay); });
                this._recoveryWaitResolve = null;
                this._recoveryTimer = null;
                if (!current()) return;
                try {
                    const ready = await data.client?.()?.reconnect?.();
                    if (!current()) return;
                    this._set({ transport: { ...ready, state: "ready", attempt: this._reconnectAttempt } });
                } catch (error) {
                    if (current()) this._set({ transport: { ...this.snapshot.transport, state: "reconnecting", lastError: error.message, attempt: this._reconnectAttempt } });
                    continue;
                }
                if (this._resumeAfterReconnect) await this.play();
                return;
            }
        }).catch((error) => { if (current()) this._set({ status: "error", error: error.message }); })
            .finally(() => { if (this._recoveryPromise === recovery) this._recoveryPromise = null; });
        this._recoveryPromise = recovery;
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
            appVersion: process.env.NEXT_PUBLIC_APP_VERSION || CEV_SIM_VERSION,
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
                evidenceContext: this._recordingEvidenceContext,
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

    setRecordingEvidenceContext(context = null) {
        this._recordingEvidenceContext = context && typeof context === "object"
            ? {
                suiteId: context.suiteId ?? null,
                resultId: context.resultId ?? null,
                caseId: context.caseId ?? null,
            }
            : null;
    }

    clear() {
        this._launchSequence += 1;
        this._rejectPendingPrepare(new Error("Run preparation was cleared."));
        this._recordingEvidenceContext = null;
        this.data?.simulation?.()?.clearRun?.();
        this._loggingPolicyOverride = null;
        this._speedOverride = null;
        this._set({
            status: "idle",
            pendingResolved: null,
            activeResolved: null,
            activeRunId: null,
            manifestRevision: null,
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
