import assert from "node:assert/strict";
import test from "node:test";

import { assetImportOperationId } from "../server/marketplace/AssetPackageImportPlanner.js";

test("adapter operation ids differ across releases with the same operation", () => {
    const operation = {
        kind: "publish-visual-use",
        useHash: "a".repeat(64),
        recordSha256: "b".repeat(64),
        blobSha256: "c".repeat(64),
    };
    const asset = {
        itemId: "org.example.asset",
        releaseVersion: "0.1.0",
        artifact: { sha256: "d".repeat(64) },
    };
    const template = {
        itemId: "org.example.template",
        releaseVersion: "0.1.0",
        artifact: { sha256: "e".repeat(64) },
    };
    const assetId = assetImportOperationId(operation, asset);
    assert.equal(assetId, assetImportOperationId(structuredClone(operation), asset));
    assert.notEqual(assetId, assetImportOperationId(operation, template));
    assert.match(assetId, /^[a-f0-9]{64}$/u);
});
