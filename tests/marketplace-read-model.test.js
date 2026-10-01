import assert from "node:assert/strict";
import test from "node:test";

import {
    buildMarketplaceFacets,
    filterCatalogEntries,
    normalizeMarketplaceQuery,
    paginateMarketplaceEntries,
    projectCatalogEntries,
    selectTrackedRelease,
    sortCatalogEntries,
} from "../server/marketplace/client/MarketplaceReadModel.js";

const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";

function release(itemId, releaseVersion, licenseExpression = "Apache-2.0") {
    return {
        itemId,
        releaseVersion,
        publisherId: "com.example.publisher",
        licenseExpression,
        artifact: { sha256: releaseVersion === "2.0.0" ? "b".repeat(64) : "a".repeat(64), sizeBytes: 64 },
        compatibility: {},
        capabilities: [],
        dependencies: [],
        releaseHash: releaseVersion === "2.0.0" ? "d".repeat(64) : "c".repeat(64),
    };
}

function catalog(itemId = "com.example.shared") {
    return {
        items: [{
            itemId,
            displayName: "Control Pack",
            summary: "Deterministic controller examples.",
            publisherId: "com.example.publisher",
            contentKind: "plugin",
            categories: ["controls"],
            tags: ["example", "plugin"],
        }],
        releases: [release(itemId, "1.0.0"), release(itemId, "2.0.0", "MIT")],
        tracks: [
            { itemId, track: "stable", releaseVersion: "1.0.0" },
            { itemId, track: "beta", releaseVersion: "2.0.0" },
        ],
        yanks: [{
            release: { itemId, releaseVersion: "2.0.0", artifactSha256: "b".repeat(64) },
            reason: "Fixture beta yank",
        }],
    };
}

function source(sourceId, name, priority) {
    return { sourceId, name, priority };
}

function item(itemId = "com.example.shared") {
    return {
        itemId,
        previews: [{ mediaType: "image/png", sha256: "e".repeat(64), sizeBytes: 123, alt: "Preview" }],
    };
}

function entries({ sourceId = SOURCE_A, name = "Primary", priority = 0, track = "stable", fresh = true } = {}) {
    const itemId = "com.example.shared";
    return projectCatalogEntries({
        source: source(sourceId, name, priority),
        health: { status: fresh ? "ready" : "expired" },
        catalog: catalog(itemId),
        itemsById: new Map([[itemId, item(itemId)]]),
        track,
        fresh,
    });
}

test("MKT-06 normalizes strict read filters and bounds pagination", () => {
    assert.deepEqual(normalizeMarketplaceQuery(), {
        q: "",
        track: "stable",
        contentKind: null,
        sourceId: null,
        publisherId: null,
        license: null,
        sort: "source",
        offset: 0,
        limit: 50,
    });
    assert.throws(() => normalizeMarketplaceQuery({ track: "nightly" }), /stable or beta/u);
    assert.throws(() => normalizeMarketplaceQuery({ limit: 101 }), /1 through 100/u);
    assert.throws(() => normalizeMarketplaceQuery({ offset: "-1" }), /non-negative/u);
    assert.throws(() => normalizeMarketplaceQuery({ sort: "popular" }), /sort must be source, name, kind, or version/u);
});

test("MKT-06 selects exact signed stable and beta tracks", () => {
    const document = catalog();
    assert.equal(selectTrackedRelease(document, "com.example.shared").releaseVersion, "1.0.0");
    assert.equal(selectTrackedRelease(document, "com.example.shared", "beta").releaseVersion, "2.0.0");
    assert.equal(selectTrackedRelease(document, "com.example.missing"), null);
});

test("MKT-06 filters searchable fields and exact facets without compatibility claims", () => {
    const projected = entries();
    for (const q of ["control", "controller", "com.example.shared", "publisher", "controls", "plugin"]) {
        assert.equal(filterCatalogEntries(projected, { q }).length, 1, q);
    }
    assert.equal(filterCatalogEntries(projected, { contentKind: "vehicle" }).length, 0);
    assert.equal(filterCatalogEntries(projected, { sourceId: SOURCE_B }).length, 0);
    assert.equal(filterCatalogEntries(projected, { publisherId: "com.example.other" }).length, 0);
    assert.equal(filterCatalogEntries(projected, { license: "MIT" }).length, 0);
    assert.deepEqual(buildMarketplaceFacets(projected), {
        contentKinds: [{ value: "plugin", label: "plugin", count: 1 }],
        sources: [{ value: SOURCE_A, label: "Primary", count: 1 }],
        publishers: [{ value: "com.example.publisher", label: "com.example.publisher", count: 1 }],
        licenses: [{ value: "Apache-2.0", label: "Apache-2.0", count: 1 }],
    });
});

test("MKT-06 preserves duplicate cross-source IDs and orders and paginates deterministically", () => {
    const duplicated = [
        ...entries({ sourceId: SOURCE_B, name: "Secondary", priority: 20, fresh: false }),
        ...entries({ sourceId: SOURCE_A, name: "Primary", priority: 10 }),
    ];
    const sorted = sortCatalogEntries(duplicated);
    assert.deepEqual(sorted.map((entry) => entry.source.sourceId), [SOURCE_A, SOURCE_B]);
    assert.equal(sorted[1].fresh, false);
    assert.equal(new Set(sorted.map((entry) => entry.key)).size, 2);
    const first = paginateMarketplaceEntries(sorted, { offset: 0, limit: 1 });
    const second = paginateMarketplaceEntries(sorted, { offset: 1, limit: 1 });
    assert.deepEqual(first.page, { offset: 0, limit: 1, total: 2 });
    assert.equal(first.entries[0].source.sourceId, SOURCE_A);
    assert.equal(second.entries[0].source.sourceId, SOURCE_B);
});

test("MKT-16 sorts catalog entries by name, kind, and release version", () => {
    const base = entries()[0];
    const cloned = (patch) => ({
        ...base,
        ...patch,
        source: { ...base.source, ...patch.source },
        item: { ...base.item, ...patch.item },
        release: { ...base.release, ...patch.release },
    });
    const rows = [
        base,
        cloned({
            key: `${SOURCE_B}:com.example.vehicle:1.2.0`,
            source: { sourceId: SOURCE_B, name: "Secondary", priority: 20 },
            item: { displayName: "Alpha Vehicle", contentKind: "vehicle", itemId: "com.example.vehicle" },
            release: { releaseVersion: "1.2.0", itemId: "com.example.vehicle" },
        }),
        cloned({
            key: `${SOURCE_A}:com.example.shared:3.0.0`,
            release: { releaseVersion: "3.0.0" },
        }),
    ];
    assert.deepEqual(sortCatalogEntries(rows, "name").map((entry) => entry.item.displayName), ["Alpha Vehicle", "Control Pack", "Control Pack"]);
    assert.deepEqual(sortCatalogEntries(rows, "kind").map((entry) => entry.item.contentKind), ["plugin", "plugin", "vehicle"]);
    assert.deepEqual(sortCatalogEntries(rows, "version").map((entry) => entry.release.releaseVersion), ["3.0.0", "1.2.0", "1.0.0"]);
});

test("MKT-06 projects yanks, freshness, and digest-addressed preview URLs", () => {
    const projected = entries({ track: "beta", fresh: false })[0];
    assert.equal(projected.release.releaseVersion, "2.0.0");
    assert.equal(projected.yanked, true);
    assert.equal(projected.fresh, false);
    assert.equal(projected.preview.url, `/api/marketplace/items/${SOURCE_A}/com.example.shared/previews/${"e".repeat(64)}`);
});
