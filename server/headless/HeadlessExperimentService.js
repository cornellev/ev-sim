import { randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";

import { createExperimentResult, normalizeExperimentResult } from "../../app/experiments/ExperimentResult.js";
import { RUN_BUNDLE_KIND, RUN_BUNDLE_VERSION } from "../../app/simulation/RunManifest.js";
import { resolveArtifactPolicy } from "./HeadlessArtifactSink.js";
import { validateManagedRun } from "./ManagedHeadlessSession.js";
import { HeadlessSupervisor } from "./HeadlessSupervisor.js";
import { verifyRunBundle } from "./RunBundle.js";
import { storageEvents } from "../mcp/events.js";

const TERMINAL_CASE_STATUSES = new Set(["completed", "failed", "error", "cancelled", "interrupted"]);

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

function interruptedResult(result, finishedAt) {
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
        const reconciled = [];
        for (const summary of await this.storage.listExperimentResults()) {
            if (!["pending", "running", "paused"].includes(summary.status)) continue;
            const stored = await this.storage.getExperimentResult(summary.id);
            if (stored?.execution?.backend !== "headless") continue;
            const next = interruptedResult(stored, nowIso(this.now));
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
        this.initialized = true;
        return reconciled;
    }

    get active() {
        return this.activeJob ? {
            jobId: this.activeJob.id,
            resultId: this.activeJob.result.id,
            suiteId: this.activeJob.suite.id,
            workerPid: this.activeJob.workerPid,
            cancelRequested: this.activeJob.cancelRequested,
        } : null;
    }

    async start({ suiteId, expectedRevision, resultId, failFast, artifactProfile } = {}) {
        await this.initialize();
        if (this.closing) throw new Error("The headless experiment service is shutting down.");
        if (this.starting || this.activeJob) throw new Error("A headless experiment queue is already active.");
        this.starting = true;
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
            const queuedResultId = resultId || `${suiteId}-result-${Date.now().toString(36)}`;
            if (await this.storage.getExperimentResult(queuedResultId)) {
                throw new Error(`Experiment result "${queuedResultId}" already exists.`);
            }

            const createdAt = nowIso(this.now);
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

            const jobId = this.jobIdFactory();
            const pending = createExperimentResult(suite, cases, {
                id: queuedResultId,
                createdAt,
                status: "pending",
                execution: { backend: "headless", jobId },
            });
            const stored = await this.storage.createExperimentResult({ result: pending });
            const job = {
                id: jobId,
                suite: clone(suite),
                plannedCases,
                failurePolicy: failurePolicy(suite, failFast),
                artifactProfile: artifactProfile ?? null,
                result: normalizeExperimentResult(stored, { allowMissingKind: true }),
                revision: stored.revision,
                abortController: new AbortController(),
                cancelRequested: false,
                workerPid: null,
                promise: null,
            };
            this.activeJob = job;
            this.publish({ domain: "experiment-result", id: stored.id, action: "created", data: { revision: stored.revision, execution: pending.execution } });
            job.promise = Promise.resolve().then(() => this._drain(job));
            return {
                jobId,
                suiteId,
                resultId: stored.id,
                revision: suite.revision,
                caseCount: cases.length,
                result: stored,
            };
        } finally {
            this.starting = false;
        }
    }

    async cancel(resultId = null) {
        const job = this.activeJob;
        if (!job || (resultId && resultId !== job.result.id)) {
            if (resultId) {
                const result = await this.storage.getExperimentResult(resultId);
                if (!result) throw new Error(`Experiment result "${resultId}" does not exist.`);
                if (result.execution?.backend !== "headless") throw new Error(`Experiment result "${resultId}" is not owned by the headless executor.`);
                return result;
            }
            return null;
        }
        job.cancelRequested = true;
        job.abortController.abort();
        await job.promise;
        return this.storage.getExperimentResult(job.result.id);
    }

    async waitForCompletion(resultId = null) {
        const job = this.activeJob;
        if (job && (!resultId || resultId === job.result.id)) await job.promise;
        return resultId ? this.storage.getExperimentResult(resultId) : null;
    }

    async close() {
        if (this.closing) return;
        this.closing = true;
        if (this.activeJob) await this.cancel(this.activeJob.result.id).catch(() => {});
        await this.supervisor.close();
        await removeStagingDirectories(this.artifactRoot);
    }

    async _persist(job, next, action) {
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
            await this._persist(job, normalizeExperimentResult({
                ...job.result,
                status: "running",
                startedAt: job.result.startedAt ?? startedAt,
                finishedAt: null,
            }, { allowMissingKind: true }), "queue-started");

            for (let index = 0; index < job.plannedCases.length; index += 1) {
                if (job.cancelRequested) break;
                if (job.result.cases[index]?.status !== "pending") continue;
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
            } else {
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
        } finally {
            await removeStagingDirectories(path.join(this.artifactRoot, job.id)).catch(() => {});
            if (this.activeJob === job) this.activeJob = null;
        }
        return job.result;
    }

    async _replaceCase(job, index, patch, action) {
        const cases = job.result.cases.map((entry, entryIndex) => entryIndex === index
            ? { ...entry, ...patch }
            : entry);
        return this._persist(job, normalizeExperimentResult({ ...job.result, cases }, { allowMissingKind: true }), action);
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
                onStarted: ({ pid }) => { job.workerPid = pid; },
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
        return this._persist(job, normalizeExperimentResult({
            ...job.result,
            status: "cancelled",
            finishedAt,
            cases,
        }, { allowMissingKind: true }), "queue-cancelled");
    }
}
