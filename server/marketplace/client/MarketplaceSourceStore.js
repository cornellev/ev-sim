import { MARKETPLACE_KINDS, MARKETPLACE_SCHEMA_VERSION } from "../MarketplaceContract.js";
import {
    assertMarketplaceSources,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import {
    atomicReplaceDurable,
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";

function conflict(expectedRevision, currentRevision) {
    const error = marketplaceError(
        MARKETPLACE_ERROR_CODES.CONFLICT,
        `Marketplace source revision conflict: expected ${expectedRevision}, current revision is ${currentRevision}.`,
    );
    error.currentRevision = currentRevision;
    return error;
}

function recovery(message, pathName = null) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, message, { path: pathName });
}

function clone(value) {
    return structuredClone(value);
}

function sortSources(sources) {
    return sources.sort((left, right) => left.priority - right.priority || left.sourceId.localeCompare(right.sourceId));
}

async function readSources(paths) {
    const bytes = await readRegularBytes(paths.sources);
    const document = assertMarketplaceSources(parseMarketplaceDocument(bytes));
    if (!Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(document)))) {
        throw recovery("Marketplace sources document is not canonical.", paths.sources);
    }
    return document;
}

export class MarketplaceSourceStore {
    #queue = Promise.resolve();

    constructor(paths, document) {
        this.paths = paths;
        this.document = document;
    }

    static async open(dataDir) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.root);
        await Promise.all([
            ensureDirectory(paths.credentials),
            ensureDirectory(paths.trust),
            ensureDirectory(paths.health),
            ensureDirectory(paths.cache),
        ]);
        const existing = await lstatOrNull(paths.sources);
        if (!existing) {
            const empty = assertMarketplaceSources({
                kind: MARKETPLACE_KINDS.sources,
                version: MARKETPLACE_SCHEMA_VERSION,
                revision: 0,
                sources: [],
            });
            try {
                await writeExclusiveDurable(paths.sources, marketplaceDocumentBytes(empty));
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
        } else if (!existing.isFile() || existing.isSymbolicLink()) {
            throw recovery("Marketplace sources path is not a regular file.", paths.sources);
        }
        return new MarketplaceSourceStore(paths, await readSources(paths));
    }

    snapshot() {
        return clone(this.document);
    }

    get(sourceId) {
        const source = this.document.sources.find((entry) => entry.sourceId === sourceId);
        return source ? clone(source) : null;
    }

    async add(source, expectedRevision) {
        return this.#mutate(expectedRevision, (document) => {
            if (document.sources.some((entry) => entry.sourceId === source.sourceId)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace source ID already exists.");
            }
            if (document.sources.some((entry) => entry.baseUrl === source.baseUrl)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace source origin is already configured.");
            }
            if (document.sources.some((entry) => entry.registryId === source.registryId)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace registry is already configured.");
            }
            document.sources.push(clone(source));
            return source.sourceId;
        });
    }

    async update(sourceId, patch, expectedRevision) {
        return this.#mutate(expectedRevision, (document) => {
            const index = document.sources.findIndex((entry) => entry.sourceId === sourceId);
            if (index < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace source was not found.");
            document.sources[index] = { ...document.sources[index], ...clone(patch) };
            return sourceId;
        });
    }

    async remove(sourceId, expectedRevision) {
        let removed = null;
        const result = await this.#mutate(expectedRevision, (document) => {
            const index = document.sources.findIndex((entry) => entry.sourceId === sourceId);
            if (index < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace source was not found.");
            [removed] = document.sources.splice(index, 1);
            return null;
        });
        return { ...result, removed: clone(removed) };
    }

    async reload() {
        this.document = await readSources(this.paths);
        return this.snapshot();
    }

    #mutate(expectedRevision, transform) {
        const request = this.#queue.catch(() => {}).then(async () => {
            const current = await readSources(this.paths);
            this.document = current;
            if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision !== current.revision) {
                throw conflict(expectedRevision, current.revision);
            }
            const next = clone(current);
            const selectedSourceId = transform(next);
            next.revision += 1;
            sortSources(next.sources);
            const validated = assertMarketplaceSources(next);
            await atomicReplaceDurable(this.paths.sources, marketplaceDocumentBytes(validated));
            this.document = validated;
            return {
                document: this.snapshot(),
                source: selectedSourceId ? this.get(selectedSourceId) : null,
            };
        });
        this.#queue = request;
        return request;
    }
}
