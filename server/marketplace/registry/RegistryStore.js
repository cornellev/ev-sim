import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { fsyncDir } from "../../storage/visual-assets/atomicFs.js";
import { recoverArtifactStagingAreas } from "../../artifacts/ArtifactVerification.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import {
    assertMarketplaceCatalog,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";
import { createEmptyCatalog, catalogBytesAndHash } from "./RegistryCatalog.js";
import {
    assertRegistryDocument,
    createRegistryDocument,
    parseRegistryDocumentBytes,
    registryDocumentBytes,
} from "./RegistryDocuments.js";
import {
    REGISTRY_DIRECTORY_MODE,
    DEFAULT_STAGING_GRACE_MS,
    catalogRevisionPath,
    registryPaths,
    requiredRegistryCoreDirectories,
    resolveRegistryPath,
} from "./RegistryLayout.js";
import {
    ensureDirectoryWithin,
    lstatOrNull,
    readRegularBytes,
    requireDirectory,
    writeExclusiveDurable,
} from "./RegistryFs.js";
import { recoverCatalogTransactions } from "./RegistryTransaction.js";
import { RegistryWriterLock } from "./RegistryWriterLock.js";
import { TufRepository } from "./TufRepository.js";
import { ensurePrivateKey } from "./TufKeys.js";

async function readRegistry(paths) {
    const bytes = await readRegularBytes(paths.registry);
    const registry = parseRegistryDocumentBytes(bytes, assertRegistryDocument);
    if (!Buffer.from(bytes).equals(Buffer.from(registryDocumentBytes(registry, assertRegistryDocument)))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "registry.json is not canonical.");
    }
    return registry;
}

async function readCatalogFile(filePath) {
    const bytes = await readRegularBytes(filePath);
    const catalog = assertMarketplaceCatalog(parseMarketplaceDocument(bytes));
    if (!Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(catalog)))) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Catalog bytes are not canonical.", { path: filePath });
    }
    return catalog;
}

async function validateLayout(paths) {
    await requireDirectory(paths.root);
    for (const directory of requiredRegistryCoreDirectories(paths)) await requireDirectory(directory);
    const registry = await readRegistry(paths);
    const catalog = await readCatalogFile(paths.catalogCurrent);
    if (catalog.registryId !== registry.registryId) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Registry identity does not match its catalog.");
    }
    return { registry, catalog };
}

async function buildInitialRegistry(root, registryId, now, { unsafeUnsignedDevelopment = false } = {}) {
    const paths = registryPaths(root);
    await fs.mkdir(paths.root, { mode: REGISTRY_DIRECTORY_MODE });
    await fs.chmod(paths.root, REGISTRY_DIRECTORY_MODE);
    for (const directory of requiredRegistryCoreDirectories(paths)) await ensureDirectoryWithin(paths.root, directory);
    const registry = createRegistryDocument(registryId, now);
    const catalog = createEmptyCatalog(registryId, now, {
        releaseAuthority: unsafeUnsignedDevelopment ? "development-unsigned" : "publisher-dsse",
    });
    const catalogData = catalogBytesAndHash(catalog);
    await writeExclusiveDurable(paths.registry, registryDocumentBytes(registry, assertRegistryDocument));
    await writeExclusiveDurable(paths.catalogCurrent, catalogData.bytes);
    await writeExclusiveDurable(
        resolveRegistryPath(paths, catalogRevisionPath(catalog.revision, catalogData.sha256)),
        catalogData.bytes,
    );
    await fsyncDir(paths.root);
}

export class MarketplaceRegistryStore {
    #writerLock;
    #closed = false;
    #queue = Promise.resolve();

    constructor(paths, registry, writerLock, options = {}, tufRepository = null) {
        this.paths = paths;
        this.registry = registry;
        this.options = Object.freeze({ ...options });
        this.tufRepository = tufRepository;
        this.#writerLock = writerLock;
    }

