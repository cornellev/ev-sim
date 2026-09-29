import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { hashMarketplaceRelease } from "../MarketplaceContracts.js";
import { AUTHORING_ONLY_CONTENT_KINDS, artifactByteLimitFor } from "../MarketplaceContract.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../MarketplaceErrors.js";
import { assertCanonicalUuid, assertMarketplaceId, assertReleaseVersion, assertSha256 } from "../MarketplaceFormats.js";
import {
    ensureDirectory,
    lstatOrNull,
    readRegularBytes,
    writeExclusiveDurable,
} from "../registry/RegistryFs.js";
import {
    evaluateMarketplaceCompatibility,
    hashMarketplaceHostProfile,
} from "./MarketplaceCompatibility.js";
import { marketplaceClientPaths } from "./MarketplaceClientLayout.js";
import { resolveInstallGraph } from "./MarketplaceDependencyResolver.js";
import {
    MARKETPLACE_INSTALL_DOCUMENT_VERSION,
    MARKETPLACE_INSTALL_KINDS,
    assertInstallDocument,
    assertInstallFinalPlan,
    assertInstallPreflight,
    hashInstallDocument,
    installDocumentBytes,
    parseInstallDocument,
} from "./MarketplaceInstallDocuments.js";

function planPath(paths, planHash) {
    assertSha256(planHash, "planHash");
    return path.join(paths.plans, `${planHash}.json`);
}

function exactRef(release) {
    return Object.freeze({
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        artifactSha256: release.artifact.sha256,
    });
}

function releaseKey(release) {
    return `${release.itemId}\u0000${release.releaseVersion}\u0000${release.artifact.sha256}`;
}

function yankedSet(catalog) {
    return new Set(catalog.yanks.map((entry) => (
        `${entry.release.itemId}\u0000${entry.release.releaseVersion}\u0000${entry.release.artifactSha256}`
    )));
}

function normalizePlan(adapterPlan) {
    if (!adapterPlan || typeof adapterPlan !== "object" || Array.isArray(adapterPlan)) {
        throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Artifact adapter plan must be an object.");
    }
    const normalized = structuredClone(adapterPlan);
    for (const key of ["rights", "conflicts", "mappings", "warnings", "blockingIssues"]) {
        if (normalized[key] === undefined) normalized[key] = [];
        if (!Array.isArray(normalized[key])) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, `Artifact adapter plan ${key} must be an array.`);
        }
    }
    return normalized;
}

function deniedRight(right) {
    return right?.allowed === false || right?.verdict === "denied";
}

export class MarketplaceInstallPlanner {
    constructor({
        paths,
        sourceStore,
        cache,
        installedStore,
        ownershipStore = null,
        artifactStore,
        adapterRegistry,
        hostProfileProvider,
        releasePolicy = () => Object.freeze({ blocked: false, warnings: Object.freeze([]) }),
    }) {
        this.paths = paths;
        this.sourceStore = sourceStore;
        this.cache = cache;
        this.installedStore = installedStore;
        this.ownershipStore = ownershipStore;
        this.artifactStore = artifactStore;
        this.adapterRegistry = adapterRegistry;
        this.hostProfileProvider = hostProfileProvider;
        this.releasePolicy = releasePolicy;
    }

    static async create(dataDir, dependencies) {
        const paths = marketplaceClientPaths(dataDir);
        await ensureDirectory(paths.plans);
        return new MarketplaceInstallPlanner({ paths, ...dependencies });
    }

