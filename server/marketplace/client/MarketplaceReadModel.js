import { compareUtf8 } from "../../../app/math/compareUtf8.js";
import { MARKETPLACE_CONTENT_KINDS, MARKETPLACE_TRACKS } from "../MarketplaceContract.js";
import {
    assertCanonicalUuid,
    assertMarketplaceId,
    assertReleaseVersion,
} from "../MarketplaceFormats.js";

export const MARKETPLACE_QUERY_DEFAULTS = Object.freeze({
    q: "",
    track: "stable",
    contentKind: null,
    sourceId: null,
    publisherId: null,
    license: null,
    offset: 0,
    limit: 50,
});

export const MARKETPLACE_QUERY_MAX_LIMIT = 100;

function boundedText(value, name, maxLength = 256) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string" || value.length > maxLength) throw new TypeError(`${name} must be a string no longer than ${maxLength} characters.`);
    return value;
}

function nonNegativeInteger(value, name, fallback) {
    if (value === null || value === undefined || value === "") return fallback;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(`${name} must be a non-negative safe integer.`);
    return parsed;
}

export function normalizeMarketplaceQuery(value = {}) {
    const q = boundedText(value.q, "q")?.trim() ?? "";
    const track = boundedText(value.track, "track", 16) ?? MARKETPLACE_QUERY_DEFAULTS.track;
    if (!MARKETPLACE_TRACKS.includes(track)) throw new TypeError("track must be stable or beta.");
    const contentKind = boundedText(value.contentKind, "contentKind", 32);
    if (contentKind && !MARKETPLACE_CONTENT_KINDS.includes(contentKind)) throw new TypeError("contentKind is not supported.");
    const sourceId = boundedText(value.sourceId, "sourceId", 36);
    if (sourceId) assertCanonicalUuid(sourceId, "sourceId");
    const publisherId = boundedText(value.publisherId, "publisherId", 255);
    if (publisherId) assertMarketplaceId(publisherId, "publisherId");
    const license = boundedText(value.license, "license", 1024);
    const offset = nonNegativeInteger(value.offset, "offset", MARKETPLACE_QUERY_DEFAULTS.offset);
    const limit = nonNegativeInteger(value.limit, "limit", MARKETPLACE_QUERY_DEFAULTS.limit);
    if (limit < 1 || limit > MARKETPLACE_QUERY_MAX_LIMIT) throw new TypeError(`limit must be from 1 through ${MARKETPLACE_QUERY_MAX_LIMIT}.`);
    return Object.freeze({ q, track, contentKind, sourceId, publisherId, license, offset, limit });
}

export function selectTrackedRelease(catalog, itemId, track = "stable") {
    assertMarketplaceId(itemId, "itemId");
    if (!MARKETPLACE_TRACKS.includes(track)) throw new TypeError("track must be stable or beta.");
    const selected = catalog.tracks.find((entry) => entry.itemId === itemId && entry.track === track);
    if (!selected) return null;
    return catalog.releases.find((entry) => entry.itemId === itemId && entry.releaseVersion === selected.releaseVersion) ?? null;
}

function sourceProjection(source, health) {
    return Object.freeze({
        sourceId: source.sourceId,
        name: source.name,
        priority: source.priority,
        health,
    });
}

function previewProjection(sourceId, itemId, item) {
    const preview = item?.previews?.[0];
    if (!preview) return null;
    return Object.freeze({
        ...structuredClone(preview),
        url: `/api/marketplace/items/${encodeURIComponent(sourceId)}/${encodeURIComponent(itemId)}/previews/${preview.sha256}`,
    });
}

export function projectCatalogEntries({ source, health, catalog, itemsById, track, fresh }) {
    const projectedSource = sourceProjection(source, health);
    return catalog.items.flatMap((summary) => {
        const release = selectTrackedRelease(catalog, summary.itemId, track);
        const item = itemsById.get(summary.itemId);
        if (!release || !item) return [];
        const yanked = catalog.yanks.some((entry) => entry.release.itemId === release.itemId
            && entry.release.releaseVersion === release.releaseVersion
            && entry.release.artifactSha256 === release.artifact.sha256);
        return [Object.freeze({
            key: `${source.sourceId}:${summary.itemId}:${release.releaseVersion}`,
            source: projectedSource,
            item: Object.freeze({
                itemId: summary.itemId,
                displayName: summary.displayName,
                summary: summary.summary,
                publisherId: summary.publisherId,
                contentKind: summary.contentKind,
                categories: [...summary.categories],
                tags: [...summary.tags],
            }),
            release: structuredClone(release),
            track,
            yanked,
            fresh,
            preview: previewProjection(source.sourceId, summary.itemId, item),
        })];
    });
}

function searchable(entry) {
    return [
        entry.item.displayName,
        entry.item.summary,
        entry.item.itemId,
        entry.item.publisherId,
        ...entry.item.categories,
        ...entry.item.tags,
    ].join("\n").toLocaleLowerCase("en-US");
}

export function filterCatalogEntries(entries, query) {
    const normalized = normalizeMarketplaceQuery(query);
    const needle = normalized.q.toLocaleLowerCase("en-US");
    return entries.filter((entry) => (!needle || searchable(entry).includes(needle))
        && (!normalized.contentKind || entry.item.contentKind === normalized.contentKind)
        && (!normalized.sourceId || entry.source.sourceId === normalized.sourceId)
        && (!normalized.publisherId || entry.item.publisherId === normalized.publisherId)
        && (!normalized.license || entry.release.licenseExpression === normalized.license));
}

function counted(values) {
    const counts = new Map();
    values.forEach(({ value, name = value }) => {
        const current = counts.get(value) ?? { value, label: name, count: 0 };
        current.count += 1;
        counts.set(value, current);
    });
    return [...counts.values()].sort((left, right) => compareUtf8(left.label, right.label));
}

export function buildMarketplaceFacets(entries) {
    return Object.freeze({
        contentKinds: counted(entries.map((entry) => ({ value: entry.item.contentKind }))),
        sources: counted(entries.map((entry) => ({ value: entry.source.sourceId, name: entry.source.name }))),
        publishers: counted(entries.map((entry) => ({ value: entry.item.publisherId }))),
        licenses: counted(entries.map((entry) => ({ value: entry.release.licenseExpression }))),
    });
}

export function sortCatalogEntries(entries) {
    return [...entries].sort((left, right) => left.source.priority - right.source.priority
        || compareUtf8(left.source.sourceId, right.source.sourceId)
        || compareUtf8(left.item.displayName, right.item.displayName)
        || compareUtf8(left.item.itemId, right.item.itemId)
        || compareUtf8(left.release.releaseVersion, right.release.releaseVersion));
}

export function paginateMarketplaceEntries(entries, query) {
    const normalized = normalizeMarketplaceQuery(query);
    return Object.freeze({
        page: Object.freeze({ offset: normalized.offset, limit: normalized.limit, total: entries.length }),
        entries: entries.slice(normalized.offset, normalized.offset + normalized.limit),
    });
}

export function assertMarketplaceDetailSelection(catalog, itemId, releaseVersion = null) {
    assertMarketplaceId(itemId, "itemId");
    if (releaseVersion) assertReleaseVersion(releaseVersion, "releaseVersion");
    const selectedVersion = releaseVersion
        ?? catalog.tracks.find((entry) => entry.itemId === itemId && entry.track === "stable")?.releaseVersion;
    return selectedVersion
        ? catalog.releases.find((entry) => entry.itemId === itemId && entry.releaseVersion === selectedVersion) ?? null
        : null;
}
