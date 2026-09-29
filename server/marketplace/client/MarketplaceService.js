import { MetadataKind } from "@tufjs/models";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { PluginStore } from "../../storage/PluginStore.js";
import {
    AUTHORING_ONLY_CONTENT_KINDS,
    MARKETPLACE_LIMITS,
    MARKETPLACE_SOURCE_HEALTH,
    artifactByteLimitFor,
} from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalUuid, assertMarketplaceId, assertSha256 } from "../MarketplaceFormats.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";
import {
    atomicReplaceDurable,
    lstatOrNull,
    readRegularBytes,
    removeDirectoryDurable,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import {
    TUF_ROLES,
    hashTufBytes,
    parseTufMetadata,
    rootRegistryId,
    verifyCanonicalTufMetadata,
    verifyTufDelegate,
    verifyTufRootContract,
} from "../registry/TufMetadata.js";
import { inspectPreviewBytes } from "../registry/PreviewMedia.js";
import { createMarketplaceClientArtifactRegistry } from "../ArtifactAdapters.js";
import { MarketplaceArtifactDownloader } from "./MarketplaceArtifactDownloader.js";
import { MarketplaceArtifactStore } from "./MarketplaceArtifactStore.js";
import { createMarketplaceHostProfile, evaluateMarketplaceCompatibility } from "./MarketplaceCompatibility.js";
import { MarketplaceInstalledStore } from "./MarketplaceInstalledStore.js";
import { MarketplaceInstallJobManager } from "./MarketplaceInstallJobManager.js";
import { MarketplaceInstallOwnershipStore } from "./MarketplaceInstallOwnershipStore.js";
import { MarketplaceInstallPlanner } from "./MarketplaceInstallPlanner.js";
import { resolveDependencyDag } from "./MarketplaceDependencyResolver.js";
import { MarketplaceReceiptStore } from "./MarketplaceReceiptStore.js";
import { MarketplaceTransactionCoordinator } from "./MarketplaceTransactionCoordinator.js";
import {
    assertHealthDocument,
    createEmptyHealth,
    healthPath,
    localDocumentBytes,
    marketplaceClientPaths,
    parseLocalDocument,
    trustRootPath,
} from "./MarketplaceClientLayout.js";
import { MarketplaceCredentialStore } from "./MarketplaceCredentialStore.js";
import { MarketplaceSourceStore } from "./MarketplaceSourceStore.js";
import { MarketplaceTrustClient } from "./MarketplaceTrustClient.js";
import { MarketplaceVerifiedCache } from "./MarketplaceVerifiedCache.js";
import { MarketplaceFixedOriginFetcher } from "./MarketplaceFixedOriginFetcher.js";
import {
    assertMarketplaceDetailSelection,
    buildMarketplaceFacets,
    filterCatalogEntries,
    normalizeMarketplaceQuery,
    paginateMarketplaceEntries,
    projectCatalogEntries,
    sortCatalogEntries,
} from "./MarketplaceReadModel.js";

function recovery(message, pathName = null, cause = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName, cause });
}

function assertBearer(value, { nullable = true } = {}) {
    if (value === null && nullable) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== 2 || value.type !== "bearer" || !Object.hasOwn(value, "token")) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "credential must be a bearer credential object.", { path: "credential" });
    }
    if (typeof value.token !== "string" || value.token.length < 1 || Buffer.byteLength(value.token) > 8 * 1024
        || /[\u0000-\u0020\u007f]/u.test(value.token)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "credential.token is invalid.", { path: "credential.token" });
    }
    return Object.freeze({ type: "bearer", token: value.token });
}

async function readCanonicalHealth(filePath) {
    const bytes = await readRegularBytes(filePath, { maxBytes: 32 * 1024 });
    const document = parseLocalDocument(bytes, assertHealthDocument);
    if (!Buffer.from(bytes).equals(Buffer.from(localDocumentBytes(document, assertHealthDocument)))) {
        throw recovery("Marketplace health document is not canonical.", filePath);
    }
    return document;
}

function publicPreview(preview) {
    const { rootBytes: _rootBytes, ...value } = preview;
    return value;
}

function publicSource(source, health) {
    const { credentialRef, ...value } = source;
    return Object.freeze({
        ...value,
        credentialConfigured: credentialRef !== null,
        health,
    });
}

export class MarketplaceService {
    #sourceQueues = new Map();
    #controllers = new Set();
    #closed = false;

