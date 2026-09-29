import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { assertMarketplaceAdvisory, marketplaceDocumentBytes } from "../MarketplaceContracts.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import {
    assertCanonicalTimestamp,
    assertCanonicalUuid,
    assertMarketplaceId,
    assertReleaseVersion,
    assertSha256,
} from "../MarketplaceFormats.js";
import { canonicalMarketplaceBytes, hashMarketplaceBytes, parseMarketplaceJsonBytes } from "../MarketplaceJson.js";
import { atomicReplaceDurable, ensureDirectory, lstatOrNull, readRegularBytes, writeExclusiveDurable } from "../registry/RegistryFs.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";

const POLICY_KIND = "cev-sim.marketplace-policy";
const POLICY_VERSION = 1;

function emptyPolicy() {
    return { kind: POLICY_KIND, version: POLICY_VERSION, revision: 0, registries: [], overrides: [] };
}

function registry(document, registryId) {
    let entry = document.registries.find((candidate) => candidate.registryId === registryId);
    if (!entry) {
        entry = {
            registryId,
            highestTimestampVersion: 0,
            highestSnapshotSha256: null,
            sourceIds: [],
            publishers: [],
            approvedPublishers: [],
            advisories: [],
            yanks: [],
            releases: [],
        };
        document.registries.push(entry);
    }
    return entry;
}

function keyForYank(yank) {
    return `${yank.release.itemId}\u0000${yank.release.releaseVersion}\u0000${yank.release.artifactSha256}`;
}

