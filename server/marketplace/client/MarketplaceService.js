import { MetadataKind } from "@tufjs/models";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import semver from "semver";

import { PluginStore } from "../../storage/PluginStore.js";
import {
    AUTHORING_ONLY_CONTENT_KINDS,
    MARKETPLACE_ARTIFACTS,
    MARKETPLACE_LIMITS,
    MARKETPLACE_SOURCE_HEALTH,
    artifactByteLimitFor,
} from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalUuid, assertMarketplaceId, assertReleaseVersion, assertSha256 } from "../MarketplaceFormats.js";
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
import { MarketplacePolicyStore } from "./MarketplacePolicyStore.js";
import { MarketplaceExecutableProvenanceStore } from "./MarketplaceExecutableProvenanceStore.js";
import { MarketplaceExecutablePolicy } from "./MarketplaceExecutablePolicy.js";
import { MarketplaceUpdateModel } from "./MarketplaceUpdateModel.js";
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
import { MarketplacePublicationCatalog } from "./MarketplacePublicationCatalog.js";
import {
    MarketplacePublicationDraftStore,
    MarketplacePublisherProfileStore,
    MarketplacePublisherSecretStore,
    createPublicationDraft,
    createPublisherProfile,
} from "./MarketplacePublisherStores.js";
import {
    MarketplacePublicationArtifactBuilder,
    MarketplacePublicationPlanner,
} from "./MarketplacePublicationPlanner.js";
import { MarketplacePublishJobManager } from "./MarketplacePublishJobManager.js";
import { MarketplacePublicationDependencyResolver } from "./MarketplacePublicationDependencyResolver.js";
import { MarketplaceLibraryReadModel } from "./MarketplaceLibraryReadModel.js";
import { MarketplaceConnectionPolicy } from "./MarketplaceConnectionPolicy.js";
import { normalizeMarketplaceOrigin } from "./MarketplaceConnectionDocuments.js";
import { MarketplacePublishingIdentityManager } from "./MarketplacePublishingIdentityManager.js";
import {
    MarketplacePublicationBindingReconciler,
    MarketplacePublicationBindingStore,
    publicationLocalIdentity,
} from "./MarketplacePublicationBindingStore.js";
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
    const allowed = new Set(["type", "token", "privateCaCertificates", "clientCertificate", "clientPrivateKey"]);
    if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "bearer"
        || !Object.hasOwn(value, "token") || Object.keys(value).some((key) => !allowed.has(key))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "credential must be a bearer credential object.", { path: "credential" });
    }
    if (typeof value.token !== "string" || value.token.length < 1 || Buffer.byteLength(value.token) > 8 * 1024
        || /[\u0000-\u0020\u007f]/u.test(value.token)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "credential.token is invalid.", { path: "credential.token" });
    }
    const privateCaCertificates = value.privateCaCertificates ?? [];
    if (!Array.isArray(privateCaCertificates) || privateCaCertificates.length > 16
        || privateCaCertificates.some((entry) => typeof entry !== "string" || !entry.includes("BEGIN CERTIFICATE") || Buffer.byteLength(entry) > 1024 ** 2)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "credential.privateCaCertificates is invalid.", { path: "credential.privateCaCertificates" });
    }
    const hasCertificate = value.clientCertificate !== undefined;
    const hasPrivateKey = value.clientPrivateKey !== undefined;
    if (hasCertificate !== hasPrivateKey || (hasCertificate && (
        typeof value.clientCertificate !== "string" || !value.clientCertificate.includes("BEGIN CERTIFICATE")
        || typeof value.clientPrivateKey !== "string" || !value.clientPrivateKey.includes("PRIVATE KEY")
        || Buffer.byteLength(value.clientCertificate) > 1024 ** 2 || Buffer.byteLength(value.clientPrivateKey) > 1024 ** 2
    ))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "credential client certificate pair is invalid.", { path: "credential.clientCertificate" });
    }
    return Object.freeze({
        type: "bearer",
        token: value.token,
        ...(privateCaCertificates.length ? { privateCaCertificates: Object.freeze([...privateCaCertificates]) } : {}),
        ...(hasCertificate ? { clientCertificate: value.clientCertificate, clientPrivateKey: value.clientPrivateKey } : {}),
    });
}

async function readCanonicalHealth(filePath) {
    const bytes = await readRegularBytes(filePath, { maxBytes: 32 * 1024 });
    const document = parseLocalDocument(bytes, assertHealthDocument);
    if (!Buffer.from(bytes).equals(Buffer.from(localDocumentBytes(document, assertHealthDocument)))) {
        throw recovery("Marketplace health document is not canonical.", filePath);
    }
    return document;
}

