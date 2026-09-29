import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

let parent;
const parents = [];
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

async function startFreshRegistry() {
    parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-ui-"));
    parents.push(parent);
    const started = await startRegistry(parent);
    registryProcess = started.child;
    registry = started.registry;
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

async function clearPluginLifecycleState(request) {
    let installed = await (await request.get("/api/marketplace/installed")).json();
    const ownership = await (await request.get("/api/marketplace/installed-ownership")).json();
    const collectionKeys = new Set(ownership.collections.map((entry) => `${entry.sourceId}:${entry.release.itemId}:${entry.release.releaseVersion}:${entry.release.artifactSha256}`));
    const direct = ownership.memberships.filter((entry) => entry.owners.some((owner) => owner.kind === "direct"))
        .sort((left, right) => Number(collectionKeys.has(`${right.sourceId}:${right.release.itemId}:${right.release.releaseVersion}:${right.release.artifactSha256}`))
            - Number(collectionKeys.has(`${left.sourceId}:${left.release.itemId}:${left.release.releaseVersion}:${left.release.artifactSha256}`)));
    for (const owner of direct) {
        const entry = installed.installations.find((candidate) => candidate.sourceId === owner.sourceId
            && candidate.release.itemId === owner.release.itemId
            && candidate.release.releaseVersion === owner.release.releaseVersion
            && candidate.release.artifactSha256 === owner.release.artifactSha256);
        if (!entry) continue;
        const segments = [entry.sourceId, entry.release.itemId, entry.release.releaseVersion, entry.release.artifactSha256]
            .map(encodeURIComponent).join("/");
        const response = await request.delete(`/api/marketplace/installed/${segments}?expectedRevision=${installed.revision}`);
        expect(response.ok(), await response.text()).toBeTruthy();
        installed = await (await request.get("/api/marketplace/installed")).json();
    }
    const library = await (await request.get("/api/storage/plugins/library")).json();
    for (const entry of library.packages.filter((candidate) => candidate.pluginId === "acme.example")) {
        const response = await request.post("/api/storage/plugins/remove", {
            data: { pluginId: entry.pluginId, packageHash: entry.packageHash },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
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
    await page.getByRole("tab", { name: "Security" }).click();
    const registryPolicy = page.getByRole("article").filter({ has: page.getByRole("heading", { name: preview.registryId, exact: true }) });
    await expect(registryPolicy).toBeVisible();
    const approve = registryPolicy.getByRole("button", { name: "Approve publisher" });
    if (await approve.count()) await approve.click();
    await expect(registryPolicy.getByRole("button", { name: "Revoke approval" })).toBeVisible();
    return { card, preview, credential };
}

test.beforeAll(async () => {
    await startFreshRegistry();
});

test.afterAll(async () => {
    await stopRegistry();
    await Promise.all(parents.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test.beforeEach(async ({ request }) => {
    await clearPluginLifecycleState(request);
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
    await expect(details.getByText("Verified signer")).toBeVisible();
    await expect(details.getByText(registry.publisher.keys[0].keyId, { exact: true })).toBeVisible();
    await expect(details.locator("dl > div").filter({ hasText: "Signer status" })).toContainText("active");
    await expect(details.getByText("[Image: Remote preview]", { exact: true })).toBeVisible();
    await expect(details.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(details.getByText("raw html")).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Install plugin" })).toBeEnabled();
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
    await startFreshRegistry();
});

test("MKT-08 installs a plugin with an explicit zero-grant review and safely removes its owner", async ({ page, request }) => {
    test.setTimeout(120_000);
    await openMarketplace(page);
    await trustSource(page, request, "Plugin Lifecycle Registry");
    await page.getByRole("tab", { name: "Discover" }).click();
    await page.getByRole("button", { name: /Control Pack/u }).click();
    const details = page.getByRole("article", { name: "Marketplace release details" });
    const install = details.getByRole("button", { name: "Install plugin" });
    await expect(install).toBeEnabled();
    await install.click();

    const dialog = page.getByRole("dialog", { name: "Install Control Pack" });
    await dialog.getByRole("button", { name: "Download and inspect" }).click();
    const commit = dialog.getByRole("button", { name: "Commit installation" });
    await expect(commit).toBeEnabled({ timeout: 30_000 });
    await expect(dialog.getByText("Package hash", { exact: true })).toBeVisible();
    await expect(dialog.getByText(registry.plugin.packageHash, { exact: true })).toBeVisible();
    await expect(dialog.getByText("CAS action", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Library action", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Owner action", { exact: true })).toBeVisible();
    const grants = dialog.locator("dl > div").filter({ hasText: "Runtime grants added" });
    await expect(grants).toContainText("None");
    await commit.click();
    await expect(dialog.getByText("Installation complete", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText(new RegExp(`${registry.plugin.packageHash}.*Plugin Library`, "u"))).toBeVisible();

    await expect.poll(async () => {
        const response = await request.get("/api/storage/plugins/library");
        const library = await response.json();
        return library.packages.some((entry) => entry.packageHash === registry.plugin.packageHash);
    }).toBe(true);
    await dialog.getByRole("contentinfo").getByRole("button", { name: "Close" }).click();
    await page.getByRole("tab", { name: "Installed" }).click();
    const installed = page.getByRole("article").filter({ hasText: "acme.example@1.0.0" });
    await expect(installed.getByText("Plugin ID", { exact: true })).toBeVisible();
    await expect(installed.getByText(registry.plugin.runtimeHash, { exact: true })).toBeVisible();
    await installed.getByRole("button", { name: "Remove installation" }).click();
    const removal = page.getByRole("dialog", { name: "Remove installation" });
    await expect(removal.getByText(/removes the direct owner only/u)).toBeVisible();
    await expect(removal.getByText(/Last-owner removal updates Marketplace visibility/u)).toBeVisible();
    await removal.getByRole("button", { name: "Remove installation" }).click();
    await expect(page.getByRole("heading", { name: "No installed Marketplace releases" })).toBeVisible();
    await expect.poll(async () => {
        const response = await request.get("/api/storage/plugins/library");
        const library = await response.json();
        return library.packages.some((entry) => entry.packageHash === registry.plugin.packageHash);
    }).toBe(false);
    const dataDir = process.env.CEV_SIM_DATA_DIR ?? ".playwright-data/storage";
    await fs.access(path.resolve(dataDir, "plugins", "cas", "sha256", registry.plugin.packageHash));
});

test("MKT-13 reviews and commits a signed beta update side by side", async ({ page, request }) => {
    test.setTimeout(120_000);
    await openMarketplace(page);
    await trustSource(page, request, "Update Registry");
    // The Playwright renderer advertises its probed WebGL backend shortly after
    // startup. Let that host profile settle before pinning the update plans so
    // the test does not intentionally exercise the stale-host rejection path.
    await page.waitForTimeout(2_500);
    await page.getByRole("tab", { name: "Discover" }).click();
    await page.getByRole("button", { name: /Control Pack/u }).click();
    await page.getByRole("button", { name: "Install plugin" }).click();
    let dialog = page.getByRole("dialog", { name: "Install Control Pack" });
    await dialog.getByRole("button", { name: "Download and inspect" }).click();
    await expect(dialog.getByRole("button", { name: "Commit installation" })).toBeEnabled({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Commit installation" }).click();
    await expect(dialog.getByText("Installation complete", { exact: true })).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("contentinfo").getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: "Updates" }).click();
    await page.getByRole("combobox", { name: "Update track" }).selectOption("beta");
    const update = page.getByRole("article").filter({ hasText: "acme.example" });
    await expect(update).toContainText("1.0.0 → 1.1.0");
    await update.getByRole("button", { name: "Review update" }).click();
    dialog = page.getByRole("dialog", { name: "Update Control Pack" });
    await dialog.getByRole("button", { name: "Download and inspect" }).click();
    await expect(dialog.getByRole("region", { name: "Update comparison" })).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("Executables added / removed / changed")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Commit installation" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Commit installation" }).click();
    await expect(dialog.getByText("Installation complete", { exact: true })).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("contentinfo").getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: "Installed" }).click();
    await expect(page.getByRole("article").filter({ hasText: "acme.example@1.0.0" })).toBeVisible();
    await expect(page.getByRole("article").filter({ hasText: "acme.example@1.1.0" })).toBeVisible();
    const installed = await (await request.get("/api/marketplace/installed")).json();
    expect(installed.installations.filter((entry) => entry.release.itemId === "acme.example").map((entry) => entry.release.releaseVersion).sort()).toEqual(["1.0.0", "1.1.0"]);
});

test("MKT-08 Marketplace removal preserves an independent manual plugin owner", async ({ page, request }) => {
    test.setTimeout(120_000);
    const manual = await request.post("/api/storage/plugins/install", {
        data: { source: { kind: "directory", path: path.resolve("tests/fixtures/plugins/acme.example") } },
    });
    expect(manual.ok(), await manual.text()).toBeTruthy();
    expect((await manual.json()).package.packageHash).toBe(registry.plugin.packageHash);

    await openMarketplace(page);
    await trustSource(page, request, "Manual Owner Registry");
    await page.getByRole("tab", { name: "Discover" }).click();
    await page.getByRole("button", { name: /Control Pack/u }).click();
    await page.getByRole("button", { name: "Install plugin" }).click();
    const dialog = page.getByRole("dialog", { name: "Install Control Pack" });
    await dialog.getByRole("button", { name: "Download and inspect" }).click();
    const commit = dialog.getByRole("button", { name: "Commit installation" });
    await expect(commit).toBeEnabled({ timeout: 30_000 });
    await expect(dialog.locator("dl > div").filter({ hasText: "CAS action" })).toContainText("reuse");
    await expect(dialog.locator("dl > div").filter({ hasText: "Library action" })).toContainText("reuse");
    await expect(dialog.locator("dl > div").filter({ hasText: "Owner action" })).toContainText("add");
    await commit.click();
    await expect(dialog.getByText("Installation complete", { exact: true })).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("contentinfo").getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: "Installed" }).click();
    const installed = page.getByRole("article").filter({ hasText: "acme.example@1.0.0" });
    await installed.getByRole("button", { name: "Remove installation" }).click();
    await page.getByRole("dialog", { name: "Remove installation" })
        .getByRole("button", { name: "Remove installation" }).click();
    await expect(page.getByRole("heading", { name: "No installed Marketplace releases" })).toBeVisible();
    const library = await (await request.get("/api/storage/plugins/library")).json();
    expect(library.packages.some((entry) => entry.packageHash === registry.plugin.packageHash)).toBe(true);

    const cleanup = await request.post("/api/storage/plugins/remove", {
        data: { pluginId: registry.release.itemId, packageHash: registry.plugin.packageHash },
    });
    expect(cleanup.ok(), await cleanup.text()).toBeTruthy();
});

test("MKT-12 reviews grouped collection members and removes only collection ownership", async ({ page, request }) => {
    test.setTimeout(120_000);
    await openMarketplace(page);
    await trustSource(page, request, "Collection Registry");
    await page.getByRole("tab", { name: "Discover" }).click();
    await page.getByRole("button", { name: /Control Collection/u }).click();
    const details = page.getByRole("article", { name: "Marketplace release details" });
    await expect(details.getByRole("button", { name: "Install collection" })).toBeEnabled();
    await expect(details.getByRole("heading", { name: "Collection members" })).toBeVisible();
    await expect(details.getByText(/Control Pack.*Plugin.*1\.0\.0/u)).toBeVisible();
    await expect(details.locator("dl > div").filter({ hasText: "Executable" })).toContainText("not-applicable");
    await details.getByRole("button", { name: "Install collection" }).click();

    const dialog = page.getByRole("dialog", { name: "Install Control Collection" });
    await dialog.getByRole("button", { name: "Download and inspect" }).click();
    const commit = dialog.getByRole("button", { name: "Commit installation" });
    await expect(commit).toBeEnabled({ timeout: 30_000 });
    await expect(dialog.getByRole("heading", { name: "Collection members" })).toBeVisible();
    await expect(dialog.getByText("Controllers", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/acme\.example@1\.0\.0.*operations/u)).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Artifact-only dependencies" })).toBeVisible();
    await commit.click();
    await expect(dialog.getByText("Installation complete", { exact: true })).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("contentinfo").getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: "Installed" }).click();
    const member = page.getByRole("article").filter({ hasText: "acme.example@1.0.0" });
    await expect(member.getByText(/Retained by collection ownership/u)).toBeVisible();
    await expect(member.getByRole("button", { name: "Remove installation" })).toHaveCount(0);
    const collection = page.getByRole("article").filter({ hasText: "com.example.control-collection@1.0.0" });
    await expect(collection.getByText(/acme\.example@1\.0\.0 \(Controllers\)/u)).toBeVisible();
    await collection.getByRole("button", { name: "Remove collection" }).click();
    await page.getByRole("dialog", { name: "Remove collection" }).getByRole("button", { name: "Remove collection" }).click();
    await expect(page.getByRole("heading", { name: "No installed Marketplace releases" })).toBeVisible();
});

test("MKT-06 Marketplace tabs and trust dialog are keyboard accessible @a11y", async ({ page, request }) => {
    test.setTimeout(60_000);
    await openMarketplace(page);
    const discover = page.getByRole("tab", { name: "Discover" });
    await discover.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Updates" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Installed" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Security" })).toBeFocused();
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
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("cev-sim-marketplace-reload-required", {
        detail: { packageHashes: ["a".repeat(64)] },
    })));
    await expect(page.getByRole("alert").filter({ hasText: "Reload required" })).toContainText("Reload required");
});
