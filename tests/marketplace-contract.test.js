import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    MARKETPLACE_ARTIFACTS,
    MARKETPLACE_CONTENT_KINDS,
    MARKETPLACE_KINDS,
} from "../server/marketplace/MarketplaceContract.js";
import {
    assertMarketplaceCatalog,
    assertMarketplaceCollection,
    assertMarketplaceDocument,
    assertMarketplaceRelease,
    validateMarketplaceDocument,
} from "../server/marketplace/MarketplaceContracts.js";
import {
    assertCanonicalUuid,
    assertMarketplaceId,
    assertReleaseVersion,
    assertSourceUrl,
    assertTargetPath,
} from "../server/marketplace/MarketplaceFormats.js";
import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../server/marketplace/MarketplaceErrors.js";
import { MARKETPLACE_SCHEMAS, marketplaceSchemaEngine } from "../server/marketplace/MarketplaceSchemas.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));

function clone(value) {
    return structuredClone(value);
}

test("MKT-01 publishes and validates all eight versioned documents", () => {
    assert.deepEqual(Object.values(fixture).map((value) => assertMarketplaceDocument(value).kind), Object.values(MARKETPLACE_KINDS));
    for (const value of Object.values(fixture)) {
        const result = validateMarketplaceDocument(value);
        assert.equal(result.ok, true);
        assert.equal(Object.isFrozen(result.document), true);
    }
    assert.equal(Object.keys(MARKETPLACE_SCHEMAS).length, 9);
    assert.ok(marketplaceSchemaEngine().getSchema(MARKETPLACE_SCHEMAS.release.$id));
});

test("MKT-01 marketplace errors preserve public codes and redact internal causes", () => {
    assert.equal(new Set(Object.values(MARKETPLACE_ERROR_CODES)).size, 17);
    const error = marketplaceError("DOCUMENT_INVALID", "Public failure.", {
        path: "$.release",
        cause: new Error("credential=secret"),
    });
    assert.deepEqual(error.toJSON(), {
        code: "DOCUMENT_INVALID",
        message: "Public failure.",
        path: "$.release",
    });
    assert.doesNotMatch(JSON.stringify(error), /secret|credential|cause/);
});

test("MKT-01 freezes all content-kind artifact contracts", () => {
    assert.deepEqual(Object.keys(MARKETPLACE_ARTIFACTS), MARKETPLACE_CONTENT_KINDS);
    for (const contentKind of MARKETPLACE_CONTENT_KINDS) {
        const release = clone(fixture.release);
        release.itemId = `com.example.${contentKind}`;
        release.contentKind = contentKind;
        release.artifact.mediaType = MARKETPLACE_ARTIFACTS[contentKind].mediaType;
        release.compatibility.contracts = [{
            kind: MARKETPLACE_ARTIFACTS[contentKind].kind,
            versions: [MARKETPLACE_ARTIFACTS[contentKind].version],
        }];
        if (contentKind !== "plugin") release.capabilities = [];
        assert.equal(assertMarketplaceRelease(release).contentKind, contentKind);
    }
    const mismatch = clone(fixture.release);
    mismatch.artifact.mediaType = MARKETPLACE_ARTIFACTS.vehicle.mediaType;
    assert.throws(() => assertMarketplaceRelease(mismatch), /expected application\/vnd\.cev-sim\.plugin-package\+json/);

    const previewBoundary = clone(fixture.item);
    previewBoundary.previews[0].sizeBytes = 8 * 1024 ** 2;
    assert.equal(assertMarketplaceDocument(previewBoundary).previews[0].sizeBytes, 8 * 1024 ** 2);
    previewBoundary.previews[0].sizeBytes += 1;
    assert.equal(validateMarketplaceDocument(previewBoundary).ok, false);
});