function validate(document) {
    if (!document || document.kind !== POLICY_KIND || document.version !== POLICY_VERSION
        || !Number.isSafeInteger(document.revision) || document.revision < 0
        || !Array.isArray(document.registries) || !Array.isArray(document.overrides)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy document is invalid.");
    }
    const registryIds = new Set();
    for (const entry of document.registries) {
        assertCanonicalUuid(entry.registryId, "registryId");
        if (registryIds.has(entry.registryId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy has duplicate registries.");
        registryIds.add(entry.registryId);
        if (!Number.isSafeInteger(entry.highestTimestampVersion) || entry.highestTimestampVersion < 0) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy rollback floor is invalid.");
        if (entry.highestSnapshotSha256 !== null) assertSha256(entry.highestSnapshotSha256, "highestSnapshotSha256");
        if (!Array.isArray(entry.sourceIds) || !Array.isArray(entry.publishers) || !Array.isArray(entry.approvedPublishers)
            || !Array.isArray(entry.advisories) || !Array.isArray(entry.yanks) || !Array.isArray(entry.releases)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy registry collections are invalid.");
        }
        const sourceIds = new Set();
        entry.sourceIds.forEach((sourceId) => {
            assertCanonicalUuid(sourceId, "sourceId");
            if (sourceIds.has(sourceId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy has duplicate source IDs.");
            sourceIds.add(sourceId);
        });
        const publishers = new Set();
        entry.publishers.forEach((publisherId) => {
            assertMarketplaceId(publisherId, "publisherId");
            if (publishers.has(publisherId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy has duplicate publishers.");
            publishers.add(publisherId);
        });
        const approvals = new Set();
        entry.approvedPublishers.forEach((publisherId) => {
            assertMarketplaceId(publisherId, "publisherId");
            if (approvals.has(publisherId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy has duplicate publisher approvals.");
            approvals.add(publisherId);
        });
        const advisoryIds = new Set();
        entry.advisories.forEach((record) => {
            assertSha256(record.hash, "advisoryHash");
            assertMarketplaceAdvisory(record.advisory);
            if (advisoryIds.has(record.advisory.advisoryId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy has duplicate advisory IDs.");
            advisoryIds.add(record.advisory.advisoryId);
            if (hashMarketplaceBytes(marketplaceDocumentBytes(record.advisory)) !== record.hash) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace advisory hash is invalid.");
        });
        const visiting = new Set();
        const visited = new Set();
        const byId = new Map(entry.advisories.map((record) => [record.advisory.advisoryId, record.advisory]));
        const visit = (advisoryId) => {
            if (visiting.has(advisoryId)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace advisory supersession contains a cycle.");
            if (visited.has(advisoryId)) return;
            visiting.add(advisoryId);
            for (const superseded of byId.get(advisoryId)?.supersedes ?? []) {
                if (!byId.has(superseded)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace advisory supersedes an unknown record.");
                visit(superseded);
            }
            visiting.delete(advisoryId);
            visited.add(advisoryId);
        };
        advisoryIds.forEach(visit);
        const releaseKeys = new Set();
        entry.releases.forEach((release) => {
            assertMarketplaceId(release.itemId, "itemId");
            assertReleaseVersion(release.releaseVersion, "releaseVersion");
            assertSha256(release.artifactSha256, "artifactSha256");
            assertMarketplaceId(release.publisherId, "publisherId");
            if (!Array.isArray(release.packageHashes) || new Set(release.packageHashes).size !== release.packageHashes.length) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace release provenance package hashes are invalid.");
            release.packageHashes.forEach((packageHash) => assertSha256(packageHash, "packageHash"));
            const key = `${release.itemId}\u0000${release.releaseVersion}\u0000${release.artifactSha256}`;
            if (releaseKeys.has(key)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy has duplicate release origins.");
            releaseKeys.add(key);
        });
        const yankKeys = new Set();
        entry.yanks.forEach((yank) => {
            assertMarketplaceId(yank.release.itemId, "itemId");
            assertReleaseVersion(yank.release.releaseVersion, "releaseVersion");
            assertSha256(yank.release.artifactSha256, "artifactSha256");
            assertCanonicalTimestamp(yank.yankedAt, "yankedAt");
            if (typeof yank.reason !== "string" || !yank.reason) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace yank record is invalid.");
            const key = keyForYank(yank);
            if (yankKeys.has(key)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy has duplicate yanks.");
            yankKeys.add(key);
        });
    }
    const overrideHashes = new Set();
    document.overrides.forEach((override) => {
        assertSha256(override.packageHash, "packageHash");
        assertCanonicalTimestamp(override.createdAt, "createdAt");
        if (overrideHashes.has(override.packageHash) || override.decision !== "allow" || typeof override.reason !== "string" || !override.reason) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy override is invalid.");
        overrideHashes.add(override.packageHash);
    });
    return document;
}

function subjectMatches(subject, release, packageHashes) {
    if (subject.itemId) return subject.itemId === release.itemId && subject.releaseVersion === release.releaseVersion;
    if (subject.artifactSha256) return subject.artifactSha256 === release.artifact.sha256;
    return packageHashes.includes(subject.packageHash);
}

function activeAdvisories(entry) {
    const byId = new Map(entry.advisories.map((record) => [record.advisory.advisoryId, record.advisory]));
    const cleared = new Set();
    for (const advisory of byId.values()) {
        if (advisory.action === "clear") (advisory.supersedes ?? []).forEach((id) => cleared.add(id));
    }
    return [...byId.values()].filter((advisory) => !cleared.has(advisory.advisoryId));
}

export class MarketplacePolicyStore {
    #queue = Promise.resolve();
    #listeners = new Set();

    constructor(paths, { now = () => new Date() } = {}) {
        this.paths = paths;
        this.now = now;
    }

    static async open(dataDir, options = {}) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.root);
        if (!await lstatOrNull(paths.policy)) await writeExclusiveDurable(paths.policy, canonicalMarketplaceBytes(emptyPolicy()));
        const store = new MarketplacePolicyStore(paths, options);
        await store.snapshot();
        return store;
    }

    async snapshot() {
        const bytes = await readRegularBytes(this.paths.policy, { maxBytes: 64 * 1024 * 1024 });
        const { document } = parseMarketplaceJsonBytes(bytes);
        validate(document);
        if (!Buffer.from(canonicalMarketplaceBytes(document)).equals(bytes)) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace policy document is not canonical.");
        return structuredClone(document);
    }

    async #mutate(operation) {
        const result = this.#queue.catch(() => {}).then(async () => {
            const document = await this.snapshot();
            const value = await operation(document);
            document.revision += 1;
            document.registries.sort((left, right) => compareUtf8(left.registryId, right.registryId));
            validate(document);
            await atomicReplaceDurable(this.paths.policy, canonicalMarketplaceBytes(document));
            for (const listener of this.#listeners) listener(document.revision);
            return value ?? document.revision;
        });
        this.#queue = result.catch(() => {});
        return result;
    }

    subscribe(listener) {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async ingestVerifiedSnapshot({ source, manifest, publishers = [], releases = [], advisories = [], yanks = [] }) {
        return this.#mutate((document) => {
            const entry = registry(document, source.registryId);
            entry.releases ??= [];
            entry.approvedPublishers ??= [];
            const timestampVersion = manifest.timestamp.version;
            if (timestampVersion < entry.highestTimestampVersion) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace policy rollback floor rejected an older timestamp.");
            if (timestampVersion === entry.highestTimestampVersion && entry.highestSnapshotSha256 !== null
                && entry.highestSnapshotSha256 !== manifest.snapshot.sha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace timestamp identity changed at the rollback floor.");
            }
            entry.highestTimestampVersion = timestampVersion;
            entry.highestSnapshotSha256 = manifest.snapshot.sha256;
            if (!entry.sourceIds.includes(source.sourceId)) entry.sourceIds.push(source.sourceId);
            entry.sourceIds.sort(compareUtf8);
            for (const publisher of publishers) {
                if (!entry.publishers.includes(publisher.publisherId)) entry.publishers.push(publisher.publisherId);
            }
            entry.publishers.sort(compareUtf8);
            const knownReleases = new Map(entry.releases.map((record) => [
                `${record.itemId}\u0000${record.releaseVersion}\u0000${record.artifactSha256}`,
                record,
            ]));
            for (const release of releases) {
                const record = {
                    itemId: release.itemId,
                    releaseVersion: release.releaseVersion,
                    artifactSha256: release.artifact.sha256,
                    publisherId: release.publisherId,
                    packageHashes: [
                        ...(release.executable ? [release.executable.packageHash] : []),
                        ...(release.embeddedPlugins?.map((plugin) => plugin.packageHash) ?? []),
                    ].sort(compareUtf8),
                };
                const key = `${record.itemId}\u0000${record.releaseVersion}\u0000${record.artifactSha256}`;
                const current = knownReleases.get(key);
                if (current && current.publisherId !== record.publisherId) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace release publisher identity changed.");
                if (!current) entry.releases.push(record);
            }
            entry.releases.sort((left, right) => compareUtf8(
                `${left.itemId}\u0000${left.releaseVersion}\u0000${left.artifactSha256}`,
                `${right.itemId}\u0000${right.releaseVersion}\u0000${right.artifactSha256}`,
            ));
            const advisoryById = new Map(entry.advisories.map((record) => [record.advisory.advisoryId, record]));
            for (const advisory of advisories) {
                const hash = hashMarketplaceBytes(marketplaceDocumentBytes(advisory));
                const current = advisoryById.get(advisory.advisoryId);
                if (current && current.hash !== hash) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace advisory identity changed.");
                if (!current) entry.advisories.push({ hash, advisory: structuredClone(advisory) });
            }
            const known = new Set(entry.advisories.map((record) => record.advisory.advisoryId));
            for (const record of entry.advisories) {
                for (const superseded of record.advisory.supersedes ?? []) {
                    if (!known.has(superseded)) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNTRUSTED, "Marketplace advisory supersedes an unknown record.");
                }
            }
            const yankByKey = new Map(entry.yanks.map((yank) => [keyForYank(yank), yank]));
            yanks.forEach((yank) => { if (!yankByKey.has(keyForYank(yank))) entry.yanks.push(structuredClone(yank)); });
            entry.advisories.sort((left, right) => compareUtf8(left.advisory.advisoryId, right.advisory.advisoryId));
            entry.yanks.sort((left, right) => compareUtf8(keyForYank(left), keyForYank(right)));
        });
    }

    async setPublisherApproval(registryId, publisherId, approved, { expectedRevision = null } = {}) {
        assertCanonicalUuid(registryId, "registryId");
        assertMarketplaceId(publisherId, "publisherId");
        return this.#mutate((document) => {
            if (expectedRevision !== null && document.revision !== expectedRevision) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace policy revision is stale.");
            const entry = registry(document, registryId);
            const approvedSet = new Set(entry.approvedPublishers ?? []);
            if (approved) approvedSet.add(publisherId); else approvedSet.delete(publisherId);
            entry.approvedPublishers = [...approvedSet].sort(compareUtf8);
        });
    }

    async setOperatorOverride(packageHash, reason, { expectedRevision = null } = {}) {
        assertSha256(packageHash, "packageHash");
        if (typeof reason !== "string" || !reason.trim()) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Operator override reason is required.");
        return this.#mutate((document) => {
            if (expectedRevision !== null && document.revision !== expectedRevision) throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace policy revision is stale.");
            const value = { packageHash, decision: "allow", reason: reason.trim(), createdAt: this.now().toISOString() };
            const index = document.overrides.findIndex((entry) => entry.packageHash === packageHash);
            if (index < 0) document.overrides.push(value); else document.overrides[index] = value;
            document.overrides.sort((left, right) => compareUtf8(left.packageHash, right.packageHash));
        });
    }

    async evaluateRelease({ registryId, publisherId, release, packageHashes = [] }) {
        const document = await this.snapshot();
        const entry = document.registries.find((candidate) => candidate.registryId === registryId);
        const approved = entry?.approvedPublishers?.includes(publisherId) ?? false;
        const applicable = (entry ? activeAdvisories(entry) : []).filter((advisory) => advisory.affected.some((subject) => subjectMatches(subject, release, packageHashes)));
        const blocks = applicable.filter((advisory) => advisory.action === "block");
        const overridden = blocks.length > 0 && packageHashes.some((hash) => document.overrides.some((entry) => entry.packageHash === hash));
        return Object.freeze({
            revision: document.revision,
            approved,
            blocked: blocks.length > 0 && !overridden,
            yanked: entry?.yanks.some((yank) => keyForYank(yank) === `${release.itemId}\u0000${release.releaseVersion}\u0000${release.artifact.sha256}`) ?? false,
            advisories: Object.freeze(applicable),
            overrides: Object.freeze(document.overrides.filter((override) => packageHashes.includes(override.packageHash))),
        });
    }

    async evaluateInstalled(installation) {
        const document = await this.snapshot();
        const entry = document.registries.find((candidate) => candidate.registryId === installation.registryId);
        const origin = entry?.releases.find((candidate) => candidate.itemId === installation.release.itemId
            && candidate.releaseVersion === installation.release.releaseVersion
            && candidate.artifactSha256 === installation.release.artifactSha256);
        if (!entry || !origin) return Object.freeze({ revision: document.revision, approved: false, blocked: false, yanked: false, advisories: Object.freeze([]), overrides: Object.freeze([]) });
        return this.evaluateRelease({
            registryId: installation.registryId,
            publisherId: origin.publisherId,
            release: {
                itemId: origin.itemId,
                releaseVersion: origin.releaseVersion,
                artifact: { sha256: origin.artifactSha256 },
            },
            packageHashes: origin.packageHashes,
        });
    }
}
