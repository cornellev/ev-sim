import { generateKeyPairSync } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import semver from "semver";

import {
    createArtifactStagingArea,
    stageArtifactStream,
} from "../../artifacts/ArtifactVerification.js";
import { artifactAdapterRegistry } from "../ArtifactAdapters.js";
import {
    MARKETPLACE_ARTIFACTS,
    MARKETPLACE_KINDS,
    MARKETPLACE_LIMITS,
    ASSET_PACKAGE_LIMITS,
    artifactByteLimitFor,
} from "../MarketplaceContract.js";
import {
    assertMarketplaceCatalog,
    assertMarketplaceAdvisory,
    assertMarketplaceItem,
    assertMarketplacePublisher,
    assertMarketplaceRelease,
    hashMarketplaceRelease,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertMarketplaceId } from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes } from "../MarketplaceJson.js";
import {
    parseReleaseEnvelope,
    publisherKeyId,
    publisherKeyObject,
    publisherPublicKey,
    verifyMarketplaceReleaseEnvelope,
} from "../PublisherSignatures.js";
import {
    advanceCatalog,
    appendCatalogAdvisory,
    appendCatalogRelease,
    appendCatalogYank,
    catalogBytesAndHash,
    projectItemSummary,
    projectPublisherSummary,
    projectReleaseSummary,
    removeCatalogTracksForRelease,
    setCatalogTrack,
    upsertCatalogPublisher,
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
    advisoryTargetPath,
    itemTargetPath,
    publisherTargetPath,
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
import { prepareCatalogTransaction } from "./RegistryTransaction.js";
import { inspectPreviewBytes } from "./PreviewMedia.js";
import { RegistryAuthStore } from "./RegistryAuthStore.js";
import { RegistryPublisherStore } from "./RegistryPublisherStore.js";

function conflict(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

const ENROLLMENT_WRITE_SCOPES = Object.freeze(["publish:blob", "publish:item", "publish:release", "manage:track"]);
const ENROLLMENT_ACTOR = Object.freeze({
    subject: "admin",
    publisherId: null,
    namespaces: Object.freeze([]),
    scopes: Object.freeze(["manage:publisher"]),
});

export function assertEnrollmentConfig(enrollment) {
    if (!enrollment || typeof enrollment !== "object" || Array.isArray(enrollment)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Enrollment configuration is invalid.");
    }
    assertMarketplaceId(enrollment.publisherId, "publisherId");
    const displayName = enrollment.displayName;
    if (typeof displayName !== "string" || !displayName.trim() || displayName !== displayName.trim()
        || displayName.length > 256 || displayName.includes("\u0000")) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Enrollment display name is invalid.");
    }
    return Object.freeze({ publisherId: enrollment.publisherId, displayName });
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

function requireActorScope(actor, scope, { publisherId = null, itemId = null, admin = false } = {}) {
    if (!actor || !Array.isArray(actor.scopes) || !actor.scopes.includes(scope)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.AUTHENTICATION_REQUIRED, "Authenticated registry actor lacks the required scope.");
    }
    if (admin && actor.subject !== "admin") {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Registry operation requires an administrator token.");
    }
    if (actor.subject !== "admin") {
        if (publisherId !== null && actor.publisherId !== publisherId) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Registry actor does not own the publisher identity.");
        }
        if (itemId !== null && !actor.namespaces?.some((namespace) => itemId === namespace || itemId.startsWith(`${namespace}.`))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Registry actor does not own the item namespace.");
        }
    }
    return actor;
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

function publisherOwnsItem(publisher, itemId) {
    return publisher.namespaces.some((namespace) => itemId === namespace || itemId.startsWith(`${namespace}.`));
}

function exactReleaseReference(summary) {
    return Object.freeze({
        itemId: summary.itemId,
        releaseVersion: summary.releaseVersion,
        artifactSha256: summary.artifact.sha256,
    });
}

async function readCatalogRelease(store, catalog, summary, { requireActive = false } = {}) {
    const bytes = await store.readTargetBytes(summary.target);
    if (!summary.publisherKeyId) {
        if (catalog.releaseAuthority !== "development-unsigned") {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.UPGRADE_REQUIRED, "Unsigned Marketplace release state is not trusted by this registry.");
        }
        return assertMarketplaceRelease(parseMarketplaceDocument(bytes));
    }
    const publisher = await new RegistryPublisherStore(store).getPublisher(summary.publisherId, catalog);
    if (!publisher) throw recovery("Signed release has no publisher target.", summary.target.path);
    const verified = verifyMarketplaceReleaseEnvelope(bytes, publisher, { requireActive });
    if (verified.keyId !== summary.publisherKeyId || hashMarketplaceBytes(verified.payloadBytes) !== summary.releaseHash) {
        throw recovery("Signed release identity does not match its catalog summary.", summary.target.path);
    }
    return verified.release;
}

