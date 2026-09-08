import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    adoptCommittedPromotion,
    assertPromotionPreviewReload,
    settleRequiredBakeUploads,
} from "../app/3d/environment/visualization/BakePromotionResult.js";

test("legacy model uploads require every request to resolve true before completion", async () => {
    assert.equal(await settleRequiredBakeUploads([Promise.resolve(true), Promise.resolve(true)]), true);
    assert.equal(await settleRequiredBakeUploads([Promise.resolve(true), Promise.resolve(false)]), false);
    await assert.rejects(
        settleRequiredBakeUploads([Promise.resolve(true), Promise.reject(new Error("upload failed"))]),
        /upload failed/,
    );

    const source = await readFile(
        new URL("../app/3d/environment/visualization/BakeHarness.js", import.meta.url),
        "utf8",
    );
    assert.doesNotMatch(source, /Promise\.allSettled\(uploads\)/);
    assert.match(
        source,
        /uploaded = await settleRequiredBakeUploads\(uploads\);[\s\S]*?if \(!uploaded\) \{[\s\S]*?return null;[\s\S]*?const completeOk = await uploadSampleComplete/,
    );
});

test("a committed preview reload failure retains its receipt for materialization-only retry", () => {
    const receipt = { generation: 3, revision: 8, descriptorHash: "a".repeat(64) };
    const preview = { status: "error", error: { message: "decoder unavailable" } };
    assert.throws(
        () => assertPromotionPreviewReload(preview, receipt),
        (error) => error.code === "BAKE_PREVIEW_RELOAD_FAILED"
            && error.receipt === receipt
            && error.preview === preview,
    );
    assert.equal(assertPromotionPreviewReload({ status: "ready" }, receipt).status, "ready");
});

test("cancellation that loses the commit race adopts the committed receipt", () => {
    const adopted = [];
    const receipt = { generation: 4, revision: 9, descriptorHash: "b".repeat(64) };
    const outcome = { cancelled: false, committed: true, receipt };
    assert.equal(
        adoptCommittedPromotion(outcome, {
            adoptPromotedVisualLayer: (value) => adopted.push(value),
        }),
        receipt,
    );
    assert.deepEqual(adopted, [receipt]);
    assert.equal(adoptCommittedPromotion({ cancelled: true }, null), null);
});
