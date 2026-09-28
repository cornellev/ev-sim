import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalUuid, assertSha256 } from "../MarketplaceFormats.js";
import {
    atomicReplaceDurable,
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";
import {
    MARKETPLACE_INSTALL_DOCUMENT_VERSION,
    MARKETPLACE_INSTALL_KINDS,
    MARKETPLACE_PRECOMMIT_PHASES,
    assertInstallJob,
    installDocumentBytes,
    parseInstallDocument,
} from "./MarketplaceInstallDocuments.js";

const TERMINAL_PHASES = new Set(["failed", "cancelled", "complete"]);

function jobPaths(paths, jobId) {
    assertCanonicalUuid(jobId, "jobId");
    const root = path.join(paths.jobs, jobId);
    return Object.freeze({
        root,
        snapshot: path.join(root, "snapshot.json"),
        work: path.join(root, "work"),
    });
}

function conflict(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function sanitizedError(error) {
    const code = error instanceof MarketplaceError ? error.code : MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED;
    const messages = {
        [MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE]: "Marketplace source is unavailable.",
        [MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH]: "Marketplace artifact verification failed.",
        [MARKETPLACE_ERROR_CODES.INCOMPATIBLE]: "Marketplace release is incompatible with this host.",
        [MARKETPLACE_ERROR_CODES.RIGHTS_DENIED]: "Marketplace installation requires denied rights.",
        [MARKETPLACE_ERROR_CODES.RELEASE_BLOCKED]: "Marketplace release is blocked by policy.",
        [MARKETPLACE_ERROR_CODES.CANCELLED]: "Marketplace installation was cancelled.",
        [MARKETPLACE_ERROR_CODES.CONFLICT]: "Marketplace installation state changed.",
        [MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED]: "Marketplace installation requires recovery.",
    };
    return Object.freeze({ code, message: messages[code] ?? "Marketplace installation failed." });
}

export class MarketplaceInstallJobManager {
    #listeners = new Map();
    #queues = new Map();
    #controllers = new Map();
    #runs = new Set();
    #closed = false;
    #closing = false;

    constructor({ paths, planner, downloader, coordinator, sourceStore, now = () => new Date(), fault = null }) {
        this.paths = paths;
        this.planner = planner;
        this.downloader = downloader;
        this.coordinator = coordinator;
        this.sourceStore = sourceStore;
        this.now = now;
        this.fault = fault;
    }

    static async create(dataDir, dependencies) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.jobs);
        return new MarketplaceInstallJobManager({ paths, ...dependencies });
    }

    #assertOpen() {
        if (this.#closed) throw marketplaceError(MARKETPLACE_ERROR_CODES.CANCELLED, "Marketplace installation job manager is closed.");
    }

    async #read(jobId) {
        const filePath = jobPaths(this.paths, jobId).snapshot;
        if (!await lstatOrNull(filePath)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace installation job was not found.");
        }
        let bytes;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                bytes = await readRegularBytes(filePath, { maxBytes: 4 * 1024 * 1024 });
                break;
            } catch (error) {
                if (error.code !== MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED || attempt === 7) throw error;
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        const job = parseInstallDocument(bytes, assertInstallJob);
        if (job.jobId !== jobId || !Buffer.from(bytes).equals(Buffer.from(installDocumentBytes(job, assertInstallJob)))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace installation job snapshot is invalid.");
        }
        return job;
    }

    #notify(job) {
        for (const listener of this.#listeners.get(job.jobId) ?? []) {
            try {
                listener(job);
            } catch {
                // Subscriber failures do not change durable job state.
            }
        }
    }

    #update(jobId, transform) {
        const previous = this.#queues.get(jobId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const current = await this.#read(jobId);
            const patch = await transform(current);
            if (patch === null) return current;
            const next = assertInstallJob({
                ...current,
                ...patch,
                revision: current.revision + 1,
                updatedAt: this.now().toISOString(),
            });
            await atomicReplaceDurable(jobPaths(this.paths, jobId).snapshot, installDocumentBytes(next, assertInstallJob));
            this.#notify(next);
            return next;
        });
        this.#queues.set(jobId, operation);
        return operation.finally(() => {
            if (this.#queues.get(jobId) === operation) this.#queues.delete(jobId);
        });
    }

    #launch(operation) {
        const running = operation().catch(() => {}).finally(() => this.#runs.delete(running));
        this.#runs.add(running);
    }

    async start(planHash) {
        this.#assertOpen();
        assertSha256(planHash, "planHash");
        const preflight = await this.planner.readPreflight(planHash);
        if (preflight.releases.some((entry) => !entry.compatibility.compatible && entry.release.contentKind !== "asset-pack")) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.INCOMPATIBLE, "Marketplace release dependency graph is incompatible with this host.");
        }
        for (const entry of preflight.releases) {
            if (!this.planner.adapterRegistry.hasLifecycle(entry.release.contentKind)) {
                throw marketplaceError(
                    MARKETPLACE_ERROR_CODES.INCOMPATIBLE,
                    `Marketplace lifecycle ${entry.release.contentKind} is not available in this milestone.`,
                );
            }
        }
        const jobId = randomUUID();
        const paths = jobPaths(this.paths, jobId);
        await ensureDirectory(paths.root);
        await ensureDirectory(paths.work);
        const timestamp = this.now().toISOString();
        const job = assertInstallJob({
            kind: MARKETPLACE_INSTALL_KINDS.job,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            jobId,
            revision: 0,
            phase: "queued",
            createdAt: timestamp,
            updatedAt: timestamp,
            planHash,
            finalPlanHash: null,
            progress: {
                artifactsTotal: preflight.artifacts.length,
                artifactsComplete: 0,
                bytesTotal: preflight.totalDownloadBytes,
                bytesComplete: 0,
                currentDigest: null,
                totalOperations: 0,
                completedOperations: 0,
                currentOperation: null,
            },
            error: null,
            receiptHashes: [],
        });
        await writeExclusiveDurable(paths.snapshot, installDocumentBytes(job, assertInstallJob));
        this.#launch(() => this.#runPrecommit(jobId));
        return job;
    }

    async snapshot(jobId) {
        this.#assertOpen();
        return this.#read(jobId);
    }

    subscribe(jobId, listener, { emitCurrent = true } = {}) {
        this.#assertOpen();
        assertCanonicalUuid(jobId, "jobId");
        if (typeof listener !== "function") throw new TypeError("Marketplace job listener must be a function.");
        let lastRevision = -1;
        const orderedListener = (job) => {
            if (job.revision <= lastRevision) return;
            lastRevision = job.revision;
            listener(job);
        };
        const listeners = this.#listeners.get(jobId) ?? new Set();
        listeners.add(orderedListener);
        this.#listeners.set(jobId, listeners);
        if (emitCurrent) this.#read(jobId).then(orderedListener).catch(() => {});
        return () => {
            listeners.delete(orderedListener);
            if (!listeners.size) this.#listeners.delete(jobId);
        };
    }

    async #runPrecommit(jobId) {
        const controller = new AbortController();
        this.#controllers.set(jobId, controller);
        try {
            let job = await this.#update(jobId, (current) => {
                if (TERMINAL_PHASES.has(current.phase)) return null;
                if (!["queued", "recover", "download", "verify", "plan"].includes(current.phase)) {
                    throw conflict("Marketplace installation job is not resumable before commit.");
                }
                return { phase: "download", error: null };
            });
            const preflight = await this.planner.readPreflight(job.planHash);
            const source = this.sourceStore.get(preflight.source.sourceId);
            if (!source || source.registryId !== preflight.source.registryId
                || source.trustedRootFingerprint !== preflight.source.trustedRootFingerprint) {
                throw conflict("Marketplace source identity changed after installation preflight.");
            }
            const work = jobPaths(this.paths, jobId).work;
            let artifactsComplete = 0;
            let bytesComplete = 0;
            for (const descriptor of preflight.artifacts) {
                if (controller.signal.aborted) throw marketplaceError(MARKETPLACE_ERROR_CODES.CANCELLED, "Marketplace installation was cancelled.");
                job = await this.#update(jobId, (current) => TERMINAL_PHASES.has(current.phase) ? null : ({
                    progress: { ...current.progress, currentDigest: descriptor.sha256 },
                }));
                if (TERMINAL_PHASES.has(job.phase)) return;
                await this.downloader.obtain({ source, descriptor, workDirectory: work, signal: controller.signal });
                artifactsComplete += 1;
                bytesComplete += descriptor.sizeBytes;
                job = await this.#update(jobId, (current) => TERMINAL_PHASES.has(current.phase) ? null : ({
                    progress: {
                        ...current.progress,
                        artifactsComplete,
                        bytesComplete,
                        currentDigest: null,
                    },
                }));
                if (TERMINAL_PHASES.has(job.phase)) return;
            }
            await this.#update(jobId, (current) => TERMINAL_PHASES.has(current.phase) ? null : ({ phase: "verify" }));
            await this.#update(jobId, (current) => TERMINAL_PHASES.has(current.phase) ? null : ({ phase: "plan" }));
            const finalized = await this.planner.createFinalPlan(job.planHash, {
                signal: controller.signal,
                workDirectory: work,
            });
            await this.#update(jobId, (current) => TERMINAL_PHASES.has(current.phase) ? null : ({
                phase: "awaiting-confirmation",
                finalPlanHash: finalized.planHash,
                error: null,
                progress: {
                    ...current.progress,
                    totalOperations: finalized.plan.releases.reduce((total, entry) => total + (entry.adapterPlan.operations?.length ?? 1), 0),
                    completedOperations: 0,
                    currentOperation: null,
                },
            }));
        } catch (error) {
            await this.#finishPrecommitError(jobId, error);
        } finally {
            if (this.#controllers.get(jobId) === controller) this.#controllers.delete(jobId);
        }
    }

    async #finishPrecommitError(jobId, error) {
        await this.#update(jobId, (current) => {
            if (TERMINAL_PHASES.has(current.phase)) return null;
            if (this.#closing) return { phase: "recover", error: null, progress: { ...current.progress, currentDigest: null } };
            if (error instanceof MarketplaceError && error.code === MARKETPLACE_ERROR_CODES.CANCELLED) {
                return { phase: "cancelled", error: null, progress: { ...current.progress, currentDigest: null } };
            }
            return { phase: "failed", error: sanitizedError(error), progress: { ...current.progress, currentDigest: null } };
        }).catch(() => {});
    }

    async confirmCommit(jobId, { expectedRevision, finalPlanHash }) {
        this.#assertOpen();
        assertSha256(finalPlanHash, "finalPlanHash");
        const plan = await this.planner.readFinalPlan(finalPlanHash);
        if (!plan.committable) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Marketplace installation plan is not committable.");
        const job = await this.#update(jobId, (current) => {
            if (current.revision !== expectedRevision) throw conflict("Marketplace installation job revision is stale.");
            if (current.phase !== "awaiting-confirmation") throw conflict("Marketplace installation job is not awaiting confirmation.");
            if (current.finalPlanHash !== finalPlanHash) throw conflict("Marketplace finalized plan does not match the job.");
            return { phase: "commit", error: null };
        });
        this.#launch(() => this.#runCommit(jobId));
        return job;
    }

    async #runCommit(jobId) {
        try {
            const job = await this.#read(jobId);
            const finalPlan = await this.planner.readFinalPlan(job.finalPlanHash);
            const result = await this.coordinator.install(job, finalPlan, {
                onOperation: (progress) => this.#update(jobId, (current) => ({
                    progress: { ...current.progress, ...progress },
                })),
            });
            await this.#resetWork(jobId);
            await this.#complete(jobId, result);
            await this.coordinator.finish(result.transactionId);
        } catch (error) {
            await this.#update(jobId, (current) => {
                if (current.phase === "complete") return null;
                if (error?.marketplaceTransactionDurable) {
                    return { phase: "needs-attention", error: sanitizedError(error), progress: { ...current.progress, currentOperation: null } };
                }
                return { phase: "failed", error: sanitizedError(error) };
            }).catch(() => {});
        }
    }

    async #complete(jobId, result) {
        const job = await this.#update(jobId, (current) => ({
            phase: "complete",
            receiptHashes: [...result.receiptHashes].sort(compareUtf8),
            error: null,
            progress: {
                ...current.progress,
                currentDigest: null,
                completedOperations: current.progress.totalOperations ?? current.progress.operationsTotal ?? 0,
                currentOperation: null,
            },
        }));
        await this.fault?.("after-job-complete", { job });
    }

    async cancel(jobId, expectedRevision) {
        this.#assertOpen();
        const job = await this.#update(jobId, (current) => {
            if (current.revision !== expectedRevision) throw conflict("Marketplace installation job revision is stale.");
            const precommitRecovery = current.phase === "recover" && current.finalPlanHash === null;
            if (!MARKETPLACE_PRECOMMIT_PHASES.has(current.phase) && !precommitRecovery) {
                throw conflict("Marketplace installation can no longer be cancelled.");
            }
            return { phase: "cancelled", error: null, progress: { ...current.progress, currentDigest: null } };
        });
        this.#controllers.get(jobId)?.abort();
        await this.#resetWork(jobId);
        return job;
    }

    async #resetWork(jobId) {
        const work = jobPaths(this.paths, jobId).work;
        await fs.rm(work, { recursive: true, force: true });
        await ensureDirectory(work);
    }

    async resume(jobId, expectedRevision) {
        this.#assertOpen();
        const job = await this.#update(jobId, (current) => {
            if (current.revision !== expectedRevision) throw conflict("Marketplace installation job revision is stale.");
            if (current.phase !== "needs-attention" || !current.finalPlanHash) {
                throw conflict("Marketplace installation job does not require resumable attention.");
            }
            return { phase: "recover", error: null, progress: { ...current.progress, currentOperation: null } };
        });
        this.#launch(() => this.#runCommit(jobId));
        return job;
    }

    async replan(jobId, expectedRevision) {
        this.#assertOpen();
        const current = await this.#read(jobId);
        if (current.revision !== expectedRevision) throw conflict("Marketplace installation job revision is stale.");
        if (current.phase !== "needs-attention" || !current.finalPlanHash) {
            throw conflict("Marketplace installation job does not require replanning.");
        }
        await this.coordinator.abandonJob(jobId);
        const finalized = await this.planner.createFinalPlan(current.planHash, {
            workDirectory: jobPaths(this.paths, jobId).work,
        });
        return this.#update(jobId, (job) => {
            if (job.revision !== expectedRevision || job.phase !== "needs-attention") throw conflict("Marketplace installation job changed during replanning.");
            return {
                phase: "awaiting-confirmation",
                finalPlanHash: finalized.planHash,
                error: null,
                progress: {
                    ...job.progress,
                    totalOperations: finalized.plan.releases.reduce((total, entry) => total + (entry.adapterPlan.operations?.length ?? 1), 0),
                    completedOperations: 0,
                    currentOperation: null,
                },
            };
        });
    }

    async listOperations(jobId) {
        this.#assertOpen();
        await this.#read(jobId);
        return this.coordinator.listJobOperations(jobId);
    }

    async recover(transactionResults = []) {
        const completed = new Map(transactionResults.filter((entry) => entry.jobId).map((entry) => [entry.jobId, entry]));
        const entries = (await fs.readdir(this.paths.jobs, { withFileTypes: true }))
            .sort((left, right) => compareUtf8(left.name, right.name));
        for (const entry of entries) {
            if (entry.isSymbolicLink() || !entry.isDirectory()) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace job store contains an unexpected node.");
            }
            const paths = jobPaths(this.paths, entry.name);
            const children = (await fs.readdir(paths.root)).sort(compareUtf8);
            if (children.join("\u0000") !== "snapshot.json\u0000work") {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace job directory is incomplete or ambiguous.");
            }
            const job = await this.#read(entry.name);
            const result = completed.get(job.jobId);
            if (result) {
                await this.#resetWork(job.jobId);
                if (job.phase !== "complete") await this.#complete(job.jobId, result);
                await this.coordinator.finish(result.transactionId);
                continue;
            }
            if (TERMINAL_PHASES.has(job.phase) || ["awaiting-confirmation", "needs-attention"].includes(job.phase)) continue;
            if (["commit", "recover"].includes(job.phase) && job.finalPlanHash) {
                await this.#update(job.jobId, () => ({ phase: "recover" }));
                this.#launch(() => this.#runCommit(job.jobId));
                continue;
            }
            await fs.rm(paths.work, { recursive: true, force: true });
            await ensureDirectory(paths.work);
            await this.#update(job.jobId, () => ({ phase: "recover", error: null }));
            this.#launch(() => this.#runPrecommit(job.jobId));
        }
    }

    async hasNonterminalSource(sourceId) {
        assertCanonicalUuid(sourceId, "sourceId");
        for (const entry of await fs.readdir(this.paths.jobs, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const job = await this.#read(entry.name);
            if (TERMINAL_PHASES.has(job.phase)) continue;
            const preflight = await this.planner.readPreflight(job.planHash);
            if (preflight.source.sourceId === sourceId) return true;
        }
        return false;
    }

    async close() {
        if (this.#closed) return;
        this.#closing = true;
        for (const controller of this.#controllers.values()) controller.abort();
        await Promise.allSettled([...this.#runs]);
        await Promise.allSettled([...this.#queues.values()]);
        this.#listeners.clear();
        this.#closed = true;
    }
}
