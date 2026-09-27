import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { fsyncDir } from "../../storage/visual-assets/atomicFs.js";
import { marketplaceDocumentBytes } from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";
import {
    REGISTRY_DOCUMENT_VERSION,
    TUF_TRANSACTION_JOURNAL_KIND,
    assertTufTransactionJournal,
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
import { hashTufBytes, parseTufMetadata } from "./TufMetadata.js";
import { MetadataKind } from "@tufjs/models";

const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

function recovery(message, pathName = null, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName, cause });
}

async function fault(faults, name, details = {}) {
    const handler = typeof faults === "function" ? faults : faults?.[name];
    if (handler) await handler(details);
}

function stageName(index) {
    return `writes/${String(index).padStart(4, "0")}`;
}

function tufDestination(paths, relativePath) {
    const destination = path.resolve(paths.tuf, relativePath);
    if (destination === paths.tuf || !destination.startsWith(`${paths.tuf}${path.sep}`)) {
        throw recovery("TUF transaction destination escapes its repository.", relativePath);
    }
    return destination;
}

async function currentTimestampIdentity(paths) {
    const filePath = path.join(paths.tufMetadata, "timestamp.json");
    const bytes = await readRegularBytes(filePath, { maxBytes: MAX_JOURNAL_BYTES });
    const metadata = parseTufMetadata(bytes, MetadataKind.Timestamp);
    return { bytes, version: metadata.signed.version, sha256: hashTufBytes(bytes) };
}

export async function prepareTufTransaction({
    paths,
    registryId,
    operation,
    catalog,
    baseTimestamp,
    targetTimestamp,
    writes,
    postTimestampWrites = [],
    transactionId = randomUUID(),
    faults = {},
}) {
    const directory = path.join(paths.tufTransactions, transactionId);
    await ensureDirectoryWithin(paths.tufTransactions, directory);
    await ensureDirectoryWithin(directory, path.join(directory, "writes"));
    const journalWrites = [];
    try {
        for (const [index, write] of writes.entries()) {
            const bytes = Buffer.from(write.bytes);
            const stagedPath = stageName(index);
            await writeExclusiveDurable(path.join(directory, stagedPath), bytes);
            journalWrites.push({
                phase: write.phase,
                stagedPath,
                destinationPath: write.destinationPath,
                sha256: hashTufBytes(bytes),
                sizeBytes: bytes.byteLength,
            });
        }
        const timestampBytes = Buffer.from(targetTimestamp.bytes);
        const timestampWrite = {
            stagedPath: stageName(writes.length),
            destinationPath: "metadata/timestamp.json",
            sha256: hashTufBytes(timestampBytes),
            sizeBytes: timestampBytes.byteLength,
        };
        await writeExclusiveDurable(path.join(directory, timestampWrite.stagedPath), timestampBytes);
        const journalPostWrites = [];
        for (const [index, write] of postTimestampWrites.entries()) {
            const bytes = Buffer.from(write.bytes);
            const stagedPath = stageName(writes.length + 1 + index);
            await writeExclusiveDurable(path.join(directory, stagedPath), bytes);
            journalPostWrites.push({
                phase: write.phase,
                stagedPath,
                destinationPath: write.destinationPath,
                sha256: hashTufBytes(bytes),
                sizeBytes: bytes.byteLength,
            });
        }
        const catalogBytes = marketplaceDocumentBytes(catalog);
        const journal = assertTufTransactionJournal({
            kind: TUF_TRANSACTION_JOURNAL_KIND,
            version: REGISTRY_DOCUMENT_VERSION,
            transactionId,
            operation,
            registryId,
            catalog: { revision: catalog.revision, sha256: hashMarketplaceBytes(catalogBytes) },
            baseTimestamp: {
                version: baseTimestamp.metadata.signed.version,
                sha256: hashTufBytes(baseTimestamp.bytes),
            },
            targetTimestamp: {
                version: targetTimestamp.metadata.signed.version,
                sha256: timestampWrite.sha256,
            },
            writes: journalWrites,
            timestampWrite,
            postTimestampWrites: journalPostWrites,
        });
        await writeExclusiveDurable(
            path.join(directory, "journal.json"),
            registryDocumentBytes(journal, assertTufTransactionJournal),
        );
        await fsyncDir(directory);
        await fsyncDir(paths.tufTransactions);
        await fault(faults, "afterJournalDurability", { journal });
        return { directory, journal, faults };
    } catch (error) {
        if (!(await lstatOrNull(path.join(directory, "journal.json")))) {
            await removeDirectoryDurable(directory).catch(() => {});
        }
        throw error;
    }
}

async function verifyDestination(paths, write) {
    try {
        await verifyRegularFile(tufDestination(paths, write.destinationPath), write.sha256, write.sizeBytes);
        return true;
    } catch (error) {
        if (error?.code === MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED) return false;
        throw error;
    }
}

