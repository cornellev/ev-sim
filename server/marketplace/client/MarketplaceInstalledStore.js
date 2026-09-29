import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import {
    assertMarketplaceInstalled,
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
import { installedDocumentHash } from "./MarketplaceInstallDocuments.js";

function installationKey(entry) {
    return `${entry.sourceId}\u0000${entry.release.itemId}\u0000${entry.release.releaseVersion}\u0000${entry.release.artifactSha256}`;
}

function sortInstallations(installations) {
    return [...installations].sort((left, right) => compareUtf8(installationKey(left), installationKey(right)));
}

function emptyInstalled() {
    return assertMarketplaceInstalled({
        kind: "cev-sim.marketplace-installed",
        version: 1,
        revision: 0,
        installations: [],
    });
}

function conflict(message) {
    return marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, message);
}

export class MarketplaceInstalledStore {
    constructor(paths) {
        this.paths = paths;
        this.queue = Promise.resolve();
    }

    static async open(dataDir) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.root);
        if (!await lstatOrNull(paths.installed)) {
            try {
                await writeExclusiveDurable(paths.installed, marketplaceDocumentBytes(emptyInstalled()));
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
            }
        }
        const store = new MarketplaceInstalledStore(paths);
        await store.snapshot();
        return store;
    }

    async snapshot() {
        let bytes;
        for (let attempt = 0; attempt < 8; attempt += 1) {
            try {
                bytes = await readRegularBytes(this.paths.installed, { maxBytes: 16 * 1024 * 1024 });
                break;
            } catch (error) {
                if (error.code !== MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED || attempt === 7) throw error;
                await new Promise((resolve) => setImmediate(resolve));
            }
        }
        const document = assertMarketplaceInstalled(parseMarketplaceDocument(bytes));
        if (!Buffer.from(bytes).equals(Buffer.from(marketplaceDocumentBytes(document)))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Installed marketplace ledger is not canonical.");
        }
        return document;
    }

    prepareInstall(base, additions, { forceRevision = false } = {}) {
        const installed = assertMarketplaceInstalled(base);
        const byKey = new Map(installed.installations.map((entry) => [installationKey(entry), structuredClone(entry)]));
        let changed = false;
        for (const addition of additions) {
            const candidate = structuredClone(addition);
            const key = installationKey(candidate);
            const current = byKey.get(key);
            if (current) {
                if (current.registryId !== candidate.registryId || current.status !== candidate.status) {
                    throw conflict("Installed marketplace release metadata changed.");
                }
                continue;
            }
            byKey.set(key, candidate);
            changed = true;
        }
        return assertMarketplaceInstalled({
            ...installed,
            revision: installed.revision + (changed || forceRevision ? 1 : 0),
            installations: sortInstallations(byKey.values()),
        });
    }

    prepareRemovalSet(base, requests, { forceRevision = true } = {}) {
        const installed = assertMarketplaceInstalled(base);
        const removalKeys = new Set(requests.map((request) => `${request.sourceId}\u0000${request.itemId}\u0000${request.releaseVersion}\u0000${request.artifactSha256}`));
        const installations = installed.installations.filter((entry) => !removalKeys.has(installationKey(entry)));
        const changed = installations.length !== installed.installations.length;
        return assertMarketplaceInstalled({
            ...installed,
            revision: installed.revision + (changed || forceRevision ? 1 : 0),
            installations,
        });
    }

    prepareRemoval(base, request) {
        const installed = assertMarketplaceInstalled(base);
        if (request.expectedRevision !== installed.revision) throw conflict("Installed marketplace revision is stale.");
        const targetKey = `${request.sourceId}\u0000${request.itemId}\u0000${request.releaseVersion}\u0000${request.artifactSha256}`;
        if (!installed.installations.some((entry) => installationKey(entry) === targetKey)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Installed marketplace release was not found.");
        }
        return this.prepareRemovalSet(installed, [request]);
    }

    async commitTarget({ base, target }) {
        const operation = this.queue.then(async () => {
            const current = await this.snapshot();
            if (installedDocumentHash(current) === installedDocumentHash(target)) return target;
            if (installedDocumentHash(current) !== installedDocumentHash(base)) {
                throw conflict("Installed marketplace ledger changed during the transaction.");
            }
            await atomicReplaceDurable(this.paths.installed, marketplaceDocumentBytes(assertMarketplaceInstalled(target)));
            return target;
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    async close() {
        await this.queue;
    }
}