function executablePackageHashes(release) {
    return [
        ...(release.executable ? [release.executable.packageHash] : []),
        ...(release.embeddedPlugins?.map((plugin) => plugin.packageHash) ?? []),
    ];
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
        policyStore,
        provenanceStore,
        executablePolicy,
        updateModel,
        publicationCatalog,
        publisherProfileStore,
        publisherSecretStore,
        publicationDraftStore,
        publicationPlanner,
        publishJobManager,
        connectionPolicy,
        publishingIdentityManager,
        publicationBindingStore,
        publicationBindingReconciler,
        publicationDependencyResolver,
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
        this.policyStore = policyStore;
        this.provenanceStore = provenanceStore;
        this.executablePolicy = executablePolicy;
        this.updateModel = updateModel;
        this.publicationCatalog = publicationCatalog;
        this.publisherProfileStore = publisherProfileStore;
        this.publisherSecretStore = publisherSecretStore;
        this.publicationDraftStore = publicationDraftStore;
        this.publicationPlanner = publicationPlanner;
        this.publishJobManager = publishJobManager;
        this.connectionPolicy = connectionPolicy;
        this.publishingIdentityManager = publishingIdentityManager;
        this.publicationBindingStore = publicationBindingStore;
        this.publicationBindingReconciler = publicationBindingReconciler;
        this.publicationDependencyResolver = publicationDependencyResolver;
        this.hostProfileProvider = hostProfileProvider;
        this.now = now;
        this.libraryReadModel = new MarketplaceLibraryReadModel(this);
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
        connectionDirectory = null,
    } = {}) {
        const resolvedPluginStore = pluginStore ?? new PluginStore(dataDir);
        await resolvedPluginStore.ensureOwnershipMigration();
        const sourceStore = await MarketplaceSourceStore.open(dataDir);
        const credentialStore = await MarketplaceCredentialStore.open(dataDir);
        const cache = await MarketplaceVerifiedCache.open(dataDir, { now, fault: cacheFault });
        const installedStore = await MarketplaceInstalledStore.open(dataDir);
        const policyStore = await MarketplacePolicyStore.open(dataDir, { now });
        const provenanceStore = await MarketplaceExecutableProvenanceStore.open(dataDir);
        const executablePolicy = new MarketplaceExecutablePolicy({ policyStore, provenanceStore });
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
            receiptStore,
            policyStore,
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
            provenanceStore,
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
        const updateModel = new MarketplaceUpdateModel({ sourceStore, cache, installedStore, policyStore });
        const connectionPolicy = await MarketplaceConnectionPolicy.open(dataDir, { directory: connectionDirectory });
        let publisherProfileStore = null;
        let publisherSecretStore = null;
        let publicationDraftStore = null;
        let publicationCatalog = null;
        let publicationPlanner = null;
        let publishJobManager = null;
        let publishingIdentityManager = null;
        let publicationBindingStore = null;
        let publicationBindingReconciler = null;
        let publicationDependencyResolver = null;
        if (storageService && editorAssetStore && visualAssetStore) {
            publisherProfileStore = await MarketplacePublisherProfileStore.open(dataDir);
            publisherSecretStore = await MarketplacePublisherSecretStore.open(dataDir);
            publicationDraftStore = await MarketplacePublicationDraftStore.open(dataDir);
            publicationBindingStore = await MarketplacePublicationBindingStore.open(dataDir, { now });
            publicationCatalog = new MarketplacePublicationCatalog({
                storageService,
                editorAssetStore,
                draftStore: publicationDraftStore,
                bindingStore: publicationBindingStore,
            });
            const publicationArtifactBuilder = new MarketplacePublicationArtifactBuilder({
                storageService,
                editorAssetStore,
                visualAssetStore,
                adapterRegistry: resolvedAdapterRegistry,
            });
            publicationPlanner = await MarketplacePublicationPlanner.create(dataDir, {
                sourceStore,
                profileStore: publisherProfileStore,
                secretStore: publisherSecretStore,
                draftStore: publicationDraftStore,
                cache,
                artifactBuilder: publicationArtifactBuilder,
                adapterRegistry: resolvedAdapterRegistry,
                now,
            });
            publishJobManager = await MarketplacePublishJobManager.create(dataDir, {
                planner: publicationPlanner,
                profileStore: publisherProfileStore,
                secretStore: publisherSecretStore,
                sourceStore,
                credentialStore,
                draftStore: publicationDraftStore,
                fetchImpl,
                now,
            });
            publishingIdentityManager = new MarketplacePublishingIdentityManager({
                connectionPolicy,
                sourceStore,
                cache,
                policyStore,
                profileStore: publisherProfileStore,
                secretStore: publisherSecretStore,
                now,
            });
            publicationBindingReconciler = new MarketplacePublicationBindingReconciler({
                bindingStore: publicationBindingStore,
                draftStore: publicationDraftStore,
                profileStore: publisherProfileStore,
                sourceStore,
                cache,
                publishJobManager,
            });
            publicationDependencyResolver = new MarketplacePublicationDependencyResolver({
                profileStore: publisherProfileStore,
                sourceStore,
                cache,
                draftStore: publicationDraftStore,
                storageService,
            });
        }
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
            policyStore,
            provenanceStore,
            executablePolicy,
            updateModel,
            publicationCatalog,
            publisherProfileStore,
            publisherSecretStore,
            publicationDraftStore,
            publicationPlanner,
            publishJobManager,
            connectionPolicy,
            publishingIdentityManager,
            publicationBindingStore,
            publicationBindingReconciler,
            publicationDependencyResolver,
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
        if (publishJobManager) {
            await publisherSecretStore.recover(publisherProfileStore.snapshot().profiles.map((profile) => profile.secretRef));
            await publishingIdentityManager.reconcileAll();
            publishJobManager.setRefreshSource(async (sourceId) => {
                await service.refreshSource(sourceId, { expectedRevision: sourceStore.snapshot().revision });
            });
            publishJobManager.setPublicationCompleted(async (sourceId) => {
                await publicationBindingReconciler.reconcileSource(sourceId);
            });
            await publishJobManager.recover();
            await publicationBindingReconciler.reconcileAll();
        }
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

    async connectSource({ baseUrl }) {
        this.#assertOpen();
        const origin = normalizeMarketplaceOrigin(baseUrl);
        const connection = this.connectionPolicy.find(origin);
        if (!connection) {
            throw marketplaceError(
                MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED,
                "This registry is not configured by the Marketplace operator.",
            );
        }
        const { kind: _kind, version: _version, ...credential } = connection.credential;
        const preview = await this.trustClient.previewSource({ baseUrl: origin, credential });
        if (preview.trustedRootFingerprint !== connection.trustedRootSha256) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Configured Marketplace root pin does not match the registry.");
        }
        let snapshot = this.sourceStore.snapshot();
        let source = snapshot.sources.find((entry) => entry.baseUrl === origin) ?? null;
        if (source && (source.registryId !== preview.registryId || source.trustedRootFingerprint !== preview.trustedRootFingerprint)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Existing Marketplace source identity does not match configured trust.");
        }
        if (!source) {
            const added = await this.addSource({
                expectedRevision: snapshot.revision,
                name: connection.displayName,
                baseUrl: origin,
                registryId: preview.registryId,
                trustedRootFingerprint: preview.trustedRootFingerprint,
                enabled: true,
                priority: connection.priority,
                credential,
            });
            source = this.sourceStore.get(added.source.sourceId);
            snapshot = this.sourceStore.snapshot();
        } else {
            const storedCredential = await this.credentialStore.readCredential(source.credentialRef);
            const credentialChanged = JSON.stringify(storedCredential) !== JSON.stringify(credential);
            const metadataChanged = source.name !== connection.displayName || !source.enabled || source.priority !== connection.priority;
            if (credentialChanged || metadataChanged) {
                await this.updateSource(source.sourceId, {
                    expectedRevision: snapshot.revision,
                    name: connection.displayName,
                    enabled: true,
                    priority: connection.priority,
                    ...(credentialChanged ? { credential } : {}),
                });
                snapshot = this.sourceStore.snapshot();
                source = this.sourceStore.get(source.sourceId);
            }
        }
        let catalog = null;
        const warnings = [];
        try {
            catalog = await this.refreshSource(source.sourceId, { expectedRevision: snapshot.revision });
        } catch (error) {
            warnings.push(Object.freeze({
                code: error instanceof MarketplaceError ? error.code : MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE,
                message: error instanceof MarketplaceError
                    ? error.message
                    : "The trusted source was saved, but its initial catalog refresh failed.",
            }));
        }
        const currentSources = await this.listSources();
        const publicValue = currentSources.sources.find((entry) => entry.sourceId === source.sourceId);
        const publishing = this.publishingIdentityManager ? await this.publishingIdentityManager.readiness() : Object.freeze({ identities: [], defaultProfileId: null, ready: false });
        return Object.freeze({ source: publicValue, catalog, publishing, warnings: Object.freeze(warnings) });
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
        const credentialRef = normalized ? await this.credentialStore.stageCredential(normalized) : null;
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
            const newCredentialRef = credentialSupplied && normalized ? await this.credentialStore.stageCredential(normalized) : null;
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
                const credential = await this.credentialStore.readCredential(source.credentialRef);
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
                    credential,
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
                await this.policyStore.ingestVerifiedSnapshot({
                    source,
                    manifest: result.manifest,
                    publishers: result.documents.publishers,
                    releases: result.documents.releases,
                    advisories: result.documents.advisories,
                    yanks: result.catalog.yanks,
                });
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
                if (this.publishingIdentityManager) await this.publishingIdentityManager.reconcileSource(sourceId);
                if (this.publicationBindingReconciler) await this.publicationBindingReconciler.reconcileSource(sourceId);
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
        const sorted = sortCatalogEntries(entries, query.sort);
        const filtered = filterCatalogEntries(sorted, query);
        const kindScope = filterCatalogEntries(sorted, { ...query, contentKind: null });
        const paginated = paginateMarketplaceEntries(filtered, query);
        const facets = buildMarketplaceFacets(sorted);
        return Object.freeze({
            sourcesRevision: snapshot.revision,
            sources: Object.freeze(publicSources),
            query,
            page: paginated.page,
            entries: Object.freeze(paginated.entries),
            facets: Object.freeze({
                ...facets,
                contentKinds: buildMarketplaceFacets(kindScope).contentKinds,
            }),
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
        const publisher = current.documents.publishers.find((entry) => entry.publisherId === selectedRelease.publisherId) ?? null;
        const publisherKey = publisher?.keys.find((entry) => entry.keyId === selectedSummary.publisherKeyId) ?? null;
        const policy = await this.policyStore.evaluateRelease({
            registryId: source.registryId,
            publisherId: selectedRelease.publisherId,
            release: selectedRelease,
            packageHashes: executablePackageHashes(selectedRelease),
        });
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
        const publisherApproved = !selectedSummary.publisherKeyId || policy.approved;
        const policyIssues = [
            ...(!publisherApproved ? [{ path: "publisherId", code: "PUBLISHER_NOT_APPROVED", required: selectedRelease.publisherId, actual: null }] : []),
            ...(policy.blocked ? [{ path: "policy", code: "RELEASE_BLOCKED", required: "allowed", actual: "blocked" }] : []),
        ];
        const issues = [...downloadIssues, ...lifecycleIssues, ...(nonExecutable ? [] : compatibility.issues), ...policyIssues];
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
            canInstall: sizeAllowed && lifecycleAvailable && (nonExecutable || compatibility.compatible) && publisherApproved && !policy.blocked,
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
            publisher: publisher ? Object.freeze({
                publisherId: publisher.publisherId,
                keyId: selectedSummary.publisherKeyId,
                keyStatus: publisherKey?.status ?? null,
            }) : null,
            advisories: policy.advisories,
            policy,
            verification: current.verification,
            fresh: current.fresh && health.status === MARKETPLACE_SOURCE_HEALTH.READY,
            eligibility,
            canInstall: eligibility.canInstall,
            collectionMembers: Object.freeze(collectionMembers),
        });
    }

    status() {
        this.#assertOpen();
        return Object.freeze({
            mode: "coordinator",
            canInstall: this.adapterRegistry.hasLifecycle(),
        });
    }

    #requirePublisherWorkspace() {
        if (!this.publishJobManager) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.INCOMPATIBLE, "Marketplace publisher workspace is unavailable without authoring stores.");
        }
    }

    async #publisherAuthority(sourceId, publisherId, keyId) {
        const source = this.sourceStore.get(sourceId);
        if (!source || !source.enabled) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publisher source was not found or is disabled.");
        const current = await this.cache.readCurrent(source, { requireFresh: true });
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Publisher source has no verified snapshot.");
        const publisher = current.documents.publishers.find((entry) => entry.publisherId === publisherId);
        const key = publisher?.keys.find((entry) => entry.keyId === keyId);
        if (!publisher) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Publisher is not registered in the target registry.");
        if (!key || key.status !== "active") throw marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, "Publisher signing key is not active in the target registry.");
        return { source, publisher, key, current };
    }

    async listPublisherProfiles() {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        return this.publisherProfileStore.snapshot({ publicOnly: true });
    }

    async publisherReadiness() {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        return this.publishingIdentityManager
            ? this.publishingIdentityManager.readiness()
            : Object.freeze({ identities: Object.freeze([]), defaultProfileId: null, ready: false });
    }

    async createPublisherProfile({ expectedRevision, name, sourceId, publisherId, writeToken, privateKeyPem }) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        const staged = await this.publisherSecretStore.stage({ writeToken, privateKeyPem });
        try {
            const { source } = await this.#publisherAuthority(sourceId, publisherId, staged.keyId);
            const profile = createPublisherProfile({ source, name, publisherId, keyId: staged.keyId, secretRef: staged.secretRef, now: this.now() });
            return await this.publisherProfileStore.add(profile, expectedRevision);
        } catch (error) {
            await this.publisherSecretStore.remove(staged.secretRef).catch(() => {});
            throw error;
        }
    }

    async updatePublisherProfile(profileId, { expectedRevision, name, writeToken, privateKeyPem }) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        const current = this.publisherProfileStore.get(profileId);
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publisher profile was not found.");
        const rotatesSecret = writeToken !== undefined || privateKeyPem !== undefined;
        if (rotatesSecret && (writeToken === undefined || privateKeyPem === undefined)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publisher token and private key must be rotated together.");
        }
        let staged = null;
        let result;
        try {
            if (rotatesSecret) {
                staged = await this.publisherSecretStore.stage({ writeToken, privateKeyPem });
                await this.#publisherAuthority(current.sourceId, current.publisherId, staged.keyId);
            }
            const updatedAt = this.now().toISOString();
            result = await this.publisherProfileStore.update(profileId, {
                ...(name !== undefined ? { name } : {}),
                ...(staged ? { keyId: staged.keyId, secretRef: staged.secretRef } : {}),
                updatedAt,
            }, expectedRevision);
        } catch (error) {
            if (staged) await this.publisherSecretStore.remove(staged.secretRef).catch(() => {});
            throw error;
        }
        if (staged) await this.publisherSecretStore.remove(current.secretRef).catch(() => {});
        return result;
    }

    async removePublisherProfile(profileId, expectedRevision) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        if (this.publicationDraftStore.snapshot().drafts.some((draft) => draft.profileId === profileId)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Publisher profile is referenced by a publication draft.");
        }
        if (await this.publishJobManager.hasReference({ profileId })) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Publisher profile is referenced by a nonterminal publication job.");
        }
        const result = await this.publisherProfileStore.remove(profileId, expectedRevision);
        await this.publisherSecretStore.remove(result.removed.secretRef);
        return { document: result.document, removed: true };
    }

    async listPublicationInventory(query) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        return this.publicationCatalog.list(query);
    }

    async listPublicationDrafts() {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        return this.publicationDraftStore.snapshot();
    }

    async #inventoryEntry(localSelection, contentKind) {
        if (contentKind === "collection") return null;
        let offset = 0;
        while (true) {
            const page = await this.publicationCatalog.list({ contentKind, offset, limit: 100 });
            const found = page.entries.find((entry) => {
                if (contentKind === "plugin") return entry.localSelection.packageHash === localSelection.packageHash;
                if (contentKind === "vehicle") return entry.localSelection.vehicleId === localSelection.vehicleId;
                if (contentKind === "run-template") return entry.localSelection.manifestId === localSelection.manifestId;
                if (contentKind === "environment") return entry.localSelection.environmentId === localSelection.environmentId;
                return localSelection.roots.every((root) => entry.localSelection.roots.some((candidate) => candidate.assetId === root.assetId && candidate.revision === root.revision));
            });
            if (found) return found;
            offset += page.entries.length;
            if (offset >= page.page.total || page.entries.length === 0) break;
        }
        throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Selected local publication content was not found.");
    }

    async createPublicationDraft(input) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        const profile = this.publisherProfileStore.get(input.profileId);
        if (!profile) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publisher profile was not found.");
        const { publisher, current } = await this.#publisherAuthority(profile.sourceId, profile.publisherId, profile.keyId);
        const inventory = await this.#inventoryEntry(input.localSelection, input.contentKind);
        if (inventory && !inventory.publishable) throw marketplaceError(MARKETPLACE_ERROR_CODES.INCOMPATIBLE, inventory.unavailableReason);
        const localId = inventory?.localId ?? "collection";
        const namespace = publisher.namespaces[0];
        const slug = String(localId).toLowerCase().replace(/[^a-z0-9.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "publication";
        const defaultItemId = input.contentKind === "plugin" ? inventory.identity.pluginId : `${namespace}.${slug}`;
        const mode = input.mode ?? "create-item";
        const requestedItemId = input.itemId ?? input.item?.itemId ?? defaultItemId;
        const existingItem = current.documents.items.find((entry) => entry.itemId === requestedItemId) ?? null;
        if (mode === "new-release" && !existingItem) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Existing marketplace item was not found in the verified source snapshot.");
        }
        if (existingItem && (existingItem.publisherId !== profile.publisherId || existingItem.contentKind !== input.contentKind)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Existing marketplace item is owned by another publisher or content kind.");
        }
        const contract = MARKETPLACE_ARTIFACTS[input.contentKind];
        const existingItemInput = existingItem ? (({ kind: _kind, version: _version, publisherId: _publisherId, contentKind: _contentKind, ...editable }) => editable)(structuredClone(existingItem)) : null;
        const item = input.item ?? existingItemInput ?? {
            itemId: defaultItemId,
            displayName: inventory?.name ?? "Marketplace Collection",
            summary: inventory?.summary ?? "A curated collection of exact marketplace releases.",
            description: "",
            categories: [input.contentKind === "run-template" ? "run-templates" : input.contentKind],
            tags: [],
            links: [],
            previews: [],
        };
        const release = input.release ?? {
            releaseVersion: input.contentKind === "plugin" ? inventory.identity.version : "0.1.0",
            licenseExpression: "Apache-2.0",
            changelog: "Initial marketplace publication.",
            track: null,
            compatibility: {
                cevSim: ">=0.1.0 <0.2.0",
                contracts: [],
                platforms: [], architectures: [], runtimes: [], backends: [], features: [],
            },
        };
        if (!contract) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Unsupported publication content kind.");
        const draft = createPublicationDraft({
            profileId: input.profileId,
            contentKind: input.contentKind,
            localSelection: input.localSelection,
            item,
            release,
            members: input.members ?? [],
            mode,
            now: this.now(),
        });
        return this.publicationDraftStore.add(draft, input.expectedRevision);
    }

    async createResolvedPublicationDraft({ expectedRevision, contentKind, localSelection, profileId = null }) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        const readiness = await this.publisherReadiness();
        const selectedProfileId = profileId ?? readiness.defaultProfileId;
        if (!selectedProfileId) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.INCOMPATIBLE, "No ready publishing identity is configured.");
        }
        const selectedIdentity = readiness.identities.find((identity) => identity.profileId === selectedProfileId && identity.status === "ready");
        if (!selectedIdentity) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.INCOMPATIBLE, "Selected publishing identity is not ready.");
        }
        const profile = this.publisherProfileStore.get(selectedProfileId);
        if (!profile) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publisher profile was not found.");
        const resolvedSelection = contentKind === "collection" && !localSelection.publicationProjectId
            ? { ...localSelection, publicationProjectId: randomUUID() }
            : localSelection;
        const inventory = await this.#inventoryEntry(resolvedSelection, contentKind);
        if (inventory && !inventory.publishable) throw marketplaceError(MARKETPLACE_ERROR_CODES.INCOMPATIBLE, inventory.unavailableReason);
        const localIdentity = inventory?.publicationIdentity ?? publicationLocalIdentity(contentKind, resolvedSelection, { projectId: randomUUID() });
        const binding = this.publicationBindingStore.get(selectedProfileId, contentKind, localIdentity);
        const { current } = await this.#publisherAuthority(profile.sourceId, profile.publisherId, profile.keyId);
        const source = this.sourceStore.get(profile.sourceId);
        const connection = this.connectionPolicy.find(source.baseUrl);
        const configuredIdentity = connection?.identities.find((identity) => identity.publisherId === profile.publisherId);
        const existingVersions = binding
            ? current.documents.releases.filter((release) => release.itemId === binding.itemId).map((release) => release.releaseVersion).filter((value) => semver.valid(value))
            : [];
        const highest = existingVersions.sort(semver.rcompare)[0] ?? null;
        const releaseVersion = contentKind === "plugin"
            ? inventory.identity.version
            : highest ? semver.inc(highest, "patch") : "0.1.0";
        const dependencyResolution = contentKind === "run-template"
            ? await this.publicationDependencyResolver.resolveRunTemplate(selectedProfileId, resolvedSelection)
            : { localSelection: resolvedSelection, dependencies: [] };
        const result = await this.createPublicationDraft({
            expectedRevision,
            profileId: selectedProfileId,
            contentKind,
            localSelection: dependencyResolution.localSelection,
            mode: binding ? "new-release" : "create-item",
            ...(binding ? { itemId: binding.itemId } : {}),
            release: {
                releaseVersion,
                licenseExpression: configuredIdentity?.defaults.license ?? "Apache-2.0",
                changelog: binding ? `Update ${releaseVersion}.` : "Initial marketplace publication.",
                track: configuredIdentity?.defaults.track ?? "stable",
                compatibility: {
                    cevSim: ">=0.1.0 <0.2.0",
                    contracts: [],
                    platforms: [], architectures: [], runtimes: [], backends: [], features: [],
                },
            },
        });
        return Object.freeze({
            ...result,
            resolution: Object.freeze({
                localIdentity,
                binding,
                mode: binding ? "new-release" : "create-item",
                dependencies: dependencyResolution.dependencies,
            }),
        });
    }

    async listPublicationReleaseOptions({ q = "", profileId = null, contentKind = null } = {}) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        return this.publicationDependencyResolver.releaseOptions({ q, profileId, contentKind });
    }

    async updatePublicationDraft(draftId, { expectedRevision, ...patch }) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        const allowed = new Set(["profileId", "mode", "localSelection", "item", "release", "members"]);
        if (Object.keys(patch).some((key) => !allowed.has(key)) || Object.keys(patch).length === 0) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Publication draft update is empty or contains unsupported fields.");
        }
        const current = this.publicationDraftStore.get(draftId);
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publication draft was not found.");
        if (patch.localSelection?.kind === "asset-pack" && patch.localSelection.roots.length > 1
            && !patch.localSelection.publicationProjectId) {
            patch.localSelection = { ...patch.localSelection, publicationProjectId: current.localSelection.publicationProjectId ?? randomUUID() };
        }
        const projected = { ...current, ...patch };
        const state = projected.contentKind === "collection" && projected.members.length === 0 ? "incomplete" : "ready";
        return this.publicationDraftStore.update(draftId, { ...patch, state }, expectedRevision);
    }

    async removePublicationDraft(draftId, expectedRevision) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        if (await this.publishJobManager.hasReference({ draftId })) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Publication draft is referenced by a nonterminal publication job.");
        }
        return this.publicationDraftStore.remove(draftId, expectedRevision);
    }

    async addPublicationPreview(draftId, bytes, { mediaType, alt, expectedRevision }) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        const preview = await inspectPreviewBytes(bytes, { mediaType });
        const descriptor = { mediaType, sha256: preview.sha256, sizeBytes: preview.sizeBytes, alt };
        const filePath = this.publicationPlanner.previewPath(preview.sha256);
        const existing = await lstatOrNull(filePath);
        if (existing) {
            const stored = await readRegularBytes(filePath, { maxBytes: MARKETPLACE_LIMITS.previewBytes });
            if (!Buffer.from(stored).equals(Buffer.from(bytes))) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Publication preview digest collision.");
        } else await writeExclusiveDurable(filePath, bytes);
        return this.publicationDraftStore.attachPreview(draftId, descriptor, expectedRevision);
    }

    async removePublicationPreview(draftId, digest, expectedRevision) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        assertSha256(digest, "digest");
        return this.publicationDraftStore.removePreview(draftId, digest, expectedRevision);
    }

    async readPublicationPreview(draftId, digest) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        assertSha256(digest, "digest");
        const draft = this.publicationDraftStore.get(draftId);
        if (!draft) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publication draft was not found.");
        const descriptor = draft.item.previews.find((entry) => entry.sha256 === digest);
        if (!descriptor) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Publication preview was not found.");
        const bytes = Buffer.from(await readRegularBytes(this.publicationPlanner.previewPath(digest), { maxBytes: MARKETPLACE_LIMITS.previewBytes }));
        if (bytes.byteLength !== descriptor.sizeBytes || hashMarketplaceBytes(bytes) !== descriptor.sha256) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.ARTIFACT_HASH_MISMATCH, "Publication preview bytes do not match the stored descriptor.");
        }
        return Object.freeze({ descriptor, bytes });
    }

    async createPublicationPlan(input) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        let plan;
        try {
            plan = await this.publicationPlanner.createPlan(input);
        } catch (error) {
            const draft = this.publicationDraftStore.get(input.draftId);
            if (draft?.revision === input.draftRevision) {
                await this.publicationDraftStore.update(input.draftId, { state: "preflight-failed" }, draft.revision).catch(() => {});
            }
            throw error;
        }
        for (const entry of plan.entries) {
            const draft = this.publicationDraftStore.get(entry.draftId);
            if (draft?.revision === entry.draftRevision) {
                await this.publicationDraftStore.update(entry.draftId, { state: "prepared" }, draft.revision).catch(() => {});
            }
        }
        return plan;
    }

    async startPublishJob(planHash) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        return this.publishJobManager.start(planHash);
    }

    async preparePublication(input) {
        const plan = await this.createPublicationPlan(input);
        const job = await this.startPublishJob(plan.planHash);
        return Object.freeze({ plan, job });
    }

    async getPublishJob(jobId) { this.#assertOpen(); this.#requirePublisherWorkspace(); return { job: await this.publishJobManager.snapshot(jobId) }; }
    subscribePublishJob(jobId, listener) { this.#assertOpen(); this.#requirePublisherWorkspace(); return this.publishJobManager.subscribe(jobId, (job) => listener({ job })); }
    async commitPublishJob(jobId, input) { this.#assertOpen(); this.#requirePublisherWorkspace(); return { job: await this.publishJobManager.commit(jobId, input) }; }
    async cancelPublishJob(jobId, expectedRevision) { this.#assertOpen(); this.#requirePublisherWorkspace(); return { job: await this.publishJobManager.cancel(jobId, expectedRevision) }; }
    async resumePublishJob(jobId, expectedRevision) { this.#assertOpen(); this.#requirePublisherWorkspace(); return { job: await this.publishJobManager.resume(jobId, expectedRevision) }; }
    async replanPublishJob(jobId, expectedRevision) {
        this.#assertOpen();
        this.#requirePublisherWorkspace();
        const job = await this.publishJobManager.replan(jobId, expectedRevision);
        return { job, plan: await this.publicationPlanner.readPlan(job.planHash) };
    }
    async listPublishJobOperations(jobId, query) { this.#assertOpen(); this.#requirePublisherWorkspace(); return this.publishJobManager.operations(jobId, query); }

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
        const installed = await this.installedStore.snapshot();
        const projected = [];
        for (const entry of installed.installations) {
            const source = this.sourceStore.get(entry.sourceId);
            let status = entry.status;
            if (source) {
                const current = await this.cache.readCurrent(source).catch(() => null);
                const release = current?.documents.releases.find((candidate) => candidate.itemId === entry.release.itemId
                    && candidate.releaseVersion === entry.release.releaseVersion
                    && candidate.artifact.sha256 === entry.release.artifactSha256);
                if (release) {
                    const policy = await this.policyStore.evaluateRelease({
                        registryId: entry.registryId,
                        publisherId: release.publisherId,
                        release,
                        packageHashes: executablePackageHashes(release),
                    });
                    if (policy.blocked) status = "blocked";
                    else if (policy.yanked) status = "yanked";
                }
            }
            if (!source) {
                const policy = await this.policyStore.evaluateInstalled(entry);
                if (policy.blocked) status = "blocked";
                else if (policy.yanked) status = "yanked";
            }
            projected.push({ ...entry, status });
        }
        return Object.freeze({ ...installed, installations: Object.freeze(projected) });
    }

    async library() {
        this.#assertOpen();
        return this.libraryReadModel.read();
    }

    async listUpdates(options = {}) {
        this.#assertOpen();
        return this.updateModel.listUpdates(options);
    }

    async listAdvisories() {
        this.#assertOpen();
        const policy = await this.policyStore.snapshot();
        return Object.freeze(policy.registries.flatMap((entry) => entry.advisories.map((record) => Object.freeze({
            registryId: entry.registryId,
            hash: record.hash,
            advisory: record.advisory,
        }))));
    }

    async getPolicy() {
        this.#assertOpen();
        return this.policyStore.snapshot();
    }

    subscribePolicy(listener) {
        this.#assertOpen();
        return this.policyStore.subscribe(listener);
    }

    async setPublisherApproval({ registryId, publisherId, approved, expectedRevision }) {
        this.#assertOpen();
        await this.policyStore.setPublisherApproval(registryId, publisherId, approved, { expectedRevision });
        return this.policyStore.snapshot();
    }

    async setOperatorOverride({ packageHash, reason, expectedRevision }) {
        this.#assertOpen();
        await this.policyStore.setOperatorOverride(packageHash, reason, { expectedRevision });
        return this.policyStore.snapshot();
    }

    async setOperatorOverrideForRelease({ registryId, itemId, releaseVersion, artifactSha256, reason, expectedRevision }) {
        this.#assertOpen();
        assertCanonicalUuid(registryId, "registryId");
        assertMarketplaceId(itemId, "itemId");
        assertReleaseVersion(releaseVersion, "releaseVersion");
        assertSha256(artifactSha256, "artifactSha256");
        const policy = await this.policyStore.snapshot();
        const origin = policy.registries.find((entry) => entry.registryId === registryId)?.releases.find((entry) => (
            entry.itemId === itemId && entry.releaseVersion === releaseVersion && entry.artifactSha256 === artifactSha256
        ));
        if (!origin) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Installed Marketplace release provenance was not found.");
        if (origin.packageHashes.length !== 1) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "This release does not resolve to one executable package override.");
        }
        await this.policyStore.setOperatorOverride(origin.packageHashes[0], reason, { expectedRevision });
        return this.policyStore.snapshot();
    }

    async authorizePackage(packageHash) {
        this.#assertOpen();
        assertSha256(packageHash, "packageHash");
        return this.executablePolicy.authorizePackage(packageHash);
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
            credential: await this.credentialStore.readCredential(source.credentialRef),
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
        await this.publishJobManager?.close();
        await this.jobManager.close();
        await this.transactionCoordinator.close();
        await this.installedStore.close();
        await this.ownershipStore.close();
        await Promise.allSettled(this.#sourceQueues.values());
    }
}
