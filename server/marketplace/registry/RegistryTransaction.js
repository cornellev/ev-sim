import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { fsyncDir } from "../../storage/visual-assets/atomicFs.js";
import { assertMarketplaceCatalog, marketplaceDocumentBytes, parseMarketplaceDocument } from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";
import { catalogRevisionPath, resolveRegistryPath } from "./RegistryLayout.js";
import {
    REGISTRY_DOCUMENT_VERSION,
    TRANSACTION_JOURNAL_KIND,
    assertTransactionJournal,
    parseRegistryDocumentBytes,
    registryDocumentBytes,
} from "./RegistryDocuments.js";
import {
    ensureDirectory,
    ensureDirectoryWithin,
    lstatOrNull,
    publishImmutableFile,
    readRegularBytes,
    removeDirectoryDurable,
    verifyRegularFile,
    writeExclusiveDurable,
} from "./RegistryFs.js";

function recovery(message, pathName = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName });
}

async function fault(faults, name, details = {}) {
    const handler = typeof faults === "function" ? faults : faults?.[name];
    if (handler) await handler(details);
}

async function currentIdentity(paths) {
    const bytes = await readRegularBytes(paths.catalogCurrent);
    const document = assertMarketplaceCatalog(parseMarketplaceDocument(bytes));
    return { bytes, document, sha256: hashMarketplaceBytes(bytes) };
}

function stageName(index) {
    return `writes/${String(index).padStart(4, "0")}`;
}

export async function prepareCatalogTransaction({
    paths,
    operation,
    baseCatalog,
    targetCatalog,
    writes = [],
    transactionId = randomUUID(),
    faults = {},
}) {
    const baseBytes = marketplaceDocumentBytes(baseCatalog);
    const baseSha256 = hashMarketplaceBytes(baseBytes);
    const targetBytes = marketplaceDocumentBytes(targetCatalog);
    const targetSha256 = hashMarketplaceBytes(targetBytes);
    if (targetCatalog.revision !== baseCatalog.revision + 1) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Catalog transaction must increment the revision exactly once.");
    }
    const revisionDestination = catalogRevisionPath(targetCatalog.revision, targetSha256);
    const completeWrites = [
        ...writes,
        { destinationPath: revisionDestination, bytes: targetBytes },
        { destinationPath: "catalog/current.json", bytes: targetBytes },
    ];
    const directory = path.join(paths.transactions, transactionId);
    await ensureDirectoryWithin(paths.transactions, directory);
    await ensureDirectoryWithin(directory, path.join(directory, "writes"));
    const journalWrites = [];
    try {
        for (const [index, write] of completeWrites.entries()) {
            const bytes = Buffer.from(write.bytes);
            const stagedPath = stageName(index);
            await writeExclusiveDurable(path.join(directory, stagedPath), bytes);
            journalWrites.push({
                stagedPath,
                destinationPath: write.destinationPath,
                sha256: hashMarketplaceBytes(bytes),
                sizeBytes: bytes.byteLength,
            });
        }
        const journal = assertTransactionJournal({
            kind: TRANSACTION_JOURNAL_KIND,
            version: REGISTRY_DOCUMENT_VERSION,
            transactionId,
            operation,
            baseCatalog: { revision: baseCatalog.revision, sha256: baseSha256 },
            targetCatalog: { revision: targetCatalog.revision, sha256: targetSha256, sizeBytes: targetBytes.byteLength },
            writes: journalWrites,
        });
        await writeExclusiveDurable(
            path.join(directory, "journal.json"),
            registryDocumentBytes(journal, assertTransactionJournal),
        );
        await fsyncDir(directory);
        await fsyncDir(paths.transactions);
        await fault(faults, "afterJournalDurability", { journal });
        return { directory, journal, faults };
    } catch (error) {
        if (!(await lstatOrNull(path.join(directory, "journal.json")))) await removeDirectoryDurable(directory).catch(() => {});
        throw error;
    }
}

