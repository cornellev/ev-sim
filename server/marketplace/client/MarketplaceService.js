import { MetadataKind } from "@tufjs/models";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { MARKETPLACE_SOURCE_HEALTH } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, MarketplaceError, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalUuid } from "../MarketplaceFormats.js";
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

    constructor({ paths, sourceStore, credentialStore, cache, trustClient, now }) {
        this.paths = paths;
        this.sourceStore = sourceStore;
        this.credentialStore = credentialStore;
        this.cache = cache;
        this.trustClient = trustClient;
        this.now = now;
    }

    static async open(dataDir, { fetchImpl = globalThis.fetch, now = () => new Date(), cacheFault = null } = {}) {
        const sourceStore = await MarketplaceSourceStore.open(dataDir);
        const credentialStore = await MarketplaceCredentialStore.open(dataDir);
        const cache = await MarketplaceVerifiedCache.open(dataDir, { now, fault: cacheFault });
        const service = new MarketplaceService({
            paths: marketplaceClientPaths(dataDir),
            sourceStore,
            credentialStore,
            cache,
            trustClient: new MarketplaceTrustClient({ fetchImpl, now }),
            now,
        });
        const snapshot = sourceStore.snapshot();
        await credentialStore.recover(snapshot.sources.flatMap((source) => source.credentialRef ? [source.credentialRef] : []));
        await cache.recover(snapshot.sources.map((source) => source.sourceId));
        await service.#recoverOperationalState(snapshot.sources);
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

    async close() {
        if (this.#closed) return;
        this.#closed = true;
        for (const controller of this.#controllers) controller.abort();
        await Promise.allSettled(this.#sourceQueues.values());
    }
}
