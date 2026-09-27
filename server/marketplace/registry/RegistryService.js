import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    createArtifactStagingArea,
    stageArtifactStream,
} from "../../artifacts/ArtifactVerification.js";
import { artifactAdapterRegistry } from "../ArtifactAdapters.js";
import {
    MARKETPLACE_ARTIFACTS,
    MARKETPLACE_KINDS,
    MARKETPLACE_LIMITS,
} from "../MarketplaceContract.js";
import {
    assertMarketplaceCatalog,
    assertMarketplaceItem,
    assertMarketplaceRelease,
    hashMarketplaceRelease,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes } from "../MarketplaceJson.js";
import {
    advanceCatalog,
    appendCatalogRelease,
    catalogBytesAndHash,
    projectItemSummary,
    projectReleaseSummary,
    setCatalogTrack,
    upsertCatalogItem,
} from "./RegistryCatalog.js";
import {
    BLOB_RECORD_KIND,
    REGISTRY_DOCUMENT_VERSION,
    assertBlobRecord,
    parseRegistryDocumentBytes,
    registryDocumentBytes,
} from "./RegistryDocuments.js";
import {
    blobPath,
    blobRecordPath,
    itemTargetPath,
    releaseTargetPath,
    resolveRegistryPath,
} from "./RegistryLayout.js";
import {
    lstatOrNull,
    publishImmutableFile,
    readRegularBytes,
    removeDirectoryDurable,
    verifyRegularFile,
    writeExclusiveDurable,
} from "./RegistryFs.js";
import { commitCatalogTransaction, prepareCatalogTransaction } from "./RegistryTransaction.js";
import { inspectPreviewBytes } from "./PreviewMedia.js";

function conflict(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

function recovery(message, pathName = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName });
}

function exactBytesEqual(left, right) {
    return Buffer.from(left).equals(Buffer.from(right));
}

async function inputSource(input) {
    if (typeof input !== "string") return { source: input, sizeBytes: undefined };
    const stat = await fs.lstat(input);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, "Input must be a regular non-symlink file.", { path: input });
    }
    return { source: createReadStream(input), sizeBytes: stat.size };
}

async function createOperationArea(root, operation) {
    return createArtifactStagingArea(root, { meta: { operation } });
}

async function cleanArea(area) {
    await removeDirectoryDurable(area.dir).catch(() => {});
}

async function stageInput(input, area, {
    maxBytes,
    expectedBytes,
    expectedSha256,
    signal,
}) {
    const opened = await inputSource(input);
    return stageArtifactStream(opened.source, {
        destination: path.join(area.dir, "payload"),
        maxBytes,
        expectedBytes: expectedBytes ?? opened.sizeBytes,
        expectedSha256,
        signal,
    });
}

function blobRecordForArtifact(contentKind, staged, inspection) {
    return assertBlobRecord({
        kind: BLOB_RECORD_KIND,
        version: REGISTRY_DOCUMENT_VERSION,
        sha256: staged.sha256,
        sizeBytes: staged.sizeBytes,
        mediaType: MARKETPLACE_ARTIFACTS[contentKind].mediaType,
        usage: {
            type: "artifact",
            contentKind,
            adapterId: inspection.adapterId,
            inspection: structuredClone(inspection),
        },
    });
}

function blobRecordForPreview(staged, preview) {
    return assertBlobRecord({
        kind: BLOB_RECORD_KIND,
        version: REGISTRY_DOCUMENT_VERSION,
        sha256: staged.sha256,
        sizeBytes: staged.sizeBytes,
        mediaType: preview.mediaType,
        usage: {
            type: "preview",
            format: preview.format,
            width: preview.width,
            height: preview.height,
            pages: preview.pages,
        },
    });
}

