import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { signMarketplaceRelease } from "../PublisherSignatures.js";
import { marketplaceDocumentBytes } from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalTimestamp, assertCanonicalUuid, assertMarketplaceId, assertReleaseVersion, assertSha256 } from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import {
    atomicReplaceDurable,
    ensureDirectory,
    hashRegularFile,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";
import { MarketplacePublisherClient } from "./MarketplacePublisherClient.js";
import { fsyncDir } from "../../storage/visual-assets/atomicFs.js";

const JOB_KIND = "cev-sim.marketplace-publish-job";
const JOURNAL_KIND = "cev-sim.marketplace-publish-journal";
const VERSION = 1;
const TERMINAL_PHASES = new Set(["complete", "cancelled"]);
const REMOTE_PHASES = new Set(["publish-artifacts", "publish-previews", "publish-items", "sign-releases", "publish-releases", "refresh"]);
const JOB_PHASES = new Set([
    "queued", "build", "inspect", "awaiting-confirmation", "publish-artifacts", "publish-previews",
    "publish-items", "sign-releases", "publish-releases", "refresh", "needs-attention", "failed", "cancelled", "complete",
]);

function jobPaths(paths, jobId) {
    if (!/^[a-f0-9-]{36}$/u.test(jobId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publish job ID is invalid.");
    const root = path.join(paths.publicationJobs, jobId);
    const work = path.join(root, "work");
    return Object.freeze({ root, snapshot: path.join(root, "snapshot.json"), journal: path.join(root, "journal.json"), work, artifacts: path.join(work, "artifacts") });
}

function conflict(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function sanitizedError(error) {
    const code = error instanceof MarketplaceError ? error.code : MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED;
    const messages = {
        [MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE]: "Marketplace registry is unavailable.",
        [MARKETPLACE_ERROR_CODES.AUTHENTICATION_REQUIRED]: "Publisher authentication failed.",
        [MARKETPLACE_ERROR_CODES.RIGHTS_DENIED]: "Publisher credentials do not authorize this operation.",
        [MARKETPLACE_ERROR_CODES.CONFLICT]: "Registry or local publication state changed.",
        [MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID]: "Registry rejected the publication document.",
        [MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID]: "Publisher signing key is invalid.",
        [MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH]: "Published bytes do not match the prepared plan.",
        [MARKETPLACE_ERROR_CODES.CANCELLED]: "Marketplace publication was cancelled.",
    };
    return Object.freeze({ code, message: messages[code] ?? "Marketplace publication requires attention." });
}

function exactObject(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, `Marketplace publication ${label} is invalid.`);
    }
}

function assertProgress(value) {
    exactObject(value, ["operationsTotal", "operationsComplete", "bytesTotal", "bytesComplete", "currentOperation"], "job progress");
    for (const key of ["operationsTotal", "operationsComplete", "bytesTotal", "bytesComplete"]) {
        if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication progress is invalid.");
    }
    if (value.operationsComplete > value.operationsTotal || value.bytesComplete > value.bytesTotal) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication progress exceeds its totals.");
    if (value.currentOperation !== null) assertSha256(value.currentOperation, "currentOperation");
}

function assertJobDocument(value) {
    exactObject(value, ["kind", "version", "jobId", "revision", "phase", "createdAt", "updatedAt", "planHash", "finalPlanHash", "rootDraftId", "progress", "error", "warning", "published"], "job");
    if (value.kind !== JOB_KIND || value.version !== VERSION || !JOB_PHASES.has(value.phase) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication job contract is invalid.");
    assertCanonicalUuid(value.jobId, "jobId");
    assertCanonicalUuid(value.rootDraftId, "rootDraftId");
    assertCanonicalTimestamp(value.createdAt, "createdAt");
    assertCanonicalTimestamp(value.updatedAt, "updatedAt");
    assertSha256(value.planHash, "planHash");
    assertSha256(value.finalPlanHash, "finalPlanHash");
    assertProgress(value.progress);
    if (value.error !== null) {
        exactObject(value.error, ["code", "message"], "job error");
        if (typeof value.error.code !== "string" || typeof value.error.message !== "string") throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication job error is invalid.");
    }
    if (value.warning !== null && typeof value.warning !== "string") throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication job warning is invalid.");
    if (!Array.isArray(value.published) || Object.keys(value.published).length !== value.published.length) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication results are invalid.");
    const identities = new Set();
    for (const entry of value.published) {
        exactObject(entry, ["itemId", "releaseVersion", "artifactSha256"], "published release");
        assertMarketplaceId(entry.itemId, "itemId");
        assertReleaseVersion(entry.releaseVersion, "releaseVersion");
        assertSha256(entry.artifactSha256, "artifactSha256");
        const identity = `${entry.itemId}@${entry.releaseVersion}`;
        if (identities.has(identity)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication results contain a duplicate release.");
        identities.add(identity);
    }
    return value;
}

function assertJournalDocument(value) {
    exactObject(value, ["kind", "version", "jobId", "revision", "completions"], "journal");
    if (value.kind !== JOURNAL_KIND || value.version !== VERSION || !Number.isSafeInteger(value.revision) || value.revision < 0
        || !Array.isArray(value.completions) || Object.keys(value.completions).length !== value.completions.length || value.revision !== value.completions.length) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication journal contract is invalid.");
    }
    assertCanonicalUuid(value.jobId, "jobId");
    const operations = new Set();
    for (const completion of value.completions) {
        exactObject(completion, ["operationId", "kind", "completedAt", "summary"], "journal completion");
        assertSha256(completion.operationId, "operationId");
        if (!["publish-artifact", "publish-preview", "publish-item", "publish-release"].includes(completion.kind) || operations.has(completion.operationId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication journal operation is invalid.");
        operations.add(completion.operationId);
        assertCanonicalTimestamp(completion.completedAt, "completedAt");
        exactObject(completion.summary, ["itemId", "releaseVersion", "artifactSha256", "sizeBytes", "registryRevision"], "journal summary");
        assertMarketplaceId(completion.summary.itemId, "itemId");
        assertReleaseVersion(completion.summary.releaseVersion, "releaseVersion");
        assertSha256(completion.summary.artifactSha256, "artifactSha256");
        if (!Number.isSafeInteger(completion.summary.sizeBytes) || completion.summary.sizeBytes < 0
            || (completion.summary.registryRevision !== null && (!Number.isSafeInteger(completion.summary.registryRevision) || completion.summary.registryRevision < 0))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication journal summary is invalid.");
        }
    }
    return value;
}

async function readCanonical(filePath, expectedKind, maxBytes = 16 * 1024 * 1024) {
    let bytes;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
            bytes = await readRegularBytes(filePath, { maxBytes });
            break;
        } catch (error) {
            const atomicReplaceRace = error instanceof MarketplaceError
                && error.code === MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED
                && error.message.includes("Visual asset path changed while opening it.");
            if (!atomicReplaceRace || attempt === 3) throw error;
        }
    }
    const { document } = parseMarketplaceJsonBytes(bytes);
    if (document?.kind !== expectedKind || document.version !== VERSION || !Buffer.from(canonicalMarketplaceBytes(document)).equals(bytes)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace publication job state is invalid.");
    }
    return expectedKind === JOB_KIND ? assertJobDocument(document) : assertJournalDocument(document);
}

function phaseFor(kind) {
    if (kind === "publish-artifact") return "publish-artifacts";
    if (kind === "publish-preview") return "publish-previews";
    if (kind === "publish-item") return "publish-items";
    return "publish-releases";
}

export class MarketplacePublishJobManager {
    #listeners = new Map();
    #queues = new Map();
    #runs = new Set();
    #controllers = new Map();
    #closed = false;

    constructor({
        paths, planner, profileStore, secretStore, sourceStore, credentialStore, draftStore,
        fetchImpl = globalThis.fetch, now = () => new Date(), refreshSource = null,
    }) {
        this.paths = paths;
        this.planner = planner;
        this.profileStore = profileStore;
        this.secretStore = secretStore;
        this.sourceStore = sourceStore;
        this.credentialStore = credentialStore;
        this.draftStore = draftStore;
        this.fetchImpl = fetchImpl;
        this.now = now;
        this.refreshSource = refreshSource;
    }

    static async create(dataDir, dependencies) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.publicationJobs);
        return new MarketplacePublishJobManager({ paths, ...dependencies });
    }

    setRefreshSource(operation) {
        this.refreshSource = operation;
    }

    #assertOpen() {
        if (this.#closed) throw marketplaceError(MARKETPLACE_ERROR_CODES.CANCELLED, "Marketplace publisher is closed.");
    }

    async #readJob(jobId) {
        const filePath = jobPaths(this.paths, jobId).snapshot;
        if (!await lstatOrNull(filePath)) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publish job was not found.");
        const job = await readCanonical(filePath, JOB_KIND);
        if (job.jobId !== jobId) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publish job identity is invalid.");
        return job;
    }

    async #readJournal(jobId) {
        return readCanonical(jobPaths(this.paths, jobId).journal, JOURNAL_KIND);
    }

    async #verifyJobArtifacts(job, plan) {
        for (const publication of plan.entries) {
            const operation = publication.operations.find((candidate) => candidate.kind === "publish-artifact");
            const filePath = path.join(jobPaths(this.paths, job.jobId).artifacts, operation.operationId);
            const identity = await hashRegularFile(filePath, publication.release.artifact.sizeBytes);
            if (identity.sha256 !== publication.release.artifact.sha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Prepared publication job artifact is missing or changed.");
            }
        }
    }

    #verifyJournalAgainstPlan(job, plan, journal) {
        if (journal.jobId !== job.jobId || job.rootDraftId !== plan.rootDraftId) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication job identity disagrees with its plan or journal.");
        const operations = new Map(plan.entries.flatMap((entry) => entry.operations.map((operation) => [operation.operationId, operation.kind])));
        const operationCount = operations.size;
        const totalBytes = plan.totalBytes;
        if (job.progress.operationsTotal !== operationCount || job.progress.bytesTotal !== totalBytes) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication job totals disagree with its plan.");
        for (const completion of journal.completions) {
            if (operations.get(completion.operationId) !== completion.kind) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication journal completion is not part of its plan.");
        }
    }

    #notify(job) {
        for (const listener of this.#listeners.get(job.jobId) ?? []) {
            try { listener(job); } catch { /* UI subscribers cannot change durable publication state. */ }
        }
    }

    #update(jobId, transform) {
        const previous = this.#queues.get(jobId) ?? Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
            const current = await this.#readJob(jobId);
            const patch = await transform(current);
            if (!patch) return current;
            const next = {
                ...current,
                ...patch,
                revision: current.revision + 1,
                updatedAt: this.now().toISOString(),
            };
            await atomicReplaceDurable(jobPaths(this.paths, jobId).snapshot, canonicalMarketplaceBytes(next));
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

    async #setDraftStates(plan, state) {
        for (const entry of plan.entries) {
            const draft = this.draftStore.get(entry.draftId);
            if (draft && draft.state !== state) {
                await this.draftStore.update(entry.draftId, { state }, draft.revision).catch(() => {});
            }
        }
    }

    async start(planHash) {
        this.#assertOpen();
        const plan = await this.planner.readPlan(planHash);
        const jobId = randomUUID();
        const paths = jobPaths(this.paths, jobId);
        try {
            await ensureDirectory(paths.root);
            await ensureDirectory(paths.artifacts);
            for (const entry of plan.entries) {
                const operation = entry.operations.find((candidate) => candidate.kind === "publish-artifact");
                const source = this.planner.artifactPath(planHash, entry.artifactFile);
                const destination = path.join(paths.artifacts, operation.operationId);
                await fs.link(source, destination);
                await fs.chmod(destination, 0o600);
            }
            await fsyncDir(paths.artifacts);
            const timestamp = this.now().toISOString();
            const operationCount = plan.entries.reduce((total, entry) => total + entry.operations.length, 0);
            const job = {
                kind: JOB_KIND,
                version: VERSION,
                jobId,
                revision: 0,
                phase: "awaiting-confirmation",
                createdAt: timestamp,
                updatedAt: timestamp,
                planHash,
                finalPlanHash: planHash,
                rootDraftId: plan.rootDraftId,
                progress: { operationsTotal: operationCount, operationsComplete: 0, bytesTotal: plan.totalBytes, bytesComplete: 0, currentOperation: null },
                error: null,
                warning: null,
                published: [],
            };
            const journal = { kind: JOURNAL_KIND, version: VERSION, jobId, revision: 0, completions: [] };
            await writeExclusiveDurable(paths.snapshot, canonicalMarketplaceBytes(job));
            await writeExclusiveDurable(paths.journal, canonicalMarketplaceBytes(journal));
            return job;
        } catch (error) {
            await fs.rm(paths.root, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
    }

    snapshot(jobId) { this.#assertOpen(); return this.#readJob(jobId); }

    subscribe(jobId, listener, { emitCurrent = true } = {}) {
        this.#assertOpen();
        const listeners = this.#listeners.get(jobId) ?? new Set();
        let revision = -1;
        const ordered = (job) => { if (job.revision > revision) { revision = job.revision; listener(job); } };
        listeners.add(ordered);
        this.#listeners.set(jobId, listeners);
        if (emitCurrent) this.#readJob(jobId).then(ordered).catch(() => {});
        return () => { listeners.delete(ordered); if (!listeners.size) this.#listeners.delete(jobId); };
    }

    async commit(jobId, { expectedRevision, finalPlanHash }) {
        const current = await this.#readJob(jobId);
        if (current.revision !== expectedRevision) throw conflict("Publish job revision changed.");
        if (current.phase !== "awaiting-confirmation") throw conflict("Publish job is not awaiting confirmation.");
        if (current.finalPlanHash !== finalPlanHash) throw conflict("Publish plan changed before confirmation.");
        const next = await this.#update(jobId, () => ({ phase: "publish-artifacts", error: null }));
        await this.#setDraftStates(await this.planner.readPlan(current.planHash), "publishing");
        this.#launch(() => this.#run(jobId));
        return next;
    }

    async cancel(jobId, expectedRevision) {
        const current = await this.#readJob(jobId);
        if (current.revision !== expectedRevision) throw conflict("Publish job revision changed.");
        if (current.phase !== "awaiting-confirmation") throw conflict("Committed publication jobs cannot be cancelled.");
        return this.#update(jobId, () => ({ phase: "cancelled", error: null }));
    }

    async resume(jobId, expectedRevision) {
        const current = await this.#readJob(jobId);
        if (current.revision !== expectedRevision) throw conflict("Publish job revision changed.");
        if (!new Set(["needs-attention", "failed"]).has(current.phase)) throw conflict("Publish job is not resumable.");
        const next = await this.#update(jobId, () => ({ phase: "publish-artifacts", error: null }));
        this.#launch(() => this.#run(jobId));
        return next;
    }

    async replan(jobId, expectedRevision) {
        const current = await this.#readJob(jobId);
        if (current.revision !== expectedRevision) throw conflict("Publish job revision changed.");
        const journal = await this.#readJournal(jobId);
        if (journal.completions.length) throw conflict("A partially published job cannot be replanned.");
        if (!new Set(["needs-attention", "failed", "awaiting-confirmation"]).has(current.phase)) throw conflict("Publish job cannot be replanned in its current phase.");
        const oldPlan = await this.planner.readPlan(current.planHash);
        const draft = this.draftStore.get(oldPlan.rootDraftId);
        if (!draft) throw conflict("Root publication draft no longer exists.");
        const plan = await this.planner.createPlan({ draftId: draft.draftId, draftRevision: draft.revision });
        const replacement = await this.start(plan.planHash);
        await this.#update(jobId, () => ({ phase: "cancelled", error: null, warning: `Replanned as job ${replacement.jobId}.` }));
        return replacement;
    }

    async operations(jobId, { offset = 0, limit = 100, status = null } = {}) {
        const job = await this.#readJob(jobId);
        const plan = await this.planner.readPlan(job.planHash);
        const journal = await this.#readJournal(jobId);
        const completed = new Map(journal.completions.map((entry) => [entry.operationId, entry]));
        let entries = plan.entries.flatMap((publication) => publication.operations.map((operation) => ({
            ...operation,
            draftId: publication.draftId,
            itemId: publication.item.itemId,
            releaseVersion: publication.release.releaseVersion,
            status: completed.has(operation.operationId) ? "complete" : "pending",
            completedAt: completed.get(operation.operationId)?.completedAt ?? null,
        })));
        if (status) entries = entries.filter((entry) => entry.status === status);
        const resolvedOffset = Number(offset);
        const resolvedLimit = Number(limit);
        if (!Number.isSafeInteger(resolvedOffset) || resolvedOffset < 0 || !Number.isSafeInteger(resolvedLimit) || resolvedLimit < 1 || resolvedLimit > 500) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publish operation pagination is invalid.");
        }
        return { total: entries.length, offset: resolvedOffset, limit: resolvedLimit, entries: entries.slice(resolvedOffset, resolvedOffset + resolvedLimit) };
    }

    async hasReference({ profileId = null, draftId = null } = {}) {
        if (!profileId && !draftId) throw new TypeError("A publication job reference target is required.");
        for (const entry of await fs.readdir(this.paths.publicationJobs, { withFileTypes: true })) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const job = await this.#readJob(entry.name);
            if (TERMINAL_PHASES.has(job.phase)) continue;
            const plan = await this.planner.readPlan(job.planHash);
            if (profileId && plan.profile.profileId === profileId) return true;
            if (draftId && plan.entries.some((publication) => publication.draftId === draftId)) return true;
        }
        return false;
    }

    async #complete(jobId, operation, summary) {
        const paths = jobPaths(this.paths, jobId);
        const journal = await this.#readJournal(jobId);
        if (journal.completions.some((entry) => entry.operationId === operation.operationId)) return journal;
        const next = {
            ...journal,
            revision: journal.revision + 1,
            completions: [...journal.completions, {
                operationId: operation.operationId,
                kind: operation.kind,
                completedAt: this.now().toISOString(),
                summary,
            }],
        };
        await atomicReplaceDurable(paths.journal, canonicalMarketplaceBytes(next));
        const transferredBytes = operation.kind === "publish-artifact"
            ? summary.sizeBytes
            : operation.kind === "publish-preview" ? summary.sizeBytes : 0;
        await this.#update(jobId, (job) => ({
            progress: {
                ...job.progress,
                operationsComplete: next.completions.length,
                bytesComplete: Math.min(job.progress.bytesTotal, job.progress.bytesComplete + transferredBytes),
                currentOperation: null,
            },
        }));
        return next;
    }

    async #client(plan) {
        const profile = this.profileStore.get(plan.profile.profileId);
        if (!profile || profile.revision !== plan.profile.profileRevision || profile.keyId !== plan.profile.keyId) throw conflict("Publisher profile changed after preparation.");
        const source = this.sourceStore.get(plan.source.sourceId);
        if (!source || source.registryId !== plan.source.registryId || source.baseUrl !== plan.source.baseUrl
            || source.trustedRootFingerprint !== plan.source.trustedRootFingerprint) throw conflict("Publisher source changed after preparation.");
        const secret = await this.secretStore.read(profile.secretRef);
        const transportCredential = await this.credentialStore.readCredential(source.credentialRef);
        return {
            client: new MarketplacePublisherClient({ baseUrl: source.baseUrl, writeToken: secret.writeToken, transportCredential, fetchImpl: this.fetchImpl }),
            privateKeyPem: secret.privateKeyPem,
            source,
        };
    }

    async #run(jobId) {
        const controller = new AbortController();
        this.#controllers.set(jobId, controller);
        try {
            const job = await this.#readJob(jobId);
            const plan = await this.planner.readPlan(job.planHash);
            const { client, privateKeyPem, source } = await this.#client(plan);
            let journal = await this.#readJournal(jobId);
            this.#verifyJournalAgainstPlan(job, plan, journal);
            await this.#update(jobId, (current) => ({ progress: {
                ...current.progress,
                operationsComplete: journal.completions.length,
                bytesComplete: Math.min(current.progress.bytesTotal, journal.completions.reduce((sum, completion) => sum
                    + (["publish-artifact", "publish-preview"].includes(completion.kind) ? completion.summary.sizeBytes : 0), 0)),
                currentOperation: null,
            } }));
            const done = () => new Set(journal.completions.map((entry) => entry.operationId));
            for (const publication of plan.entries) {
                for (const operation of publication.operations) {
                    if (done().has(operation.operationId)) continue;
                    await this.#update(jobId, (current) => ({ phase: phaseFor(operation.kind), progress: { ...current.progress, currentOperation: operation.operationId } }));
                    let result;
                    if (operation.kind === "publish-artifact") {
                        const filePath = path.join(jobPaths(this.paths, jobId).artifacts, operation.operationId);
                        const identity = await hashRegularFile(filePath, publication.release.artifact.sizeBytes);
                        if (identity.sha256 !== publication.release.artifact.sha256) throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Prepared publication artifact changed.");
                        result = await client.publishArtifact(publication.contentKind, createReadStream(filePath), publication.release.artifact, { signal: controller.signal });
                        if (result.descriptor?.sha256 !== publication.release.artifact.sha256 || result.descriptor?.sizeBytes !== publication.release.artifact.sizeBytes) {
                            throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Registry artifact response does not match the prepared plan.");
                        }
                    } else if (operation.kind === "publish-preview") {
                        const preview = publication.item.previews.find((entry) => entry.sha256 === operation.sha256);
                        const filePath = this.planner.previewPath(preview.sha256);
                        const identity = await hashRegularFile(filePath, preview.sizeBytes);
                        if (identity.sha256 !== preview.sha256) throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Prepared preview changed.");
                        result = await client.publishPreview(createReadStream(filePath), preview, { signal: controller.signal });
                        if (result.descriptor?.sha256 !== preview.sha256 || result.descriptor?.sizeBytes !== preview.sizeBytes) {
                            throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Registry preview response does not match the prepared plan.");
                        }
                    } else if (operation.kind === "publish-item") {
                        result = await client.publishItem(marketplaceDocumentBytes(publication.item), { signal: controller.signal });
                    } else {
                        await this.#update(jobId, (current) => ({ phase: "sign-releases", progress: { ...current.progress, currentOperation: operation.operationId } }));
                        const signed = signMarketplaceRelease(publication.release, privateKeyPem, { keyId: plan.profile.keyId });
                        result = await client.publishRelease(signed.bytes, { track: publication.track, signal: controller.signal });
                    }
                    journal = await this.#complete(jobId, operation, {
                        itemId: publication.item.itemId,
                        releaseVersion: publication.release.releaseVersion,
                        artifactSha256: publication.release.artifact.sha256,
                        sizeBytes: operation.kind === "publish-artifact"
                            ? publication.release.artifact.sizeBytes
                            : operation.kind === "publish-preview" ? publication.item.previews.find((entry) => entry.sha256 === operation.sha256).sizeBytes : 0,
                        registryRevision: result.revision ?? null,
                    });
                }
            }
            await this.#update(jobId, () => ({ phase: "refresh" }));
            let warning = null;
            try { await this.refreshSource?.(source.sourceId); } catch { warning = "Publication succeeded, but the local verified catalog could not be refreshed."; }
            const published = plan.entries.map((entry) => ({
                itemId: entry.item.itemId,
                releaseVersion: entry.release.releaseVersion,
                artifactSha256: entry.release.artifact.sha256,
            }));
            await this.#update(jobId, () => ({ phase: "complete", error: null, warning, published }));
            await this.#setDraftStates(plan, "published");
        } catch (error) {
            const journal = await this.#readJournal(jobId).catch(() => ({ completions: [] }));
            const job = await this.#readJob(jobId).catch(() => null);
            const plan = job ? await this.planner.readPlan(job.planHash).catch(() => null) : null;
            if (plan) await this.#setDraftStates(plan, "needs-attention");
            await this.#update(jobId, (current) => TERMINAL_PHASES.has(current.phase) ? null : ({
                phase: journal.completions.length ? "needs-attention" : "failed",
                error: sanitizedError(error),
                progress: { ...current.progress, currentOperation: null },
            })).catch(() => {});
        } finally {
            this.#controllers.delete(jobId);
        }
    }

    async recover() {
        await ensureDirectory(this.paths.publicationJobs);
        for (const entry of await fs.readdir(this.paths.publicationJobs, { withFileTypes: true })) {
            const root = path.join(this.paths.publicationJobs, entry.name);
            if (!entry.isDirectory() || entry.isSymbolicLink()) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication jobs directory contains a hostile node.");
            const job = await this.#readJob(entry.name);
            const journal = await this.#readJournal(entry.name);
            const plan = await this.planner.readPlan(job.planHash);
            this.#verifyJournalAgainstPlan(job, plan, journal);
            if (!TERMINAL_PHASES.has(job.phase)) await this.#verifyJobArtifacts(job, plan);
            if (REMOTE_PHASES.has(job.phase)) this.#launch(() => this.#run(entry.name));
        }
    }

    async close() {
        if (this.#closed) return;
        this.#closed = true;
        for (const controller of this.#controllers.values()) controller.abort();
        await Promise.allSettled([...this.#runs, ...this.#queues.values()]);
    }
}

export const MARKETPLACE_PUBLISH_JOB_PHASES = Object.freeze([
    ...JOB_PHASES,
]);
