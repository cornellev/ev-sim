import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    hashMarketplaceDocument,
    hashMarketplaceRelease,
    marketplaceDocumentBytes,
    parseMarketplaceDocument,
} from "../server/marketplace/MarketplaceContracts.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/marketplace/documents.v1.json", import.meta.url), "utf8"));
const canonical = JSON.parse(await readFile(new URL("./fixtures/marketplace/canonical.v1.json", import.meta.url), "utf8"));
const encoder = new TextEncoder();

test("MKT-01 canonical release bytes and hashes are frozen", () => {
    const bytes = marketplaceDocumentBytes(fixture.release);
    assert.equal(bytes.includes(0x0a), false);
    assert.equal(Buffer.from(bytes).toString("utf8"), canonical.releaseUtf8);
    assert.equal(hashMarketplaceRelease(fixture.release), canonical.releaseSha256);
    const reversed = Object.fromEntries(Object.entries(fixture.release).reverse());
    assert.deepEqual(marketplaceDocumentBytes(reversed), bytes);
    assert.equal(hashMarketplaceDocument(reversed), hashMarketplaceDocument(fixture.release));
    assert.deepEqual(parseMarketplaceDocument(encoder.encode(`${JSON.stringify(reversed, null, 2)}\n`)), fixture.release);
});

test("MKT-01 canonical vectors preserve Unicode and sort numeric-looking hash names", () => {
    for (const vector of [
        {
            input: canonical.unicodeItemInputUtf8,
            expected: canonical.unicodeItemCanonicalUtf8,
            sha256: canonical.unicodeItemSha256,
        },
        {
            input: canonical.numericHashReceiptInputUtf8,
            expected: canonical.numericHashReceiptCanonicalUtf8,
            sha256: canonical.numericHashReceiptSha256,
        },
    ]) {
        const document = parseMarketplaceDocument(encoder.encode(vector.input));
        assert.equal(Buffer.from(marketplaceDocumentBytes(document)).toString("utf8"), vector.expected);
        assert.equal(hashMarketplaceDocument(document), vector.sha256);
    }
});

test("MKT-01 release identity stays separate from exact artifact bytes", () => {
    const changed = structuredClone(fixture.release);
    changed.changelog = "Different signed metadata.";
    assert.equal(changed.artifact.sha256, fixture.release.artifact.sha256);
    assert.notEqual(hashMarketplaceRelease(changed), hashMarketplaceRelease(fixture.release));
});

test("MKT-01 strict byte reader rejects malformed, ambiguous, and dangerous JSON", () => {
    const raw = JSON.stringify(fixture.release);
    assert.throws(() => parseMarketplaceDocument(Uint8Array.from([0xc3, 0x28])), /Invalid marketplace JSON/);
    assert.throws(() => parseMarketplaceDocument(Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode(raw)])), /byte-order mark/);
    assert.throws(() => parseMarketplaceDocument(encoder.encode(`${raw} true`)), /Trailing data/);
    assert.throws(
        () => parseMarketplaceDocument(encoder.encode('{"kind":"cev-sim.marketplace-item","k\\u0069nd":"duplicate"}')),
        /Duplicate JSON object key/,
    );
    assert.throws(() => parseMarketplaceDocument(encoder.encode('{"__proto__":{}}')), /Prohibited JSON object key/);
    assert.throws(() => parseMarketplaceDocument(encoder.encode(JSON.stringify({ ...fixture.release, extra: 1 }))), /additional properties/);
});

test("MKT-01 strict reader enforces nesting, integer, digest, enum, and Unicode limits", () => {
    let nested = "null";
    for (let index = 0; index < 66; index += 1) nested = `[${nested}]`;
    assert.throws(() => parseMarketplaceDocument(encoder.encode(nested)), /nesting exceeds 64/);
    assert.throws(
        () => parseMarketplaceDocument(encoder.encode(JSON.stringify({
            ...fixture.release,
            artifact: { ...fixture.release.artifact, sizeBytes: 1.5 },
        }))),
        /must be integer/,
    );
    const maximumArtifact = structuredClone(fixture.release);
    maximumArtifact.artifact.sizeBytes = 50 * 1024 ** 3;
    assert.equal(marketplaceDocumentBytes(maximumArtifact).byteLength > 0, true);
    maximumArtifact.artifact.sizeBytes += 1;
    assert.throws(() => marketplaceDocumentBytes(maximumArtifact), /must be <= 53687091200/);
    maximumArtifact.artifact.sizeBytes = Number.MAX_SAFE_INTEGER + 1;
    assert.throws(() => marketplaceDocumentBytes(maximumArtifact), /must be <= 53687091200/);
    assert.throws(
        () => parseMarketplaceDocument(encoder.encode(JSON.stringify({
            ...fixture.release,
            artifact: { ...fixture.release.artifact, sha256: "A".repeat(64) },
        }))),
        /format.*sha256|match format.*sha256/,
    );
    assert.throws(
        () => parseMarketplaceDocument(encoder.encode(JSON.stringify({ ...fixture.release, contentKind: "script" }))),
        /equal to one of the allowed values/,
    );
    const lone = structuredClone(fixture.item);
    lone.description = "\ud800";
    assert.throws(() => marketplaceDocumentBytes(lone), /lone surrogate/);

    const numericHashName = structuredClone(fixture.installReceipt);
    numericHashName.mappings[0].hashes = { "bad/name": "a".repeat(64) };
    assert.throws(() => marketplaceDocumentBytes(numericHashName), /property name|match pattern/);

    const oversizedItem = structuredClone(fixture.item);
    const longLink = { label: "x", url: `https://example.com/${"x".repeat(2000)}` };
    oversizedItem.links = Array.from({ length: 4200 }, () => longLink);
    assert.throws(() => marketplaceDocumentBytes(oversizedItem), /exceeds 8388608 bytes/);
});
