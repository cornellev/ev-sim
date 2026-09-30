import semver from "semver";

export class MarketplaceLibraryReadModel {
    constructor(service) {
        this.service = service;
    }

    async read() {
        const [installed, ownership, stableUpdates, betaUpdates, advisories] = await Promise.all([
            this.service.listInstalled(),
            this.service.listInstalledOwnership(),
            this.service.listUpdates({ track: "stable" }),
            this.service.listUpdates({ track: "beta" }),
            this.service.listAdvisories(),
        ]);
        const updates = new Map();
        for (const candidate of [...stableUpdates, ...betaUpdates]) {
            const key = `${candidate.identity.sourceId}\u0000${candidate.identity.itemId}`;
            const current = updates.get(key);
            if (!current || semver.gt(candidate.candidate.release.releaseVersion, current.candidate.release.releaseVersion)) updates.set(key, candidate);
        }
        const entries = [];
        for (const installation of installed.installations) {
            const source = this.service.sourceStore.get(installation.sourceId);
            const current = source ? await this.service.cache.readCurrent(source).catch(() => null) : null;
            const item = current?.documents.items.find((candidate) => candidate.itemId === installation.release.itemId) ?? null;
            const latestReceiptHash = installation.receiptHashes.at(-1) ?? null;
            const receipt = latestReceiptHash ? await this.service.receiptStore.read(latestReceiptHash).catch(() => null) : null;
            const membership = ownership.memberships.find((candidate) => candidate.sourceId === installation.sourceId
                && candidate.release.itemId === installation.release.itemId
                && candidate.release.releaseVersion === installation.release.releaseVersion
                && candidate.release.artifactSha256 === installation.release.artifactSha256) ?? null;
            const collection = ownership.collections.find((candidate) => candidate.sourceId === installation.sourceId
                && candidate.release.itemId === installation.release.itemId
                && candidate.release.releaseVersion === installation.release.releaseVersion
                && candidate.release.artifactSha256 === installation.release.artifactSha256) ?? null;
            entries.push(Object.freeze({
                sourceId: installation.sourceId,
                registryId: installation.registryId,
                itemId: installation.release.itemId,
                displayName: item?.displayName ?? installation.release.itemId,
                contentKind: item?.contentKind ?? null,
                releaseVersion: installation.release.releaseVersion,
                artifactSha256: installation.release.artifactSha256,
                status: installation.status,
                installedAt: receipt?.installedAt ?? null,
                receiptHash: latestReceiptHash,
                receiptHashes: Object.freeze([...installation.receiptHashes]),
                mappings: Object.freeze(receipt?.mappings ?? []),
                dependencyLock: Object.freeze(receipt?.dependencyLock ?? []),
                owners: Object.freeze(membership?.owners ?? []),
                collection,
                update: updates.get(`${installation.sourceId}\u0000${installation.release.itemId}`) ?? null,
            }));
        }
        return Object.freeze({ revision: installed.revision, entries: Object.freeze(entries), ownership, advisories });
    }
}