    static async initialize(root, {
        registryId = null,
        offlineRootKeyPath = null,
        now = () => new Date(),
        unsafeUnsignedDevelopment = false,
    } = {}) {
        const paths = registryPaths(root);
        const existing = await lstatOrNull(paths.root);
        if (existing) {
            if (!existing.isDirectory() || existing.isSymbolicLink()) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Registry root already exists and is not an ordinary directory.");
            }
            const entries = await fs.readdir(paths.root);
            if (entries.length > 0) {
                const validated = await validateLayout(paths);
                if (registryId !== null && validated.registry.registryId !== registryId) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Existing registry ID differs from the requested registry ID.");
                }
                if (offlineRootKeyPath) {
                    const writerLock = await RegistryWriterLock.acquire(paths, { now });
                    try {
                        await recoverCatalogTransactions(paths);
                        const current = await validateLayout(paths);
                        await TufRepository.initialize(paths, current.registry, { offlineRootKeyPath, now });
                    } finally {
                        await writerLock.close();
                    }
                }
                return validated.registry;
            }
        }
        const parent = path.dirname(paths.root);
        await fs.mkdir(parent, { recursive: true, mode: REGISTRY_DIRECTORY_MODE });
        await requireDirectory(parent);
        const temporary = path.join(parent, `.${path.basename(paths.root)}.initialize-${randomUUID()}`);
        try {
            if (offlineRootKeyPath) await ensurePrivateKey(offlineRootKeyPath, { registryRoot: paths.root });
            await buildInitialRegistry(temporary, registryId ?? randomUUID(), now, { unsafeUnsignedDevelopment });
            if (offlineRootKeyPath) {
                const temporaryPaths = registryPaths(temporary);
                await TufRepository.initialize(temporaryPaths, await readRegistry(temporaryPaths), { offlineRootKeyPath, now });
            }
            if (existing) await fs.rmdir(paths.root);
            await fs.rename(temporary, paths.root);
            await fsyncDir(parent);
            const registry = await readRegistry(paths);
            return registry;
        } catch (error) {
            await fs.rm(temporary, { recursive: true, force: true }).catch(() => {});
            throw error;
        }
    }

    static async open(root, options = {}) {
        const paths = registryPaths(root);
        const { registry } = await validateLayout(paths);
        const writerLock = await RegistryWriterLock.acquire(paths, { now: options.now });
        let store = null;
        try {
            await recoverCatalogTransactions(paths, { faults: options.recoveryFaults });
            const tufRepository = await TufRepository.open(paths, registry, {
                now: options.now ?? (() => new Date()),
                faults: options.tufFaults,
            });
            store = new MarketplaceRegistryStore(paths, registry, writerLock, options, tufRepository);
            await store.recover();
            return store;
        } catch (error) {
            if (store) await store.close();
            else await writerLock.close();
            throw error;
        }
    }

    async readCatalog() {
        return readCatalogFile(this.paths.catalogCurrent);
    }

    async readTarget(target) {
        const bytes = await this.readTargetBytes(target);
        const document = parseMarketplaceDocument(bytes);
        if (!Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(document)))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Target bytes are not canonical.", { path: target.path });
        }
        return { document, bytes };
    }

    async readTargetBytes(target) {
        const bytes = await readRegularBytes(resolveRegistryPath(this.paths, target.path));
        if (bytes.byteLength !== target.sizeBytes) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Target size does not match its descriptor.");
        const sha256 = hashMarketplaceBytes(bytes);
        if (sha256 !== target.sha256) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Target digest does not match its descriptor.");
        return bytes;
    }

    async recover() {
        return this.mutate(async () => ({
            transactions: await recoverCatalogTransactions(this.paths, { faults: this.options.recoveryFaults }),
            staging: await recoverArtifactStagingAreas(this.paths.uploadStaging, {
                ttlMs: this.options.stagingGraceMs ?? DEFAULT_STAGING_GRACE_MS,
                now: this.options.now,
            }),
            tuf: await this.tufRepository?.recover() ?? null,
        }));
    }

    async commitCatalogMutation(prepared, targetCatalog) {
        const { commitCatalogTransaction } = await import("./RegistryTransaction.js");
        const result = await commitCatalogTransaction(this.paths, prepared);
        const tuf = this.tufRepository
            ? await this.tufRepository.publishCatalog(targetCatalog, { operation: prepared.journal.operation })
            : null;
        return { catalog: result, tuf };
    }

    mutate(operation) {
        if (this.#closed) return Promise.reject(new Error("Marketplace registry store is closed."));
        const execute = async () => {
            await this.#writerLock.assertOwned();
            return operation();
        };
        const result = this.#queue.then(execute, execute);
        this.#queue = result.catch(() => {});
        return result;
    }

    async verifyOwnership() {
        return this.#writerLock.assertOwned();
    }

    async close() {
        if (this.#closed) return;
        this.#closed = true;
        await this.#queue.catch(() => {});
        await this.#writerLock?.close();
    }
}
