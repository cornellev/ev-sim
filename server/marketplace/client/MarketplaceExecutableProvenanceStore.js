import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalUuid, assertMarketplaceId, assertReleaseVersion, assertSha256 } from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import { atomicReplaceDurable, ensureDirectory, lstatOrNull, readRegularBytes, writeExclusiveDurable } from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";

const KIND = "cev-sim.marketplace-executable-provenance";

function empty() {
    return { kind: KIND, version: 1, revision: 0, packages: [] };
}

function originKey(origin) {
    return [origin.sourceId, origin.registryId, origin.publisherId, origin.release.itemId,
        origin.release.releaseVersion, origin.release.artifactSha256, origin.role].join("\u0000");
}

function validate(document) {
    if (!document || document.kind !== KIND || document.version !== 1 || !Number.isSafeInteger(document.revision)
        || document.revision < 0 || !Array.isArray(document.packages)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace executable provenance document is invalid.");
    const hashes = new Set();
    for (const entry of document.packages) {
        assertSha256(entry.packageHash, "packageHash");
        if (hashes.has(entry.packageHash) || !Array.isArray(entry.origins)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace executable provenance has duplicate packages.");
        hashes.add(entry.packageHash);
        const origins = new Set();
        for (const origin of entry.origins) {
            assertCanonicalUuid(origin.sourceId, "sourceId");
            assertCanonicalUuid(origin.registryId, "registryId");
            assertMarketplaceId(origin.publisherId, "publisherId");
            assertMarketplaceId(origin.release.itemId, "itemId");
            assertReleaseVersion(origin.release.releaseVersion, "releaseVersion");
            assertSha256(origin.release.artifactSha256, "artifactSha256");
            if (!new Set(["direct", "embedded"]).has(origin.role) || origins.has(originKey(origin))) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace executable provenance origin is invalid.");
            origins.add(originKey(origin));
        }
    }
    return document;
}

export class MarketplaceExecutableProvenanceStore {
    #queue = Promise.resolve();

    constructor(paths) {
        this.paths = paths;
    }

    static async open(dataDir) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.root);
        if (!await lstatOrNull(paths.provenance)) await writeExclusiveDurable(paths.provenance, canonicalMarketplaceBytes(empty()));
        const store = new MarketplaceExecutableProvenanceStore(paths);
        await store.snapshot();
        return store;
    }

    async snapshot() {
        const bytes = await readRegularBytes(this.paths.provenance, { maxBytes: 64 * 1024 * 1024 });
        const { document } = parseMarketplaceJsonBytes(bytes);
        validate(document);
        if (!Buffer.from(canonicalMarketplaceBytes(document)).equals(bytes)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace executable provenance is not canonical.");
        return structuredClone(document);
    }

    async record(packageHash, origin) {
        assertSha256(packageHash, "packageHash");
        const operation = this.#queue.catch(() => {}).then(async () => {
            const document = await this.snapshot();
            let entry = document.packages.find((candidate) => candidate.packageHash === packageHash);
            if (!entry) {
                entry = { packageHash, origins: [] };
                document.packages.push(entry);
            }
            if (entry.origins.some((candidate) => originKey(candidate) === originKey(origin))) return document.revision;
            entry.origins.push(structuredClone(origin));
            entry.origins.sort((left, right) => compareUtf8(originKey(left), originKey(right)));
            document.packages.sort((left, right) => compareUtf8(left.packageHash, right.packageHash));
            document.revision += 1;
            validate(document);
            await atomicReplaceDurable(this.paths.provenance, canonicalMarketplaceBytes(document));
            return document.revision;
        });
        this.#queue = operation.catch(() => {});
        return operation;
    }

    async originsFor(packageHash) {
        assertSha256(packageHash, "packageHash");
        const entry = (await this.snapshot()).packages.find((candidate) => candidate.packageHash === packageHash);
        return Object.freeze(entry ? structuredClone(entry.origins) : []);
    }
}
