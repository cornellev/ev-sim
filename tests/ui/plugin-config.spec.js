import path from "node:path";

import { expect, test } from "@playwright/test";

import { PluginStore } from "../../server/storage/PluginStore.js";
import { pluginFixtureResource } from "../helpers/pluginFixtures.js";
import { openWorkspace } from "./openWorkspace.js";

const storageRoot = path.resolve(process.env.CEV_SIM_DATA_DIR ?? ".playwright-data/storage");

let resource;
let store;

test.beforeAll(async () => {
    resource = await pluginFixtureResource();
    store = new PluginStore(storageRoot);
    await store.putPackage(resource);
    await store.installFromHash(resource.packageHash);
});

test("Config Scripts tab locks an installed plugin and surfaces missing-package diagnostics", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await page.getByRole("button", { name: "New" }).first().click();
    await page.getByRole("switch", { name: "Advanced" }).click();
    await page.getByRole("tab", { name: "Scripts" }).click();
    await expect(page.getByText("Simulator plugins")).toBeVisible();
    await expect(page.getByRole("switch", { name: "Enable plugins" })).toBeVisible();
    await page.getByRole("switch", { name: "Enable plugins" }).click();
    const installed = page.getByLabel("Installed plugin packages");
    await expect(installed).toContainText("acme.example@");
    await installed.selectOption(resource.packageHash);
    await expect(page.getByLabel("Plugin ID").first()).toHaveValue("acme.example");
    await expect(page.getByLabel("Expected packageHash").first()).toHaveValue(resource.packageHash);
    await page.getByLabel("signals.read.vehicles").check();
    await expect(page.getByLabel("signals.read.vehicles")).toBeChecked();

    await page.getByRole("tab", { name: "JSON" }).click();
    const raw = page.getByLabel("Raw run manifest JSON");
    await expect(raw).toBeVisible();
    const current = await raw.inputValue();
    expect(current).toContain(resource.packageHash);
    await raw.fill(current.replace(resource.packageHash, "0".repeat(64)));
    await page.getByRole("tab", { name: "Scripts" }).click();
    await expect(page.getByLabel("Expected packageHash").first()).toHaveValue("0".repeat(64));
    await page.getByRole("button", { name: "Validate" }).click();
    await expect(page.getByRole("status").filter({ hasText: /Plugin "acme\.example" package 0{64} is not available/ })).toBeVisible();
});