    constructor({
        paths,
        sourceStore,
        credentialStore,
        cache,
        trustClient,
        installedStore,
        ownershipStore,
        receiptStore,
        artifactStore,
        planner,
        transactionCoordinator,
        jobManager,
        adapterRegistry,
        hostProfileProvider,
        now,
    }) {
        this.paths = paths;
        this.sourceStore = sourceStore;
        this.credentialStore = credentialStore;
        this.cache = cache;
        this.trustClient = trustClient;
        this.installedStore = installedStore;
        this.ownershipStore = ownershipStore;
        this.receiptStore = receiptStore;
        this.artifactStore = artifactStore;
        this.planner = planner;
        this.transactionCoordinator = transactionCoordinator;
        this.jobManager = jobManager;
        this.adapterRegistry = adapterRegistry;
        this.hostProfileProvider = hostProfileProvider;
        this.now = now;
    }

    static async open(dataDir, {
        fetchImpl = globalThis.fetch,
        now = () => new Date(),
        cacheFault = null,
        transactionFault = null,
        jobFault = null,
        adapterRegistry = null,
        pluginStore = null,
        storageService = null,
        editorAssetStore = null,
        visualAssetStore = null,
        publishPluginLibraryChange = null,
        hostProfileProvider = async () => createMarketplaceHostProfile(),
        releasePolicy,
    } = {}) {
        const resolvedPluginStore = pluginStore ?? new PluginStore(dataDir);
        await resolvedPluginStore.ensureOwnershipMigration();
        const sourceStore = await MarketplaceSourceStore.open(dataDir);
        const credentialStore = await MarketplaceCredentialStore.open(dataDir);
        const cache = await MarketplaceVerifiedCache.open(dataDir, { now, fault: cacheFault });
        const installedStore = await MarketplaceInstalledStore.open(dataDir);
        const ownershipStore = await MarketplaceInstallOwnershipStore.open(dataDir, await installedStore.snapshot(), { allowPending: true });
        const receiptStore = await MarketplaceReceiptStore.open(dataDir);
        const resolvedAdapterRegistry = adapterRegistry ?? createMarketplaceClientArtifactRegistry({
            pluginStore: resolvedPluginStore,
            publishLibraryChange: publishPluginLibraryChange,
            storageService,
            editorAssetStore,
            visualAssetStore,
            receiptStore,
        });
        const artifactStore = await MarketplaceArtifactStore.open(dataDir, { now });
        const planner = await MarketplaceInstallPlanner.create(dataDir, {
            sourceStore,
            cache,
            installedStore,
            ownershipStore,
            artifactStore,
            adapterRegistry: resolvedAdapterRegistry,
            hostProfileProvider,
            ...(releasePolicy ? { releasePolicy } : {}),
        });
        const transactionCoordinator = await MarketplaceTransactionCoordinator.create(dataDir, {
            planner,
            installedStore,
            ownershipStore,
            receiptStore,
            artifactStore,
            adapterRegistry: resolvedAdapterRegistry,
            now,
            fault: transactionFault,
        });
        const downloader = new MarketplaceArtifactDownloader({
            artifactStore,
            credentialStore,
            fetchImpl,
        });
        const jobManager = await MarketplaceInstallJobManager.create(dataDir, {
            planner,
            downloader,
            coordinator: transactionCoordinator,
            sourceStore,
            now,
            fault: jobFault,
        });
        const service = new MarketplaceService({
            paths: marketplaceClientPaths(dataDir),
            sourceStore,
            credentialStore,
            cache,
            trustClient: new MarketplaceTrustClient({ fetchImpl, now }),
            installedStore,
            ownershipStore,
            receiptStore,
            artifactStore,
            planner,
            transactionCoordinator,
            jobManager,
            adapterRegistry: resolvedAdapterRegistry,
            hostProfileProvider,
            now,
        });
        const snapshot = sourceStore.snapshot();
        await credentialStore.recover(snapshot.sources.flatMap((source) => source.credentialRef ? [source.credentialRef] : []));
        await cache.recover(snapshot.sources.map((source) => source.sourceId));
        await service.#recoverOperationalState(snapshot.sources);
        await planner.recover();
        const recoveredTransactions = await transactionCoordinator.recoverPending();
        ownershipStore.verifyAgainstInstalled(await ownershipStore.snapshot(), await installedStore.snapshot());
        await jobManager.recover(recoveredTransactions);
        return service;
    }

