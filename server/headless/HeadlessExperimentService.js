import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

import { createExperimentResult, normalizeExperimentResult } from "../../app/experiments/ExperimentResult.js";
import { RUN_BUNDLE_KIND, RUN_BUNDLE_VERSION } from "../../app/simulation/RunManifest.js";
import { resolveArtifactPolicy } from "./HeadlessArtifactSink.js";
import {
    appendQueueEntry,
    queuePositionFor,
    removeQueueEntry,
} from "./HeadlessExperimentQueue.js";
import { validateManagedRun } from "./ManagedHeadlessSession.js";
import { HeadlessSupervisor } from "./HeadlessSupervisor.js";
import { verifyRunBundle } from "./RunBundle.js";
import { storageEvents } from "../mcp/events.js";

const TERMINAL_CASE_STATUSES = new Set(["completed", "failed", "error", "cancelled", "interrupted"]);
const TERMINAL_RESULT_STATUSES = new Set(["completed", "cancelled", "interrupted", "error"]);
const RESUMABLE_RESULT_STATUSES = new Set(["pending", "running", "paused"]);
const HEALTH_PUBLISH_INTERVAL_MS = 250;

function nowIso(now) {
    const value = typeof now === "function" ? now() : Date.now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function bundleFromResolved(resolved, createdAt) {
    return {
        kind: RUN_BUNDLE_KIND,
        version: RUN_BUNDLE_VERSION,
        exportedAt: createdAt,
        manifest: clone(resolved.manifest),
        resolved: clone(resolved),
        resolvedHash: resolved.resolvedHash,
        simulationSemanticHash: resolved.simulationSemanticHash,
    };
}

function failurePolicy(suite, override) {
    if (override !== undefined) return override ? "fail-fast" : "continue";
    return suite.execution?.failurePolicy === "fail-fast"
        || suite.execution?.continueOnFailure === false
        ? "fail-fast"
        : "continue";
}

function absoluteArtifacts(finalized) {
    return (finalized.artifacts || []).map((artifact) => ({
        ...artifact,
        uri: path.resolve(finalized.outputDirectory, artifact.uri),
    }));
}

async function removeStagingDirectories(root) {
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const target = path.join(root, entry.name);
        if (entry.name.startsWith(".") && entry.name.includes(".tmp-")) {
            await fs.rm(target, { recursive: true, force: true });
        } else {
            await removeStagingDirectories(target);
        }
    }
}

function interruptRunningCaseOnly(result, finishedAt) {
    const next = normalizeExperimentResult(result, { allowMissingKind: true });
    next.cases = next.cases.map((entry) => entry.status === "running"
        ? {
            ...entry,
            status: "interrupted",
            completed: false,
            passed: false,
            finishedAt,
            failureReason: "The server process exited before the managed case completed.",
        }
        : entry);
    const hasPending = next.cases.some((entry) => entry.status === "pending");
    if (hasPending) {
        next.status = "paused";
        next.finishedAt = null;
    } else {
        next.status = "interrupted";
        next.finishedAt = next.finishedAt || finishedAt;
    }
    return next;
}

function finalizeInterruptedResult(result, finishedAt) {
    return normalizeExperimentResult({
        ...result,
        status: "interrupted",
        finishedAt,
        cases: result.cases.map((entry) => ["pending", "running"].includes(entry.status)
            ? {
                ...entry,
                status: "interrupted",
                completed: false,
                passed: false,
                finishedAt,
                failureReason: "The server process exited before the managed case completed.",
            }
            : entry),
    }, { allowMissingKind: true });
}

export class HeadlessExperimentService {
    constructor(storage, logService, options = {}) {
        if (!storage || !logService) throw new Error("HeadlessExperimentService requires storage and logging services.");
        this.storage = storage;
        this.logService = logService;
        this.now = options.now ?? Date.now;
        this.jobIdFactory = options.jobIdFactory ?? (() => `headless-${randomUUID()}`);
        this.artifactRoot = path.resolve(options.artifactRoot || path.join(storage.dataDir, "headless-runs"));
        this.supervisor = options.supervisor ?? new HeadlessSupervisor({
            socket: path.join(storage.dataDir, ".embedded-headless-supervisor.sock"),
            config: {
                kind: "cev-sim.headless-supervisor-config",
                version: 1,
                preset: "safety",
                shutdownGraceMs: 250,
                killGraceMs: 250,
            },
        });
        this.importLog = options.importLog ?? ((filePath, importOptions) => (
            this.logService.importStream(createReadStream(filePath), importOptions)
        ));
        this.publish = options.publish ?? ((event) => storageEvents.publish(event));
        this.activeJob = null;
        this.starting = false;
        this.closing = false;
        this.initialized = false;
        this.initializePromise = null;
        this.pumpRunning = false;
        this.pumpPromise = null;
        this.liveHealth = null;
        this.lastHealthPublishAt = 0;
        this.cancelledResultIds = new Set();
        this.resumePausedJobs = false;
    }