export async function verifyTransactionWrite(paths, directory, write, { staged = false } = {}) {
    const filePath = staged
        ? path.join(directory, write.stagedPath)
        : resolveRegistryPath(paths, write.destinationPath);
    try {
        await verifyRegularFile(filePath, write.sha256, write.sizeBytes);
        return true;
    } catch (error) {
        if (error.code === MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED) return false;
        throw error;
    }
}

async function publishWrite(paths, directory, write, { replace = false } = {}) {
    const staged = path.join(directory, write.stagedPath);
    const destination = resolveRegistryPath(paths, write.destinationPath);
    if (replace) {
        if (!(await verifyTransactionWrite(paths, directory, write, { staged: true }))) {
            throw recovery("Transaction replacement staging is corrupt.", staged);
        }
        await ensureDirectory(path.dirname(destination));
        await fs.rename(staged, destination);
        await fs.chmod(destination, 0o600);
        await fsyncDir(path.dirname(destination));
        return;
    }
    try {
        await publishImmutableFile(staged, destination, write.sha256, write.sizeBytes, paths.root);
    } catch (error) {
        throw recovery(`Immutable transaction destination conflicts: ${write.destinationPath}`, destination);
    }
}

export async function commitCatalogTransaction(paths, prepared, { faults = prepared.faults ?? {} } = {}) {
    const { directory, journal } = prepared;
    const currentWrite = journal.writes.find((entry) => entry.destinationPath === "catalog/current.json");
    const revisionPrefix = "catalog/revisions/";
    const targets = journal.writes.filter((entry) => entry !== currentWrite && !entry.destinationPath.startsWith(revisionPrefix));
    const revision = journal.writes.find((entry) => entry.destinationPath.startsWith(revisionPrefix));
    for (const [index, write] of targets.entries()) {
        await publishWrite(paths, directory, write);
        await fault(faults, "afterTargetRename", { index, write });
    }
    await publishWrite(paths, directory, revision);
    await fault(faults, "afterRevisionPublication", { write: revision });
    await publishWrite(paths, directory, currentWrite, { replace: true });
    await fault(faults, "afterCurrentCatalogRename", { write: currentWrite });
    await fault(faults, "beforeJournalCleanup", { journal });
    await removeDirectoryDurable(directory);
    return journal.targetCatalog;
}

async function readPreparedTransaction(paths, name) {
    const directory = path.join(paths.transactions, name);
    const stat = await lstatOrNull(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw recovery("Transaction entry is not a regular directory.", directory);
    const bytes = await readRegularBytes(path.join(directory, "journal.json"), { maxBytes: 8 * 1024 * 1024 });
    const journal = parseRegistryDocumentBytes(bytes, assertTransactionJournal);
    if (!Buffer.from(bytes).equals(Buffer.from(registryDocumentBytes(journal, assertTransactionJournal)))) {
        throw recovery("Transaction journal bytes are not canonical.", directory);
    }
    if (journal.transactionId !== name) throw recovery("Transaction directory does not match its journal ID.", directory);
    return { directory, journal, faults: {} };
}

export async function recoverCatalogTransactions(paths, { faults = {} } = {}) {
    const names = (await fs.readdir(paths.transactions)).sort();
    const recovered = [];
    for (const name of names) {
        const prepared = await readPreparedTransaction(paths, name);
        const current = await currentIdentity(paths);
        if (current.sha256 === prepared.journal.targetCatalog.sha256) {
            for (const write of prepared.journal.writes) {
                if (!(await verifyTransactionWrite(paths, prepared.directory, write))) {
                    throw recovery("Committed transaction is missing or has a conflicting destination.", write.destinationPath);
                }
            }
            await removeDirectoryDurable(prepared.directory);
            recovered.push({ transactionId: name, action: "cleaned" });
            continue;
        }
        if (current.sha256 !== prepared.journal.baseCatalog.sha256
            || current.document.revision !== prepared.journal.baseCatalog.revision) {
            throw recovery("Current catalog matches neither transaction base nor target; manual recovery is required.", paths.catalogCurrent);
        }
        await commitCatalogTransaction(paths, prepared, { faults });
        recovered.push({ transactionId: name, action: "completed" });
    }
    return recovered;
}
