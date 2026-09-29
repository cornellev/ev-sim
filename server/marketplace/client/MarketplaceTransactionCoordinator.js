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
import { canonicalMarketplaceBytes, hashMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import {
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    removeDirectoryDurable,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";
import {
    assertInstallOwnership,
    installOwnershipBytes,
    installOwnershipHash,
} from "./MarketplaceInstallOwnershipStore.js";
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
const COMPLETIONS_DIRECTORY = "completions";
const INSTALLED_WRITE = "installed.json";
const OWNERSHIP_WRITE = "ownership.json";

function transactionPaths(paths, transactionId) {
    assertCanonicalUuid(transactionId, "transactionId");
    const root = path.join(paths.transactions, transactionId);
    return Object.freeze({
        root,
        journal: path.join(root, JOURNAL_FILE),
        writes: path.join(root, WRITES_DIRECTORY),
        installed: path.join(root, WRITES_DIRECTORY, INSTALLED_WRITE),
        ownership: path.join(root, WRITES_DIRECTORY, OWNERSHIP_WRITE),
        completions: path.join(root, COMPLETIONS_DIRECTORY),
    });
}

function operationCompletionPath(paths, operationId) {
    assertSha256(operationId, "operationId");
    return path.join(paths.completions, `${operationId}.json`);
}

function operationHash(operation) {
    return hashMarketplaceBytes(canonicalMarketplaceBytes(operation));
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
        ownershipStore,
        receiptStore,
        artifactStore,
        adapterRegistry,
        provenanceStore = null,
        now = () => new Date(),
        fault = null,
    }) {
        this.paths = paths;
        this.planner = planner;
        this.installedStore = installedStore;
        this.ownershipStore = ownershipStore;
        this.receiptStore = receiptStore;
        this.artifactStore = artifactStore;
        this.adapterRegistry = adapterRegistry;
        this.provenanceStore = provenanceStore;
        this.now = now;
        this.fault = fault;
    }

    static async create(dataDir, dependencies) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.transactions);
        return new MarketplaceTransactionCoordinator({ paths, ...dependencies });
    }

    async prepareInstall(job, finalPlan) {
        const workDirectory = path.join(this.paths.jobs, job.jobId, "work");
        const validated = await this.planner.revalidateFinalPlan(job.finalPlanHash, { workDirectory });
        if (validated.preflightHash !== finalPlan.preflightHash) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Final marketplace plan changed before transaction preparation.");
        }
        const preflight = await this.planner.readPreflight(validated.preflightHash);
        const base = await this.installedStore.snapshot();
        const ownershipBase = await this.ownershipStore.snapshot();
        this.ownershipStore.verifyAgainstInstalled(ownershipBase, base);
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
            if (entry.disposition === "artifact-only") continue;
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
        const ownershipMemberships = validated.releases
            .filter((entry) => entry.disposition !== "artifact-only")
            .map((entry) => ({
                sourceId: preflight.source.sourceId,
                registryId: preflight.source.registryId,
                release: exactRef(entry.release),
                owners: structuredClone(entry.owners ?? [{ kind: "direct" }]),
            }));
        const ownershipCollections = validated.releases
            .filter((entry) => entry.disposition === "collection")
            .map((entry) => ({
                sourceId: preflight.source.sourceId,
                registryId: preflight.source.registryId,
                release: exactRef(entry.release),
                members: structuredClone(entry.adapterPlan.collection?.members ?? []),
            }));
        const ownershipTarget = this.ownershipStore.prepareInstall(ownershipBase, {
            memberships: ownershipMemberships,
            collections: ownershipCollections,
        });
        const target = this.installedStore.prepareInstall(base, additions, {
            forceRevision: ownershipTarget.revision !== ownershipBase.revision,
        });
        if (target.revision !== ownershipTarget.revision) throw recovery("Marketplace installed and ownership targets have different revisions.");
        const transactionId = randomUUID();
        const paths = transactionPaths(this.paths, transactionId);
        await ensureDirectory(paths.root);
        await ensureDirectory(paths.writes);
        await ensureDirectory(paths.completions);
        await writeExclusiveDurable(paths.installed, marketplaceDocumentBytes(target));
        await writeExclusiveDurable(paths.ownership, installOwnershipBytes(ownershipTarget));
        for (const receipt of receipts) {
            await writeExclusiveDurable(receiptWrite(paths, receipt.hash), marketplaceDocumentBytes(receipt.document));
        }
        const adapterOperations = additions.flatMap((addition) => {
            const entry = validated.releases.find((candidate) => exactKey(candidate.release) === exactKey(addition.release));
            const operations = entry.adapterPlan.operations?.length ? entry.adapterPlan.operations : [{
                operationId: hashMarketplaceBytes(canonicalMarketplaceBytes({
                    adapterId: entry.adapterId,
                    release: exactRef(entry.release),
                    kind: "commit-adapter",
                })),
                kind: "commit-adapter",
            }];
            const owningCollections = (entry.owners ?? [])
                .filter((owner) => owner.kind === "collection")
                .map((owner) => exactKey(owner.collection));
            return operations.map((operation) => ({
                operationId: operation.operationId,
                operationHash: operationHash(operation),
                adapterId: entry.adapterId,
                itemId: addition.release.itemId,
                releaseVersion: addition.release.releaseVersion,
                artifactSha256: addition.release.artifactSha256,
                disposition: entry.disposition ?? "requested",
                owners: structuredClone(entry.owners ?? [{ kind: "direct" }]),
                collectionGroups: owningCollections.map((collectionKey) => {
                    const collection = validated.releases.find((candidate) => exactKey(candidate.release) === collectionKey);
                    return collection?.adapterPlan.collection?.members.find((member) => exactKey(member.release) === exactKey(addition.release))?.group ?? null;
                }),
            }));
        });
        const journal = assertInstallTransaction({
            kind: MARKETPLACE_INSTALL_KINDS.transaction,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            transactionId,
            jobId: job.jobId,
            operation: "install",
            finalPlanHash: job.finalPlanHash,
            installedBase: { revision: base.revision, sha256: installedDocumentHash(base) },
            installedTarget: { revision: target.revision, sha256: installedDocumentHash(target) },
            ownershipBase: { revision: ownershipBase.revision, sha256: installOwnershipHash(ownershipBase) },
            ownershipTarget: { revision: ownershipTarget.revision, sha256: installOwnershipHash(ownershipTarget) },
            receiptHashes: receipts.map((entry) => entry.hash).sort(compareUtf8),
            adapterCommits: additions.map((addition) => {
                const entry = validated.releases.find((candidate) => exactKey(candidate.release) === exactKey(addition.release));
                return {
                    adapterId: entry.adapterId,
                    itemId: addition.release.itemId,
                    releaseVersion: addition.release.releaseVersion,
                    artifactSha256: addition.release.artifactSha256,
                    receiptHash: receipts.find((receipt) => receipt.document.release.itemId === addition.release.itemId
                        && receipt.document.release.releaseVersion === addition.release.releaseVersion
                        && receipt.document.release.artifactSha256 === addition.release.artifactSha256).hash,
                };
            }),
            adapterOperations,
        });
        await writeExclusiveDurable(paths.journal, installDocumentBytes(journal, assertInstallTransaction));
        try {
            await this.fault?.("after-journal", { journal });
        } catch (error) {
            error.marketplaceTransactionDurable = true;
            throw error;
        }
        return Object.freeze({ journal, paths, base, target, ownershipBase, ownershipTarget, finalPlan: validated, preflight });
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
        let ownershipTarget = null;
        if (journal.ownershipTarget) {
            const ownershipBytes = await readRegularBytes(paths.ownership, { maxBytes: 16 * 1024 * 1024 });
            const { document } = parseMarketplaceJsonBytes(ownershipBytes);
            ownershipTarget = assertInstallOwnership(document);
            if (installOwnershipHash(ownershipTarget) !== journal.ownershipTarget.sha256
                || ownershipTarget.revision !== journal.ownershipTarget.revision
                || !Buffer.from(ownershipBytes).equals(Buffer.from(installOwnershipBytes(ownershipTarget)))) {
                throw recovery("Marketplace transaction target ownership ledger is invalid.");
            }
        }
        return Object.freeze({ journal, paths, target, ownershipTarget, finalPlan, preflight });
    }

    async #preparedTransactionForJob(job) {
        const matches = [];
        for (const entry of (await fs.readdir(this.paths.transactions, { withFileTypes: true }))
            .sort((left, right) => compareUtf8(left.name, right.name))) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const paths = transactionPaths(this.paths, entry.name);
            if (!await lstatOrNull(paths.journal)) continue;
            const bytes = await readRegularBytes(paths.journal, { maxBytes: 1024 * 1024 });
            const journal = parseInstallDocument(bytes, assertInstallTransaction);
            if (journal.transactionId !== entry.name
                || !Buffer.from(bytes).equals(Buffer.from(installDocumentBytes(journal, assertInstallTransaction)))) {
                throw recovery("Marketplace transaction journal identity is invalid.");
            }
            if (journal.jobId === job.jobId) matches.push({ journal, paths });
        }
        if (matches.length > 1) throw recovery("Marketplace job has multiple active transactions.");
        if (!matches.length) return null;
        const [{ journal, paths }] = matches;
        if (journal.operation !== "install" || journal.finalPlanHash !== job.finalPlanHash) {
            throw recovery("Marketplace job transaction does not match its finalized plan.");
        }
        return this.#readPrepared(journal, paths);
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

    async #publishReceipt(prepared, receiptHash, index) {
        const bytes = await readRegularBytes(receiptWrite(prepared.paths, receiptHash), { maxBytes: 16 * 1024 * 1024 });
        const receipt = assertMarketplaceInstallReceipt(parseMarketplaceDocument(bytes));
        const published = await this.receiptStore.publish(receipt);
        if (published.hash !== receiptHash) throw recovery("Marketplace transaction receipt hash is invalid.");
        await this.fault?.("after-receipt", { journal: prepared.journal, receiptHash, index });
        const planned = prepared.finalPlan?.releases.find((entry) => isDeepStrictEqual(exactRef(entry.release), receipt.release));
        await this.fault?.(planned?.disposition === "collection" ? "after-collection-receipt" : "after-member-receipt", {
            journal: prepared.journal, receiptHash, index,
        });
    }

    async #readCompletion(prepared, transactionOperation) {
        const filePath = operationCompletionPath(prepared.paths, transactionOperation.operationId);
        if (!await lstatOrNull(filePath)) return null;
        const bytes = await readRegularBytes(filePath, { maxBytes: 4 * 1024 * 1024 });
        const { document } = parseMarketplaceJsonBytes(bytes);
        const keys = Object.keys(document).sort(compareUtf8);
        if (keys.join("\u0000") !== "kind\u0000operationHash\u0000operationId\u0000result\u0000transactionId\u0000version"
            || document.kind !== "cev-sim.marketplace-operation-completion" || document.version !== 1
            || document.transactionId !== prepared.journal.transactionId
            || document.operationId !== transactionOperation.operationId
            || document.operationHash !== transactionOperation.operationHash
            || !Buffer.from(bytes).equals(Buffer.from(canonicalMarketplaceBytes(document)))) {
            throw recovery("Marketplace operation completion marker is invalid.");
        }
        return document;
    }

    async #commitAdapters(prepared) {
        if (!prepared.finalPlan) return;
        const commits = new Map(prepared.journal.adapterCommits.map((entry) => [exactKey(entry), entry]));
        const transactionOperations = prepared.journal.adapterOperations ?? [];
        let index = 0;
        for (const entry of prepared.finalPlan.releases) {
            if (!commits.has(exactKey(entry.release))) continue;
            const adapter = this.adapterRegistry.requireLifecycle(entry.release.contentKind);
            if (adapter.id !== entry.adapterId) throw recovery("Marketplace transaction adapter identity changed.");
            const artifactHandle = await this.artifactStore.get(entry.release.artifact);
            if (!artifactHandle) throw recovery("Marketplace transaction artifact is unavailable.");
            if (prepared.journal.adapterOperations === undefined) {
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
                continue;
            }
            const operations = entry.adapterPlan.operations?.length ? entry.adapterPlan.operations : [{
                operationId: transactionOperations.find((candidate) => exactKey(candidate) === exactKey(entry.release))?.operationId,
                kind: "commit-adapter",
            }];
            for (const operation of operations) {
                const transactionOperation = transactionOperations.find((candidate) => candidate.operationId === operation.operationId);
                if (!transactionOperation || transactionOperation.adapterId !== adapter.id
                    || transactionOperation.operationHash !== operationHash(operation)) {
                    throw recovery("Marketplace transaction operation changed after journaling.");
                }
                const input = {
                    release: entry.release,
                    inspection: entry.inspection,
                    adapterPlan: entry.adapterPlan,
                    artifactHandle,
                    operation,
                    transactionId: prepared.journal.transactionId,
                    context: Object.freeze({
                        source: prepared.preflight.source,
                        workDirectory: path.join(this.paths.jobs, prepared.journal.jobId, "work"),
                    }),
                };
                await prepared.onOperation?.({
                    currentOperation: operation.operationId,
                    completedOperations: index,
                    totalOperations: transactionOperations.length,
                });
                const completion = await this.#readCompletion(prepared, transactionOperation);
                const result = completion
                    ? await adapter.recover({ ...input, completion: completion.result })
                    : await adapter.commit(input);
                if (!completion) {
                    const document = {
                        kind: "cev-sim.marketplace-operation-completion",
                        version: 1,
                        transactionId: prepared.journal.transactionId,
                        operationId: operation.operationId,
                        operationHash: transactionOperation.operationHash,
                        result: result ?? {},
                    };
                    await writeExclusiveDurable(operationCompletionPath(prepared.paths, operation.operationId), canonicalMarketplaceBytes(document));
                }
                await this.fault?.("after-adapter-operation", {
                    journal: prepared.journal, adapterId: adapter.id, operationId: operation.operationId, index,
                });
                await this.fault?.(entry.disposition === "collection" ? "after-collection-operation" : "after-member-operation", {
                    journal: prepared.journal, adapterId: adapter.id, operationId: operation.operationId, index,
                });
                await this.fault?.("after-adapter-commit", { journal: prepared.journal, adapterId: adapter.id, index });
                index += 1;
                await prepared.onOperation?.({
                    currentOperation: null,
                    completedOperations: index,
                    totalOperations: transactionOperations.length,
                });
            }
            const commit = commits.get(exactKey(entry.release));
            if (commit.receiptHash) await this.#publishReceipt(prepared, commit.receiptHash, index);
        }
    }

    async #publishExecutableProvenance(prepared) {
        if (!this.provenanceStore || !prepared.finalPlan || !prepared.preflight) return;
        for (const entry of prepared.finalPlan.releases) {
            if (entry.disposition === "artifact-only") continue;
            const baseOrigin = {
                sourceId: prepared.preflight.source.sourceId,
                registryId: prepared.preflight.source.registryId,
                publisherId: entry.release.publisherId,
                release: exactRef(entry.release),
            };
            if (entry.release.contentKind === "plugin" && entry.inspection?.identity?.packageHash) {
                await this.provenanceStore.record(entry.inspection.identity.packageHash, { ...baseOrigin, role: "direct" });
            }
            for (const plugin of entry.release.embeddedPlugins ?? []) {
                await this.provenanceStore.record(plugin.packageHash, { ...baseOrigin, role: "embedded" });
            }
        }
        await this.fault?.("after-provenance-publication", { journal: prepared.journal });
    }

    async #removeAdapterOwnership(prepared) {
        let index = 0;
        for (const entry of prepared.journal.adapterRemovals ?? []) {
            const adapter = this.adapterRegistry.requireRemovalAdapter(entry.adapterId);
            const receipt = await this.receiptStore.read(entry.receiptHash);
            await adapter.remove({
                receipt,
                removalPlan: entry.removalPlan,
                transactionId: prepared.journal.transactionId,
                context: Object.freeze({ operation: prepared.journal.operation }),
            });
            await this.fault?.("after-adapter-removal", {
                journal: prepared.journal,
                adapterId: adapter.id,
                index,
            });
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
        let currentOwnership = null;
        let currentOwnershipHash = null;
        let legacyOwnershipTarget = null;
        if (prepared.journal.ownershipTarget) {
            currentOwnership = await this.ownershipStore.snapshot();
            currentOwnershipHash = installOwnershipHash(currentOwnership);
            if (currentOwnershipHash !== prepared.journal.ownershipBase.sha256
                && currentOwnershipHash !== prepared.journal.ownershipTarget.sha256) {
                throw recovery("Marketplace ownership ledger matches neither transaction base nor target.");
            }
            if (currentHash === prepared.journal.installedTarget.sha256
                && currentOwnershipHash !== prepared.journal.ownershipTarget.sha256) {
                throw recovery("Installed membership became visible before its ownership target.");
            }
        } else {
            currentOwnership = await this.ownershipStore.snapshot();
            legacyOwnershipTarget = this.ownershipStore.prepareLegacyInstalledTarget(currentOwnership, prepared.target);
        }
        if (prepared.journal.operation === "remove-membership") {
            if (currentOwnershipHash === prepared.journal.ownershipBase?.sha256) {
                await this.ownershipStore.commitTarget({ base: currentOwnership, target: prepared.ownershipTarget });
                currentOwnership = prepared.ownershipTarget;
                await this.fault?.("after-ownership-publication", { journal: prepared.journal });
            }
            if (legacyOwnershipTarget && installOwnershipHash(currentOwnership) !== installOwnershipHash(legacyOwnershipTarget)) {
                await this.ownershipStore.commitTarget({ base: currentOwnership, target: legacyOwnershipTarget });
                await this.fault?.("after-ownership-publication", { journal: prepared.journal });
            }
            await this.#publishExecutableProvenance(prepared);
            if (currentHash === prepared.journal.installedBase.sha256) {
                await this.installedStore.commitTarget({ base: current, target: prepared.target });
                await this.fault?.("after-installed", { journal: prepared.journal });
                await this.fault?.("after-installed-publication", { journal: prepared.journal });
            }
            await this.#removeAdapterOwnership(prepared);
        } else {
            if (prepared.journal.ownershipTarget) await this.#commitAdapters(prepared);
            else {
                await this.#publishReceipts(prepared);
                await this.#commitAdapters(prepared);
            }
            await this.#publishExecutableProvenance(prepared);
            if (currentOwnershipHash === prepared.journal.ownershipBase?.sha256) {
                await this.ownershipStore.commitTarget({ base: currentOwnership, target: prepared.ownershipTarget });
                await this.fault?.("after-ownership-publication", { journal: prepared.journal });
            }
            if (legacyOwnershipTarget && installOwnershipHash(currentOwnership) !== installOwnershipHash(legacyOwnershipTarget)) {
                await this.ownershipStore.commitTarget({ base: currentOwnership, target: legacyOwnershipTarget });
                await this.fault?.("after-ownership-publication", { journal: prepared.journal });
            }
            if (currentHash === prepared.journal.installedBase.sha256) {
                await this.installedStore.commitTarget({ base: current, target: prepared.target });
                await this.fault?.("after-installed", { journal: prepared.journal });
                await this.fault?.("after-installed-publication", { journal: prepared.journal });
            }
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

    install(job, finalPlan, { onOperation = null } = {}) {
        const operation = this.#queue.catch(() => {}).then(async () => {
            let prepared = null;
            try {
                prepared = await this.#preparedTransactionForJob(job)
                    ?? await this.prepareInstall(job, finalPlan);
                return await this.#apply(Object.freeze({ ...prepared, onOperation }));
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
            const childNames = children.sort().join("\u0000");
            if (![`${JOURNAL_FILE}\u0000${WRITES_DIRECTORY}`, `${COMPLETIONS_DIRECTORY}\u0000${JOURNAL_FILE}\u0000${WRITES_DIRECTORY}`].includes(childNames)) {
                throw recovery("Marketplace transaction directory is ambiguous.");
            }
            const bytes = await readRegularBytes(paths.journal, { maxBytes: 1024 * 1024 });
            const journal = parseInstallDocument(bytes, assertInstallTransaction);
            if (journal.transactionId !== entry.name
                || !Buffer.from(bytes).equals(Buffer.from(installDocumentBytes(journal, assertInstallTransaction)))) {
                throw recovery("Marketplace transaction journal identity is invalid.");
            }
            if (journal.adapterOperations !== undefined) {
                if (!children.includes(COMPLETIONS_DIRECTORY)) throw recovery("Marketplace transaction completion store is missing.");
                const operationIds = new Set(journal.adapterOperations.map((operation) => operation.operationId));
                for (const completion of await fs.readdir(paths.completions, { withFileTypes: true })) {
                    if (completion.isSymbolicLink() || !completion.isFile() || !/^[a-f0-9]{64}\.json$/u.test(completion.name)
                        || !operationIds.has(completion.name.slice(0, -5))) {
                        throw recovery("Marketplace transaction completion store is ambiguous.");
                    }
                }
            }
            const expectedWrites = [
                INSTALLED_WRITE,
                ...(journal.ownershipTarget ? [OWNERSHIP_WRITE] : []),
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
        const ownership = await this.ownershipStore.snapshot();
        this.ownershipStore.verifyAgainstInstalled(ownership, installed);
        const installations = new Map(installed.installations.map((entry) => [
            installationKey(entry.sourceId, entry.release), entry,
        ]));
        const installedPlans = finalPlan.releases.filter((entry) => entry.disposition !== "artifact-only");
        const matched = installedPlans.map((entry) => (
            installations.get(installationKey(preflight.source.sourceId, entry.release))
        ));
        if (matched.some((entry) => !entry)) return null;
        for (let index = 0; index < matched.length; index += 1) {
            const installation = matched[index];
            const planned = installedPlans[index];
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
            const membership = ownership.memberships.find((entry) => installationKey(entry.sourceId, entry.release)
                === installationKey(preflight.source.sourceId, planned.release));
            if (!membership || !(planned.owners ?? [{ kind: "direct" }]).every((owner) => (
                membership.owners.some((candidate) => isDeepStrictEqual(candidate, owner))
            ))) throw recovery("Installed marketplace membership has incomplete ownership.");
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
        const ownershipBase = await this.ownershipStore.snapshot();
        this.ownershipStore.verifyAgainstInstalled(ownershipBase, base);
        const targetKey = installationKey(request.sourceId, {
            itemId: request.itemId,
            releaseVersion: request.releaseVersion,
            artifactSha256: request.artifactSha256,
        });
        const installation = base.installations.find((entry) => installationKey(entry.sourceId, entry.release) === targetKey);
        if (!installation) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Installed marketplace release was not found.");
        }
        const ownershipRemoval = this.ownershipStore.prepareRemoval(ownershipBase, request);
        const adapterRemovals = [];
        for (const removed of ownershipRemoval.removedMemberships) {
            const removedInstallation = base.installations.find((entry) => installationKey(entry.sourceId, entry.release) === installationKey(removed.sourceId, removed.release));
            if (!removedInstallation) throw recovery("Ownership removal refers to a missing installed membership.");
            const receiptHash = removedInstallation.receiptHashes.at(-1);
            const receipt = await this.receiptStore.read(receiptHash);
            const removalAdapter = this.adapterRegistry.findRemovalAdapter(receipt);
            if (removalAdapter) {
                const removalPlan = await removalAdapter.planRemoval({
                    receipt,
                    installation: removedInstallation,
                    context: Object.freeze({ installed: base }),
                });
                if (!removalPlan || typeof removalPlan !== "object" || Array.isArray(removalPlan)) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Artifact adapter ${removalAdapter.id} returned an invalid removal plan.`);
                }
                adapterRemovals.push({ adapterId: removalAdapter.id, receiptHash, removalPlan });
            }
        }
        const target = this.installedStore.prepareRemovalSet(base, ownershipRemoval.removedMemberships.map((entry) => ({
            sourceId: entry.sourceId,
            itemId: entry.release.itemId,
            releaseVersion: entry.release.releaseVersion,
            artifactSha256: entry.release.artifactSha256,
        })));
        if (target.revision !== ownershipRemoval.target.revision) throw recovery("Marketplace removal targets have different revisions.");
        const transactionId = randomUUID();
        const paths = transactionPaths(this.paths, transactionId);
        await ensureDirectory(paths.root);
        await ensureDirectory(paths.writes);
        await writeExclusiveDurable(paths.installed, marketplaceDocumentBytes(target));
        await writeExclusiveDurable(paths.ownership, installOwnershipBytes(ownershipRemoval.target));
        const journal = assertInstallTransaction({
            kind: MARKETPLACE_INSTALL_KINDS.transaction,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            transactionId,
            jobId: null,
            operation: "remove-membership",
            finalPlanHash: null,
            installedBase: { revision: base.revision, sha256: installedDocumentHash(base) },
            installedTarget: { revision: target.revision, sha256: installedDocumentHash(target) },
            ownershipBase: { revision: ownershipBase.revision, sha256: installOwnershipHash(ownershipBase) },
            ownershipTarget: { revision: ownershipRemoval.target.revision, sha256: installOwnershipHash(ownershipRemoval.target) },
            receiptHashes: [],
            adapterCommits: [],
            adapterRemovals,
        });
        await writeExclusiveDurable(paths.journal, installDocumentBytes(journal, assertInstallTransaction));
        await this.fault?.("after-journal", { journal });
        return this.commit(Object.freeze({
            journal, paths, base, target, ownershipBase, ownershipTarget: ownershipRemoval.target, finalPlan: null, preflight: null,
        }));
    }

    async listJobOperations(jobId) {
        assertCanonicalUuid(jobId, "jobId");
        const operations = [];
        for (const entry of (await fs.readdir(this.paths.transactions, { withFileTypes: true })).sort((left, right) => compareUtf8(left.name, right.name))) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const paths = transactionPaths(this.paths, entry.name);
            if (!await lstatOrNull(paths.journal)) continue;
            const journal = parseInstallDocument(await readRegularBytes(paths.journal, { maxBytes: 1024 * 1024 }), assertInstallTransaction);
            if (journal.jobId !== jobId) continue;
            for (const operation of journal.adapterOperations ?? []) {
                operations.push(Object.freeze({
                    ...operation,
                    transactionId: journal.transactionId,
                    status: await lstatOrNull(operationCompletionPath(paths, operation.operationId)) ? "complete" : "pending",
                }));
            }
        }
        return Object.freeze(operations);
    }

    abandonJob(jobId) {
        assertCanonicalUuid(jobId, "jobId");
        const operation = this.#queue.catch(() => {}).then(async () => {
            const current = await this.installedStore.snapshot();
            for (const entry of await fs.readdir(this.paths.transactions, { withFileTypes: true })) {
                if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
                const paths = transactionPaths(this.paths, entry.name);
                if (!await lstatOrNull(paths.journal)) continue;
                const journal = parseInstallDocument(await readRegularBytes(paths.journal, { maxBytes: 1024 * 1024 }), assertInstallTransaction);
                if (journal.jobId !== jobId) continue;
                if (installedDocumentHash(current) !== journal.installedBase.sha256) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace transaction already changed installed membership and cannot be replanned.");
                }
                if (journal.ownershipBase) {
                    const ownership = await this.ownershipStore.snapshot();
                    if (installOwnershipHash(ownership) !== journal.ownershipBase.sha256) {
                        throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace transaction already changed installation ownership and cannot be replanned.");
                    }
                }
                await removeDirectoryDurable(paths.root);
            }
        });
        this.#queue = operation.catch(() => {});
        return operation;
    }

    async close() {
        await this.#queue;
    }
}