    async initialize() {
        if (this.initialized) return [];
        this.initializePromise ??= this._initialize();
        try {
            return await this.initializePromise;
        } finally {
            if (!this.initialized) this.initializePromise = null;
        }
    }

    async _initialize() {
        await fs.mkdir(this.artifactRoot, { recursive: true });
        await removeStagingDirectories(this.artifactRoot);
        const reconciled = await this._reconcileOnStartup();
        this.initialized = true;
        this.resumePausedJobs = true;
        await this._ensurePump();
        this.resumePausedJobs = false;
        return reconciled;
    }

    async _reconcileOnStartup() {
        const reconciled = [];
        const queue = await this.storage.getHeadlessExperimentQueue();
        const validEntries = [];

        for (const entry of queue.entries) {
            const stored = await this.storage.getExperimentResult(entry.resultId);
            const sidecars = await this.storage.readHeadlessRunBundles(entry.resultId);
            if (!stored || stored.execution?.backend !== "headless" || !sidecars) {
                if (stored?.execution?.backend === "headless") {
                    try {
                        const next = normalizeExperimentResult({
                            ...stored,
                            status: "error",
                            finishedAt: nowIso(this.now),
                        }, { allowMissingKind: true });
                        const updated = await this.storage.putExperimentResult(stored.id, {
                            result: next,
                            expectedRevision: stored.revision,
                        });
                        reconciled.push(updated);
                        this.publish({ domain: "experiment-result", id: stored.id, action: "reconciliation-failed", data: { revision: updated.revision } });
                    } catch (error) {
                        this.publish({ domain: "experiment-result", id: entry.resultId, action: "reconciliation-failed", data: { error: error.message } });
                    }
                }
                await this.storage.deleteHeadlessRunBundles(entry.resultId).catch(() => {});
                continue;
            }
            validEntries.push(entry);
            if (!RESUMABLE_RESULT_STATUSES.has(stored.status)) continue;
            if (stored.status === "running") {
                const next = interruptRunningCaseOnly(stored, nowIso(this.now));
                try {
                    const updated = await this.storage.putExperimentResult(stored.id, {
                        result: next,
                        expectedRevision: stored.revision,
                    });
                    reconciled.push(updated);
                    this.publish({ domain: "experiment-result", id: stored.id, action: "interrupted", data: { revision: updated.revision } });
                } catch (error) {
                    this.publish({ domain: "experiment-result", id: stored.id, action: "reconciliation-failed", data: { error: error.message } });
                }
            }
        }

        if (validEntries.length !== queue.entries.length) {
            let current = queue;
            for (const entry of queue.entries) {
                if (validEntries.some((valid) => valid.resultId === entry.resultId)) continue;
                current = removeQueueEntry(current, entry.resultId);
            }
            await this.storage.putHeadlessExperimentQueue({ queue: current, expectedRevision: queue.revision });
        }

        for (const summary of await this.storage.listExperimentResults()) {
            if (!["pending", "running", "paused"].includes(summary.status)) continue;
            if (validEntries.some((entry) => entry.resultId === summary.id)) continue;
            const stored = await this.storage.getExperimentResult(summary.id);
            if (stored?.execution?.backend !== "headless") continue;
            const next = finalizeInterruptedResult(stored, nowIso(this.now));
            try {
                const updated = await this.storage.putExperimentResult(stored.id, {
                    result: next,
                    expectedRevision: stored.revision,
                });
                reconciled.push(updated);
                this.publish({ domain: "experiment-result", id: stored.id, action: "interrupted", data: { revision: updated.revision } });
            } catch (error) {
                this.publish({ domain: "experiment-result", id: stored.id, action: "reconciliation-failed", data: { error: error.message } });
            }
        }

        return reconciled;
    }

    get active() {
        return this.activeJob ? {
            jobId: this.activeJob.id,
            resultId: this.activeJob.result.id,
            suiteId: this.activeJob.suite.id,
            workerPid: this.activeJob.workerPid,
            cancelRequested: this.activeJob.cancelRequested,
            activeCaseIndex: this.activeJob.activeCaseIndex ?? null,
        } : null;
    }