    #assertOpen() {
        if (this.#closed) throw marketplaceError(MARKETPLACE_ERROR_CODES.CANCELLED, "Marketplace service is closed.");
    }

    async #readTrust(source) {
        const filePath = trustRootPath(this.paths, source.sourceId);
        const bytes = await readRegularBytes(filePath, { maxBytes: 512_000 });
        const root = parseTufMetadata(bytes, MetadataKind.Root);
        verifyCanonicalTufMetadata({ bytes, metadata: root }, "trusted bootstrap root");
        verifyTufRootContract(root);
        verifyTufDelegate(root, TUF_ROLES.ROOT, root);
        if (hashTufBytes(bytes) !== source.trustedRootFingerprint || rootRegistryId(root) !== source.registryId) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace trust root does not match configured source identity.");
        }
        return Object.freeze({ bytes, root });
    }

    async #readHealth(sourceId) {
        const filePath = healthPath(this.paths, sourceId);
        if (!await lstatOrNull(filePath)) return createEmptyHealth(sourceId);
        const health = await readCanonicalHealth(filePath);
        if (health.sourceId !== sourceId) throw recovery("Marketplace health document has the wrong source ID.", filePath);
        return health;
    }

    async #writeHealth(document) {
        const validated = assertHealthDocument(document);
        await atomicReplaceDurable(
            healthPath(this.paths, validated.sourceId),
            localDocumentBytes(validated, assertHealthDocument),
        );
        return validated;
    }

    async #health(source) {
        const operational = await this.#readHealth(source.sourceId);
        if (!source.enabled) {
            return Object.freeze({
                status: MARKETPLACE_SOURCE_HEALTH.DISABLED,
                usableOffline: false,
                lastAttemptAt: operational.lastAttemptAt,
                lastSuccessAt: operational.lastSuccessAt,
                lastErrorCode: operational.lastErrorCode,
                catalogRevision: operational.catalogRevision,
                catalogSha256: operational.catalogSha256,
                earliestExpiryAt: operational.earliestExpiryAt,
            });
        }
        let current = null;
        try {
            await this.#readTrust(source);
            current = await this.cache.readCurrent(source);
        } catch {
            return Object.freeze({
                status: MARKETPLACE_SOURCE_HEALTH.UNTRUSTED,
                usableOffline: false,
                lastAttemptAt: operational.lastAttemptAt,
                lastSuccessAt: operational.lastSuccessAt,
                lastErrorCode: operational.lastErrorCode,
                catalogRevision: operational.catalogRevision,
                catalogSha256: operational.catalogSha256,
                earliestExpiryAt: operational.earliestExpiryAt,
            });
        }
        let status;
        if (current?.expired) status = MARKETPLACE_SOURCE_HEALTH.EXPIRED;
        else if (operational.lastErrorCode === MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE) status = MARKETPLACE_SOURCE_HEALTH.OFFLINE;
        else if (!operational.lastSuccessAt || operational.lastErrorCode) status = MARKETPLACE_SOURCE_HEALTH.STALE;
        else status = MARKETPLACE_SOURCE_HEALTH.READY;
        return Object.freeze({
            status,
            usableOffline: Boolean(current),
            lastAttemptAt: operational.lastAttemptAt,
            lastSuccessAt: operational.lastSuccessAt,
            lastErrorCode: operational.lastErrorCode,
            catalogRevision: operational.catalogRevision,
            catalogSha256: operational.catalogSha256,
            earliestExpiryAt: operational.earliestExpiryAt,
        });
    }

    async #recoverOperationalState(sources) {
        const configured = new Map(sources.map((source) => [source.sourceId, source]));
        for (const entry of await fs.readdir(this.paths.trust, { withFileTypes: true })) {
            const entryPath = path.join(this.paths.trust, entry.name);
            if (entry.isSymbolicLink() || !entry.isDirectory()) throw recovery("Marketplace trust store contains a hostile node.", entryPath);
            if (!configured.has(entry.name)) await removeDirectoryDurable(entryPath);
        }
        for (const entry of await fs.readdir(this.paths.health, { withFileTypes: true })) {
            const entryPath = path.join(this.paths.health, entry.name);
            if (entry.isSymbolicLink() || !entry.isFile()) throw recovery("Marketplace health store contains a hostile node.", entryPath);
            const match = /^([a-f0-9-]{36})\.json$/u.exec(entry.name);
            if (!match) throw recovery("Marketplace health store contains an unexpected filename.", entryPath);
            if (!configured.has(match[1])) await fs.rm(entryPath);
        }
        for (const source of sources) {
            await this.#readTrust(source);
            const filePath = healthPath(this.paths, source.sourceId);
            if (await lstatOrNull(filePath)) await this.#readHealth(source.sourceId);
            else await this.#writeHealth(createEmptyHealth(source.sourceId));
        }
    }

    async listSources() {
        this.#assertOpen();
        const snapshot = this.sourceStore.snapshot();
        const sources = await Promise.all(snapshot.sources.map(async (source) => publicSource(source, await this.#health(source))));
        return Object.freeze({ revision: snapshot.revision, sources });
    }

    async previewSource(input) {
        this.#assertOpen();
        const { baseUrl } = input;
        const normalized = Object.hasOwn(input, "credential") ? assertBearer(input.credential, { nullable: false }) : null;
        return publicPreview(await this.trustClient.previewSource({ baseUrl, credential: normalized }));
    }

    async addSource(input) {
        this.#assertOpen();
        const {
            expectedRevision,
            name,
            baseUrl,
            registryId,
            trustedRootFingerprint,
            enabled,
            priority,
        } = input;
        const normalized = Object.hasOwn(input, "credential") ? assertBearer(input.credential, { nullable: false }) : null;
        const preview = await this.trustClient.previewSource({ baseUrl, credential: normalized });
        if (preview.registryId !== registryId || preview.trustedRootFingerprint !== trustedRootFingerprint) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace source confirmation does not match the discovered registry trust root.");
        }
        const sourceId = randomUUID();
        const credentialRef = normalized ? await this.credentialStore.stageBearer(normalized.token) : null;
        const rootPath = trustRootPath(this.paths, sourceId);
        const health = createEmptyHealth(sourceId);
        let visible = false;
        try {
            await writeExclusiveDurable(rootPath, preview.rootBytes);
            await this.#writeHealth(health);
            const result = await this.sourceStore.add({
                sourceId,
                registryId,
                name,
                baseUrl,
                trustedRootFingerprint,
                enabled,
                priority,
                credentialRef,
            }, expectedRevision);
            visible = true;
            return Object.freeze({
                revision: result.document.revision,
                source: publicSource(result.source, await this.#health(result.source)),
            });
        } finally {
            if (!visible) {
                await this.credentialStore.remove(credentialRef).catch(() => {});
                await removeDirectoryDurable(path.dirname(rootPath)).catch(() => {});
                await fs.rm(healthPath(this.paths, sourceId), { force: true }).catch(() => {});
            }
        }
    }

    async updateSource(sourceId, { expectedRevision, credential, ...patch }) {
        this.#assertOpen();
        assertCanonicalUuid(sourceId, "sourceId");
        return this.#serializeSource(sourceId, async () => {
            this.#assertOpen();
            const allowed = new Set(["name", "enabled", "priority"]);
            for (const key of Object.keys(patch)) if (!allowed.has(key)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Source field ${key} is immutable or unsupported.`, { path: key });
            }
            const current = this.sourceStore.get(sourceId);
            if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace source was not found.");
            const credentialSupplied = credential !== undefined;
            const normalized = credentialSupplied ? assertBearer(credential) : null;
            const newCredentialRef = credentialSupplied && normalized ? await this.credentialStore.stageBearer(normalized.token) : null;
            let result;
            try {
                result = await this.sourceStore.update(sourceId, {
                    ...patch,
                    ...(credentialSupplied ? { credentialRef: newCredentialRef } : {}),
                }, expectedRevision);
            } catch (error) {
                if (newCredentialRef) await this.credentialStore.remove(newCredentialRef).catch(() => {});
                throw error;
            }
            if (credentialSupplied) await this.credentialStore.remove(current.credentialRef).catch(() => {});
            return Object.freeze({
                revision: result.document.revision,
                source: publicSource(result.source, await this.#health(result.source)),
            });
        });
    }

    async removeSource(sourceId, expectedRevision) {
        this.#assertOpen();
        assertCanonicalUuid(sourceId, "sourceId");
        return this.#serializeSource(sourceId, async () => {
            this.#assertOpen();
            if (await this.jobManager.hasNonterminalSource(sourceId)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace source has a nonterminal installation job.");
            }
            const result = await this.sourceStore.remove(sourceId, expectedRevision);
            const cleanup = await Promise.allSettled([
                this.credentialStore.remove(result.removed.credentialRef),
                fs.rm(path.dirname(trustRootPath(this.paths, sourceId)), { recursive: true, force: true }),
                fs.rm(healthPath(this.paths, sourceId), { force: true }),
                this.cache.removeSource(sourceId),
            ]);
            const failed = cleanup.find((entry) => entry.status === "rejected");
            if (failed) throw recovery("Marketplace source was removed but local cleanup requires recovery.", null, failed.reason);
            return Object.freeze({ revision: result.document.revision });
        });
    }

    #serializeSource(sourceId, operation) {
        const previous = this.#sourceQueues.get(sourceId) ?? Promise.resolve();
        const current = previous.catch(() => {}).then(operation);
        this.#sourceQueues.set(sourceId, current);
        return current.finally(() => {
            if (this.#sourceQueues.get(sourceId) === current) this.#sourceQueues.delete(sourceId);
        });
    }

    async refreshSource(sourceId, { expectedRevision }) {
        this.#assertOpen();
        assertCanonicalUuid(sourceId, "sourceId");
        return this.#serializeSource(sourceId, async () => {
            this.#assertOpen();
            const starting = this.sourceStore.snapshot();
            if (starting.revision !== expectedRevision) {
                const error = marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace source revision conflict.");
                error.currentRevision = starting.revision;
                throw error;
            }
            const source = starting.sources.find((entry) => entry.sourceId === sourceId);
            if (!source) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace source was not found.");
            if (!source.enabled) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Disabled marketplace sources cannot be refreshed.");
            const attemptAt = this.now().toISOString();
            const controller = new AbortController();
            this.#controllers.add(controller);
            let staging = null;
            try {
                const trust = await this.#readTrust(source);
                const bearerToken = await this.credentialStore.readBearer(source.credentialRef);
                let current = null;
                try {
                    current = await this.cache.readCurrent(source);
                } catch {
                    // A fresh online verification may recover from a damaged or
                    // unverifiable cache by starting again at the pinned root.
                }
                staging = await this.cache.stageRefresh(sourceId);
                const result = await this.trustClient.refreshSource({
                    source,
                    bearerToken,
                    bootstrapRootBytes: trust.bytes,
                    staging,
                    previousSnapshotRoot: current?.snapshotRoot ?? null,
                    signal: controller.signal,
                });
                if (current && (result.manifest.catalog.revision < current.manifest.catalog.revision
                    || (result.manifest.catalog.revision === current.manifest.catalog.revision
                        && result.manifest.catalog.sha256 !== current.manifest.catalog.sha256))) {
                    throw marketplaceError(
                        MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID,
                        "Marketplace catalog revision was rolled back or rewritten.",
                    );
                }
                const latest = this.sourceStore.snapshot();
                const latestSource = latest.sources.find((entry) => entry.sourceId === sourceId);
                if (latest.revision !== expectedRevision || JSON.stringify(latestSource) !== JSON.stringify(source)) {
                    const error = marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace source changed during refresh.");
                    error.currentRevision = latest.revision;
                    throw error;
                }
                const published = await this.cache.publish(source, staging, result);
                staging = null;
                const successAt = this.now().toISOString();
                const operational = await this.#writeHealth({
                    ...createEmptyHealth(sourceId),
                    lastAttemptAt: attemptAt,
                    lastSuccessAt: successAt,
                    snapshotId: published.manifest.snapshotId,
                    catalogRevision: published.manifest.catalog.revision,
                    catalogSha256: published.manifest.catalog.sha256,
                    earliestExpiryAt: result.earliestExpiryAt,
                });
                return Object.freeze({
                    snapshotId: published.manifest.snapshotId,
                    catalogRevision: published.manifest.catalog.revision,
                    catalogSha256: published.manifest.catalog.sha256,
                    health: await this.#health(source),
                    lastSuccessAt: operational.lastSuccessAt,
                });
            } catch (error) {
                const code = error instanceof MarketplaceError ? error.code : MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID;
                if (this.sourceStore.get(sourceId)) {
                    const existing = await this.#readHealth(sourceId).catch(() => createEmptyHealth(sourceId));
                    await this.#writeHealth({ ...existing, lastAttemptAt: attemptAt, lastErrorCode: code }).catch(() => {});
                }
                throw error;
            } finally {
                this.#controllers.delete(controller);
                if (staging) await removeDirectoryDurable(staging.root).catch(() => {});
            }
        });
    }

    #requireSource(sourceId) {
        const source = this.sourceStore.get(sourceId);
        if (!source) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace source was not found.");
        if (!source.enabled) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace source is disabled.");
        return source;
    }

    async readVerifiedCatalog(sourceId, options = {}) {
        this.#assertOpen();
        return this.cache.readCatalog(this.#requireSource(sourceId), options);
    }

    async readVerifiedItem(sourceId, itemId, options = {}) {
        this.#assertOpen();
        return this.cache.readItem(this.#requireSource(sourceId), itemId, options);
    }

    async readVerifiedRelease(sourceId, itemId, releaseVersion, options = {}) {
        this.#assertOpen();
        return this.cache.readRelease(this.#requireSource(sourceId), itemId, releaseVersion, options);
    }

    async searchCatalog(filters = {}) {
        this.#assertOpen();
        const query = normalizeMarketplaceQuery(filters);
        const snapshot = this.sourceStore.snapshot();
        const publicSources = [];
        const entries = [];
        for (const source of snapshot.sources) {
            const health = await this.#health(source);
            publicSources.push(publicSource(source, health));
            if (!source.enabled) continue;
            const current = await this.cache.readCurrent(source);
            if (!current) continue;
            const itemsById = new Map(current.documents.items.map((item) => [item.itemId, item]));
            entries.push(...projectCatalogEntries({
                source,
                health,
                catalog: current.catalog,
                itemsById,
                track: query.track,
                fresh: current.fresh && health.status === MARKETPLACE_SOURCE_HEALTH.READY,
            }));
        }
        const sorted = sortCatalogEntries(entries);
        const filtered = filterCatalogEntries(sorted, query);
        const paginated = paginateMarketplaceEntries(filtered, query);
        return Object.freeze({
            sourcesRevision: snapshot.revision,
            sources: Object.freeze(publicSources),
            query,
            page: paginated.page,
            entries: Object.freeze(paginated.entries),
            facets: buildMarketplaceFacets(sorted),
        });
    }

    async getCatalogItem(sourceId, itemId, { releaseVersion = null } = {}) {
        this.#assertOpen();
        assertCanonicalUuid(sourceId, "sourceId");
        assertMarketplaceId(itemId, "itemId");
        const source = this.#requireSource(sourceId);
        const current = await this.cache.readCurrent(source);
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace source has no verified snapshot.");
        const item = current.documents.items.find((entry) => entry.itemId === itemId);
        if (!item) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace item is not present in the verified snapshot.");
        const selectedSummary = assertMarketplaceDetailSelection(current.catalog, itemId, releaseVersion);
        if (!selectedSummary) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace release is not present in the verified snapshot.");
        const selectedRelease = current.documents.releases.find((entry) => entry.itemId === itemId
            && entry.releaseVersion === selectedSummary.releaseVersion);
        if (!selectedRelease) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace verified snapshot is incomplete.");
        const releases = current.catalog.releases.filter((entry) => entry.itemId === itemId);
        const tracks = Object.fromEntries(current.catalog.tracks
            .filter((entry) => entry.itemId === itemId)
            .map((entry) => [entry.track, entry.releaseVersion]));
        const yanks = current.catalog.yanks.filter((entry) => entry.release.itemId === itemId);
        const health = await this.#health(source);
        const hostProfile = await this.hostProfileProvider();
        const compatibility = evaluateMarketplaceCompatibility(selectedRelease.compatibility, hostProfile);
        const isCollection = selectedRelease.contentKind === "collection";
        const lifecycleAvailable = this.adapterRegistry.hasLifecycle(selectedRelease.contentKind);
        const lifecycleIssues = !lifecycleAvailable ? [{
                path: "contentKind",
                code: "LIFECYCLE_UNAVAILABLE",
                required: selectedRelease.contentKind,
                actual: null,
            }] : [];
        const closure = isCollection ? resolveDependencyDag({
            rootRelease: {
                itemId: selectedRelease.itemId,
                releaseVersion: selectedRelease.releaseVersion,
                artifactSha256: selectedRelease.artifact.sha256,
            },
            catalog: current.catalog,
            releases: current.documents.releases,
        }).releases : [selectedRelease];
        const oversized = closure.filter((release) => release.artifact.sizeBytes > artifactByteLimitFor(release.contentKind));
        const sizeAllowed = oversized.length === 0;
        const downloadIssues = oversized.map((release) => ({
            path: release.itemId === selectedRelease.itemId && release.releaseVersion === selectedRelease.releaseVersion
                ? "artifact.sizeBytes"
                : `dependencies.${release.itemId}.artifact.sizeBytes`,
            code: "ARTIFACT_LIMIT_EXCEEDED",
            required: artifactByteLimitFor(release.contentKind),
            actual: release.artifact.sizeBytes,
        }));
        const authoringOnly = AUTHORING_ONLY_CONTENT_KINDS.includes(selectedRelease.contentKind);
        const nonExecutable = authoringOnly || isCollection;
        const issues = [...downloadIssues, ...lifecycleIssues, ...(nonExecutable ? [] : compatibility.issues)];
        const selectedExactKey = `${selectedRelease.itemId}\u0000${selectedRelease.releaseVersion}\u0000${selectedRelease.artifact.sha256}`;
        const warnings = yanks.some((entry) => (
            `${entry.release.itemId}\u0000${entry.release.releaseVersion}\u0000${entry.release.artifactSha256}` === selectedExactKey
        )) ? [`Exact release ${selectedRelease.itemId}@${selectedRelease.releaseVersion} is yanked.`] : [];
        const eligibility = Object.freeze({
            lifecycleAvailable,
            compatible: compatibility.compatible,
            downloadable: Object.freeze({
                status: sizeAllowed ? "eligible" : "blocked",
                issues: Object.freeze(downloadIssues),
            }),
            importable: Object.freeze({
                status: lifecycleAvailable ? (nonExecutable ? "requires-inspection" : "eligible") : "blocked",
                issues: Object.freeze(lifecycleIssues),
            }),
            executable: Object.freeze({
                status: nonExecutable ? "not-applicable" : (compatibility.compatible ? "eligible" : "blocked"),
                issues: Object.freeze(nonExecutable ? [] : compatibility.issues),
            }),
            canInstall: sizeAllowed && lifecycleAvailable && (nonExecutable || compatibility.compatible),
            issues: Object.freeze(issues),
            warnings: Object.freeze(warnings),
        });
        const itemsById = new Map(current.documents.items.map((candidate) => [candidate.itemId, candidate]));
        const releasesByExact = new Map(current.documents.releases.map((candidate) => [
            `${candidate.itemId}\u0000${candidate.releaseVersion}\u0000${candidate.artifact.sha256}`,
            candidate,
        ]));
        const collectionMembers = isCollection ? selectedRelease.dependencies.map((reference) => {
            const memberRelease = releasesByExact.get(`${reference.itemId}\u0000${reference.releaseVersion}\u0000${reference.artifactSha256}`);
            const memberItem = itemsById.get(reference.itemId);
            if (!memberRelease || !memberItem) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Collection member is missing from the verified snapshot.");
            return Object.freeze({
                release: reference,
                name: memberItem.displayName,
                contentKind: memberItem.contentKind,
                publisherId: memberItem.publisherId,
                releaseHash: current.catalog.releases.find((candidate) => candidate.itemId === reference.itemId
                    && candidate.releaseVersion === reference.releaseVersion)?.releaseHash,
            });
        }) : [];
        return Object.freeze({
            source: publicSource(source, health),
            item,
            selectedRelease,
            selectedReleaseHash: selectedSummary.releaseHash,
            releases: Object.freeze(releases),
            tracks: Object.freeze(tracks),
            yanks: Object.freeze(yanks),
            verification: current.verification,
            fresh: current.fresh && health.status === MARKETPLACE_SOURCE_HEALTH.READY,
            eligibility,
            canInstall: eligibility.canInstall,
            collectionMembers: Object.freeze(collectionMembers),
        });
    }

    status() {
        this.#assertOpen();
        return Object.freeze({ mode: "coordinator", canInstall: this.adapterRegistry.hasLifecycle() });
    }

    async createInstallPlan(input) {
        this.#assertOpen();
        const result = await this.planner.createPreflight(input);
        return Object.freeze({
            planHash: result.planHash,
            createdAt: this.now().toISOString(),
            preflight: result.plan,
        });
    }

    async #jobView(job) {
        return Object.freeze({
            job,
            finalPlan: job.finalPlanHash ? await this.planner.readFinalPlan(job.finalPlanHash) : null,
        });
    }

    async startInstallJob(planHash) {
        this.#assertOpen();
        return this.#jobView(await this.jobManager.start(planHash));
    }

    async getInstallJob(jobId) {
        this.#assertOpen();
        return this.#jobView(await this.jobManager.snapshot(jobId));
    }

    subscribeInstallJob(jobId, listener, options = {}) {
        this.#assertOpen();
        let sequence = Promise.resolve();
        return this.jobManager.subscribe(jobId, (job) => {
            sequence = sequence.then(async () => listener(await this.#jobView(job))).catch(() => {});
        }, options);
    }

    async confirmInstallJob(jobId, input) {
        this.#assertOpen();
        return this.#jobView(await this.jobManager.confirmCommit(jobId, input));
    }

    async cancelInstallJob(jobId, expectedRevision) {
        this.#assertOpen();
        return this.#jobView(await this.jobManager.cancel(jobId, expectedRevision));
    }

    async resumeInstallJob(jobId, expectedRevision) {
        this.#assertOpen();
        return this.#jobView(await this.jobManager.resume(jobId, expectedRevision));
    }

    async replanInstallJob(jobId, expectedRevision) {
        this.#assertOpen();
        return this.#jobView(await this.jobManager.replan(jobId, expectedRevision));
    }

    async listInstallJobOperations(jobId, { offset = "0", limit = "100", status = null } = {}) {
        this.#assertOpen();
        const parsedOffset = Number(offset);
        const parsedLimit = Number(limit);
        if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0 || !Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 500) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Operation pagination is invalid.");
        }
        if (status !== null && !["pending", "complete"].includes(status)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Operation status filter is invalid.");
        }
        const operations = await this.jobManager.listOperations(jobId);
        const filtered = status ? operations.filter((entry) => entry.status === status) : operations;
        return Object.freeze({ total: filtered.length, offset: parsedOffset, limit: parsedLimit, entries: Object.freeze(filtered.slice(parsedOffset, parsedOffset + parsedLimit)) });
    }

    async listInstalled() {
        this.#assertOpen();
        return this.installedStore.snapshot();
    }

    async listInstalledOwnership() {
        this.#assertOpen();
        const installed = await this.installedStore.snapshot();
        const ownership = await this.ownershipStore.snapshot();
        this.ownershipStore.verifyAgainstInstalled(ownership, installed);
        return ownership;
    }

    async readReceipt(receiptHash) {
        this.#assertOpen();
        return this.receiptStore.read(receiptHash);
    }

    async removeInstalled(request) {
        this.#assertOpen();
        return this.transactionCoordinator.removeMembership(request);
    }

    async readVerifiedPreview(sourceId, itemId, digest) {
        this.#assertOpen();
        assertCanonicalUuid(sourceId, "sourceId");
        assertMarketplaceId(itemId, "itemId");
        assertSha256(digest, "digest");
        const source = this.#requireSource(sourceId);
        const current = await this.cache.readCurrent(source);
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace source has no verified snapshot.");
        const item = current.documents.items.find((entry) => entry.itemId === itemId);
        const descriptor = item?.previews?.find((entry) => entry.sha256 === digest);
        if (!descriptor) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace preview is not present in the verified item.");
        const pathName = `/v1/blobs/sha256/${digest}`;
        const fetcher = new MarketplaceFixedOriginFetcher({
            baseUrl: source.baseUrl,
            bearerToken: await this.credentialStore.readBearer(source.credentialRef),
            fetchImpl: this.trustClient.fetchImpl,
        });
        fetcher.allowPath(pathName);
        let bytes;
        try {
            bytes = Buffer.from(await fetcher.downloadBytes(
                fetcher.url(pathName),
                Math.min(MARKETPLACE_LIMITS.previewBytes, descriptor.sizeBytes) + 1,
            ));
        } catch (error) {
            if (error instanceof MarketplaceError) throw error;
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace preview is unavailable.", { cause: error });
        }
        if (bytes.byteLength !== descriptor.sizeBytes || hashMarketplaceBytes(bytes) !== descriptor.sha256) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Marketplace preview bytes do not match the verified descriptor.");
        }
        const inspected = await inspectPreviewBytes(bytes, { mediaType: descriptor.mediaType });
        if (inspected.sha256 !== descriptor.sha256 || inspected.sizeBytes !== descriptor.sizeBytes) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Marketplace preview inspection does not match the verified descriptor.");
        }
        return Object.freeze({ bytes, descriptor });
    }

    async close() {
        if (this.#closed) return;
        this.#closed = true;
        for (const controller of this.#controllers) controller.abort();
        await this.jobManager.close();
        await this.transactionCoordinator.close();
        await this.installedStore.close();
        await this.ownershipStore.close();
        await Promise.allSettled(this.#sourceQueues.values());
    }
}
