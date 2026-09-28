import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

let parent;
let registry;
let registryProcess;

async function startRegistry(parentDirectory) {
    const child = spawn(process.execPath, [
        "--experimental-default-type=module",
        path.resolve("tests/helpers/marketplaceRegistryProcess.mjs"),
        parentDirectory,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    const line = await new Promise((resolve, reject) => {
        let text = "";
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Marketplace registry process exited with ${code}.`)));
        child.stdout.on("data", (chunk) => {
            text += chunk;
            const newline = text.indexOf("\n");
            if (newline >= 0) resolve(text.slice(0, newline));
        });
    });
    return { child, registry: JSON.parse(line) };
}

async function stopRegistry() {
    if (!registryProcess || registryProcess.exitCode !== null) return;
    registryProcess.kill("SIGTERM");
    await new Promise((resolve) => registryProcess.once("exit", resolve));
}

async function openMarketplace(page) {
    await page.goto("/");
    await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Marketplace/i }).click();
    await expect(page.getByRole("tablist", { name: "Marketplace sections" })).toBeVisible();
}

async function clearSources(request) {
    let snapshot = await (await request.get("/api/marketplace/sources")).json();
    for (const source of snapshot.sources) {
        const response = await request.delete(`/api/marketplace/sources/${source.sourceId}?expectedRevision=${snapshot.revision}`);
        expect(response.ok(), await response.text()).toBeTruthy();
        snapshot = await response.json();
    }
}

async function trustSource(page, request, name = "Playwright Registry") {
    const credential = { type: "bearer", token: "playwright-write-only-token" };
    const previewResponse = await request.post("/api/marketplace/sources/preview", {
        data: { baseUrl: registry.baseUrl, credential },
    });
    expect(previewResponse.ok(), await previewResponse.text()).toBeTruthy();
    const preview = await previewResponse.json();

    await page.getByRole("tab", { name: "Sources" }).click();
    await page.getByRole("button", { name: "Add source" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Marketplace source" });
    await dialog.getByRole("textbox", { name: "Registry origin" }).fill(registry.baseUrl);
    await dialog.getByRole("textbox", { name: "Source name" }).fill(name);
    await dialog.getByLabel("Read token").fill(credential.token);
    await dialog.getByRole("button", { name: "Preview trust" }).click();
    await expect(dialog.getByText(preview.trustedRootFingerprint, { exact: true })).toBeVisible();
    await dialog.getByRole("textbox", { name: "Type the verified fingerprint" }).fill(preview.trustedRootFingerprint);
    await dialog.getByRole("button", { name: "Trust source" }).click();
    await expect(dialog).toBeHidden();
    const card = page.getByRole("article", { name: `${name} marketplace source` });
    const refresh = card.getByRole("button", { name: "Refresh" });
    await expect(refresh).toBeFocused();
    await refresh.click();
    await expect(card.getByText("ready", { exact: true })).toBeVisible();
    return { card, preview, credential };
}

test.beforeAll(async () => {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-ui-"));
    const started = await startRegistry(parent);
    registryProcess = started.child;
    registry = started.registry;
});

test.afterAll(async () => {
    await stopRegistry();
    if (parent) await fs.rm(parent, { recursive: true, force: true });
});

test.beforeEach(async ({ request }) => {
    await clearSources(request);
});

test("MKT-06 trusts, refreshes, browses, retains offline catalog, updates, and removes a source", async ({ page, request }) => {
    test.setTimeout(120_000);
    await openMarketplace(page);
    const { card, credential } = await trustSource(page, request);

    const listed = await (await request.get("/api/marketplace/sources")).json();
    expect(JSON.stringify(listed)).not.toContain(credential.token);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(credential.token);

    await page.getByRole("tab", { name: "Discover" }).click();
    const result = page.getByRole("button", { name: /Control Pack/u });
    await expect(result).toBeVisible();
    await result.focus();
    await page.keyboard.press("Enter");
    const details = page.getByRole("article", { name: "Marketplace release details" });
    await expect(details.getByRole("heading", { name: "Control Pack", level: 2 })).toBeVisible();
    await expect(details.getByText("Declared publisher")).toBeVisible();
    await expect(details.getByText("Publisher DSSE is not part of MKT-06.")).toBeVisible();
    await expect(details.getByText("[Image: Remote preview]", { exact: true })).toBeVisible();
    await expect(details.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(details.getByText("raw html")).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Install plugin" })).toBeDisabled();
    const preview = details.getByRole("img", { name: "Control Pack preview" });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image) => image.complete && image.naturalWidth > 0)).toBeTruthy();

    await page.getByRole("button", { name: "Open workspace switcher" }).click();
    const menu = page.getByRole("dialog", { name: "Workspaces" });
    await menu.getByRole("button", { name: "Plugins" }).click();
    await menu.getByRole("button", { name: "Browse Marketplace" }).click();
    await expect(page.getByRole("tab", { name: "Discover" })).toBeVisible();

    await stopRegistry();
    await page.getByRole("tab", { name: "Sources" }).click();
    await card.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("Marketplace source operation failed")).toBeVisible();
    await page.getByRole("tab", { name: "Discover" }).click();
    await expect(page.getByRole("button", { name: /Control Pack/u })).toBeVisible();
    await expect(page.getByText("cached metadata", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: "Sources" }).click();
    await card.getByRole("textbox", { name: "Source name" }).fill("Renamed Registry");
    await card.getByRole("button", { name: "Save changes" }).click();
    const renamed = page.getByRole("article", { name: "Renamed Registry marketplace source" });
    await expect(renamed).toBeVisible();
    await renamed.getByRole("button", { name: "Remove" }).click();
    const removal = page.getByRole("dialog", { name: "Remove Marketplace source" });
    await removal.getByRole("button", { name: "Remove source" }).click();
    await expect(page.getByText("No trusted sources")).toBeVisible();
});

test("MKT-06 Marketplace tabs and trust dialog are keyboard accessible @a11y", async ({ page, request }) => {
    test.setTimeout(60_000);
    await openMarketplace(page);
    const discover = page.getByRole("tab", { name: "Discover" });
    await discover.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Installed" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Sources" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Trusted sources", exact: true })).toBeVisible();

    let results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole("button", { name: "Add source" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add Marketplace source" });
    await expect(dialog).toBeVisible();
    await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    results = await new AxeBuilder({ page }).include(".sf-dialog").analyze();
    expect(results.violations).toEqual([]);
    const box = await dialog.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 720);
    await dialog.getByRole("button", { name: "Close" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Add source" })).toBeFocused();
});