    async getQueue() {
        await this.initialize();
        const queue = await this.storage.getHeadlessExperimentQueue();
        const entries = [];
        for (const [index, entry] of queue.entries.entries()) {
            const result = await this.storage.getExperimentResult(entry.resultId);
            entries.push({
                ...entry,
                queuePosition: index + 1,
                active: this.activeJob?.result.id === entry.resultId,
                result: result ? {
                    id: result.id,
                    suiteId: result.suiteId,
                    status: result.status,
                    revision: result.revision,
                    summary: result.summary,
                    execution: result.execution,
                } : null,
            });
        }
        return { revision: queue.revision, entries, pumpRunning: this.pumpRunning, active: this.active };
    }

    getLiveHealth() {
        return this.liveHealth ?? {
            pumpState: this.pumpRunning ? "running" : "idle",
            activeResultId: this.activeJob?.result.id ?? null,
            activeCaseIndex: this.activeJob?.activeCaseIndex ?? null,
            workerPid: this.activeJob?.workerPid ?? null,
            cancelRequested: this.activeJob?.cancelRequested ?? false,
            supervisor: null,
        };
    }

    async preflight({ suiteId, expectedRevision, artifactProfile } = {}) {
        const suite = await this.storage.getExperimentSuite(suiteId);
        if (!suite) throw new Error(`Experiment suite "${suiteId}" does not exist.`);
        if (expectedRevision !== undefined && Number(suite.revision) !== Number(expectedRevision)) {
            throw new Error(`Experiment suite revision conflict: expected ${expectedRevision}, current revision is ${suite.revision}.`);
        }
        const validation = await this.storage.validateExperimentSuite(suiteId);
        if (!validation.ok) {
            const error = new Error("Experiment suite validation found issues.");
            error.details = validation;
            throw error;
        }
        const cases = validation.matrix?.cases ?? [];
        if (cases.length === 0) throw new Error("The experiment suite has no compatible cases to run.");
        for (const entry of cases) {
            const resolution = await this.storage.resolveExperimentCase(suiteId, { case: entry });
            validateManagedRun(verifyRunBundle(bundleFromResolved(resolution.resolvedRun, nowIso(this.now))).resolved);
            resolveArtifactPolicy(
                artifactProfile ? { profile: artifactProfile } : null,
                resolution.resolvedRun.manifest,
            );
        }
        return {
            suiteId,
            revision: suite.revision,
            definitionHash: suite.definitionHash,
            caseCount: cases.length,
            failurePolicy: failurePolicy(suite),
        };
    }

    async start(options = {}) {
        return this.enqueue(options);
    }

