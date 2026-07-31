import { getRunSessionController } from "../simulation/RunSessionController.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import {
    createExperimentResult as persistExperimentResult,
    getExperimentResult,
    resolveExperimentCase,
    saveExperimentResult,
} from "./ExperimentClient.js";
import {
    createExperimentResult as createExperimentResultDocument,
    interruptActiveExperimentCases,
    normalizeExperimentResult,
} from "./ExperimentResult.js";
import { MetricAccumulator } from "./MetricReducers.js";

const TERMINAL_CASE_STATUSES = new Set(["completed", "failed", "error", "cancelled", "interrupted"]);
const TERMINAL_RUN_STATUSES = new Set([
    "completed",
    "failed",
    "error",
    "cancelled",
    "interrupted",
    "assertion-failed",
    "stopped",
]);
const FAILED_RUN_STATUSES = new Set(["failed", "assertion-failed"]);
const INTERRUPTED_RUN_STATUSES = new Set(["interrupted", "stopped"]);

function clone(value) {
    if (value === undefined) return undefined;
    return typeof structuredClone === "function"
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function documentFrom(value, key) {
    return value?.[key] ?? value?.document ?? value;
}

function nowIso(now) {
    const value = typeof now === "function" ? now() : Date.now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function failurePolicy(suite, override) {
    if (override !== undefined) return override ? "fail-fast" : "continue";
    return suite?.execution?.failurePolicy === "fail-fast"
        || suite?.execution?.continueOnFailure === false
        ? "fail-fast"
        : "continue";
}

function progressFor(result) {
    const cases = result?.cases ?? [];
    const terminal = cases.filter((entry) => TERMINAL_CASE_STATUSES.has(entry.status)).length;
    const runningIndex = cases.findIndex((entry) => entry.status === "running");
    return {
        completed: terminal,
        total: cases.length,
        fraction: cases.length > 0 ? terminal / cases.length : 0,
        currentIndex: runningIndex,
    };
}

/**
 * Persist every queue left active by a prior browser lifetime as interrupted.
 * The caller may exclude the result currently owned by a live controller.
 */
export async function interruptStaleExperimentResults(entries = [], options = {}) {
    const loadResult = options.getResult ?? getExperimentResult;
    const persistResult = options.saveResult ?? saveExperimentResult;
    const excludeResultId = options.excludeResultId ?? null;
    const finishedAt = nowIso(options.now ?? Date.now);
    const candidates = entries.filter((entry) => (
        entry?.id
        && entry.id !== excludeResultId
        && ["running", "paused"].includes(entry.status)
    ));
    const updated = [];

    for (const candidate of candidates) {
        const raw = documentFrom(await loadResult(candidate.id), "result");
        if (!raw) continue;
        const result = normalizeExperimentResult(raw, { allowMissingKind: true });
        const stale = ["running", "paused"].includes(result.status)
            || result.cases.some((entry) => entry.status === "running");
        if (!stale) continue;
        const interrupted = interruptActiveExperimentCases(result, finishedAt);
        const stored = documentFrom(await persistResult(
            interrupted.id,
            interrupted,
            raw.revision ?? undefined,
        ), "result");
        updated.push(stored ?? interrupted);
    }

    return updated;
}

/**
 * Runs a persisted experiment queue through the authoritative browser
 * simulation. Cases are intentionally sequential: the shared simulation,
 * telemetry, logging, and ROS resources are reset by RunSessionController
 * between resolved runs.
 */
export class ExperimentRunController {
    constructor(options = {}) {
        this.runSession = options.runSession ?? getRunSessionController();
        this.telemetry = options.telemetry ?? getTelemetryStore();
        this.resolveCase = options.resolveCase ?? resolveExperimentCase;
        this.createResult = options.createResult ?? persistExperimentResult;
        this.saveResult = options.saveResult ?? saveExperimentResult;
        this.now = options.now ?? Date.now;
        this.listeners = new Set();
        this.result = null;
        this.suite = null;
        this.revision = null;
        this._failurePolicy = "continue";
        this._paused = false;
        this._cancelRequested = false;
        this._pauseWaiters = new Set();
        this._terminalWaiter = null;
        this._executionPromise = null;
        this._metricSubscription = null;
        this._metricAccumulator = null;
        this._runSnapshot = this.runSession.getSnapshot?.() ?? { status: "idle" };
        this.snapshot = {
            status: "idle",
            result: null,
            run: clone(this._runSnapshot),
            currentCase: null,
            progress: progressFor(null),
            realtimeWarning: false,
            error: null,
        };
        this._unsubscribeRunSession = this.runSession.subscribe?.((value) => this._onRunSnapshot(value)) ?? null;
    }

    getSnapshot() {
        return clone(this.snapshot);
    }

    subscribe(listener) {
        this.listeners.add(listener);
        listener(this.getSnapshot());
        return () => this.listeners.delete(listener);
    }

    /**
     * Start a new queue. Pass `{ suite, cases }`, or `{ suite, result }` when
     * the pending result was already created by the workspace.
     */
    async start(input = {}, options = {}) {
        if (this._executionPromise) throw new Error("An experiment queue is already active.");
        const suite = input.suite ?? (input.kind === "cev-sim.experiment-suite" ? input : options.suite);
        if (!suite?.id) throw new Error("An experiment suite is required.");
        this.suite = clone(suite);
        this._failurePolicy = failurePolicy(suite, input.failFast ?? options.failFast);
        this._paused = false;
        this._cancelRequested = false;

        const suppliedResult = input.result ?? options.result;
        if (suppliedResult) {
            const raw = documentFrom(suppliedResult, "result");
            this.revision = input.expectedRevision ?? options.expectedRevision ?? raw?.revision ?? null;
            this.result = normalizeExperimentResult(raw, { allowMissingKind: true });
        } else {
            const cases = input.cases ?? options.cases ?? [];
            const pending = createExperimentResultDocument(suite, cases, {
                id: input.resultId ?? options.resultId,
                createdAt: nowIso(this.now),
                status: "pending",
            });
            const stored = documentFrom(await this.createResult(pending), "result");
            this.revision = stored?.revision ?? null;
            this.result = normalizeExperimentResult(stored, { allowMissingKind: true });
        }
        if (this.result.suiteId !== suite.id) {
            throw new Error(`Result "${this.result.id}" belongs to suite "${this.result.suiteId}", not "${suite.id}".`);
        }

        this._set({ status: "running", error: null });
        this._executionPromise = this._drainQueue().finally(() => {
            this._executionPromise = null;
        });
        return this.getSnapshot();
    }

    /** Mark a result left running by a prior page lifetime as interrupted. */
    async load(resultValue, { suite = null, persist = true } = {}) {
        if (this._executionPromise) throw new Error("Cannot load a result while an experiment queue is active.");
        const raw = documentFrom(resultValue, "result");
        const nextSuite = suite ? clone(suite) : this.suite;
        const nextResult = normalizeExperimentResult(raw, { allowMissingKind: true });
        if (nextSuite?.id && nextResult.suiteId !== nextSuite.id) {
            throw new Error(`Result "${nextResult.id}" belongs to suite "${nextResult.suiteId}", not "${nextSuite.id}".`);
        }
        this.suite = nextSuite;
        this.revision = raw?.revision ?? null;
        this.result = nextResult;
        if (this.result.status === "running" || this.result.cases.some((entry) => entry.status === "running")) {
            this.result = interruptActiveExperimentCases(this.result, nowIso(this.now));
            if (persist) await this._persist();
        }
        this._set({ status: this.result.status, error: null });
        return this.getSnapshot();
    }

    async pause() {
        if (!this._executionPromise || this._paused || this._cancelRequested) return this.getSnapshot();
        this._paused = true;
        this.runSession.pause?.();
        this.result = normalizeExperimentResult({ ...this.result, status: "paused" }, { allowMissingKind: true });
        await this._persist();
        this._set({ status: "paused" });
        return this.getSnapshot();
    }

    async resume({ suite = null, failFast } = {}) {
        if (!this.result) throw new Error("Load or start an experiment result before resuming it.");
        const nextSuite = suite ?? this.suite;
        if (nextSuite?.id && this.result.suiteId !== nextSuite.id) {
            throw new Error(`Result "${this.result.id}" belongs to suite "${this.result.suiteId}", not "${nextSuite.id}".`);
        }
        if (suite) this.suite = clone(suite);
        if (failFast !== undefined || suite) this._failurePolicy = failurePolicy(this.suite, failFast);
        if (this._executionPromise) {
            if (!this._paused) return this.getSnapshot();
            this._paused = false;
            this.result = normalizeExperimentResult({ ...this.result, status: "running", finishedAt: null }, { allowMissingKind: true });
            await this._persist();
            await this.runSession.play?.();
            this._releasePauseWaiters();
            this._set({ status: "running", error: null });
            return this.getSnapshot();
        }

        if (!this.result.cases.some((entry) => entry.status === "pending")) {
            throw new Error("This experiment result has no compatible pending cases to resume.");
        }
        this._paused = false;
        this._cancelRequested = false;
        this.result = normalizeExperimentResult({ ...this.result, status: "running", finishedAt: null }, { allowMissingKind: true });
        await this._persist();
        this._set({ status: "running", error: null });
        this._executionPromise = this._drainQueue().finally(() => {
            this._executionPromise = null;
        });
        return this.getSnapshot();
    }

    async cancel() {
        if (!this.result || this._cancelRequested) return this.getSnapshot();
        this._cancelRequested = true;
        this._paused = false;
        this._releasePauseWaiters();
        const active = this.result.cases.some((entry) => entry.status === "running");
        if (active) {
            try {
                const runResult = await this.runSession.stop?.({ status: "cancelled" });
                if (runResult) this._resolveTerminal(runResult);
            } catch {
                this._resolveTerminal({ status: "cancelled", passed: false, completed: false });
            }
        } else if (!this._executionPromise) {
            await this._finalizeCancellation();
        }
        return this.getSnapshot();
    }

    waitForCompletion() {
        return this._executionPromise ?? Promise.resolve(this.getSnapshot());
    }

    destroy() {
        this._unsubscribeRunSession?.();
        this._unsubscribeRunSession = null;
        this._stopMetricCollection();
        this.listeners.clear();
    }

    async _drainQueue() {
        try {
            while (true) {
                await this._waitWhilePaused();
                if (this._cancelRequested) break;
                const nextIndex = this.result.cases.findIndex((entry) => entry.status === "pending");
                if (nextIndex < 0) break;
                const caseResult = await this._runCase(nextIndex);
                if (this._failurePolicy === "fail-fast" && caseResult.passed !== true) {
                    this.result = normalizeExperimentResult({
                        ...this.result,
                        cases: this.result.cases.map((entry) => entry.status === "pending"
                            ? { ...entry, status: "cancelled", completed: false, passed: false, finishedAt: nowIso(this.now), failureReason: "Skipped by fail-fast policy." }
                            : entry),
                    }, { allowMissingKind: true });
                    await this._persist();
                    break;
                }
            }

            if (this._cancelRequested) {
                await this._finalizeCancellation();
            } else {
                this.result = normalizeExperimentResult({
                    ...this.result,
                    status: "completed",
                    finishedAt: nowIso(this.now),
                }, { allowMissingKind: true });
                await this._persist();
                this._set({ status: "completed", currentCase: null });
            }
        } catch (error) {
            this.result = this.result && normalizeExperimentResult({
                ...this.result,
                status: "error",
                finishedAt: nowIso(this.now),
            }, { allowMissingKind: true });
            try {
                if (this.result) await this._persist();
            } catch {
                // The original execution error remains the useful failure.
            }
            this._set({ status: "error", error: error?.message || String(error) });
        } finally {
            this._stopMetricCollection();
            this._terminalWaiter = null;
        }
        return this.getSnapshot();
    }

    async _runCase(index) {
        const startedAt = nowIso(this.now);
        this._replaceCase(index, {
            status: "running",
            completed: false,
            passed: false,
            startedAt,
            finishedAt: null,
            failureReason: null,
        });
        this.result = normalizeExperimentResult({
            ...this.result,
            status: "running",
            startedAt: this.result.startedAt ?? startedAt,
            finishedAt: null,
        }, { allowMissingKind: true });
        await this._persist();
        const activeCase = this.result.cases[index];
        this._set({ status: "running", currentCase: activeCase, realtimeWarning: false, error: null });

        let resolution = null;
        let runResult = null;
        this._stopMetricCollection();
        this._metricAccumulator = new MetricAccumulator(this.result.metricDefinitions);
        try {
            resolution = await this.resolveCase(this.result.suiteId, { case: activeCase });
            const resolvedRun = resolution?.resolvedRun ?? resolution?.resolved ?? resolution;
            if (!resolvedRun?.resolvedHash) throw new Error("Case resolution did not return a resolved run manifest.");
            this._set({ realtimeWarning: Boolean(resolution?.realtimeWarning) });
            // Manifest application resets every run-scoped telemetry source.
            // Subscribe after that reset so reducers observe the case itself,
            // rather than setup events or the tail of the previous case.
            await this.runSession.prepare(resolvedRun, { autoplay: false });
            this._startMetricCollection(this.result.metricDefinitions);
            const terminalRun = this._waitForTerminalRun(resolvedRun.resolvedHash);
            await this.runSession.play();
            runResult = await terminalRun;
        } catch (error) {
            this._terminalWaiter = null;
            runResult = {
                status: "error",
                completed: false,
                passed: false,
                failureReason: error?.message || String(error),
            };
        }

        const finishedAt = nowIso(this.now);
        const terminal = this._caseFromRun(activeCase, runResult, resolution, startedAt, finishedAt);
        this._replaceCase(index, terminal);
        this._stopMetricCollection();
        await this._persist();
        this._set({ currentCase: this.result.cases[index] });
        return this.result.cases[index];
    }

    _caseFromRun(activeCase, runResult = {}, resolution, startedAt, finishedAt) {
        const runStatus = String(runResult.status || "");
        const cancelled = this._cancelRequested || runStatus === "cancelled";
        const errored = !cancelled && runStatus === "error";
        const explicitlyFailed = !cancelled && !errored && FAILED_RUN_STATUSES.has(runStatus);
        const interrupted = !cancelled
            && !errored
            && !explicitlyFailed
            && (INTERRUPTED_RUN_STATUSES.has(runStatus) || runResult.completed === false);
        const completed = !cancelled
            && !errored
            && !interrupted
            && (runResult.completed ?? TERMINAL_RUN_STATUSES.has(runStatus));
        const passed = completed && runResult.passed === true;
        const status = cancelled
            ? "cancelled"
            : errored
                ? "error"
                : interrupted
                    ? "interrupted"
                    : passed
                        ? "completed"
                        : "failed";
        const metrics = this._metricAccumulator?.finalize({
            ...runResult,
            status,
            completed,
            passed,
            startedAt,
            finishedAt,
        }) ?? {};
        return {
            ...activeCase,
            status,
            completed,
            passed,
            terminationReason: runResult.terminationReason ?? runResult.status ?? null,
            latestTrigger: runResult.latestTrigger ?? null,
            terminalEvent: runResult.terminalEvent ?? null,
            assertions: runResult.assertions ?? runResult.assertionResults ?? [],
            outcomes: runResult.outcomes ?? runResult.outcomeResults ?? [],
            metrics,
            dependencyHashes: resolution?.dependencyHashes ?? resolution?.resolvedRun?.dependencyHashes ?? {},
            resolvedHash: resolution?.resolvedHash ?? resolution?.resolvedRun?.resolvedHash ?? null,
            logId: runResult.logId ?? runResult.recording?.id ?? null,
            startedAt,
            finishedAt,
            failureReason: runResult.failureReason ?? runResult.error?.message ?? runResult.error ?? (status === "failed" ? "Case did not pass." : null),
        };
    }

    _startMetricCollection(definitions) {
        this._stopMetricCollection();
        this._metricAccumulator = new MetricAccumulator(definitions);
        const paths = this._metricAccumulator.definitions
            .filter((metric) => metric.source.kind === "signal")
            .map((metric) => metric.source.path);
        this._metricSubscription = this.telemetry?.subscribeSignals?.(
            { paths, includeEvents: true, includeCatalog: false },
            (message) => {
                if (message.kind === "update") {
                    this._metricAccumulator?.pushSignal(message.path, message.entry?.value);
                } else if (message.kind === "event") {
                    this._metricAccumulator?.pushEvent(message.event);
                }
            },
        ) ?? null;
        // Manifest application publishes deterministic t=0 inputs before the
        // reducer subscription is installed. Seed reducers from the reset
        // store so `first`, `last`, min/max, and event counts include that
        // initial case state without observing the previous case.
        for (const path of paths) {
            const entry = this.telemetry?.read?.(path);
            if (entry && entry.value !== undefined) this._metricAccumulator.pushSignal(path, entry.value);
        }
        for (const event of this.telemetry?.events?.() ?? []) {
            this._metricAccumulator.pushEvent(event);
        }
    }

    _stopMetricCollection() {
        this._metricSubscription?.();
        this._metricSubscription = null;
    }

    _waitForTerminalRun(resolvedHash) {
        return new Promise((resolve) => {
            this._terminalWaiter = { resolvedHash, resolve };
            this._maybeResolveTerminal(this._runSnapshot);
        });
    }

    _onRunSnapshot(value) {
        this._runSnapshot = clone(value);
        this._maybeResolveTerminal(value);
        this._set({ run: value });
    }

    _maybeResolveTerminal(value) {
        const waiter = this._terminalWaiter;
        if (!waiter) return;
        const runResult = value?.runResult;
        if (runResult?.resolvedHash === waiter.resolvedHash
            && (TERMINAL_RUN_STATUSES.has(runResult.status) || TERMINAL_RUN_STATUSES.has(value.status))) {
            this._resolveTerminal(runResult);
            return;
        }
        if (value?.status === "error" && value?.activeResolved?.resolvedHash === waiter.resolvedHash) {
            this._resolveTerminal({
                status: "error",
                completed: false,
                passed: false,
                failureReason: value.error || "The run session failed.",
            });
        }
    }

    _resolveTerminal(runResult) {
        const waiter = this._terminalWaiter;
        if (!waiter) return;
        this._terminalWaiter = null;
        waiter.resolve(clone(runResult));
    }

    async _waitWhilePaused() {
        if (!this._paused) return;
        await new Promise((resolve) => this._pauseWaiters.add(resolve));
    }

    _releasePauseWaiters() {
        for (const resolve of this._pauseWaiters) resolve();
        this._pauseWaiters.clear();
    }

    async _finalizeCancellation() {
        const finishedAt = nowIso(this.now);
        this.result = normalizeExperimentResult({
            ...this.result,
            status: "cancelled",
            finishedAt,
            cases: this.result.cases.map((entry) => entry.status === "pending" || entry.status === "running"
                ? { ...entry, status: "cancelled", completed: false, passed: false, finishedAt }
                : entry),
        }, { allowMissingKind: true });
        await this._persist();
        this._set({ status: "cancelled", currentCase: null });
    }

    _replaceCase(index, patch) {
        this.result = normalizeExperimentResult({
            ...this.result,
            cases: this.result.cases.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...patch } : entry),
        }, { allowMissingKind: true });
    }

    async _persist() {
        const stored = documentFrom(await this.saveResult(this.result.id, this.result, this.revision ?? undefined), "result");
        this.revision = stored?.revision ?? this.revision;
        this.result = normalizeExperimentResult(stored, { allowMissingKind: true });
        this._set({ result: this.result });
        return this.result;
    }

    _set(patch) {
        const result = patch.result === undefined ? this.result : patch.result;
        const currentCase = patch.currentCase === undefined
            ? result?.cases?.find((entry) => entry.status === "running") ?? this.snapshot.currentCase
            : patch.currentCase;
        this.snapshot = {
            ...this.snapshot,
            ...patch,
            result: clone(result),
            currentCase: clone(currentCase),
            progress: progressFor(result),
        };
        const value = this.getSnapshot();
        for (const listener of this.listeners) listener(value);
    }
}

let sharedExperimentRunController;

export function getExperimentRunController() {
    if (!sharedExperimentRunController) sharedExperimentRunController = new ExperimentRunController();
    return sharedExperimentRunController;
}
