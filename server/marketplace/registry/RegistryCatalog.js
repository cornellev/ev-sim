import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { MARKETPLACE_KINDS, MARKETPLACE_SCHEMA_VERSION } from "../MarketplaceContract.js";
import {
    assertMarketplaceCatalog,
    marketplaceDocumentBytes,
} from "../MarketplaceContracts.js";
import { hashMarketplaceBytes } from "../MarketplaceJson.js";

function byKeys(...keys) {
    return (left, right) => {
        for (const key of keys) {
            const comparison = compareUtf8(left[key], right[key]);
            if (comparison !== 0) return comparison;
        }
        return 0;
    };
}

function sortedStrings(values) {
    return [...values].sort(compareUtf8);
}

function sortedCompatibility(value) {
    const compatibility = structuredClone(value);
    compatibility.contracts.sort(byKeys("kind"));
    compatibility.contracts.forEach((entry) => entry.versions.sort(compareUtf8));
    compatibility.platforms = sortedStrings(compatibility.platforms);
    compatibility.architectures = sortedStrings(compatibility.architectures);
    compatibility.runtimes = sortedStrings(compatibility.runtimes);
    compatibility.backends.sort(byKeys("kind", "id", "version"));
    compatibility.features = sortedStrings(compatibility.features);
    return compatibility;
}

export function createEmptyCatalog(registryId, now = () => new Date(), { releaseAuthority = "publisher-dsse" } = {}) {
    return assertMarketplaceCatalog({
        kind: MARKETPLACE_KINDS.catalog,
        version: MARKETPLACE_SCHEMA_VERSION,
        registryId,
        revision: 1,
        generatedAt: now().toISOString(),
        releaseAuthority,
        publishers: [],
        items: [],
        releases: [],
        tracks: [],
        yanks: [],
        advisories: [],
    });
}

export function projectItemSummary(item, target) {
    return Object.freeze({
        itemId: item.itemId,
        publisherId: item.publisherId,
        contentKind: item.contentKind,
        displayName: item.displayName,
        summary: item.summary,
        categories: sortedStrings(item.categories),
        tags: sortedStrings(item.tags),
        target: structuredClone(target),
    });
}

export function projectPublisherSummary(publisher, target) {
    return Object.freeze({
        publisherId: publisher.publisherId,
        target: structuredClone(target),
    });
}

export function projectReleaseSummary(release, releaseHash, target, { publisherKeyId = null } = {}) {
    return Object.freeze({
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        contentKind: release.contentKind,
        publisherId: release.publisherId,
        ...(publisherKeyId ? { publisherKeyId } : {}),
        licenseExpression: release.licenseExpression,
        artifact: structuredClone(release.artifact),
        compatibility: sortedCompatibility(release.compatibility),
        capabilities: sortedStrings(release.capabilities),
        dependencies: structuredClone(release.dependencies).sort(byKeys("itemId", "releaseVersion", "artifactSha256")),
        ...(release.executable ? { executable: structuredClone(release.executable) } : {}),
        ...(release.embeddedPlugins ? {
            embeddedPlugins: structuredClone(release.embeddedPlugins).sort(byKeys("pluginId", "packageHash")),
        } : {}),
        releaseHash,
        target: structuredClone(target),
    });
}

export function sortCatalog(catalog) {
    const sorted = structuredClone(catalog);
    if (sorted.publishers) sorted.publishers.sort(byKeys("publisherId"));
    sorted.items.sort(byKeys("itemId"));
    sorted.releases.sort(byKeys("itemId", "releaseVersion"));
    sorted.tracks.sort(byKeys("itemId", "track"));
    sorted.yanks.sort((left, right) => byKeys("itemId", "releaseVersion", "artifactSha256")(left.release, right.release));
    sorted.advisories.sort(byKeys("advisoryId"));
    return assertMarketplaceCatalog(sorted);
}

export function upsertCatalogPublisher(catalog, summary) {
    const next = structuredClone(catalog);
    next.publishers ??= [];
    const index = next.publishers.findIndex((entry) => entry.publisherId === summary.publisherId);
    if (index < 0) next.publishers.push(structuredClone(summary));
    else next.publishers[index] = structuredClone(summary);
    return sortCatalog(next);
}

export function upsertCatalogItem(catalog, summary) {
    const next = structuredClone(catalog);
    const index = next.items.findIndex((entry) => entry.itemId === summary.itemId);
    if (index < 0) next.items.push(structuredClone(summary));
    else next.items[index] = structuredClone(summary);
    return sortCatalog(next);
}

export function appendCatalogRelease(catalog, summary) {
    const next = structuredClone(catalog);
    next.releases.push(structuredClone(summary));
    return sortCatalog(next);
}

export function setCatalogTrack(catalog, itemId, track, releaseVersion) {
    if (!new Set(["stable", "beta"]).has(track)) throw new TypeError("Catalog track must be stable or beta.");
    const next = structuredClone(catalog);
    const index = next.tracks.findIndex((entry) => entry.itemId === itemId && entry.track === track);
    const value = { itemId, track, releaseVersion };
    if (index < 0) next.tracks.push(value);
    else next.tracks[index] = value;
    return sortCatalog(next);
}

export function removeCatalogTracksForRelease(catalog, itemId, releaseVersion) {
    const next = structuredClone(catalog);
    next.tracks = next.tracks.filter((entry) => entry.itemId !== itemId || entry.releaseVersion !== releaseVersion);
    return sortCatalog(next);
}

export function appendCatalogYank(catalog, yank) {
    const next = structuredClone(catalog);
    const duplicate = next.yanks.some((entry) => entry.release.itemId === yank.release.itemId
        && entry.release.releaseVersion === yank.release.releaseVersion
        && entry.release.artifactSha256 === yank.release.artifactSha256);
    if (duplicate) throw new TypeError("Catalog release is already yanked.");
    next.yanks.push(structuredClone(yank));
    return sortCatalog(next);
}

export function appendCatalogAdvisory(catalog, summary) {
    const next = structuredClone(catalog);
    const duplicate = next.advisories.find((entry) => entry.advisoryId === summary.advisoryId);
    if (duplicate) {
        if (duplicate.target.sha256 !== summary.target.sha256) throw new TypeError("Catalog advisory identity is immutable.");
        return sortCatalog(next);
    }
    next.advisories.push(structuredClone(summary));
    return sortCatalog(next);
}

export function advanceCatalog(catalog, now = () => new Date()) {
    return sortCatalog({
        ...structuredClone(catalog),
        revision: catalog.revision + 1,
        generatedAt: now().toISOString(),
    });
}

export function catalogBytesAndHash(catalog) {
    const validated = assertMarketplaceCatalog(catalog);
    const bytes = marketplaceDocumentBytes(validated);
    return Object.freeze({ document: validated, bytes, sha256: hashMarketplaceBytes(bytes) });
}