    async enqueue({ suiteId, expectedRevision, resultId, failFast, artifactProfile } = {}) {
        await this.initialize();
        if (this.closing) throw new Error("The headless experiment service is shutting down.");
        return this.storage.withHeadlessAdmission(async () => {
            this.starting = true;
            let queuedResultId = null;
            let wroteSidecars = false;
            try {
                const suite = await this.storage.getExperimentSuite(suiteId);
                if (!suite) throw new Error(`Experiment suite "${suiteId}" does not exist.`);
                if (expectedRevision !== undefined && Number(suite.revision) !== Number(expectedRevision)) {
                    throw new Error(`Experiment suite revision conflict: expected ${expectedRevision}, current revision is ${suite.revision}.`);
                }
                const validation = await this.storage.validateExperimentSuite(suiteId);
                if (!validation.ok) {
                    const error = new Error("Experiment suite validation found issues.");
                    error.details = validation;
                    throw error;
                }
                const cases = validation.matrix?.cases ?? [];
                if (cases.length === 0) throw new Error("The experiment suite has no compatible cases to run.");
                queuedResultId = resultId || `${suiteId}-result-${Date.now().toString(36)}`;
                if (await this.storage.getExperimentResult(queuedResultId)) {
                    throw new Error(`Experiment result "${queuedResultId}" already exists.`);
                }

                const createdAt = nowIso(this.now);
                const jobId = this.jobIdFactory();
                const plannedCases = await Promise.all(cases.map(async (entry) => {
                    const resolution = await this.storage.resolveExperimentCase(suiteId, { case: entry });
                    if (Number(resolution.suite?.revision) !== Number(suite.revision)) {
                        throw new Error(`Experiment suite revision changed while resolving case "${entry.id}".`);
                    }
                    const bundle = bundleFromResolved(resolution.resolvedRun, createdAt);
                    const verified = verifyRunBundle(bundle);
                    validateManagedRun(verified.resolved);
                    const policy = resolveArtifactPolicy(
                        artifactProfile ? { profile: artifactProfile } : null,
                        verified.resolved.manifest,
                    );
                    return { case: clone(entry), resolution, bundle, verified, policy };
                }));
                const currentSuite = await this.storage.getExperimentSuite(suiteId);
                if (Number(currentSuite?.revision) !== Number(suite.revision)
                    || currentSuite?.definitionHash !== suite.definitionHash) {
                    throw new Error("Experiment suite changed during atomic headless preflight; retry with the new revision.");
                }

                await this.storage.writeHeadlessRunBundles(queuedResultId, {
                    manifest: {
                        jobId,
                        suiteId,
                        suiteRevision: suite.revision,
                        suiteHash: suite.definitionHash,
                        createdAt,
                        cases: plannedCases.map((entry) => ({
                            id: entry.case.id,
                            dependencyHashes: entry.resolution.dependencyHashes ?? {},
                        })),
                    },
                    bundles: plannedCases.map((entry) => entry.bundle),
                });
                wroteSidecars = true;

                const pending = createExperimentResult(suite, cases, {
                    id: queuedResultId,
                    createdAt,
                    status: "pending",
                    execution: { backend: "headless", jobId },
                });
                const stored = await this.storage.createExperimentResult({ result: pending });

                const queue = await this.storage.getHeadlessExperimentQueue();
                const nextQueue = appendQueueEntry(queue, {
                    jobId,
                    resultId: queuedResultId,
                    suiteId,
                    suiteRevision: suite.revision,
                    suiteHash: suite.definitionHash,
                    enqueuedAt: createdAt,
                    failurePolicy: failurePolicy(suite, failFast),
                    artifactProfile: artifactProfile ?? null,
                });
                const updatedQueue = await this.storage.putHeadlessExperimentQueue({
                    queue: nextQueue,
                    expectedRevision: queue.revision,
                });
                this.publish({
                    domain: "headless-queue",
                    id: queuedResultId,
                    action: "enqueued",
                    data: { revision: updatedQueue.revision, queuePosition: queuePositionFor(updatedQueue, queuedResultId) },
                });
                this.publish({ domain: "experiment-result", id: stored.id, action: "created", data: { revision: stored.revision, execution: pending.execution } });
                await this._ensurePump();
                return {
                    jobId,
                    suiteId,
                    resultId: stored.id,
                    revision: suite.revision,
                    caseCount: cases.length,
                    queuePosition: queuePositionFor(updatedQueue, stored.id),
                    result: stored,
                };
            } catch (error) {
                if (wroteSidecars && queuedResultId) {
                    await this.storage.deleteHeadlessRunBundles(queuedResultId).catch(() => {});
                }
                throw error;
            } finally {
                this.starting = false;
            }
        });
    }

    async cancel(resultId = null) {
        await this.initialize();
        if (!resultId) {
            const active = this.activeJob;
            if (!active) return null;
            resultId = active.result.id;
        }

        const result = await this.storage.getExperimentResult(resultId);
        if (!result) throw new Error(`Experiment result "${resultId}" does not exist.`);
        if (result.execution?.backend !== "headless") {
            throw new Error(`Experiment result "${resultId}" is not owned by the headless executor.`);
        }

        if (TERMINAL_RESULT_STATUSES.has(result.status) && result.status !== "paused") {
            return result;
        }

        if (this.activeJob?.result.id === resultId) {
            this.activeJob.cancelRequested = true;
            this.activeJob.abortController.abort();
            await this.activeJob.promise;
            return this.storage.getExperimentResult(resultId);
        }

        this.cancelledResultIds.add(resultId);
        const finishedAt = nowIso(this.now);
        const cancelled = normalizeExperimentResult({
            ...result,
            status: "cancelled",
            finishedAt,
            cases: result.cases.map((entry) => TERMINAL_CASE_STATUSES.has(entry.status)
                ? entry
                : {
                    ...entry,
                    status: "cancelled",
                    completed: false,
                    passed: false,
                    finishedAt,
                    failureReason: "Cancelled by request.",
                }),
        }, { allowMissingKind: true });
        const stored = await this.storage.putExperimentResult(resultId, {
            result: cancelled,
            expectedRevision: result.revision,
        });
        await this._removeFromQueue(resultId);
        await this.storage.deleteHeadlessRunBundles(resultId).catch(() => {});
        this.publish({ domain: "experiment-result", id: resultId, action: "queue-cancelled", data: { revision: stored.revision } });
        this.publish({ domain: "headless-queue", id: resultId, action: "cancelled" });
        return stored;
    }

