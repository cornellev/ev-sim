import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertSha256 } from "../MarketplaceFormats.js";

export class MarketplaceExecutablePolicy {
    constructor({ policyStore, provenanceStore }) {
        this.policyStore = policyStore;
        this.provenanceStore = provenanceStore;
    }

    subscribe(listener) {
        return this.policyStore.subscribe(listener);
    }

    async evaluateRelease({ registryId, publisherId, release, packageHashes = [] }) {
        return this.policyStore.evaluateRelease({ registryId, publisherId, release, packageHashes });
    }

    async evaluatePackage(packageHash) {
        assertSha256(packageHash, "packageHash");
        const origins = await this.provenanceStore.originsFor(packageHash);
        const evaluations = [];
        for (const origin of origins) {
            evaluations.push(await this.policyStore.evaluateRelease({
                registryId: origin.registryId,
                publisherId: origin.publisherId,
                release: {
                    itemId: origin.release.itemId,
                    releaseVersion: origin.release.releaseVersion,
                    artifact: { sha256: origin.release.artifactSha256 },
                },
                packageHashes: [packageHash],
            }));
        }
        return Object.freeze({
            packageHash,
            origins,
            blocked: evaluations.some((entry) => entry.blocked),
            approved: evaluations.length === 0 || evaluations.some((entry) => entry.approved),
            evaluations: Object.freeze(evaluations),
        });
    }

    async authorizePackage(packageHash) {
        const result = await this.evaluatePackage(packageHash);
        if (result.blocked) throw marketplaceError(MARKETPLACE_ERROR_CODES.RELEASE_BLOCKED, `Plugin package ${packageHash} is blocked by Marketplace policy.`);
        if (!result.approved) throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, `Plugin package ${packageHash} has no approved Marketplace publisher.`);
        return result;
    }

    async snapshotForPackages(packageHashes) {
        const packages = [];
        for (const packageHash of [...new Set(packageHashes)].sort()) packages.push(await this.evaluatePackage(packageHash));
        const policy = await this.policyStore.snapshot();
        return Object.freeze({ revision: policy.revision, packages: Object.freeze(packages) });
    }
}
