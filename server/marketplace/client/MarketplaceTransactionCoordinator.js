import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import {
    assertMarketplaceInstallReceipt,
    assertMarketplaceInstalled,
    hashMarketplaceDocument,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalUuid, assertMarketplaceId, assertReleaseVersion, assertSha256 } from "../MarketplaceFormats.js";
import {
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    removeDirectoryDurable,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";
import {
    MARKETPLACE_INSTALL_DOCUMENT_VERSION,
    MARKETPLACE_INSTALL_KINDS,
    assertInstallTransaction,
    installDocumentBytes,
    installedDocumentHash,
    parseInstallDocument,
} from "./MarketplaceInstallDocuments.js";

const JOURNAL_FILE = "journal.json";
const WRITES_DIRECTORY = "writes";
const INSTALLED_WRITE = "installed.json";

function transactionPaths(paths, transactionId) {
    assertCanonicalUuid(transactionId, "transactionId");
    const root = path.join(paths.transactions, transactionId);
    return Object.freeze({
        root,
        journal: path.join(root, JOURNAL_FILE),
        writes: path.join(root, WRITES_DIRECTORY),
        installed: path.join(root, WRITES_DIRECTORY, INSTALLED_WRITE),
    });
}

function receiptWrite(paths, receiptHash) {
    assertSha256(receiptHash, "receiptHash");
    return path.join(paths.writes, `receipt-${receiptHash}.json`);
}

function exactKey(reference) {
    return `${reference.itemId}\u0000${reference.releaseVersion}\u0000${reference.artifactSha256 ?? reference.artifact.sha256}`;
}

function exactRef(release) {
    return {
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifact.sha256,
    };
}

function dependencyClosure(release, releasesByKey) {
    const found = new Map();
    const visit = (current) => {
        for (const dependency of current.dependencies) {
            const resolved = releasesByKey.get(exactKey(dependency));
            if (!resolved) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Final marketplace plan has an incomplete dependency graph.");
            const key = exactKey(dependency);
            if (found.has(key)) continue;
            found.set(key, exactRef(resolved));
            visit(resolved);
        }
    };
    visit(release);
    return [...found.values()].sort((left, right) => compareUtf8(exactKey(left), exactKey(right)));
}

function installationKey(sourceId, release) {
    return `${sourceId}\u0000${exactKey(release)}`;
}

function recovery(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message);
}

export class MarketplaceTransactionCoordinator {
    #queue = Promise.resolve();

    constructor({
        paths,
        planner,
        installedStore,
        receiptStore,
        artifactStore,
        adapterRegistry,
        now = () => new Date(),
        fault = null,
    }) {
        this.paths = paths;
        this.planner = planner;
        this.installedStore = installedStore;
        this.receiptStore = receiptStore;
        this.artifactStore = artifactStore;
        this.adapterRegistry = adapterRegistry;
        this.now = now;
        this.fault = fault;
    }