async function readBlobRecord(paths, digest) {
    const recordPath = resolveRegistryPath(paths, blobRecordPath(digest));
    const bytes = await readRegularBytes(recordPath, { maxBytes: MARKETPLACE_LIMITS.jsonBytes });
    const record = parseRegistryDocumentBytes(bytes, assertBlobRecord);
    if (!exactBytesEqual(bytes, registryDocumentBytes(record, assertBlobRecord))) {
        throw recovery("Blob record bytes are not canonical.", recordPath);
    }
    return record;
}

async function verifyBlobRecordAndFile(paths, record) {
    await verifyRegularFile(resolveRegistryPath(paths, blobPath(record.sha256)), record.sha256, record.sizeBytes);
    return record;
}

async function publishBlob(paths, staged, record) {
    const destination = resolveRegistryPath(paths, blobPath(staged.sha256));
    const recordDestination = resolveRegistryPath(paths, blobRecordPath(staged.sha256));
    const blobStat = await lstatOrNull(destination);
    const recordStat = await lstatOrNull(recordDestination);
    if (blobStat || recordStat) {
        if (!blobStat || !recordStat) throw recovery("CAS blob and blob record are incomplete; refusing to repair them automatically.", destination);
        const existing = await readBlobRecord(paths, staged.sha256);
        await verifyBlobRecordAndFile(paths, existing);
        const expectedBytes = registryDocumentBytes(record, assertBlobRecord);
        const existingBytes = registryDocumentBytes(existing, assertBlobRecord);
        if (!exactBytesEqual(expectedBytes, existingBytes)) throw conflict("CAS digest already has different registry metadata.");
        await fs.rm(staged.path, { force: true });
        return false;
    }
    await publishImmutableFile(staged.path, destination, staged.sha256, staged.sizeBytes, paths.root);
    try {
        await writeExclusiveDurable(recordDestination, registryDocumentBytes(record, assertBlobRecord));
    } catch (error) {
        throw recovery("CAS blob was published without its blob record; manual recovery is required.", destination);
    }
    return true;
}

function descriptor(record) {
    return Object.freeze({
        mediaType: record.mediaType,
        sha256: record.sha256,
        sizeBytes: record.sizeBytes,
    });
}

function targetDescriptor(relativePath, bytes) {
    return Object.freeze({
        path: relativePath,
        sha256: hashMarketplaceBytes(bytes),
        sizeBytes: bytes.byteLength,
    });
}

