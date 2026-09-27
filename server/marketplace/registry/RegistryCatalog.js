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

export function createEmptyCatalog(registryId, now = () => new Date()) {
    return assertMarketplaceCatalog({
        kind: MARKETPLACE_KINDS.catalog,
        version: MARKETPLACE_SCHEMA_VERSION,
        registryId,
        revision: 1,
        generatedAt: now().toISOString(),
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

export function projectReleaseSummary(release, releaseHash, target) {
    return Object.freeze({
        itemId: release.itemId,
        releaseVersion: release.releaseVersion,
        contentKind: release.contentKind,
        publisherId: release.publisherId,
        licenseExpression: release.licenseExpression,
        artifact: structuredClone(release.artifact),
        compatibility: sortedCompatibility(release.compatibility),
        capabilities: sortedStrings(release.capabilities),
        dependencies: structuredClone(release.dependencies).sort(byKeys("itemId", "releaseVersion", "artifactSha256")),
        releaseHash,
        target: structuredClone(target),
    });
}

export function sortCatalog(catalog) {
    const sorted = structuredClone(catalog);
    sorted.items.sort(byKeys("itemId"));
    sorted.releases.sort(byKeys("itemId", "releaseVersion"));
    sorted.tracks.sort(byKeys("itemId", "track"));
    sorted.yanks.sort((left, right) => byKeys("itemId", "releaseVersion", "artifactSha256")(left.release, right.release));
    sorted.advisories.sort(byKeys("advisoryId"));
    return assertMarketplaceCatalog(sorted);
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