test("MKT-01 identifier, SemVer, path, URL, and schema boundaries are strict", () => {
    assert.equal(assertMarketplaceId("com.example.release"), "com.example.release");
    for (const value of ["example", "Com.example", "com..example", "com.example "]) {
        assert.throws(() => assertMarketplaceId(value), /marketplace identifier/);
    }
    assert.equal(assertCanonicalUuid("123e4567-e89b-12d3-a456-426614174000"), "123e4567-e89b-12d3-a456-426614174000");
    for (const value of ["123E4567-e89b-12d3-a456-426614174000", "123e4567-e89b-02d3-a456-426614174000", "123e4567-e89b-12d3-7456-426614174000"]) {
        assert.throws(() => assertCanonicalUuid(value), /canonical lowercase UUID/);
    }
    assert.equal(assertReleaseVersion("1.2.3-beta.1"), "1.2.3-beta.1");
    for (const value of ["v1.2.3", "1.2.3+build", "1.02.3", ">=1.0.0"]) {
        assert.throws(() => assertReleaseVersion(value), /canonical SemVer/);
    }
    assert.equal(assertTargetPath("releases/com.example/1.0.0.json"), "releases/com.example/1.0.0.json");
    for (const value of ["/absolute", "a/../b", "a//b", "a%2fb", "a\\b", "a?b"]) {
        assert.throws(() => assertTargetPath(value), /normalized relative/);
    }
    assert.equal(assertSourceUrl("http://127.0.0.1:3000/"), "http://127.0.0.1:3000/");
    assert.equal(assertSourceUrl("https://registry.example.com/"), "https://registry.example.com/");
    for (const value of ["http://registry.example.com/", "https://registry.example.com/path", "https://USER@example.com/"]) {
        assert.throws(() => assertSourceUrl(value), /origin URL|loopback/);
    }
    assert.equal(validateMarketplaceDocument({ ...fixture.release, version: 2 }).issues[0].code, "UNSUPPORTED_SCHEMA");
    assert.equal(validateMarketplaceDocument({ ...fixture.release, extra: true }).issues[0].code, "DOCUMENT_INVALID");
});

test("MKT-01 catalog semantics reject inconsistent and dangling signed summaries", () => {
    const duplicate = clone(fixture.catalog);
    duplicate.releases.push(clone(duplicate.releases[0]));
    assert.throws(() => assertMarketplaceCatalog(duplicate), /duplicate release tuple/);

    const dangling = clone(fixture.catalog);
    dangling.tracks[0].releaseVersion = "9.0.0";
    assert.throws(() => assertMarketplaceCatalog(dangling), /missing from the catalog/);

    const prerelease = clone(fixture.catalog);
    prerelease.releases[0].releaseVersion = "2.0.0-beta.1";
    prerelease.tracks[0].releaseVersion = "2.0.0-beta.1";
    assert.throws(() => assertMarketplaceCatalog(prerelease), /stable track cannot select/);

    const mismatch = clone(fixture.catalog);
    mismatch.releases[0].publisherId = "com.other.publisher";
    assert.throws(() => assertMarketplaceCatalog(mismatch), /must match its item summary/);

    const multipleVersions = clone(fixture.catalog);
    multipleVersions.releases.push({ ...clone(multipleVersions.releases[0]), releaseVersion: "2.0.0" });
    assert.equal(assertMarketplaceCatalog(multipleVersions).releases.length, 2);
});

test("MKT-01 exact dependencies, ordered sources, receipts, and collections reject duplicates", () => {
    const release = clone(fixture.release);
    release.dependencies = [
        { itemId: "com.example.dependency", releaseVersion: "1.0.0", artifactSha256: "1".repeat(64) },
        { itemId: "com.example.dependency", releaseVersion: "1.0.0", artifactSha256: "2".repeat(64) },
    ];
    assert.throws(() => assertMarketplaceRelease(release), /duplicate dependency release/);
    release.dependencies = [{
        itemId: "com.example.dependency",
        releaseVersion: "1.0.0",
        artifactSha256: "1".repeat(64),
        registryId: "123e4567-e89b-12d3-a456-426614174000",
    }];
    assert.equal(validateMarketplaceDocument(release).ok, false);

    const collection = clone(fixture.collection);
    collection.members.push({
        release: { ...collection.members[0].release, releaseVersion: "2.0.0" },
        group: "Newer",
    });
    assert.deepEqual(assertMarketplaceCollection(collection).members.map((entry) => entry.release.releaseVersion), ["1.2.3", "2.0.0"]);
    collection.members.reverse();
    assert.deepEqual(assertMarketplaceCollection(collection).members.map((entry) => entry.release.releaseVersion), ["2.0.0", "1.2.3"]);

    const sources = clone(fixture.sources);
    sources.sources.push({ ...sources.sources[0], sourceId: "123e4567-e89b-12d3-a456-426614174002", priority: 5 });
    assert.equal(validateMarketplaceDocument(sources).issues[0].message.includes("ordered by priority"), true);

    const receipt = clone(fixture.installReceipt);
    receipt.track = "stable";
    assert.equal(validateMarketplaceDocument(receipt).ok, false);
    receipt.track = undefined;
    delete receipt.track;
    receipt.token = "secret";
    assert.equal(validateMarketplaceDocument(receipt).ok, false);

    const installed = clone(fixture.installed);
    installed.installations.push({
        ...clone(installed.installations[0]),
        release: { ...installed.installations[0].release, releaseVersion: "2.0.0" },
    });
    assert.match(validateMarketplaceDocument(installed).issues[0].message, /duplicate receipt reference/);

    const advisory = clone(fixture.advisory);
    advisory.affected = [{ itemId: "com.example.urban-rain", releaseVersion: "1.2.3" }];
    assert.equal(validateMarketplaceDocument(advisory).ok, true);
});