async function publishImmutableWrite(paths, prepared, write) {
    const staged = path.join(prepared.directory, write.stagedPath);
    const destination = tufDestination(paths, write.destinationPath);
    try {
        await publishImmutableFile(staged, destination, write.sha256, write.sizeBytes, paths.tuf);
    } catch (error) {
        throw recovery(`TUF immutable destination conflicts: ${write.destinationPath}`, destination, error);
    }
}

async function replaceTimestamp(paths, prepared) {
    const write = prepared.journal.timestampWrite;
    const staged = path.join(prepared.directory, write.stagedPath);
    const destination = tufDestination(paths, write.destinationPath);
    await verifyRegularFile(staged, write.sha256, write.sizeBytes);
    await ensureDirectory(path.dirname(destination));
    await fs.rename(staged, destination);
    await fs.chmod(destination, 0o600);
    await fsyncDir(path.dirname(destination));
}

async function publishPostTimestampWrites(paths, prepared, faults) {
    for (const [index, write] of prepared.journal.postTimestampWrites.entries()) {
        await publishImmutableWrite(paths, prepared, write);
        await fault(faults, "afterPostTimestampWrite", { index, write, journal: prepared.journal });
        await fault(faults, "afterFinalRoot", { index, write });
    }
}

export async function commitTufTransaction(paths, prepared, { faults = prepared.faults ?? {} } = {}) {
    for (const [index, write] of prepared.journal.writes.entries()) {
        await publishImmutableWrite(paths, prepared, write);
        await fault(faults, "afterImmutableWrite", { index, write, journal: prepared.journal });
        if (write.phase === "target") await fault(faults, "afterTargetPublication", { index, write });
        if (write.phase === "delegated") await fault(faults, "afterDelegatedMetadata", { index, write });
        if (write.phase === "snapshot") await fault(faults, "afterSnapshotMetadata", { index, write });
        if (write.phase === "root") await fault(faults, "afterTransitionRoot", { index, write });
    }
    await replaceTimestamp(paths, prepared);
    await fault(faults, "afterTimestampPublication", { journal: prepared.journal });
    await publishPostTimestampWrites(paths, prepared, faults);
    await fault(faults, "beforeJournalCleanup", { journal: prepared.journal });
    await removeDirectoryDurable(prepared.directory);
    return Object.freeze({
        transactionId: prepared.journal.transactionId,
        timestampVersion: prepared.journal.targetTimestamp.version,
    });
}

async function readPreparedTransaction(paths, name) {
    const directory = path.join(paths.tufTransactions, name);
    const stat = await lstatOrNull(directory);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw recovery("TUF transaction entry is not a regular directory.", directory);
    const bytes = await readRegularBytes(path.join(directory, "journal.json"), { maxBytes: MAX_JOURNAL_BYTES });
    const journal = parseRegistryDocumentBytes(bytes, assertTufTransactionJournal);
    if (!Buffer.from(bytes).equals(Buffer.from(registryDocumentBytes(journal, assertTufTransactionJournal)))) {
        throw recovery("TUF transaction journal is not canonical.", directory);
    }
    if (journal.transactionId !== name) throw recovery("TUF transaction directory does not match its journal ID.", directory);
    return { directory, journal, faults: {} };
}

export async function recoverTufTransactions(paths, {
    faults = {},
    registryId = null,
    catalog = null,
} = {}) {
    const names = (await fs.readdir(paths.tufTransactions)).sort();
    const recovered = [];
    for (const name of names) {
        const prepared = await readPreparedTransaction(paths, name);
        if (registryId && prepared.journal.registryId !== registryId) {
            throw recovery("TUF transaction registry ID does not match registry.json.", prepared.directory);
        }
        if (catalog) {
            const catalogBytes = marketplaceDocumentBytes(catalog);
            if (prepared.journal.catalog.revision !== catalog.revision
                || prepared.journal.catalog.sha256 !== hashMarketplaceBytes(catalogBytes)) {
                throw recovery("TUF transaction catalog does not match catalog/current.json.", prepared.directory);
            }
        }
        const current = await currentTimestampIdentity(paths);
        const base = prepared.journal.baseTimestamp;
        const target = prepared.journal.targetTimestamp;
        if (current.sha256 === target.sha256 && current.version === target.version) {
            for (const write of prepared.journal.writes) {
                if (!(await verifyDestination(paths, write))) {
                    throw recovery("Published TUF transaction is missing an immutable destination.", write.destinationPath);
                }
            }
            await publishPostTimestampWrites(paths, prepared, faults);
            await removeDirectoryDurable(prepared.directory);
            recovered.push({ transactionId: name, action: "cleaned" });
            continue;
        }
        if (current.sha256 !== base.sha256 || current.version !== base.version) {
            throw recovery("Published timestamp matches neither TUF transaction base nor target.", path.join(paths.tufMetadata, "timestamp.json"));
        }
        await commitTufTransaction(paths, prepared, { faults });
        recovered.push({ transactionId: name, action: "completed" });
    }
    return recovered;
}
