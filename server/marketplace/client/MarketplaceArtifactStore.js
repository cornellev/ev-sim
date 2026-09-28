import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { fsyncDir } from "../../storage/visual-assets/atomicFs.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertSha256 } from "../MarketplaceFormats.js";
import {
    ensureDirectory,
    hashRegularFile,
    lstatOrNull,
    publishImmutableFile,
    readRegularBytes,
    verifyRegularFile,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";
import {
    MARKETPLACE_INSTALL_DOCUMENT_VERSION,
    MARKETPLACE_INSTALL_KINDS,
    assertArtifactRecord,
    assertQuarantineRecord,
    installDocumentBytes,
    parseInstallDocument,
} from "./MarketplaceInstallDocuments.js";

function artifactPath(paths, digest) {
    assertSha256(digest, "artifactSha256");
    return path.join(paths.artifacts, digest);
}

function recordPath(paths, digest) {
    assertSha256(digest, "artifactSha256");
    return path.join(paths.artifactRecords, `${digest}.json`);
}

function recovery(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message);
}

async function publishRecord(paths, record) {
    const destination = recordPath(paths, record.sha256);
    const bytes = installDocumentBytes(record, assertArtifactRecord);
    if (await lstatOrNull(destination)) {
        const existing = await readRegularBytes(destination, { maxBytes: 64 * 1024 });
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw recovery("Marketplace artifact record disagrees with cached bytes.");
        return false;
    }
    try {
        await writeExclusiveDurable(destination, bytes);
        return true;
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const existing = await readRegularBytes(destination, { maxBytes: 64 * 1024 });
        if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw recovery("Concurrent marketplace artifact publication disagreed.");
        return false;
    }
}

export class MarketplaceArtifactStore {
    constructor(paths, { now = () => new Date() } = {}) {
        this.paths = paths;
        this.now = now;
    }

    static async open(dataDir, options = {}) {
        const paths = marketplaceClientPaths(dataDir);
        await Promise.all([
            ensureDirectory(paths.artifacts),
            ensureDirectory(paths.artifactRecords),
            ensureDirectory(paths.quarantine),
        ]);
        const store = new MarketplaceArtifactStore(paths, options);
        await store.recover();
        return store;
    }

    async get(descriptor) {
        const recordFile = recordPath(this.paths, descriptor.sha256);
        if (!await lstatOrNull(recordFile)) return null;
        const bytes = await readRegularBytes(recordFile, { maxBytes: 64 * 1024 });
        const record = parseInstallDocument(bytes, assertArtifactRecord);
        if (!Buffer.from(bytes).equals(Buffer.from(installDocumentBytes(record, assertArtifactRecord)))) {
            throw recovery("Marketplace artifact record is not canonical.");
        }
        if (record.sha256 !== descriptor.sha256 || record.sizeBytes !== descriptor.sizeBytes
            || record.mediaType !== descriptor.mediaType) return null;
        const filePath = artifactPath(this.paths, descriptor.sha256);
        await verifyRegularFile(filePath, descriptor.sha256, descriptor.sizeBytes);
        return Object.freeze({
            path: filePath,
            mediaType: descriptor.mediaType,
            sha256: descriptor.sha256,
            sizeBytes: descriptor.sizeBytes,
        });
    }