    async waitForCompletion(resultId = null) {
        if (!resultId) {
            if (this.pumpPromise) await this.pumpPromise;
            return null;
        }
        while (!this.closing) {
            const result = await this.storage.getExperimentResult(resultId);
            if (!result) return null;
            const pendingCases = result.cases?.some((entry) => entry.status === "pending") ?? false;
            const terminal = TERMINAL_RESULT_STATUSES.has(result.status)
                || (result.status === "paused" && !pendingCases);
            if (terminal) return result;
            if (this.activeJob?.result.id === resultId) {
                await this.activeJob.promise;
                continue;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return this.storage.getExperimentResult(resultId);
    }

    async close() {
        if (this.closing) return;
        this.closing = true;
        const activeJob = this.activeJob;
        if (activeJob) {
            activeJob.cancelRequested = true;
            activeJob.abortController.abort();
            await activeJob.promise.catch(() => {});
            const finishedAt = nowIso(this.now);
            const current = await this.storage.getExperimentResult(activeJob.result.id);
            if (current && RESUMABLE_RESULT_STATUSES.has(current.status)) {
                const next = interruptRunningCaseOnly(current, finishedAt);
                await this.storage.putExperimentResult(current.id, {
                    result: next,
                    expectedRevision: current.revision,
                }).catch(() => {});
            }
        }
        if (this.pumpPromise) await this.pumpPromise.catch(() => {});
        await this.supervisor.close();
        await removeStagingDirectories(this.artifactRoot);
    }

    async _ensurePump() {
        if (this.pumpRunning || this.closing) return;
        this.pumpRunning = true;
        this.pumpPromise = this._drainQueue().finally(() => {
            this.pumpRunning = false;
            this.liveHealth = {
                ...this.getLiveHealth(),
                pumpState: "idle",
                activeResultId: null,
                activeCaseIndex: null,
                workerPid: null,
            };
        });
    }

    async _drainQueue() {
        while (!this.closing) {
            const queue = await this.storage.getHeadlessExperimentQueue();
            const entry = queue.entries.find((candidate) => {
                if (this.cancelledResultIds.has(candidate.resultId)) return false;
                return true;
            });
            if (!entry) break;

            const result = await this.storage.getExperimentResult(entry.resultId);
            if (!result || result.execution?.backend !== "headless") {
                await this._removeFromQueue(entry.resultId);
                continue;
            }
            if (this.cancelledResultIds.has(entry.resultId) || result.status === "cancelled") {
                this.cancelledResultIds.delete(entry.resultId);
                await this._removeFromQueue(entry.resultId);
                await this.storage.deleteHeadlessRunBundles(entry.resultId).catch(() => {});
                continue;
            }
            if (TERMINAL_RESULT_STATUSES.has(result.status) && result.status !== "paused") {
                await this._finalizeQueueEntry(entry);
                continue;
            }
            if (result.status === "paused" && !this.resumePausedJobs) {
                await this._removeFromQueue(entry.resultId);
                continue;
            }

            const sidecars = await this.storage.readHeadlessRunBundles(entry.resultId);
            if (!sidecars) {
                await this._persistQueueError(entry, result, "Immutable run-bundle sidecars are missing.");
                continue;
            }

            try {
                await this._runJob(entry, result, sidecars);
            } catch (error) {
                const current = await this.storage.getExperimentResult(entry.resultId).catch(() => null);
                if (current && this.activeJob && Number(current.revision) !== Number(this.activeJob.revision)) {
                    this.publish({ domain: "experiment-run", id: entry.resultId, action: "revision-conflict", data: { error: error.message } });
                    await this._removeFromQueue(entry.resultId);
                    await this.storage.deleteHeadlessRunBundles(entry.resultId).catch(() => {});
                } else if (entry.resultId === this.activeJob?.result.id && this.activeJob.cancelRequested) {
                    await this._finalizeCancellation(this.activeJob).catch(() => {});
                } else {
                    await this._persistQueueError(entry, result, error.message).catch(() => {});
                }
            } finally {
                if (this.activeJob?.result.id === entry.resultId) {
                    this.activeJob = null;
                    this.liveHealth = {
                        ...this.getLiveHealth(),
                        workerPid: null,
                        activeCaseIndex: null,
                    };
                }
            }

            const latest = await this.storage.getExperimentResult(entry.resultId);
            if (latest && TERMINAL_RESULT_STATUSES.has(latest.status) && latest.status !== "paused") {
                await this._finalizeQueueEntry(entry);
            }
        }
    }

    async _runJob(entry, result, sidecars) {
        const plannedCases = sidecars.bundles.map((bundle, index) => {
            const verified = verifyRunBundle(bundle);
            const meta = sidecars.manifest.cases[index] ?? {};
            const policy = resolveArtifactPolicy(
                entry.artifactProfile ? { profile: entry.artifactProfile } : null,
                verified.resolved.manifest,
            );
            return {
                case: result.cases[index],
                resolution: { dependencyHashes: meta.dependencyHashes ?? {} },
                bundle,
                verified,
                policy,
            };
        });
        const suite = await this.storage.getExperimentSuite(entry.suiteId);
        const job = {
            id: entry.jobId,
            suite: clone(suite),
            plannedCases,
            failurePolicy: entry.failurePolicy,
            artifactProfile: entry.artifactProfile,
            result: normalizeExperimentResult(result, { allowMissingKind: true }),
            revision: result.revision,
            abortController: new AbortController(),
            cancelRequested: false,
            workerPid: null,
            activeCaseIndex: null,
            promise: null,
        };
        this.activeJob = job;
        job.promise = this._drain(job);
        await job.promise;
    }

    async _persist(job, next, action) {
        const current = await this.storage.getExperimentResult(job.result.id);
        if (current && Number(current.revision) !== Number(job.revision)) {
            throw new Error(`Experiment result revision conflict: expected ${job.revision}, current revision is ${current.revision}.`);
        }
        const stored = await this.storage.putExperimentResult(job.result.id, {
            result: next,
            expectedRevision: job.revision,
        });
        job.revision = stored.revision;
        job.result = normalizeExperimentResult(stored, { allowMissingKind: true });
        this.publish({ domain: "experiment-result", id: stored.id, action, data: { revision: stored.revision, status: stored.status } });
        return job.result;
    }

    async _drain(job) {
        try {
            const startedAt = nowIso(this.now);
            if (job.result.status === "pending") {
                await this._persist(job, normalizeExperimentResult({
                    ...job.result,
                    status: "running",
                    startedAt: job.result.startedAt ?? startedAt,
                    finishedAt: null,
                }, { allowMissingKind: true }), "queue-started");
            } else if (job.result.status === "paused") {
                await this._persist(job, normalizeExperimentResult({
                    ...job.result,
                    status: "running",
                    finishedAt: null,
                }, { allowMissingKind: true }), "queue-resumed");
            }

            for (let index = 0; index < job.plannedCases.length; index += 1) {
                if (job.cancelRequested) break;
                if (job.result.cases[index]?.status !== "pending") continue;
                job.activeCaseIndex = index;
                this._publishLiveHealth(job);
                const caseStartedAt = nowIso(this.now);
                await this._replaceCase(job, index, {
                    status: "running",
                    completed: false,
                    passed: false,
                    startedAt: caseStartedAt,
                    finishedAt: null,
                    failureReason: null,
                }, "case-started");
                const terminal = await this._runCase(job, index, caseStartedAt);
                await this._replaceCase(job, index, terminal, "case-finalized");
                if (job.failurePolicy === "fail-fast" && terminal.passed !== true) {
                    const finishedAt = nowIso(this.now);
                    const casesAfterFailure = job.result.cases.map((entry) => entry.status === "pending"
                        ? {
                            ...entry,
                            status: "cancelled",
                            completed: false,
                            passed: false,
                            finishedAt,
                            failureReason: "Skipped by fail-fast policy.",
                        }
                        : entry);
                    await this._persist(job, normalizeExperimentResult({ ...job.result, cases: casesAfterFailure }, { allowMissingKind: true }), "fail-fast");
                    break;
                }
            }

            if (job.cancelRequested) {
                await this._finalizeCancellation(job);
            } else if (!["cancelled", "error", "interrupted"].includes(job.result.status)) {
                await this._persist(job, normalizeExperimentResult({
                    ...job.result,
                    status: "completed",
                    finishedAt: nowIso(this.now),
                }, { allowMissingKind: true }), "queue-finalized");
            }
        } catch (error) {
            if (job.cancelRequested) {
                await this._finalizeCancellation(job).catch(() => {});
            } else {
                const current = await this.storage.getExperimentResult(job.result.id).catch(() => null);
                if (current && Number(current.revision) !== Number(job.revision)) {
                    // Propagate so _drainQueue can dequeue and delete immutable sidecars.
                    throw error;
                } else {
                    const finishedAt = nowIso(this.now);
                    const cases = job.result.cases.map((entry) => entry.status === "running"
                        ? { ...entry, status: "error", completed: false, passed: false, finishedAt, failureReason: error.message }
                        : entry);
                    await this._persist(job, normalizeExperimentResult({
                        ...job.result,
                        status: "error",
                        finishedAt,
                        cases,
                    }, { allowMissingKind: true }), "queue-error").catch(() => {});
                    this.publish({ domain: "experiment-run", id: job.result.id, action: "error", data: { error: error.message } });
                }
            }
        } finally {
            job.activeCaseIndex = null;
            await removeStagingDirectories(path.join(this.artifactRoot, job.id)).catch(() => {});
        }
        return job.result;
    }

    async _replaceCase(job, index, patch, action) {
        const cases = job.result.cases.map((entry, entryIndex) => entryIndex === index
            ? { ...entry, ...patch }
            : entry);
        return this._persist(job, normalizeExperimentResult({ ...job.result, cases }, { allowMissingKind: true }), action);
    }

    _publishLiveHealth(job, supervisorHealth = null) {
        const now = typeof this.now === "function" ? this.now() : Date.now();
        this.liveHealth = {
            pumpState: "running",
            activeResultId: job.result.id,
            activeCaseIndex: job.activeCaseIndex,
            workerPid: job.workerPid,
            cancelRequested: job.cancelRequested,
            supervisor: supervisorHealth,
        };
        if (now - this.lastHealthPublishAt >= HEALTH_PUBLISH_INTERVAL_MS) {
            this.lastHealthPublishAt = now;
            this.publish({
                domain: "headless-runtime",
                id: job.result.id,
                action: "health",
                data: this.liveHealth,
            });
        }
    }

    async _runCase(job, index, startedAt) {
        const planned = job.plannedCases[index];
        const activeCase = job.result.cases[index];
        const outputUri = path.join(this.artifactRoot, job.id, `case-${String(index).padStart(4, "0")}`);
        let finalized = null;
        let artifacts = [];
        try {
            finalized = await this.supervisor.runManagedExperiment({
                bundle: planned.bundle,
                metricDefinitions: job.result.metricDefinitions,
                artifactPolicy: job.artifactProfile ? { profile: job.artifactProfile } : null,
                outputUri,
            }, {
                signal: job.abortController.signal,
                onStarted: ({ pid }) => {
                    job.workerPid = pid;
                    this._publishLiveHealth(job);
                },
                onHealth: (health) => {
                    this._publishLiveHealth(job, health);
                },
            });
            job.workerPid = null;
            if (job.cancelRequested) return this._cancelledCase(activeCase, startedAt);
            const runResult = finalized.runResult;
            artifacts = absoluteArtifacts(finalized);
            const artifactWarnings = [...(runResult.artifactWarnings || [])];
            let logId = null;
            const logArtifact = artifacts.find((artifact) => artifact.name === "run.sflog");
            if (logArtifact) {
                try {
                    const imported = await this.importLog(logArtifact.uri, {
                        name: `${job.suite.name}: ${activeCase.id}`,
                    });
                    if (imported.runId !== runResult.runId || imported.resolvedHash !== runResult.resolvedHash) {
                        await this.logService.deleteLog(imported.id).catch(() => {});
                        throw new Error("Imported SFLog identity does not match the finalized managed run.");
                    }
                    logId = imported.id;
                    logArtifact.catalogUri = `fusion://logs/${encodeURIComponent(logId)}`;
                    await this._linkImportedLogEvidence(imported.id, {
                        suiteId: job.suite.id,
                        resultId: job.result.id,
                        caseId: activeCase.id,
                        runResult,
                        dependencyHashes: planned.resolution.dependencyHashes ?? {},
                    });
                    this.publish({ domain: "logging", id: logId, action: "imported", data: { resultId: job.result.id, caseId: activeCase.id } });
                } catch (error) {
                    if (planned.policy.logRequired) throw error;
                    artifactWarnings.push(`Optional SFLog import failed: ${error.message}`);
                }
            } else if (planned.policy.logRequired) {
                throw new Error("Required managed SFLog was not retained for import.");
            }
            const passed = runResult.passed === true;
            return {
                ...activeCase,
                status: passed ? "completed" : "failed",
                completed: true,
                passed,
                terminationReason: runResult.terminationReason ?? runResult.status ?? null,
                latestTrigger: runResult.latestTrigger ?? null,
                terminalEvent: runResult.terminalEvent ?? null,
                assertions: runResult.assertions ?? [],
                outcomes: runResult.outcomes ?? [],
                metrics: finalized.experimentMetrics ?? runResult.experimentMetrics ?? {},
                dependencyHashes: planned.resolution.dependencyHashes ?? {},
                resolvedHash: runResult.resolvedHash,
                runId: runResult.runId,
                simulationSemanticHash: runResult.simulationSemanticHash,
                episodeHash: runResult.episodeHash,
                trajectoryHash: runResult.trajectoryHash,
                artifacts,
                artifactWarnings,
                logId,
                startedAt,
                finishedAt: nowIso(this.now),
                failureReason: runResult.failureReason ?? (passed ? null : "Case did not pass."),
            };
        } catch (error) {
            job.workerPid = null;
            if (job.cancelRequested) return this._cancelledCase(activeCase, startedAt);
            const runResult = finalized?.runResult;
            return {
                ...activeCase,
                status: "error",
                completed: false,
                passed: false,
                dependencyHashes: planned.resolution.dependencyHashes ?? {},
                resolvedHash: planned.verified.resolvedHash,
                runId: runResult?.runId ?? null,
                simulationSemanticHash: runResult?.simulationSemanticHash ?? planned.verified.simulationSemanticHash,
                episodeHash: runResult?.episodeHash ?? null,
                trajectoryHash: runResult?.trajectoryHash ?? null,
                artifacts,
                artifactWarnings: artifacts.length > 0 ? [`Artifact integration failed: ${error.message}`] : [],
                startedAt,
                finishedAt: nowIso(this.now),
                failureReason: error.message,
            };
        }
    }

    _cancelledCase(activeCase, startedAt) {
        return {
            ...activeCase,
            status: "cancelled",
            completed: false,
            passed: false,
            startedAt,
            finishedAt: nowIso(this.now),
            failureReason: "Cancelled by request.",
        };
    }

    async _linkImportedLogEvidence(logId, {
        suiteId,
        resultId,
        caseId,
        runResult = {},
        dependencyHashes = {},
    } = {}) {
        if (!logId || typeof this.logService.linkExperimentEvidence !== "function") return null;
        return this.logService.linkExperimentEvidence(logId, {
            suiteId,
            resultId,
            caseId,
            runId: runResult.runId ?? null,
            manifestId: runResult.manifestId ?? null,
            definitionHash: runResult.definitionHash ?? null,
            resolvedHash: runResult.resolvedHash ?? null,
            simulationSemanticHash: runResult.simulationSemanticHash ?? null,
            episodeHash: runResult.episodeHash ?? null,
            trajectoryHash: runResult.trajectoryHash ?? null,
            dependencyHashes,
            candidateModels: runResult.candidateModels
                ?? runResult.provenance?.candidateModels
                ?? [],
            gitCommit: runResult.gitCommit ?? runResult.gitHash ?? null,
        });
    }

    async _finalizeCancellation(job) {
        if (job.result.status === "cancelled") return job.result;
        const finishedAt = nowIso(this.now);
        const cases = job.result.cases.map((entry) => !TERMINAL_CASE_STATUSES.has(entry.status)
            ? {
                ...entry,
                status: "cancelled",
                completed: false,
                passed: false,
                finishedAt,
                failureReason: "Cancelled by request.",
            }
            : entry);
        const stored = await this._persist(job, normalizeExperimentResult({
            ...job.result,
            status: "cancelled",
            finishedAt,
            cases,
        }, { allowMissingKind: true }), "queue-cancelled");
        await this._removeFromQueue(job.result.id);
        await this.storage.deleteHeadlessRunBundles(job.result.id).catch(() => {});
        this.publish({ domain: "headless-queue", id: job.result.id, action: "cancelled" });
        return stored;
    }

    async _persistQueueError(entry, result, message) {
        const finishedAt = nowIso(this.now);
        const next = normalizeExperimentResult({
            ...result,
            status: "error",
            finishedAt,
            cases: result.cases.map((caseEntry) => caseEntry.status === "pending" || caseEntry.status === "running"
                ? {
                    ...caseEntry,
                    status: "error",
                    completed: false,
                    passed: false,
                    finishedAt,
                    failureReason: message,
                }
                : caseEntry),
        }, { allowMissingKind: true });
        await this.storage.putExperimentResult(result.id, {
            result: next,
            expectedRevision: result.revision,
        });
        await this._finalizeQueueEntry(entry);
        this.publish({ domain: "experiment-run", id: result.id, action: "error", data: { error: message } });
    }

    async _finalizeQueueEntry(entry) {
        await this._removeFromQueue(entry.resultId);
        await this.storage.deleteHeadlessRunBundles(entry.resultId).catch(() => {});
        this.publish({ domain: "headless-queue", id: entry.resultId, action: "dequeued" });
    }

    async _removeFromQueue(resultId) {
        const queue = await this.storage.getHeadlessExperimentQueue();
        if (!queue.entries.some((entry) => entry.resultId === resultId)) return queue;
        const next = removeQueueEntry(queue, resultId);
        return this.storage.putHeadlessExperimentQueue({ queue: next, expectedRevision: queue.revision });
    }
}
