import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { MARKETPLACE_ERROR_CODES, marketplaceError } from "../server/marketplace/MarketplaceErrors.js";
import { publicMarketplaceError } from "../server/marketplace/MarketplaceRouteErrors.js";
import { createMarketplaceRouter } from "../server/routes/marketplaceRouter.js";
import {
    EDITOR_ASSET_ERROR_CODES,
    VISUAL_LAYER_ERROR_CODES,
    editorAssetError,
    visualAssetError,
} from "../server/storage/StorageErrors.js";

const DRAFT_ID = "11111111-1111-4111-8111-111111111111";

function listen(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, "127.0.0.1");
        server.once("error", reject);
        server.once("listening", () => resolve(server));
    });
}

test("marketplace routes report environment export failures instead of recovery", async (t) => {
    const logs = [];
    const failures = [
        visualAssetError(VISUAL_LAYER_ERROR_CODES.WORLD_MISMATCH, "Environment visual-layer identity is stale."),
        new Error("Marketplace environment export requires a saved schema-v4 environment."),
        new Error('Saved environment "yard" was not found.'),
        new Error(`Visual layer descriptor ${"ab".repeat(32)} is missing.`),
        new TypeError("visualLayerAccess.assets.0.useHash: missing use record abc"),
        editorAssetError(EDITOR_ASSET_ERROR_CODES.NOT_FOUND, 'Editor asset "crate" was not found.'),
        visualAssetError(VISUAL_LAYER_ERROR_CODES.RIGHTS_DENIED, "Visual source rights deny publication."),
    ];
    let index = 0;
    const app = express();
    app.use("/api/marketplace", createMarketplaceRouter({
        async preparePublication() {
            throw failures[index];
        },
    }, { logger: { error(message) { logs.push(message); } } }));
    const server = await listen(app);
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const post = () => fetch(`${origin}/api/marketplace/publisher/preparations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draftId: DRAFT_ID, draftRevision: 1 }),
    });

    index = 0;
    const stale = await (await post()).json();
    assert.equal(stale.error.code, "DOCUMENT_INVALID");
    assert.equal(stale.error.message, "Environment visual-layer identity is stale.");
    assert.match(logs.at(-1), /POST \/publisher\/preparations DOCUMENT_INVALID from StorageHttpError VISUAL_LAYER_WORLD_MISMATCH/u);

    index = 1;
    const legacy = await post();
    assert.equal(legacy.status, 422);
    assert.equal((await legacy.json()).error.message, "Marketplace environment export requires a saved schema-v4 environment.");

    index = 2;
    const missing = await (await post()).json();
    assert.equal(missing.error.code, "SOURCE_NOT_FOUND");
    assert.equal(missing.error.message, 'Saved environment "yard" was not found.');

    index = 3;
    const descriptor = await (await post()).json();
    assert.equal(descriptor.error.code, "SOURCE_NOT_FOUND");
    assert.match(descriptor.error.message, /Visual layer descriptor [a-f0-9]{64} is missing\./u);

    index = 4;
    const visual = await (await post()).json();
    assert.equal(visual.error.code, "DOCUMENT_INVALID");
    assert.match(visual.error.message, /missing use record/u);

    index = 5;
    const asset = await (await post()).json();
    assert.equal(asset.error.code, "SOURCE_NOT_FOUND");
    assert.match(asset.error.message, /crate/u);

    index = 6;
    const rights = await post();
    assert.equal(rights.status, 412);
    assert.equal((await rights.json()).error.code, "RIGHTS_DENIED");
});

test("marketplace routes keep unexpected and recovery errors redacted", () => {
    const leaked = publicMarketplaceError(new Error("open /Users/example/secret-token.json failed"));
    assert.equal(leaked.code, MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED);
    assert.equal(leaked.message, "Marketplace request failed.");
    assert.doesNotMatch(leaked.message, /secret-token/u);

    const recovery = publicMarketplaceError(marketplaceError(
        MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED,
        "Publication plan /var/lib/marketplace/plans/abc is invalid.",
    ));
    assert.equal(recovery.message, "Marketplace local state requires recovery.");
    assert.equal(publicMarketplaceError(marketplaceError(MARKETPLACE_ERROR_CODES.CONFLICT, "Draft changed.")).message, "Draft changed.");

    const hostile = publicMarketplaceError(visualAssetError("VISUAL_ASSET_SYMLINK", "symlink at /tmp/store"));
    assert.equal(hostile.code, MARKETPLACE_ERROR_CODES.RECOVERY_REQUIRED);
    assert.equal(hostile.message, "Marketplace request failed.");
});