    async publish(stagedPath, descriptor) {
        const actual = await hashRegularFile(stagedPath, descriptor.sizeBytes);
        if (actual.sha256 !== descriptor.sha256) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Marketplace artifact digest does not match its verified descriptor.");
        }
        const destination = artifactPath(this.paths, descriptor.sha256);
        const created = await publishImmutableFile(
            stagedPath,
            destination,
            descriptor.sha256,
            descriptor.sizeBytes,
            this.paths.artifacts,
        );
        const record = assertArtifactRecord({
            kind: MARKETPLACE_INSTALL_KINDS.artifactRecord,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            sha256: descriptor.sha256,
            sizeBytes: descriptor.sizeBytes,
            mediaType: descriptor.mediaType,
        });
        await publishRecord(this.paths, record);
        return Object.freeze({
            path: destination,
            mediaType: descriptor.mediaType,
            sha256: descriptor.sha256,
            sizeBytes: descriptor.sizeBytes,
            created,
        });
    }

    async quarantine(stagedPath, { expectedSha256, actualSha256, sizeBytes, reasonCode }) {
        const quarantineId = randomUUID();
        const directory = path.join(this.paths.quarantine, quarantineId);
        await ensureDirectory(directory);
        const artifact = path.join(directory, "artifact");
        const record = assertQuarantineRecord({
            kind: MARKETPLACE_INSTALL_KINDS.quarantineRecord,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            quarantineId,
            createdAt: this.now().toISOString(),
            expectedSha256,
            actualSha256,
            sizeBytes,
            reasonCode,
        });
        let moved = false;
        try {
            await fs.rename(stagedPath, artifact);
            moved = true;
            await fs.chmod(artifact, 0o600);
            await fsyncDir(directory);
            await writeExclusiveDurable(path.join(directory, "record.json"), installDocumentBytes(record, assertQuarantineRecord));
            return Object.freeze({ quarantineId, record });
        } catch (error) {
            if (moved) await fs.rename(artifact, stagedPath).catch(() => {});
            await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
    }

    async quarantineCached(descriptor, reasonCode = "ADAPTER_VERIFICATION_FAILED") {
        const handle = await this.get(descriptor);
        if (!handle) return null;
        const result = await this.quarantine(handle.path, {
            expectedSha256: descriptor.sha256,
            actualSha256: descriptor.sha256,
            sizeBytes: descriptor.sizeBytes,
            reasonCode,
        });
        await fs.rm(recordPath(this.paths, descriptor.sha256));
        await fsyncDir(this.paths.artifactRecords);
        return result;
    }

    async recover() {
        for (const entry of await fs.readdir(this.paths.artifactRecords, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || !entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
                throw recovery("Marketplace artifact record store contains an unexpected node.");
            }
            const digest = entry.name.slice(0, -5);
            const bytes = await readRegularBytes(path.join(this.paths.artifactRecords, entry.name), { maxBytes: 64 * 1024 });
            const record = parseInstallDocument(bytes, assertArtifactRecord);
            if (record.sha256 !== digest || !Buffer.from(bytes).equals(Buffer.from(installDocumentBytes(record, assertArtifactRecord)))) {
                throw recovery("Marketplace artifact record has a mismatched identity or noncanonical bytes.");
            }
            await verifyRegularFile(artifactPath(this.paths, digest), digest, record.sizeBytes);
        }
        for (const entry of await fs.readdir(this.paths.artifacts, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || !entry.isFile() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
                throw recovery("Marketplace artifact store contains an unexpected node.");
            }
        }
        for (const entry of await fs.readdir(this.paths.quarantine, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || !entry.isDirectory()) throw recovery("Marketplace quarantine contains an unexpected node.");
            const directory = path.join(this.paths.quarantine, entry.name);
            const children = (await fs.readdir(directory)).sort();
            if (children.join("\u0000") !== "artifact\u0000record.json") throw recovery("Marketplace quarantine record is incomplete or ambiguous.");
            const bytes = await readRegularBytes(path.join(directory, "record.json"), { maxBytes: 64 * 1024 });
            const record = parseInstallDocument(bytes, assertQuarantineRecord);
            if (record.quarantineId !== entry.name || !Buffer.from(bytes).equals(Buffer.from(installDocumentBytes(record, assertQuarantineRecord)))) {
                throw recovery("Marketplace quarantine identity is invalid.");
            }
            const actual = await hashRegularFile(path.join(directory, "artifact"), record.sizeBytes);
            if (actual.sha256 !== record.actualSha256) throw recovery("Marketplace quarantine artifact does not match its record.");
        }
    }
}
