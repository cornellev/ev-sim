import semver from "semver";

import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";

function exactInstallationKey(entry) {
    return `${entry.sourceId}\u0000${entry.registryId}\u0000${entry.release.itemId}`;
}

function candidateFor(catalog, itemId, track) {
    const pointer = catalog.tracks.find((entry) => entry.itemId === itemId && entry.track === track);
    if (!pointer) return null;
    return catalog.releases.find((entry) => entry.itemId === itemId && entry.releaseVersion === pointer.releaseVersion) ?? null;
}

function yanked(catalog, release) {
    return catalog.yanks.some((entry) => entry.release.itemId === release.itemId
        && entry.release.releaseVersion === release.releaseVersion
        && entry.release.artifactSha256 === release.artifact.sha256);
}

export class MarketplaceUpdateModel {
    constructor({ sourceStore, cache, installedStore, policyStore }) {
        this.sourceStore = sourceStore;
        this.cache = cache;
        this.installedStore = installedStore;
        this.policyStore = policyStore;
    }

    async listUpdates({ track = "stable" } = {}) {
        if (!["stable", "beta"].includes(track)) throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Marketplace update track must be stable or beta.");
        const installed = await this.installedStore.snapshot();
        const groups = new Map();
        installed.installations.forEach((entry) => {
            const key = exactInstallationKey(entry);
            const values = groups.get(key) ?? [];
            values.push(entry);
            groups.set(key, values);
        });
        const updates = [];
        for (const installations of groups.values()) {
            const newest = installations.reduce((left, right) => semver.gt(right.release.releaseVersion, left.release.releaseVersion) ? right : left);
            const source = this.sourceStore.get(newest.sourceId);
            if (!source || !source.enabled || source.registryId !== newest.registryId) continue;
            const current = await this.cache.readCurrent(source);
            if (!current) continue;
            const summary = candidateFor(current.catalog, newest.release.itemId, track);
            if (!summary || !semver.gt(summary.releaseVersion, newest.release.releaseVersion) || yanked(current.catalog, summary)) continue;
            const release = current.documents.releases.find((entry) => entry.itemId === summary.itemId && entry.releaseVersion === summary.releaseVersion);
            if (!release) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace update candidate is missing from its verified snapshot.");
            const packageHashes = [
                ...(release.executable ? [release.executable.packageHash] : []),
                ...(release.embeddedPlugins?.map((entry) => entry.packageHash) ?? []),
            ];
            const policy = await this.policyStore.evaluateRelease({
                registryId: source.registryId,
                publisherId: release.publisherId,
                release,
                packageHashes,
            });
            if (policy.blocked) continue;
            updates.push(Object.freeze({
                identity: Object.freeze({ sourceId: source.sourceId, registryId: source.registryId, itemId: summary.itemId }),
                track,
                from: newest,
                retained: Object.freeze([...installations].sort((left, right) => semver.compare(left.release.releaseVersion, right.release.releaseVersion))),
                candidate: Object.freeze({ release, summary, snapshotId: current.manifest.snapshotId }),
                policy,
            }));
        }
        return Object.freeze(updates.sort((left, right) => left.identity.itemId.localeCompare(right.identity.itemId)));
    }
}