    static async create(dataDir, dependencies) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.transactions);
        return new MarketplaceTransactionCoordinator({ paths, ...dependencies });
    }

    async prepareInstall(job, finalPlan) {
        const validated = await this.planner.revalidateFinalPlan(job.finalPlanHash);
        if (validated.preflightHash !== finalPlan.preflightHash) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Final marketplace plan changed before transaction preparation.");
        }
        const preflight = await this.planner.readPreflight(validated.preflightHash);
        const base = await this.installedStore.snapshot();
        if (base.revision !== validated.installedRevision) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Installed marketplace revision changed before commit.");
        }
        const installedAt = this.now().toISOString();
        const existing = new Map(base.installations.map((entry) => [installationKey(entry.sourceId, entry.release), entry]));
        const releasesByKey = new Map(validated.releases.map((entry) => [exactKey(entry.release), entry.release]));
        const preflightByKey = new Map(preflight.releases.map((entry) => [exactKey(entry.release), entry]));
        const receipts = [];
        const additions = [];
        for (const entry of validated.releases) {
            const release = entry.release;
            const key = installationKey(preflight.source.sourceId, release);
            if (existing.has(key)) continue;
            const dependencyLock = dependencyClosure(release, releasesByKey);
            const adapter = this.adapterRegistry.requireLifecycle(release.contentKind);
            const context = Object.freeze({
                source: preflight.source,
                installedAt,
                installed: base,
            });
            const contribution = await adapter.createReceipt({
                release,
                releaseHash: entry.releaseHash,
                dependencyLock,
                adapterPlan: entry.adapterPlan,
                installedAt,
                context,
            });
            const mappings = Array.isArray(contribution) ? contribution
                : contribution?.kind ? contribution.mappings
                    : contribution?.mappings;
            if (!Array.isArray(mappings)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Artifact adapter ${adapter.id} returned an invalid receipt contribution.`);
            }
            const receipt = assertMarketplaceInstallReceipt({
                kind: "cev-sim.marketplace-install-receipt",
                version: 1,
                sourceId: preflight.source.sourceId,
                registryId: preflight.source.registryId,
                release: exactRef(release),
                releaseHash: entry.releaseHash,
                installedAt,
                dependencyLock,
                mappings,
            });
            if (contribution?.kind) {
                const supplied = assertMarketplaceInstallReceipt(contribution);
                if (!Buffer.from(marketplaceDocumentBytes(supplied)).equals(Buffer.from(marketplaceDocumentBytes(receipt)))) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Artifact adapter ${adapter.id} changed receipt identity fields.`);
                }
            }
            const receiptHash = hashMarketplaceDocument(receipt);
            const history = await this.receiptStore.listForRelease({
                sourceId: preflight.source.sourceId,
                ...exactRef(release),
            });
            const receiptHashes = [...new Set([...history.filter((hash) => hash !== receiptHash), receiptHash])];
            receipts.push({ hash: receiptHash, document: receipt });
            additions.push({
                sourceId: preflight.source.sourceId,
                registryId: preflight.source.registryId,
                release: exactRef(release),
                receiptHashes,
                status: preflightByKey.get(exactKey(release))?.yanked ? "yanked" : "installed",
            });
        }
        const target = this.installedStore.prepareInstall(base, additions);
        const transactionId = randomUUID();
        const paths = transactionPaths(this.paths, transactionId);
        await ensureDirectory(paths.root);
        await ensureDirectory(paths.writes);
        await writeExclusiveDurable(paths.installed, marketplaceDocumentBytes(target));
        for (const receipt of receipts) {
            await writeExclusiveDurable(receiptWrite(paths, receipt.hash), marketplaceDocumentBytes(receipt.document));
        }
        const journal = assertInstallTransaction({
            kind: MARKETPLACE_INSTALL_KINDS.transaction,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            transactionId,
            jobId: job.jobId,
            operation: "install",
            finalPlanHash: job.finalPlanHash,
            installedBase: { revision: base.revision, sha256: installedDocumentHash(base) },
            installedTarget: { revision: target.revision, sha256: installedDocumentHash(target) },
            receiptHashes: receipts.map((entry) => entry.hash).sort(compareUtf8),
            adapterCommits: additions.map((addition) => {
                const entry = validated.releases.find((candidate) => exactKey(candidate.release) === exactKey(addition.release));
                return {
                    adapterId: entry.adapterId,
                    itemId: addition.release.itemId,
                    releaseVersion: addition.release.releaseVersion,
                    artifactSha256: addition.release.artifactSha256,
                };
            }),
        });
        await writeExclusiveDurable(paths.journal, installDocumentBytes(journal, assertInstallTransaction));
        try {
            await this.fault?.("after-journal", { journal });
        } catch (error) {
            error.marketplaceTransactionDurable = true;
            throw error;
        }
        return Object.freeze({ journal, paths, base, target, finalPlan: validated, preflight });
    }

    async #readPrepared(journal, paths) {
        const installedBytes = await readRegularBytes(paths.installed, { maxBytes: 16 * 1024 * 1024 });
        const target = assertMarketplaceInstalled(parseMarketplaceDocument(installedBytes));
        if (installedDocumentHash(target) !== journal.installedTarget.sha256
            || target.revision !== journal.installedTarget.revision
            || !Buffer.from(installedBytes).equals(Buffer.from(marketplaceDocumentBytes(target)))) {
            throw recovery("Marketplace transaction target ledger is invalid.");
        }
        const finalPlan = journal.finalPlanHash ? await this.planner.readFinalPlan(journal.finalPlanHash) : null;
        const preflight = finalPlan ? await this.planner.readPreflight(finalPlan.preflightHash) : null;
        return Object.freeze({ journal, paths, target, finalPlan, preflight });
    }

    async #publishReceipts(prepared) {
        for (const [index, receiptHash] of prepared.journal.receiptHashes.entries()) {
            const bytes = await readRegularBytes(receiptWrite(prepared.paths, receiptHash), { maxBytes: 16 * 1024 * 1024 });
            const receipt = assertMarketplaceInstallReceipt(parseMarketplaceDocument(bytes));
            const published = await this.receiptStore.publish(receipt);
            if (published.hash !== receiptHash) throw recovery("Marketplace transaction receipt hash is invalid.");
            await this.fault?.("after-receipt", { journal: prepared.journal, receiptHash, index });
        }
    }

    async #commitAdapters(prepared) {
        if (!prepared.finalPlan) return;
        const commits = new Map(prepared.journal.adapterCommits.map((entry) => [exactKey(entry), entry]));
        let index = 0;
        for (const entry of prepared.finalPlan.releases) {
            if (!commits.has(exactKey(entry.release))) continue;
            const adapter = this.adapterRegistry.requireLifecycle(entry.release.contentKind);
            if (adapter.id !== entry.adapterId) throw recovery("Marketplace transaction adapter identity changed.");
            const artifactHandle = await this.artifactStore.get(entry.release.artifact);
            if (!artifactHandle) throw recovery("Marketplace transaction artifact is unavailable.");
            await adapter.commit({
                release: entry.release,
                inspection: entry.inspection,
                adapterPlan: entry.adapterPlan,
                artifactHandle,
                transactionId: prepared.journal.transactionId,
                context: Object.freeze({ source: prepared.preflight.source }),
            });
            await this.fault?.("after-adapter-commit", { journal: prepared.journal, adapterId: adapter.id, index });
            index += 1;
        }
    }

    async #apply(prepared) {
        const current = await this.installedStore.snapshot();
        const currentHash = installedDocumentHash(current);
        if (currentHash !== prepared.journal.installedBase.sha256
            && currentHash !== prepared.journal.installedTarget.sha256) {
            throw recovery("Installed marketplace ledger matches neither transaction base nor target.");
        }
        await this.#publishReceipts(prepared);
        await this.#commitAdapters(prepared);
        if (currentHash === prepared.journal.installedBase.sha256) {
            await this.installedStore.commitTarget({ base: current, target: prepared.target });
            await this.fault?.("after-installed", { journal: prepared.journal });
        }
        return Object.freeze({
            transactionId: prepared.journal.transactionId,
            jobId: prepared.journal.jobId,
            receiptHashes: prepared.journal.receiptHashes,
            installedRevision: prepared.journal.installedTarget.revision,
        });
    }

    commit(prepared) {
        const operation = this.#queue.catch(() => {}).then(async () => {
            try {
                const result = await this.#apply(prepared);
                if (prepared.journal.jobId === null) await this.#finish(prepared.journal.transactionId, prepared.journal);
                return result;
            } catch (error) {
                error.marketplaceTransactionDurable = true;
                throw error;
            }
        });
        this.#queue = operation.catch(() => {});
        return operation;
    }

    install(job, finalPlan) {
        const operation = this.#queue.catch(() => {}).then(async () => {
            let prepared = null;
            try {
                prepared = await this.prepareInstall(job, finalPlan);
                return await this.#apply(prepared);
            } catch (error) {
                if (prepared) error.marketplaceTransactionDurable = true;
                throw error;
            }
        });
        this.#queue = operation.catch(() => {});
        return operation;
    }

    async #finish(transactionId, journal = null) {
        const paths = transactionPaths(this.paths, transactionId);
        if (await lstatOrNull(paths.root)) await removeDirectoryDurable(paths.root);
        await this.fault?.("after-cleanup", { journal });
    }

    finish(transactionId) {
        const operation = this.#queue.catch(() => {}).then(() => this.#finish(transactionId));
        this.#queue = operation.catch(() => {});
        return operation;
    }

    async recoverPending() {
        const results = [];
        const entries = (await fs.readdir(this.paths.transactions, { withFileTypes: true }))
            .sort((left, right) => compareUtf8(left.name, right.name));
        for (const entry of entries) {
            if (entry.isSymbolicLink() || !entry.isDirectory()) throw recovery("Marketplace transaction store contains an unexpected node.");
            const paths = transactionPaths(this.paths, entry.name);
            const children = await fs.readdir(paths.root);
            if (!children.includes(JOURNAL_FILE)) {
                await removeDirectoryDurable(paths.root);
                continue;
            }
            if (children.sort().join("\u0000") !== `${JOURNAL_FILE}\u0000${WRITES_DIRECTORY}`) {
                throw recovery("Marketplace transaction directory is ambiguous.");
            }
            const bytes = await readRegularBytes(paths.journal, { maxBytes: 1024 * 1024 });
            const journal = parseInstallDocument(bytes, assertInstallTransaction);
            if (journal.transactionId !== entry.name
                || !Buffer.from(bytes).equals(Buffer.from(installDocumentBytes(journal, assertInstallTransaction)))) {
                throw recovery("Marketplace transaction journal identity is invalid.");
            }
            const expectedWrites = [
                INSTALLED_WRITE,
                ...journal.receiptHashes.map((hash) => `receipt-${hash}.json`),
            ].sort(compareUtf8);
            const actualWrites = (await fs.readdir(paths.writes)).sort(compareUtf8);
            if (actualWrites.join("\u0000") !== expectedWrites.join("\u0000")) {
                throw recovery("Marketplace transaction staged writes are incomplete or ambiguous.");
            }
            const result = await this.#apply(await this.#readPrepared(journal, paths));
            if (journal.jobId === null) await this.#finish(journal.transactionId, journal);
            results.push(result);
        }
        return Object.freeze(results);
    }

    async reconcileCompleted(job) {
        if (!job.finalPlanHash) return null;
        const finalPlan = await this.planner.readFinalPlan(job.finalPlanHash);
        const preflight = await this.planner.readPreflight(finalPlan.preflightHash);
        const installed = await this.installedStore.snapshot();
        const installations = new Map(installed.installations.map((entry) => [
            installationKey(entry.sourceId, entry.release), entry,
        ]));
        const matched = finalPlan.releases.map((entry) => (
            installations.get(installationKey(preflight.source.sourceId, entry.release))
        ));
        if (matched.some((entry) => !entry)) return null;
        for (let index = 0; index < matched.length; index += 1) {
            const installation = matched[index];
            const planned = finalPlan.releases[index];
            if (installation.registryId !== preflight.source.registryId
                || !await this.artifactStore.get(planned.release.artifact)) {
                throw recovery("Installed marketplace membership failed its integrity check.");
            }
            let exactReceipt = false;
            for (const receiptHash of installation.receiptHashes) {
                const receipt = await this.receiptStore.read(receiptHash);
                if (receipt.releaseHash === planned.releaseHash
                    && isDeepStrictEqual(receipt.release, exactRef(planned.release))) exactReceipt = true;
            }
            if (!exactReceipt) throw recovery("Installed marketplace membership has no matching immutable receipt.");
        }
        return Object.freeze({
            jobId: job.jobId,
            receiptHashes: [...new Set(matched.flatMap((entry) => entry.receiptHashes))].sort(compareUtf8),
            installedRevision: installed.revision,
        });
    }

    async removeMembership(request) {
        assertCanonicalUuid(request.sourceId, "sourceId");
        assertMarketplaceId(request.itemId, "itemId");
        assertReleaseVersion(request.releaseVersion, "releaseVersion");
        assertSha256(request.artifactSha256, "artifactSha256");
        if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "expectedRevision must be a non-negative integer.");
        }
        const base = await this.installedStore.snapshot();
        const target = this.installedStore.prepareRemoval(base, request);
        const transactionId = randomUUID();
        const paths = transactionPaths(this.paths, transactionId);
        await ensureDirectory(paths.root);
        await ensureDirectory(paths.writes);
        await writeExclusiveDurable(paths.installed, marketplaceDocumentBytes(target));
        const journal = assertInstallTransaction({
            kind: MARKETPLACE_INSTALL_KINDS.transaction,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            transactionId,
            jobId: null,
            operation: "remove-membership",
            finalPlanHash: null,
            installedBase: { revision: base.revision, sha256: installedDocumentHash(base) },
            installedTarget: { revision: target.revision, sha256: installedDocumentHash(target) },
            receiptHashes: [],
            adapterCommits: [],
        });
        await writeExclusiveDurable(paths.journal, installDocumentBytes(journal, assertInstallTransaction));
        await this.fault?.("after-journal", { journal });
        return this.commit(Object.freeze({ journal, paths, base, target, finalPlan: null, preflight: null }));
    }

    async close() {
        await this.#queue;
    }
}