function requireKind(document, kind) {
    if (document.kind !== kind) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Expected ${kind}; received ${document.kind}.`, { path: "$.kind" });
    }
    return document;
}

function releaseKey(release) {
    return `${release.itemId}\u0000${release.releaseVersion}`;
}

function catalogWithoutRevision(catalog) {
    const value = structuredClone(catalog);
    delete value.revision;
    delete value.generatedAt;
    return canonicalMarketplaceBytes(value);
}

async function listRegularNames(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw recovery("Registry listing encountered a hostile filesystem node.", path.join(directory, entry.name));
    }
    return entries.map((entry) => entry.name).sort();
}

async function walkRegularFiles(directory) {
    const found = [];
    const visit = async (current) => {
        for (const entry of await fs.readdir(current, { withFileTypes: true })) {
            const absolute = path.join(current, entry.name);
            if (entry.isSymbolicLink()) throw recovery("Registry target tree contains a symlink.", absolute);
            if (entry.isDirectory()) await visit(absolute);
            else if (entry.isFile()) found.push(absolute);
            else throw recovery("Registry target tree contains a non-regular node.", absolute);
        }
    };
    await visit(directory);
    return found.sort();
}

export class MarketplaceRegistryService {
    constructor(store, {
        now = () => new Date(),
        artifactRegistry = artifactAdapterRegistry,
        faults = {},
    } = {}) {
        this.store = store;
        this.now = now;
        this.artifactRegistry = artifactRegistry;
        this.faults = faults;
    }

    async validateArtifact(input, {
        contentKind,
        sha256,
        sizeBytes,
        signal,
    }) {
        const contract = MARKETPLACE_ARTIFACTS[contentKind];
        if (!contract) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Unknown marketplace content kind.");
        const temporary = this.store?.paths.uploadStaging ?? await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-validate-"));
        const standalone = !this.store;
        const area = await createOperationArea(temporary, "validate-artifact");
        try {
            const staged = await stageInput(input, area, {
                maxBytes: MARKETPLACE_LIMITS.artifactBytes,
                expectedBytes: sizeBytes,
                expectedSha256: sha256,
                signal,
            });
            const inspection = await this.artifactRegistry.inspect(contentKind, {
                path: staged.path,
                mediaType: contract.mediaType,
                sha256: staged.sha256,
                sizeBytes: staged.sizeBytes,
            }, { signal, stagingRoot: path.join(area.dir, "inspection") });
            return Object.freeze({ descriptor: descriptor(blobRecordForArtifact(contentKind, staged, inspection)), inspection });
        } finally {
            await cleanArea(area);
            if (standalone) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
        }
    }

    async admitArtifact(input, options) {
        if (!this.store) throw new TypeError("Artifact admission requires an open registry store.");
        const { contentKind, sha256, sizeBytes, signal } = options;
        const contract = MARKETPLACE_ARTIFACTS[contentKind];
        if (!contract) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Unknown marketplace content kind.");
        const area = await createOperationArea(this.store.paths.uploadStaging, "admit-artifact");
        try {
            const staged = await stageInput(input, area, {
                maxBytes: MARKETPLACE_LIMITS.artifactBytes,
                expectedBytes: sizeBytes,
                expectedSha256: sha256,
                signal,
            });
            const inspection = await this.artifactRegistry.inspect(contentKind, {
                path: staged.path,
                mediaType: contract.mediaType,
                sha256: staged.sha256,
                sizeBytes: staged.sizeBytes,
            }, { signal, stagingRoot: path.join(area.dir, "inspection") });
            const record = blobRecordForArtifact(contentKind, staged, inspection);
            const created = await this.store.mutate(() => publishBlob(this.store.paths, staged, record));
            return Object.freeze({ descriptor: descriptor(record), inspection, created });
        } finally {
            await cleanArea(area);
        }
    }

    async validatePreview(input, { mediaType, sha256, sizeBytes, signal }) {
        const temporary = this.store?.paths.uploadStaging ?? await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-validate-"));
        const standalone = !this.store;
        const area = await createOperationArea(temporary, "validate-preview");
        try {
            const staged = await stageInput(input, area, {
                maxBytes: MARKETPLACE_LIMITS.previewBytes,
                expectedBytes: sizeBytes,
                expectedSha256: sha256,
                signal,
            });
            const preview = await inspectPreviewBytes(await readRegularBytes(staged.path, { maxBytes: MARKETPLACE_LIMITS.previewBytes }), { mediaType });
            return Object.freeze({ descriptor: descriptor(blobRecordForPreview(staged, preview)), preview });
        } finally {
            await cleanArea(area);
            if (standalone) await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
        }
    }

    async admitPreview(input, options) {
        if (!this.store) throw new TypeError("Preview admission requires an open registry store.");
        const { mediaType, sha256, sizeBytes, signal } = options;
        const area = await createOperationArea(this.store.paths.uploadStaging, "admit-preview");
        try {
            const staged = await stageInput(input, area, {
                maxBytes: MARKETPLACE_LIMITS.previewBytes,
                expectedBytes: sizeBytes,
                expectedSha256: sha256,
                signal,
            });
            const preview = await inspectPreviewBytes(await readRegularBytes(staged.path, { maxBytes: MARKETPLACE_LIMITS.previewBytes }), { mediaType });
            const record = blobRecordForPreview(staged, preview);
            const created = await this.store.mutate(() => publishBlob(this.store.paths, staged, record));
            return Object.freeze({ descriptor: descriptor(record), preview, created });
        } finally {
            await cleanArea(area);
        }
    }

    async #verifyItemPreviews(item) {
        for (const preview of item.previews) {
            const record = await readBlobRecord(this.store.paths, preview.sha256);
            await verifyBlobRecordAndFile(this.store.paths, record);
            if (record.usage.type !== "preview" || record.mediaType !== preview.mediaType
                || record.sizeBytes !== preview.sizeBytes) {
                throw conflict(`Item preview ${preview.sha256} does not match its admitted CAS record.`);
            }
        }
    }

    async admitItem(rawBytes) {
        const item = assertMarketplaceItem(requireKind(parseMarketplaceDocument(rawBytes), MARKETPLACE_KINDS.item));
        const bytes = marketplaceDocumentBytes(item);
        const itemHash = hashMarketplaceBytes(bytes);
        await this.#verifyItemPreviews(item);
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            const existingSummary = catalog.items.find((entry) => entry.itemId === item.itemId);
            if (existingSummary) {
                if (existingSummary.publisherId !== item.publisherId || existingSummary.contentKind !== item.contentKind) {
                    throw conflict("An admitted item's publisherId and contentKind are immutable.");
                }
                if (existingSummary.target.sha256 === itemHash) {
                    return Object.freeze({ itemId: item.itemId, itemHash, revision: catalog.revision, created: false });
                }
            }
            const relativePath = itemTargetPath(item.itemId, itemHash);
            const target = targetDescriptor(relativePath, bytes);
            let next = upsertCatalogItem(catalog, projectItemSummary(item, target));
            next = advanceCatalog(next, this.now);
            const prepared = await prepareCatalogTransaction({
                paths: this.store.paths,
                operation: "admit-item",
                baseCatalog: catalog,
                targetCatalog: next,
                writes: [{ destinationPath: relativePath, bytes }],
                faults: this.faults,
            });
            await commitCatalogTransaction(this.store.paths, prepared);
            return Object.freeze({ itemId: item.itemId, itemHash, revision: next.revision, created: !existingSummary });
        });
    }

    async admitRelease(rawBytes, { track = null } = {}) {
        if (track !== null && !["stable", "beta"].includes(track)) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, "Release track must be stable or beta.");
        const release = assertMarketplaceRelease(requireKind(parseMarketplaceDocument(rawBytes), MARKETPLACE_KINDS.release));
        const bytes = marketplaceDocumentBytes(release);
        const releaseHash = hashMarketplaceRelease(release);
        const record = await readBlobRecord(this.store.paths, release.artifact.sha256);
        await verifyBlobRecordAndFile(this.store.paths, record);
        if (record.usage.type !== "artifact" || record.usage.contentKind !== release.contentKind
            || record.mediaType !== release.artifact.mediaType || record.sizeBytes !== release.artifact.sizeBytes) {
            throw conflict("Release artifact does not match its admitted CAS record.");
        }
        this.artifactRegistry.validate(release.contentKind, record.usage.inspection, release);
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            const item = catalog.items.find((entry) => entry.itemId === release.itemId);
            if (!item) throw conflict("Release item must be admitted first.");
            if (item.publisherId !== release.publisherId || item.contentKind !== release.contentKind) {
                throw conflict("Release publisherId and contentKind must match the admitted item.");
            }
            const indexedReleases = new Map(catalog.releases.map((entry) => [releaseKey(entry), entry]));
            for (const dependency of release.dependencies) {
                const admitted = indexedReleases.get(releaseKey(dependency));
                if (!admitted || admitted.artifact.sha256 !== dependency.artifactSha256) {
                    throw conflict(`Exact dependency ${dependency.itemId}@${dependency.releaseVersion} is not admitted.`);
                }
            }
            const existing = indexedReleases.get(releaseKey(release));
            if (existing && existing.releaseHash !== releaseHash) {
                throw conflict(`Release tuple ${release.itemId}@${release.releaseVersion} is immutable.`);
            }
            const relativePath = releaseTargetPath(release.itemId, release.releaseVersion, releaseHash);
            let next = catalog;
            const writes = [];
            if (!existing) {
                const target = targetDescriptor(relativePath, bytes);
                next = appendCatalogRelease(next, projectReleaseSummary(release, releaseHash, target));
                writes.push({ destinationPath: relativePath, bytes });
            }
            if (track !== null) next = setCatalogTrack(next, release.itemId, track, release.releaseVersion);
            if (exactBytesEqual(catalogWithoutRevision(catalog), catalogWithoutRevision(next))) {
                return Object.freeze({
                    itemId: release.itemId,
                    releaseVersion: release.releaseVersion,
                    releaseHash,
                    revision: catalog.revision,
                    created: false,
                });
            }
            next = advanceCatalog(next, this.now);
            const prepared = await prepareCatalogTransaction({
                paths: this.store.paths,
                operation: "admit-release",
                baseCatalog: catalog,
                targetCatalog: next,
                writes,
                faults: this.faults,
            });
            await commitCatalogTransaction(this.store.paths, prepared);
            return Object.freeze({
                itemId: release.itemId,
                releaseVersion: release.releaseVersion,
                releaseHash,
                revision: next.revision,
                created: !existing,
            });
        });
    }

    async getItem(itemId) {
        const catalog = await this.store.readCatalog();
        const summary = catalog.items.find((entry) => entry.itemId === itemId);
        if (!summary) return null;
        return (await this.store.readTarget(summary.target)).document;
    }

    async getRelease(itemId, releaseVersion) {
        const catalog = await this.store.readCatalog();
        const summary = catalog.releases.find((entry) => entry.itemId === itemId && entry.releaseVersion === releaseVersion);
        if (!summary) return null;
        return (await this.store.readTarget(summary.target)).document;
    }

    async listItems() {
        return (await this.store.readCatalog()).items;
    }

    async listReleases() {
        return (await this.store.readCatalog()).releases;
    }

    async listBlobs() {
        const names = await listRegularNames(this.store.paths.blobRecords);
        const records = [];
        for (const name of names) {
            if (!/^[a-f0-9]{64}\.json$/u.test(name)) throw recovery("Unexpected blob-record filename.", path.join(this.store.paths.blobRecords, name));
            const digest = name.slice(0, -5);
            const record = await readBlobRecord(this.store.paths, digest);
            if (record.sha256 !== digest) throw recovery("Blob record filename does not match its digest.", name);
            records.push(record);
        }
        return records;
    }

    async #verifyCatalogContents(catalog) {
        for (const summary of catalog.items) {
            const { document, bytes } = await this.store.readTarget(summary.target);
            const item = assertMarketplaceItem(document);
            const projected = projectItemSummary(item, summary.target);
            if (!exactBytesEqual(canonicalMarketplaceBytes(projected), canonicalMarketplaceBytes(summary))) {
                throw recovery("Catalog item summary does not match its canonical target.", summary.target.path);
            }
            if (hashMarketplaceBytes(bytes) !== summary.target.sha256) throw recovery("Item target hash mismatch.", summary.target.path);
            await this.#verifyItemPreviews(item);
        }
        const releases = new Map(catalog.releases.map((entry) => [releaseKey(entry), entry]));
        for (const summary of catalog.releases) {
            const { document } = await this.store.readTarget(summary.target);
            const release = assertMarketplaceRelease(document);
            const projected = projectReleaseSummary(release, hashMarketplaceRelease(release), summary.target);
            if (!exactBytesEqual(canonicalMarketplaceBytes(projected), canonicalMarketplaceBytes(summary))) {
                throw recovery("Catalog release summary does not match its canonical target.", summary.target.path);
            }
            const record = await readBlobRecord(this.store.paths, release.artifact.sha256);
            await verifyBlobRecordAndFile(this.store.paths, record);
            if (record.usage.type !== "artifact" || record.usage.contentKind !== release.contentKind) {
                throw recovery("Release artifact record has the wrong usage or content kind.", summary.target.path);
            }
            this.artifactRegistry.validate(release.contentKind, record.usage.inspection, release);
            for (const dependency of release.dependencies) {
                const admitted = releases.get(releaseKey(dependency));
                if (!admitted || admitted.artifact.sha256 !== dependency.artifactSha256) throw recovery("Release dependency is unavailable.", summary.target.path);
            }
        }
    }

    async verifyRegistry() {
        await this.store.verifyOwnership();
        const catalog = await this.store.readCatalog();
        if (catalog.registryId !== this.store.registry.registryId) throw recovery("Catalog registryId does not match registry.json.");
        const revisionNames = await listRegularNames(this.store.paths.catalogRevisions);
        const revisions = [];
        for (const name of revisionNames) {
            const match = /^(\d+)-([a-f0-9]{64})\.json$/u.exec(name);
            if (!match) throw recovery("Unexpected catalog revision filename.", name);
            const bytes = await readRegularBytes(path.join(this.store.paths.catalogRevisions, name));
            const document = assertMarketplaceCatalog(parseMarketplaceDocument(bytes));
            if (!exactBytesEqual(bytes, marketplaceDocumentBytes(document))) {
                throw recovery("Catalog revision bytes are not canonical.", name);
            }
            const revision = Number(match[1]);
            const digest = hashMarketplaceBytes(bytes);
            if (document.registryId !== this.store.registry.registryId || document.revision !== revision || digest !== match[2]) {
                throw recovery("Catalog revision filename, hash, or registry identity is invalid.", name);
            }
            revisions.push({ revision, digest, document });
        }
        revisions.sort((left, right) => left.revision - right.revision);
        revisions.forEach((entry, index) => {
            if (entry.revision !== index + 1) throw recovery("Catalog revision history is not continuous.");
        });
        const currentData = catalogBytesAndHash(catalog);
        const latest = revisions.at(-1);
        if (!latest || latest.revision !== catalog.revision || latest.digest !== currentData.sha256) {
            throw recovery("Current catalog is not the latest retained catalog revision.");
        }
        for (const revision of revisions) await this.#verifyCatalogContents(revision.document);
        const referencedTargets = new Set(revisions.flatMap((revision) => [
            ...revision.document.items.map((entry) => entry.target.path),
            ...revision.document.releases.map((entry) => entry.target.path),
        ]));
        const targetFiles = [
            ...await walkRegularFiles(this.store.paths.itemTargets),
            ...await walkRegularFiles(this.store.paths.releaseTargets),
        ];
        for (const file of targetFiles) {
            const relative = path.relative(this.store.paths.root, file).split(path.sep).join("/");
            const bytes = await readRegularBytes(file);
            const document = parseMarketplaceDocument(bytes);
            if (!exactBytesEqual(bytes, marketplaceDocumentBytes(document))) throw recovery("Immutable target is not canonical.", relative);
            const expected = document.kind === MARKETPLACE_KINDS.item
                ? itemTargetPath(document.itemId, hashMarketplaceBytes(bytes))
                : document.kind === MARKETPLACE_KINDS.release
                    ? releaseTargetPath(document.itemId, document.releaseVersion, hashMarketplaceRelease(document))
                    : null;
            if (expected !== relative || !referencedTargets.has(relative)) {
                throw recovery("Immutable target path is invalid or is not retained by a catalog revision.", relative);
            }
        }
        if (targetFiles.length !== referencedTargets.size) throw recovery("A retained catalog target is missing from immutable storage.");
        const records = await this.listBlobs();
        for (const record of records) {
            await verifyBlobRecordAndFile(this.store.paths, record);
            if (record.usage.type === "artifact") {
                const inspection = await this.artifactRegistry.inspect(record.usage.contentKind, {
                    path: resolveRegistryPath(this.store.paths, blobPath(record.sha256)),
                    mediaType: record.mediaType,
                    sha256: record.sha256,
                    sizeBytes: record.sizeBytes,
                }, { stagingRoot: this.store.paths.uploadStaging });
                if (!exactBytesEqual(canonicalMarketplaceBytes(inspection), canonicalMarketplaceBytes(record.usage.inspection))) {
                    throw recovery("Stored artifact inspection does not match a fresh inspection.", record.sha256);
                }
            } else {
                const fresh = await inspectPreviewBytes(
                    await readRegularBytes(resolveRegistryPath(this.store.paths, blobPath(record.sha256)), { maxBytes: MARKETPLACE_LIMITS.previewBytes }),
                    { mediaType: record.mediaType },
                );
                if (fresh.width !== record.usage.width || fresh.height !== record.usage.height || fresh.format !== record.usage.format) {
                    throw recovery("Stored preview inspection does not match its bytes.", record.sha256);
                }
            }
        }
        const blobNames = await listRegularNames(this.store.paths.blobs);
        const recordDigests = new Set(records.map((entry) => entry.sha256));
        for (const digest of blobNames) if (!recordDigests.has(digest)) throw recovery("CAS blob is missing its record.", digest);
        const pendingTransactions = await fs.readdir(this.store.paths.transactions);
        if (pendingTransactions.length > 0) throw recovery("Registry contains pending transactions after recovery.");
        return Object.freeze({
            ok: true,
            registryId: this.store.registry.registryId,
            revision: catalog.revision,
            counts: { items: catalog.items.length, releases: catalog.releases.length, blobs: records.length },
        });
    }

    async planGarbageCollection({ graceMs }) {
        if (!Number.isFinite(graceMs) || graceMs < 0) throw new TypeError("GC graceMs must be non-negative.");
        const marked = new Set();
        const releaseFiles = await walkRegularFiles(this.store.paths.releaseTargets);
        for (const file of releaseFiles) {
            const release = assertMarketplaceRelease(parseMarketplaceDocument(await readRegularBytes(file)));
            marked.add(release.artifact.sha256);
        }
        const revisionFiles = (await listRegularNames(this.store.paths.catalogRevisions)).map((name) => path.join(this.store.paths.catalogRevisions, name));
        for (const file of revisionFiles) {
            const revision = assertMarketplaceCatalog(parseMarketplaceDocument(await readRegularBytes(file)));
            for (const summary of revision.items) {
                const item = assertMarketplaceItem((await this.store.readTarget(summary.target)).document);
                item.previews.forEach((preview) => marked.add(preview.sha256));
            }
        }
        const records = await this.listBlobs();
        const unreferencedBlobs = records.filter((record) => !marked.has(record.sha256)).map((record) => record.sha256).sort();
        const cutoff = this.now().getTime() - graceMs;
        const expiredStaging = [];
        for (const name of (await fs.readdir(this.store.paths.uploadStaging)).sort()) {
            const directory = path.join(this.store.paths.uploadStaging, name);
            const stat = await fs.lstat(directory);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw recovery("Upload staging contains a hostile node.", directory);
            let createdAt = stat.mtimeMs;
            try {
                const meta = JSON.parse(await fs.readFile(path.join(directory, "meta.json"), "utf8"));
                createdAt = Date.parse(meta.createdAt);
            } catch {
                // A malformed staging record is eligible only by its directory age.
            }
            if (Number.isFinite(createdAt) && createdAt <= cutoff) expiredStaging.push(name);
        }
        return Object.freeze({
            dryRun: true,
            graceMs,
            markedBlobs: [...marked].sort(),
            unreferencedBlobs,
            expiredStaging,
        });
    }
}