    async #publish(document, assertion) {
        const validated = assertion(document);
        const hash = hashInstallDocument(validated, assertion);
        const destination = planPath(this.paths, hash);
        const bytes = installDocumentBytes(validated, assertion);
        if (await lstatOrNull(destination)) {
            const existing = await readRegularBytes(destination, { maxBytes: 64 * 1024 * 1024 });
            if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace installation plan hash collision or corruption.");
            }
        } else {
            try {
                await writeExclusiveDurable(destination, bytes);
            } catch (error) {
                if (error.code !== "EEXIST") throw error;
                const existing = await readRegularBytes(destination, { maxBytes: 64 * 1024 * 1024 });
                if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
                    throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Concurrent marketplace installation plans disagreed.");
                }
            }
        }
        return Object.freeze({ planHash: hash, plan: validated });
    }

    async createPreflight({ sourceId, itemId, releaseVersion }) {
        assertCanonicalUuid(sourceId, "sourceId");
        assertMarketplaceId(itemId, "itemId");
        assertReleaseVersion(releaseVersion, "releaseVersion");
        const source = this.sourceStore.get(sourceId);
        if (!source) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace source was not found.");
        if (!source.enabled) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace source is disabled.");
        const current = await this.cache.readCurrent(source);
        if (!current) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_UNAVAILABLE, "Marketplace source has no verified snapshot.");
        const root = current.documents.releases.find((release) => (
            release.itemId === itemId && release.releaseVersion === releaseVersion
        ));
        if (!root) throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace release is not present in the verified snapshot.");
        const resolved = resolveInstallGraph({
            rootRelease: exactRef(root),
            catalog: current.catalog,
            releases: current.documents.releases,
            releasePolicy: this.releasePolicy,
        });
        for (const { release } of resolved.releases) {
            const limit = artifactByteLimitFor(release.contentKind);
            if (release.artifact.sizeBytes > limit) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, `Marketplace ${release.contentKind} artifact exceeds its ${limit}-byte limit.`);
            }
        }
        const hostProfile = await this.hostProfileProvider();
        const hostProfileHash = hashMarketplaceHostProfile(hostProfile);
        const installed = await this.installedStore.snapshot();
        if (this.ownershipStore) {
            const ownership = await this.ownershipStore.snapshot();
            this.ownershipStore.verifyAgainstInstalled(ownership, installed);
        }
        const yanks = yankedSet(current.catalog);
        const summaryHashes = new Map(current.catalog.releases.map((release) => [
            `${release.itemId}\u0000${release.releaseVersion}`,
            release.releaseHash,
        ]));
        const releases = resolved.releases.map(({ release, disposition, owners }) => {
            const compatibility = evaluateMarketplaceCompatibility(release.compatibility, hostProfile);
            const releaseHash = summaryHashes.get(`${release.itemId}\u0000${release.releaseVersion}`);
            if (releaseHash !== hashMarketplaceRelease(release)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Verified marketplace release hash disagrees with its catalog summary.");
            }
            const yanked = yanks.has(releaseKey(release));
            return {
                release,
                releaseHash,
                disposition,
                owners,
                compatibility,
                yanked,
                warnings: yanked ? [`Exact release ${release.itemId}@${release.releaseVersion} is yanked.`] : [],
            };
        });
        const artifactsByDigest = new Map();
        for (const { release } of resolved.releases) {
            const current = artifactsByDigest.get(release.artifact.sha256);
            if (current && (current.mediaType !== release.artifact.mediaType || current.sizeBytes !== release.artifact.sizeBytes)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.SIGNATURE_INVALID, "Verified releases disagree about a shared artifact descriptor.");
            }
            artifactsByDigest.set(release.artifact.sha256, structuredClone(release.artifact));
        }
        const artifacts = [...artifactsByDigest.values()].sort((left, right) => compareUtf8(left.sha256, right.sha256));
        const totalDownloadBytes = artifacts.reduce((total, artifact) => {
            const next = total + artifact.sizeBytes;
            if (!Number.isSafeInteger(next)) throw marketplaceError(MARKETPLACE_ERROR_CODES.LIMIT_EXCEEDED, "Marketplace installation download size is too large.");
            return next;
        }, 0);
        const document = {
            kind: MARKETPLACE_INSTALL_KINDS.preflight,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            source: {
                sourceId: source.sourceId,
                registryId: source.registryId,
                trustedRootFingerprint: source.trustedRootFingerprint,
                snapshotId: current.manifest.snapshotId,
                catalogRevision: current.manifest.catalog.revision,
                catalogSha256: current.manifest.catalog.sha256,
            },
            root: exactRef(root),
            releases,
            artifacts,
            totalDownloadBytes,
            installedRevision: installed.revision,
            hostProfile,
            hostProfileHash,
            warnings: resolved.warnings,
        };
        return this.#publish(document, assertInstallPreflight);
    }

    async readPlan(planHash) {
        const filePath = planPath(this.paths, planHash);
        if (!await lstatOrNull(filePath)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.SOURCE_NOT_FOUND, "Marketplace installation plan was not found.");
        }
        const bytes = await readRegularBytes(filePath, { maxBytes: 64 * 1024 * 1024 });
        const document = parseInstallDocument(bytes, assertInstallDocument);
        if (hashInstallDocument(document) !== planHash
            || !Buffer.from(bytes).equals(Buffer.from(installDocumentBytes(document)))) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace installation plan is not canonical or has the wrong hash.");
        }
        return document;
    }

    async readPreflight(planHash) {
        const document = await this.readPlan(planHash);
        if (document.kind !== MARKETPLACE_INSTALL_KINDS.preflight) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Expected a marketplace installation preflight plan.");
        }
        return document;
    }

    async readFinalPlan(planHash) {
        const document = await this.readPlan(planHash);
        if (document.kind !== MARKETPLACE_INSTALL_KINDS.finalPlan) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.DOCUMENT_INVALID, "Expected a finalized marketplace installation plan.");
        }
        return document;
    }

    async createFinalPlan(preflightHash, { signal = null, workDirectory = null } = {}) {
        const preflight = await this.readPreflight(preflightHash);
        const source = this.sourceStore.get(preflight.source.sourceId);
        if (!source || source.registryId !== preflight.source.registryId
            || source.trustedRootFingerprint !== preflight.source.trustedRootFingerprint || !source.enabled) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace source identity changed after preflight.");
        }
        const pinned = await this.cache.readSnapshot(source, preflight.source.snapshotId);
        if (pinned.manifest.catalog.revision !== preflight.source.catalogRevision
            || pinned.manifest.catalog.sha256 !== preflight.source.catalogSha256) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Pinned marketplace catalog identity changed.");
        }
        const pinnedReleases = new Map(pinned.documents.releases.map((release) => [
            `${release.itemId}\u0000${release.releaseVersion}`,
            release,
        ]));
        const pinnedRoot = pinnedReleases.get(`${preflight.root.itemId}\u0000${preflight.root.releaseVersion}`);
        const reproduced = resolveInstallGraph({
            rootRelease: preflight.root,
            catalog: pinned.catalog,
            releases: pinned.documents.releases,
            releasePolicy: this.releasePolicy,
        });
        const hasInstallIntent = preflight.releases.some((entry) => entry.disposition !== undefined);
        const reproducedIntent = reproduced.releases.map((entry) => hasInstallIntent ? ({
            release: entry.release,
            disposition: entry.disposition,
            owners: entry.owners,
        }) : entry.release);
        const preflightIntent = preflight.releases.map((entry) => hasInstallIntent ? ({
            release: entry.release,
            disposition: entry.disposition,
            owners: entry.owners,
        }) : entry.release);
        if (!pinnedRoot || !isDeepStrictEqual(reproducedIntent, preflightIntent)) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace preflight graph or installation intent changed.");
        }
        const installed = await this.installedStore.snapshot();
        if (this.ownershipStore) {
            const ownership = await this.ownershipStore.snapshot();
            this.ownershipStore.verifyAgainstInstalled(ownership, installed);
        }
        const hostProfile = await this.hostProfileProvider();
        const hostProfileHash = hashMarketplaceHostProfile(hostProfile);
        const releases = [];
        for (const entry of preflight.releases) {
            const release = entry.release;
            const pinnedRelease = pinnedReleases.get(`${release.itemId}\u0000${release.releaseVersion}`);
            if (!pinnedRelease || hashMarketplaceRelease(pinnedRelease) !== entry.releaseHash
                || pinnedRelease.artifact.sha256 !== release.artifact.sha256) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Pinned marketplace release identity changed.");
            }
            const compatibility = evaluateMarketplaceCompatibility(release.compatibility, hostProfile);
            if (!compatibility.compatible && release.contentKind !== "collection"
                && !AUTHORING_ONLY_CONTENT_KINDS.includes(release.contentKind)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.INCOMPATIBLE, `Marketplace release ${release.itemId}@${release.releaseVersion} is incompatible with this host.`);
            }
            const policy = this.releasePolicy(release) ?? {};
            if (policy.blocked) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RELEASE_BLOCKED, `Marketplace release ${release.itemId}@${release.releaseVersion} is blocked.`);
            }
            const disposition = entry.disposition ?? "requested";
            const adapter = disposition === "artifact-only"
                ? this.adapterRegistry.get(release.contentKind)
                : this.adapterRegistry.requireLifecycle(release.contentKind);
            const artifactHandle = await this.artifactStore.get(release.artifact);
            if (!artifactHandle) throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Verified marketplace artifact is unavailable during planning.");
            const context = Object.freeze({
                signal,
                installed,
                hostProfile,
                source: preflight.source,
                workDirectory,
                stagingRoot: workDirectory ? path.join(workDirectory, "inspection") : undefined,
            });
            let inspection;
            try {
                inspection = await adapter.inspect(artifactHandle, context);
                adapter.validate(inspection, release);
            } catch (error) {
                await this.artifactStore.quarantineCached(release.artifact).catch(() => {});
                throw error;
            }
            let adapterPlan = disposition === "artifact-only"
                ? normalizePlan({
                    mode: "artifact-only",
                    rights: [], conflicts: [], mappings: [], warnings: [], blockingIssues: [], operations: [],
                })
                : normalizePlan(await adapter.plan({ release, inspection, artifactHandle, context }));
            const alreadyInstalled = installed.installations.some((installation) => (
                installation.sourceId === preflight.source.sourceId
                && installation.release.itemId === release.itemId
                && installation.release.releaseVersion === release.releaseVersion
                && installation.release.artifactSha256 === release.artifact.sha256
            ));
            if (disposition !== "artifact-only" && alreadyInstalled) {
                adapterPlan = { ...adapterPlan, operations: [], installationAction: "reuse" };
            }
            const rightsDenied = adapterPlan.rights.filter(deniedRight);
            const blockingIssues = [
                ...adapterPlan.blockingIssues.map(String),
                ...rightsDenied.map((right) => `Required right denied: ${String(right.id ?? right.right ?? "unknown")}`),
            ];
            releases.push({
                release,
                releaseHash: entry.releaseHash,
                disposition,
                owners: entry.owners ?? [{ kind: "direct" }],
                compatibility,
                adapterId: adapter.id,
                artifact: release.artifact,
                inspection,
                adapterPlan,
                rights: adapterPlan.rights,
                conflicts: adapterPlan.conflicts,
                mappings: adapterPlan.mappings,
                warnings: adapterPlan.warnings.map(String),
                blockingIssues,
            });
        }
        const blockingIssues = releases.flatMap((entry) => entry.blockingIssues);
        const warnings = [...new Set([
            ...preflight.warnings,
            ...releases.flatMap((entry) => entry.warnings),
        ])].sort(compareUtf8);
        return this.#publish({
            kind: MARKETPLACE_INSTALL_KINDS.finalPlan,
            version: MARKETPLACE_INSTALL_DOCUMENT_VERSION,
            preflightHash,
            installedRevision: installed.revision,
            hostProfileHash,
            releases,
            committable: blockingIssues.length === 0,
            blockingIssues,
            warnings,
        }, assertInstallFinalPlan);
    }

    async revalidateFinalPlan(finalPlanHash, { workDirectory = null } = {}) {
        const expected = await this.readFinalPlan(finalPlanHash);
        const current = await this.createFinalPlan(expected.preflightHash, { workDirectory });
        if (current.planHash !== finalPlanHash) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Marketplace installation plan changed before commit.");
        }
        if (!current.plan.committable) {
            throw marketplaceError(MARKETPLACE_ERROR_CODES.RIGHTS_DENIED, "Marketplace installation requires denied rights or has blocking conflicts.");
        }
        return current.plan;
    }

    async recover() {
        for (const entry of await fs.readdir(this.paths.plans, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || !entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
                throw marketplaceError(MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED, "Marketplace plan store contains an unexpected node.");
            }
            await this.readPlan(entry.name.slice(0, -5));
        }
    }
}
