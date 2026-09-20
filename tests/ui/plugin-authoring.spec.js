import path from "node:path";

import { expect, test } from "@playwright/test";

import { PluginStore } from "../../server/storage/PluginStore.js";
import { pluginFixtureResource } from "../helpers/pluginFixtures.js";
import { waitForCatalogType } from "./pluginCatalog.js";

const storageRoot = path.resolve(process.env.CEV_SIM_DATA_DIR ?? ".playwright-data/storage");

async function openWorkspace(page, label) {
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    if (await opener.isVisible()) {
        await opener.click();
    } else {
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("Escape");
    }
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
    const discard = page.getByRole("button", { name: "Discard and switch" });
    if (await discard.isVisible()) await discard.click();
}

async function addBlock(page, query, namePattern) {
    const expand = page.getByRole("button", { name: "Expand block library" });
    if (await expand.isVisible()) {
        await expand.click();
    }
    const search = page.getByPlaceholder("Search blocks");
    await expect(search).toBeVisible();
    await search.fill(query);
    await page.getByRole("button", { name: namePattern }).click();
}

let resource;
let store;

test.beforeAll(async () => {
    resource = await pluginFixtureResource();
    store = new PluginStore(storageRoot);
    await store.putPackage(resource);
    await store.installFromHash(resource.packageHash);
});

test("plugin catalog places a locked Scale unit and compiles", async ({ page, request }) => {
    test.setTimeout(180_000);
    await waitForCatalogType(request, "acme.example.ScaleBlock");
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();
    await addBlock(page, "acme.example", /Scale Math/);
    await expect(page.getByText("Scale", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input value, float64" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output result, float64" })).toBeVisible();
    await page.keyboard.press("Meta+s").catch(() => {});
    await page.keyboard.press("Control+s").catch(() => {});
    await expect(page.getByText(/acme\.example@/)).toBeVisible();
});