async function verifyEmbeddedPluginReferences(store, catalog, release, indexedReleases, fail) {
    for (const embedded of release.embeddedPlugins ?? []) {
        const admitted = indexedReleases.get(releaseKey(embedded.release));
        if (!admitted || admitted.artifact.sha256 !== embedded.release.artifactSha256) {
            throw fail(`Embedded plugin release ${embedded.release.itemId}@${embedded.release.releaseVersion} is not admitted with the exact artifact.`);
        }
        const pluginRelease = await readCatalogRelease(store, catalog, admitted);
        if (pluginRelease.contentKind !== "plugin" || pluginRelease.artifact.sha256 !== embedded.release.artifactSha256) {
            throw fail(`Embedded plugin reference ${embedded.pluginId} does not name an admitted plugin artifact.`);
        }
        const record = await readBlobRecord(store.paths, pluginRelease.artifact.sha256);
        await verifyBlobRecordAndFile(store.paths, record);
        const identity = record.usage?.inspection?.identity;
        if (record.usage?.type !== "artifact" || record.usage.contentKind !== "plugin"
            || identity?.pluginId !== embedded.pluginId
            || identity?.packageHash !== embedded.packageHash
            || identity?.runtimeHash !== embedded.runtimeHash) {
            throw fail(`Embedded plugin ${embedded.pluginId} does not match its admitted plugin inspection.`);
        }
    }
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
        this.publisherStore = store ? new RegistryPublisherStore(store) : null;
    }

    async validateArtifact(input, {
        contentKind,
        sha256,
        sizeBytes,
        signal,
    }) {
        const contract = MARKETPLACE_ARTIFACTS[contentKind];
        if (!contract) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Unknown marketplace content kind.");
        const maxBytes = artifactByteLimitFor(contentKind);
        if (sizeBytes !== undefined && sizeBytes > maxBytes) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, `${contentKind} artifact exceeds its ${maxBytes}-byte limit.`);
        }
        const temporary = this.store?.paths.uploadStaging ?? await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-validate-"));
        const standalone = !this.store;
        const area = await createOperationArea(temporary, "validate-artifact");
        try {
            const staged = await stageInput(input, area, {
                maxBytes,
                expectedBytes: sizeBytes,
                expectedSha256: sha256,
                signal,
            });
            const inspection = await this.artifactRegistry.inspect(contentKind, {
                path: staged.path,
                mediaType: contract.mediaType,
                sha256: staged.sha256,
                sizeBytes: staged.sizeBytes,
            }, {
                signal,
                stagingRoot: path.join(area.dir, "inspection"),
                ...(contentKind === "asset-pack" ? { limits: ASSET_PACKAGE_LIMITS } : {}),
            });
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
        const maxBytes = artifactByteLimitFor(contentKind);
        if (sizeBytes !== undefined && sizeBytes > maxBytes) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, `${contentKind} artifact exceeds its ${maxBytes}-byte limit.`);
        }
        const area = await createOperationArea(this.store.paths.uploadStaging, "admit-artifact");
        try {
            const staged = await stageInput(input, area, {
                maxBytes,
                expectedBytes: sizeBytes,
                expectedSha256: sha256,
                signal,
            });
            const inspection = await this.artifactRegistry.inspect(contentKind, {
                path: staged.path,
                mediaType: contract.mediaType,
                sha256: staged.sha256,
                sizeBytes: staged.sizeBytes,
            }, {
                signal,
                stagingRoot: path.join(area.dir, "inspection"),
                ...(contentKind === "asset-pack" ? { limits: ASSET_PACKAGE_LIMITS } : {}),
            });
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

    async enrollPublisher(enrollment) {
        const { publisherId, displayName } = assertEnrollmentConfig(enrollment);
        const { privateKey, publicKey } = generateKeyPairSync("ed25519");
        const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" });
        const keyId = publisherKeyId(publicKey);
        const timestamp = this.now().toISOString();
        const key = {
            keyId,
            algorithm: "ed25519",
            publicKey: publisherPublicKey(publicKey),
            status: "active",
            createdAt: timestamp,
            statusChangedAt: timestamp,
        };
        const catalog = await this.store.readCatalog();
        const existing = await this.publisherStore.getPublisher(publisherId, catalog);
        if (!existing) {
            const publisher = {
                kind: "cev-sim.marketplace-publisher",
                version: 1,
                publisherId,
                namespaces: [publisherId],
                keys: [key],
            };
            try {
                await this.registerPublisher(marketplaceDocumentBytes(publisher), { actor: ENROLLMENT_ACTOR });
            } catch (error) {
                if (error?.code !== MARKETPLACE_ERROR_CODES.CONFLICT || !error.message.includes("already exists")) throw error;
                await this.addPublisherKey(publisherId, key, { actor: ENROLLMENT_ACTOR });
            }
        } else {
            await this.addPublisherKey(publisherId, key, { actor: ENROLLMENT_ACTOR });
        }
        const auth = await RegistryAuthStore.open(this.store.paths, { now: this.now });
        const reader = await auth.createToken({ subject: "reader", scopes: ["read"] });
        const writer = await auth.createToken({
            subject: "publisher",
            publisherId,
            namespaces: [publisherId],
            scopes: ENROLLMENT_WRITE_SCOPES,
        });
        return Object.freeze({
            publisherId,
            displayName,
            keyId,
            privateKeyPem,
            readToken: reader.token,
            writeToken: writer.token,
        });
    }

    async registerPublisher(rawBytes, { actor } = {}) {
        requireActorScope(actor, "manage:publisher", { admin: true });
        const publisher = assertMarketplacePublisher(parseMarketplaceDocument(rawBytes));
        const bytes = marketplaceDocumentBytes(publisher);
        const publisherHash = hashMarketplaceBytes(bytes);
        for (const key of publisher.keys) {
            if (publisherKeyId(publisherKeyObject(key.publicKey)) !== key.keyId) throw conflict("Publisher key ID does not match its public key.");
        }
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            const existing = await this.publisherStore.getPublisher(publisher.publisherId, catalog);
            if (existing) {
                if (Buffer.from(marketplaceDocumentBytes(existing)).equals(bytes)) {
                    return Object.freeze({ publisherId: publisher.publisherId, publisherHash, revision: catalog.revision, created: false });
                }
                throw conflict("Publisher identity already exists; use publisher key lifecycle operations.");
            }
            for (const current of await this.publisherStore.listPublishers(catalog)) {
                for (const namespace of publisher.namespaces) {
                    if (current.namespaces.some((owned) => namespace === owned || namespace.startsWith(`${owned}.`) || owned.startsWith(`${namespace}.`))) {
                        throw conflict(`Publisher namespace ${namespace} overlaps an existing publisher namespace.`);
                    }
                }
            }
            const relativePath = publisherTargetPath(publisher.publisherId, publisherHash);
            const target = targetDescriptor(relativePath, bytes);
            let next = upsertCatalogPublisher(catalog, projectPublisherSummary(publisher, target));
            next = advanceCatalog(next, this.now);
            const prepared = await prepareCatalogTransaction({
                paths: this.store.paths,
                operation: "register-publisher",
                baseCatalog: catalog,
                targetCatalog: next,
                writes: [{ destinationPath: relativePath, bytes }],
                faults: this.faults,
            });
            await this.store.commitCatalogMutation(prepared, next);
            return Object.freeze({ publisherId: publisher.publisherId, publisherHash, revision: next.revision, created: true });
        });
    }

    async #replacePublisher(publisherId, operation, mutate, { actor } = {}) {
        requireActorScope(actor, "manage:publisher", { admin: true });
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            const current = await this.publisherStore.getPublisher(publisherId, catalog);
            if (!current) throw conflict("Publisher identity is not registered.");
            const nextPublisher = assertMarketplacePublisher(mutate(structuredClone(current)));
            if (nextPublisher.publisherId !== publisherId) throw conflict("Publisher identity is immutable.");
            const bytes = marketplaceDocumentBytes(nextPublisher);
            const publisherHash = hashMarketplaceBytes(bytes);
            const currentSummary = catalog.publishers.find((entry) => entry.publisherId === publisherId);
            if (currentSummary.target.sha256 === publisherHash) {
                return Object.freeze({ publisherId, publisherHash, revision: catalog.revision, changed: false });
            }
            const relativePath = publisherTargetPath(publisherId, publisherHash);
            const target = targetDescriptor(relativePath, bytes);
            let next = upsertCatalogPublisher(catalog, projectPublisherSummary(nextPublisher, target));
            next = advanceCatalog(next, this.now);
            const prepared = await prepareCatalogTransaction({
                paths: this.store.paths,
                operation,
                baseCatalog: catalog,
                targetCatalog: next,
                writes: [{ destinationPath: relativePath, bytes }],
                faults: this.faults,
            });
            await this.store.commitCatalogMutation(prepared, next);
            return Object.freeze({ publisherId, publisherHash, revision: next.revision, changed: true });
        });
    }

    async addPublisherKey(publisherId, key, options = {}) {
        return this.#replacePublisher(publisherId, "add-publisher-key", (publisher) => {
            if (publisher.keys.some((entry) => entry.keyId === key.keyId)) throw conflict("Publisher key ID already exists.");
            publisher.keys.push(structuredClone(key));
            publisher.keys.sort((left, right) => left.keyId.localeCompare(right.keyId));
            return publisher;
        }, options);
    }

    async setPublisherKeyStatus(publisherId, keyId, status, options = {}) {
        if (!new Set(["retired", "revoked"]).has(status)) throw conflict("Publisher keys may only transition to retired or revoked.");
        return this.#replacePublisher(publisherId, "set-publisher-key-status", (publisher) => {
            const key = publisher.keys.find((entry) => entry.keyId === keyId);
            if (!key) throw conflict("Publisher key ID is not registered.");
            if (key.status === "revoked" && status !== "revoked") throw conflict("Revoked publisher keys cannot be reactivated.");
            if (key.status === "retired" && status !== "retired" && status !== "revoked") throw conflict("Retired publisher keys cannot be reactivated.");
            key.status = status;
            key.statusChangedAt = this.now().toISOString();
            return publisher;
        }, options);
    }

    async compromisePublisherKey(publisherId, keyId, {
        actor,
        advisoryId,
        rationale,
        remediation = "Install a release signed by a new active publisher key.",
        severity = "critical",
    } = {}) {
        requireActorScope(actor, "manage:advisory", { admin: true });
        requireActorScope(actor, "manage:publisher", { admin: true });
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            if (catalog.advisories.some((entry) => entry.advisoryId === advisoryId)) throw conflict("Compromise advisory identity already exists.");
            const publisher = await this.publisherStore.getPublisher(publisherId, catalog);
            if (!publisher) throw conflict("Publisher identity is not registered.");
            const key = publisher.keys.find((entry) => entry.keyId === keyId);
            if (!key) throw conflict("Publisher key ID is not registered.");
            key.status = "revoked";
            key.statusChangedAt = this.now().toISOString();
            const affectedReleases = catalog.releases.filter((entry) => entry.publisherId === publisherId && entry.publisherKeyId === keyId);
            if (affectedReleases.length < 1) throw conflict("Publisher key has no admitted releases to compromise.");
            const subjects = [];
            const subjectKeys = new Set();
            const addSubject = (subject, subjectKey) => {
                if (!subjectKeys.has(subjectKey)) { subjectKeys.add(subjectKey); subjects.push(subject); }
            };
            for (const release of affectedReleases) {
                addSubject({ itemId: release.itemId, releaseVersion: release.releaseVersion }, `release:${release.itemId}@${release.releaseVersion}`);
                addSubject({ artifactSha256: release.artifact.sha256 }, `artifact:${release.artifact.sha256}`);
                if (release.executable) addSubject({ packageHash: release.executable.packageHash }, `package:${release.executable.packageHash}`);
                for (const plugin of release.embeddedPlugins ?? []) addSubject({ packageHash: plugin.packageHash }, `package:${plugin.packageHash}`);
                if (release.contentKind === "plugin") {
                    const record = await readBlobRecord(this.store.paths, release.artifact.sha256);
                    const packageHash = record.usage?.inspection?.identity?.packageHash;
                    if (packageHash) addSubject({ packageHash }, `package:${packageHash}`);
                }
            }
            const advisory = assertMarketplaceAdvisory({
                kind: MARKETPLACE_KINDS.advisory,
                version: 1,
                advisoryId,
                publisherId,
                issuedAt: this.now().toISOString(),
                affected: subjects,
                severity,
                rationale,
                remediation,
                action: "block",
            });
            const publisherBytes = marketplaceDocumentBytes(assertMarketplacePublisher(publisher));
            const publisherHash = hashMarketplaceBytes(publisherBytes);
            const publisherPath = publisherTargetPath(publisherId, publisherHash);
            const advisoryBytes = marketplaceDocumentBytes(advisory);
            const advisoryHash = hashMarketplaceBytes(advisoryBytes);
            const advisoryPath = advisoryTargetPath(advisoryId, advisoryHash);
            let next = upsertCatalogPublisher(catalog, projectPublisherSummary(publisher, targetDescriptor(publisherPath, publisherBytes)));
            next = appendCatalogAdvisory(next, { advisoryId, target: targetDescriptor(advisoryPath, advisoryBytes) });
            for (const release of affectedReleases) next = removeCatalogTracksForRelease(next, release.itemId, release.releaseVersion);
            next = advanceCatalog(next, this.now);
            const prepared = await prepareCatalogTransaction({
                paths: this.store.paths,
                operation: "compromise-publisher-key",
                baseCatalog: catalog,
                targetCatalog: next,
                writes: [
                    { destinationPath: publisherPath, bytes: publisherBytes },
                    { destinationPath: advisoryPath, bytes: advisoryBytes },
                ],
                faults: this.faults,
            });
            await this.store.commitCatalogMutation(prepared, next);
            return Object.freeze({ publisherId, keyId, advisoryId, affectedReleases: affectedReleases.length, revision: next.revision });
        });
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

    async admitItem(rawBytes, { actor = null } = {}) {
        const item = assertMarketplaceItem(requireKind(parseMarketplaceDocument(rawBytes), MARKETPLACE_KINDS.item));
        const bytes = marketplaceDocumentBytes(item);
        const itemHash = hashMarketplaceBytes(bytes);
        await this.#verifyItemPreviews(item);
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            if (catalog.releaseAuthority !== "development-unsigned") {
                const publisher = await this.publisherStore.getPublisher(item.publisherId, catalog);
                if (!publisher || !publisherOwnsItem(publisher, item.itemId)) throw conflict("Item publisher does not own its namespace.");
                requireActorScope(actor, "publish:item", { publisherId: item.publisherId, itemId: item.itemId });
            }
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
            await this.store.commitCatalogMutation(prepared, next);
            return Object.freeze({ itemId: item.itemId, itemHash, revision: next.revision, created: !existingSummary });
        });
    }

    async admitRelease(rawBytes, { track = null, actor = null } = {}) {
        if (track !== null && !["stable", "beta"].includes(track)) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, "Release track must be stable or beta.");
        const release = assertMarketplaceRelease(requireKind(parseMarketplaceDocument(rawBytes), MARKETPLACE_KINDS.release));
        const bytes = marketplaceDocumentBytes(release);
        const catalog = await this.store.readCatalog();
        if (catalog.releaseAuthority !== "development-unsigned") {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.UPGRADE_REQUIRED, "Unsigned release admission is disabled; provision publisher authority and submit a DSSE envelope.");
        }
        return this.#admitVerifiedRelease(release, bytes, { track, actor, publisherKeyId: null, operation: "admit-release" });
    }

    async admitReleaseEnvelope(rawEnvelopeBytes, { actor, track = null } = {}) {
        if (track !== null && !["stable", "beta"].includes(track)) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, "Release track must be stable or beta.");
        const parsed = parseReleaseEnvelope(rawEnvelopeBytes);
        const catalog = await this.store.readCatalog();
        const publisher = await this.publisherStore.getPublisher(parsed.release.publisherId, catalog);
        if (!publisher) throw conflict("Release publisher is not registered.");
        if (!publisherOwnsItem(publisher, parsed.release.itemId)) throw conflict("Release publisher does not own its item namespace.");
        requireActorScope(actor, "publish:release", { publisherId: publisher.publisherId, itemId: parsed.release.itemId });
        if (track !== null) requireActorScope(actor, "manage:track", { publisherId: publisher.publisherId, itemId: parsed.release.itemId });
        const verified = verifyMarketplaceReleaseEnvelope(rawEnvelopeBytes, publisher, { requireActive: true });
        return this.#admitVerifiedRelease(verified.release, verified.bytes, {
            track,
            actor,
            publisherKeyId: verified.keyId,
            operation: "admit-release-envelope",
        });
    }

    async #admitVerifiedRelease(release, targetBytes, { track, actor, publisherKeyId, operation }) {
        const releaseHash = hashMarketplaceRelease(release);
        const record = await readBlobRecord(this.store.paths, release.artifact.sha256);
        await verifyBlobRecordAndFile(this.store.paths, record);
        if (record.usage.type !== "artifact" || record.usage.contentKind !== release.contentKind
            || record.mediaType !== release.artifact.mediaType || record.sizeBytes !== release.artifact.sizeBytes) {
            throw conflict("Release artifact does not match its admitted CAS record.");
        }
        if (publisherKeyId && release.contentKind === "plugin") {
            const identity = record.usage?.inspection?.identity;
            if (!release.executable || release.executable.pluginId !== identity?.pluginId
                || release.executable.packageHash !== identity?.packageHash
                || release.executable.runtimeHash !== identity?.runtimeHash) {
                throw conflict("Signed plugin release executable identity does not match its admitted artifact.");
            }
        }
        this.artifactRegistry.validate(release.contentKind, record.usage.inspection, release);
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            if (publisherKeyId) {
                const currentPublisher = await this.publisherStore.getPublisher(release.publisherId, catalog);
                const verified = verifyMarketplaceReleaseEnvelope(targetBytes, currentPublisher, { requireActive: true });
                if (verified.keyId !== publisherKeyId || hashMarketplaceBytes(verified.payloadBytes) !== releaseHash) {
                    throw conflict("Release envelope changed before admission.");
                }
                requireActorScope(actor, "publish:release", { publisherId: release.publisherId, itemId: release.itemId });
            }
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
            await verifyEmbeddedPluginReferences(this.store, catalog, release, indexedReleases, conflict);
            const existing = indexedReleases.get(releaseKey(release));
            if (existing && (existing.releaseHash !== releaseHash || (existing.publisherKeyId ?? null) !== publisherKeyId)) {
                throw conflict(`Release tuple ${release.itemId}@${release.releaseVersion} is immutable.`);
            }
            const relativePath = releaseTargetPath(release.itemId, release.releaseVersion, releaseHash);
            let next = catalog;
            const writes = [];
            if (!existing) {
                const target = targetDescriptor(relativePath, targetBytes);
                next = appendCatalogRelease(next, projectReleaseSummary(release, releaseHash, target, { publisherKeyId }));
                writes.push({ destinationPath: relativePath, bytes: targetBytes });
            }
            if (track !== null) {
                const yanked = next.yanks.some((entry) => entry.release.itemId === release.itemId
                    && entry.release.releaseVersion === release.releaseVersion
                    && entry.release.artifactSha256 === release.artifact.sha256);
                if (yanked) throw conflict("Yanked releases cannot be assigned to a track.");
                next = setCatalogTrack(next, release.itemId, track, release.releaseVersion);
            }
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
                operation,
                baseCatalog: catalog,
                targetCatalog: next,
                writes,
                faults: this.faults,
            });
            await this.store.commitCatalogMutation(prepared, next);
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
        return readCatalogRelease(this.store, catalog, summary);
    }

    async listItems() {
        return (await this.store.readCatalog()).items;
    }

    async listReleases() {
        return (await this.store.readCatalog()).releases;
    }

    async listPublishers() {
        return this.publisherStore.listPublishers();
    }

    async setTrack(itemId, track, releaseVersion, { actor } = {}) {
        if (!["stable", "beta"].includes(track)) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFIG_INVALID, "Release track must be stable or beta.");
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            const release = catalog.releases.find((entry) => entry.itemId === itemId && entry.releaseVersion === releaseVersion);
            if (!release) throw conflict("Track release is not admitted.");
            requireActorScope(actor, "manage:track", { publisherId: release.publisherId, itemId });
            if (track === "stable" && semver.prerelease(releaseVersion) !== null) throw conflict("Stable tracks cannot select prereleases.");
            if (catalog.yanks.some((entry) => entry.release.itemId === itemId
                && entry.release.releaseVersion === releaseVersion
                && entry.release.artifactSha256 === release.artifact.sha256)) throw conflict("Yanked releases cannot be assigned to a track.");
            let next = setCatalogTrack(catalog, itemId, track, releaseVersion);
            if (exactBytesEqual(catalogWithoutRevision(catalog), catalogWithoutRevision(next))) {
                return Object.freeze({ itemId, track, releaseVersion, revision: catalog.revision, changed: false });
            }
            next = advanceCatalog(next, this.now);
            const prepared = await prepareCatalogTransaction({
                paths: this.store.paths,
                operation: "set-track",
                baseCatalog: catalog,
                targetCatalog: next,
                writes: [],
                faults: this.faults,
            });
            await this.store.commitCatalogMutation(prepared, next);
            return Object.freeze({ itemId, track, releaseVersion, revision: next.revision, changed: true });
        });
    }

    async yankRelease({ itemId, releaseVersion, artifactSha256, reason }, { actor } = {}) {
        if (typeof reason !== "string" || reason.length < 1 || reason.length > 4096) throw conflict("Yank reason is required.");
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            const release = catalog.releases.find((entry) => entry.itemId === itemId && entry.releaseVersion === releaseVersion
                && entry.artifact.sha256 === artifactSha256);
            if (!release) throw conflict("Exact release is not admitted.");
            requireActorScope(actor, "manage:yank", { publisherId: release.publisherId, itemId });
            if (catalog.yanks.some((entry) => entry.release.itemId === itemId
                && entry.release.releaseVersion === releaseVersion && entry.release.artifactSha256 === artifactSha256)) {
                throw conflict("Exact release is already yanked.");
            }
            let next = appendCatalogYank(catalog, {
                release: exactReleaseReference(release),
                reason,
                yankedAt: this.now().toISOString(),
            });
            next = removeCatalogTracksForRelease(next, itemId, releaseVersion);
            next = advanceCatalog(next, this.now);
            const prepared = await prepareCatalogTransaction({
                paths: this.store.paths,
                operation: "yank-release",
                baseCatalog: catalog,
                targetCatalog: next,
                writes: [],
                faults: this.faults,
            });
            await this.store.commitCatalogMutation(prepared, next);
            return Object.freeze({ release: exactReleaseReference(release), revision: next.revision });
        });
    }

    async #subjectPublisher(catalog, subject) {
        if (subject.itemId) {
            return catalog.releases.find((entry) => entry.itemId === subject.itemId
                && entry.releaseVersion === subject.releaseVersion)?.publisherId ?? null;
        }
        if (subject.artifactSha256) {
            return catalog.releases.find((entry) => entry.artifact.sha256 === subject.artifactSha256)?.publisherId ?? null;
        }
        for (const release of catalog.releases) {
            if (release.embeddedPlugins?.some((plugin) => plugin.packageHash === subject.packageHash)) return release.publisherId;
            if (release.executable?.packageHash === subject.packageHash) return release.publisherId;
            if (release.contentKind === "plugin") {
                const record = await readBlobRecord(this.store.paths, release.artifact.sha256);
                if (record.usage?.inspection?.identity?.packageHash === subject.packageHash) return release.publisherId;
            }
        }
        return null;
    }

    async admitAdvisory(rawBytes, { actor, compromiseResponse = false } = {}) {
        const advisory = assertMarketplaceAdvisory(parseMarketplaceDocument(rawBytes));
        if (["block", "clear"].includes(advisory.action) || compromiseResponse) {
            requireActorScope(actor, "manage:advisory", { admin: true });
        } else {
            requireActorScope(actor, "manage:advisory", { publisherId: advisory.publisherId });
        }
        const bytes = marketplaceDocumentBytes(advisory);
        const advisoryHash = hashMarketplaceBytes(bytes);
        return this.store.mutate(async () => {
            const catalog = await this.store.readCatalog();
            const existing = catalog.advisories.find((entry) => entry.advisoryId === advisory.advisoryId);
            if (existing) {
                if (existing.target.sha256 === advisoryHash) return Object.freeze({ advisoryId: advisory.advisoryId, revision: catalog.revision, created: false });
                throw conflict("Advisory identity is immutable.");
            }
            for (const subject of advisory.affected) {
                const owner = await this.#subjectPublisher(catalog, subject);
                if (!owner) throw conflict("Advisory subject is not admitted by this registry.");
                if (!compromiseResponse && owner !== advisory.publisherId) throw conflict("Advisory subject does not belong to its declared publisher.");
            }
            for (const superseded of advisory.supersedes ?? []) {
                if (!catalog.advisories.some((entry) => entry.advisoryId === superseded)) throw conflict("Advisory supersedes an unknown advisory.");
            }
            const relativePath = advisoryTargetPath(advisory.advisoryId, advisoryHash);
            const target = targetDescriptor(relativePath, bytes);
            let next = appendCatalogAdvisory(catalog, { advisoryId: advisory.advisoryId, target });
            next = advanceCatalog(next, this.now);
            const prepared = await prepareCatalogTransaction({
                paths: this.store.paths,
                operation: "admit-advisory",
                baseCatalog: catalog,
                targetCatalog: next,
                writes: [{ destinationPath: relativePath, bytes }],
                faults: this.faults,
            });
            await this.store.commitCatalogMutation(prepared, next);
            return Object.freeze({ advisoryId: advisory.advisoryId, advisoryHash, revision: next.revision, created: true });
        });
    }

    async listAdvisories() {
        const catalog = await this.store.readCatalog();
        const advisories = [];
        for (const summary of catalog.advisories) advisories.push((await this.store.readTarget(summary.target)).document);
        return advisories;
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
        if (!catalog.releaseAuthority) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.UPGRADE_REQUIRED, "Registry catalog predates publisher-signed release authority.");
        }
        for (const summary of catalog.publishers ?? []) {
            const { document } = await this.store.readTarget(summary.target);
            const publisher = assertMarketplacePublisher(document);
            const projected = projectPublisherSummary(publisher, summary.target);
            if (!exactBytesEqual(canonicalMarketplaceBytes(projected), canonicalMarketplaceBytes(summary))) {
                throw recovery("Catalog publisher summary does not match its canonical target.", summary.target.path);
            }
        }
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
            const release = await readCatalogRelease(this.store, catalog, summary);
            const projected = projectReleaseSummary(release, hashMarketplaceRelease(release), summary.target, {
                publisherKeyId: summary.publisherKeyId ?? null,
            });
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
            await verifyEmbeddedPluginReferences(
                this.store,
                catalog,
                release,
                releases,
                (message) => recovery(message, summary.target.path),
            );
        }
        for (const summary of catalog.advisories) {
            const { document } = await this.store.readTarget(summary.target);
            const advisory = assertMarketplaceAdvisory(document);
            if (advisory.advisoryId !== summary.advisoryId) throw recovery("Catalog advisory summary does not match its target.", summary.target.path);
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
            ...(revision.document.publishers ?? []).map((entry) => entry.target.path),
            ...revision.document.items.map((entry) => entry.target.path),
            ...revision.document.releases.map((entry) => entry.target.path),
            ...revision.document.advisories.map((entry) => entry.target.path),
        ]));
        const targetFiles = [
            ...await walkRegularFiles(this.store.paths.publisherTargets),
            ...await walkRegularFiles(this.store.paths.itemTargets),
            ...await walkRegularFiles(this.store.paths.releaseTargets),
            ...await walkRegularFiles(this.store.paths.advisoryTargets),
        ];
        for (const file of targetFiles) {
            const relative = path.relative(this.store.paths.root, file).split(path.sep).join("/");
            if (!referencedTargets.has(relative)) throw recovery("Immutable target is not retained by a catalog revision.", relative);
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
        const tuf = this.store.tufRepository ? await this.store.tufRepository.verify() : null;
        if (tuf && (tuf.catalogRevision !== catalog.revision || tuf.catalogSha256 !== currentData.sha256)) {
            throw recovery("Published TUF catalog is not reconciled with catalog/current.json.");
        }
        return Object.freeze({
            ok: true,
            registryId: this.store.registry.registryId,
            revision: catalog.revision,
            counts: { items: catalog.items.length, releases: catalog.releases.length, blobs: records.length },
            ...(tuf ? { tuf } : {}),
        });
    }

    async planGarbageCollection({ graceMs }) {
        if (!Number.isFinite(graceMs) || graceMs < 0) throw new TypeError("GC graceMs must be non-negative.");
        const marked = new Set();
        const revisionFiles = (await listRegularNames(this.store.paths.catalogRevisions)).map((name) => path.join(this.store.paths.catalogRevisions, name));
        for (const file of revisionFiles) {
            const revision = assertMarketplaceCatalog(parseMarketplaceDocument(await readRegularBytes(file)));
            revision.releases.forEach((release) => marked.add(release.artifact.sha256));
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
