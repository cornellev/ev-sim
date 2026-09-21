import { promises as fs } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { BrowserPluginModuleSource } from "../../app/plugin/browser/BrowserPluginModuleSource.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { PluginStore } from "../../server/storage/PluginStore.js";
import { pluginFixtureResource } from "../helpers/pluginFixtures.js";
import { waitForCatalogType } from "./pluginCatalog.js";
import { openWorkspace } from "./openWorkspace.js";

const storageRoot = path.resolve(process.env.CEV_SIM_DATA_DIR ?? ".playwright-data/storage");

async function addBlock(page, query, namePattern) {
    const library = page.locator("[data-block-library]");
    const expand = library.getByRole("button", { name: "Expand block library" });
    if (await expand.isVisible()) {
        await expand.click();
    }
    const search = library.getByPlaceholder("Search blocks");
    await expect(search).toBeVisible();
    await search.fill(query);
    await library.getByRole("button", { name: namePattern }).click();
}

let throwing;
let custom;
let store;

test.beforeAll(async () => {
    throwing = await pluginFixtureResource();
    custom = await pluginFixtureResource({ fixture: "acme.ui-scale" });
    store = new PluginStore(storageRoot);
    await store.putPackage(throwing);
    await store.putPackage(custom);
    await store.installFromHash(throwing.packageHash);
    await store.installFromHash(custom.packageHash);
});

test("custom plugin UI renders and throwing UI falls back to generic settings", async ({ page, request }) => {
    test.setTimeout(180_000);
    await waitForCatalogType(request, "acme.ui-scale.ScaleBlock");
    await waitForCatalogType(request, "acme.example.ScaleBlock");
    const verified = verifyPluginPackage(custom);
    const moduleSource = new BrowserPluginModuleSource();
    const asset = moduleSource.assetUrl(verified, "ui/icon.svg");
    const assetResponse = await request.get(asset);
    expect(assetResponse.status()).toBe(200);

    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();
    await addBlock(page, "acme.ui-scale", /UI Scale Math/);
    await expect(page.locator("[data-plugin-view='acme.ui-scale']")).toBeVisible();
    await addBlock(page, "acme.example", /acme\.example@/);
    const factor = page.getByLabel("factor").last();
    await expect(factor).toBeVisible();
    await factor.fill("4");
    await factor.blur();

    const uiPath = path.join(store.casDir, throwing.packageHash, "files", "ui", "index.js");
    const originalUi = throwing.files.find((file) => file.path === "ui/index.js");
    const originalBytes = Buffer.from(originalUi.data, "base64");
    try {
        const tampered = await request.get(`/api/storage/plugins/packages/${throwing.packageHash}/files/ui/index.js`);
        expect(tampered.status()).toBe(200);
        await fs.writeFile(uiPath, "tampered");
        const after = await request.get(`/api/storage/plugins/packages/${throwing.packageHash}/files/ui/index.js`);
        expect(after.status()).toBe(400);
    } finally {
        await fs.writeFile(uiPath, originalBytes);
    }
});
