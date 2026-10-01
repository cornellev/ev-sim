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

    const sources = await (await request.get("/api/marketplace/sources")).json();
    const addedResponse = await request.post("/api/marketplace/sources", { data: {
        expectedRevision: sources.revision,
        name,
        baseUrl: registry.baseUrl,
        registryId: preview.registryId,
        trustedRootFingerprint: preview.trustedRootFingerprint,
        enabled: true,
        priority: 10,
        credential,
    } });
    expect(addedResponse.ok(), await addedResponse.text()).toBeTruthy();
    const added = await addedResponse.json();
    const refresh = await request.post(`/api/marketplace/sources/${added.source.sourceId}/refresh`, { data: { expectedRevision: added.revision } });
    expect(refresh.ok(), await refresh.text()).toBeTruthy();
    const policy = await (await request.get("/api/marketplace/policy")).json();
    const approved = await request.put("/api/marketplace/policy/publisher-approvals", { data: {
        registryId: preview.registryId,
        publisherId: registry.publisher.publisherId,
        approved: true,
        expectedRevision: policy.revision,
    } });
    expect(approved.ok(), await approved.text()).toBeTruthy();
    await page.getByRole("tab", { name: "Library" }).click();
    await page.getByRole("tab", { name: "Discover" }).click();
    return { source: added.source, preview, credential };
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

test("MKT-16 exposes task-led publishing without browser profile or secret setup", async ({ page, request }) => {
    test.setTimeout(120_000);
    await openMarketplace(page);
    const { credential } = await trustSource(page, request, "Publisher Workspace Registry");
    await page.getByRole("tab", { name: "Publish" }).click();
    await expect(page.getByRole("heading", { name: "Local catalog" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Select content to publish" })).toBeVisible();
    await expect(page.getByLabel("Content kind")).toBeVisible();
    await expect(page.getByLabel("Sort publications")).toBeVisible();
    await expect(page.getByText("Publishing is not configured", { exact: true })).toBeVisible();
    await expect(page.getByLabel(/private key|write bearer token|publisher id|item id|artifact sha/i)).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Profile/u })).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(credential.token);
    expect(await page.content()).not.toContain("PRIVATE KEY");
});

test("MKT-16 source settings expose one URL field while retained sources remain operable", async ({ page, request }) => {
    test.setTimeout(120_000);
    await openMarketplace(page);
    const { credential } = await trustSource(page, request);

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
    await details.getByText("Technical details", { exact: true }).click();
    await expect(details.getByText("Declared publisher")).toBeVisible();
    await expect(details.getByText("[Image: Remote preview]", { exact: true })).toBeVisible();
    await expect(details.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(details.getByText("raw html")).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Install plugin" })).toBeEnabled();
    const preview = details.getByRole("img", { name: "Control Pack preview" });
    await expect(preview).toBeVisible();
    await expect.poll(() => preview.evaluate((image) => image.complete && image.naturalWidth > 0)).toBeTruthy();
    const filters = page.getByRole("complementary", { name: "Marketplace filters" });
    const results = page.getByRole("region", { name: "Marketplace results" });
    for (const region of [filters, results, details]) {
        const box = await region.boundingBox();
        assert.ok(box && box.width > 80 && box.x >= 0 && box.x + box.width <= 1281);
    }
    await page.setViewportSize({ width: 800, height: 720 });
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
    await details.scrollIntoViewIfNeeded();
    const narrow = await details.boundingBox();
    assert.ok(narrow && narrow.width > 200 && narrow.x >= 0 && narrow.x + narrow.width <= 801);
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByRole("button", { name: "Open workspace switcher" }).click();
    const menu = page.getByRole("dialog", { name: "Workspaces" });
    await menu.getByRole("button", { name: "Plugins" }).click();
    await menu.getByRole("button", { name: "Browse Marketplace" }).click();
    await expect(page.getByRole("tab", { name: "Discover" })).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Add source" }).click();
    let dialog = page.getByRole("dialog", { name: "Add source" });
    await expect(dialog.getByRole("textbox", { name: "Marketplace URL" })).toBeVisible();
    await expect(dialog.locator("input")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Connect" })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const card = page.getByRole("article", { name: "Playwright Registry marketplace source" });
    await expect(card.getByText("Ready", { exact: true })).toBeVisible();

    await stopRegistry();
    await card.getByRole("button", { name: "Sync now" }).click();
    await expect(page.getByText("Source needs attention")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: /Control Pack/u })).toBeVisible();
    await expect(page.getByText("Cached catalog", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Settings" }).click();
    await card.getByRole("button", { name: "Remove" }).click();
    dialog = page.getByRole("dialog", { name: "Remove source" });
    await dialog.getByRole("button", { name: "Remove source" }).click();
    await expect(page.getByText("No sources connected")).toBeVisible();
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
    const commit = dialog.getByRole("button", { name: "Install", exact: true });
    await expect(commit).toBeEnabled({ timeout: 30_000 });
    await dialog.getByText("Mappings and exact operations", { exact: true }).click();
    await expect(dialog.getByText(registry.plugin.packageHash, { exact: true })).toBeVisible();
    const grants = dialog.locator("dl > div").filter({ hasText: "Runtime grants added" });
    await expect(grants).toContainText("None");
    await commit.click();
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible({ timeout: 30_000 });

    await expect.poll(async () => {
        const response = await request.get("/api/storage/plugins/library");
        const library = await response.json();
        return library.packages.some((entry) => entry.packageHash === registry.plugin.packageHash);
    }).toBe(true);
    const installed = page.getByRole("article").filter({ hasText: "Control Pack" });
    await expect(installed).toContainText("Version 1.0.0");
    await installed.getByRole("button", { name: "Remove", exact: true }).click();
    const removal = page.getByRole("dialog", { name: "Remove installation" });
    await expect(removal.getByText(/removes the direct owner only/u)).toBeVisible();
    await expect(removal.getByText(/Last-owner removal updates Marketplace visibility/u)).toBeVisible();
    await removal.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
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
    await expect(dialog.getByRole("button", { name: "Install", exact: true })).toBeEnabled({ timeout: 30_000 });
    await dialog.getByRole("button", { name: "Install", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible({ timeout: 30_000 });

    const update = page.getByRole("article").filter({ hasText: "Control Pack" });
    await expect(update.getByText("Update available", { exact: true })).toBeVisible();
    await update.getByRole("button", { name: "Review update" }).click();
    dialog = page.getByRole("dialog", { name: "Update Control Pack" });
    await expect(dialog.getByRole("region", { name: "Update comparison" })).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByText("Executables added / removed / changed")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Install update" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Install update" }).click();
    await expect(page.getByRole("article").filter({ hasText: "Version 1.1.0" })).toBeVisible({ timeout: 30_000 });
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
    const commit = dialog.getByRole("button", { name: "Install", exact: true });
    await expect(commit).toBeEnabled({ timeout: 30_000 });
    await commit.click();
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible({ timeout: 30_000 });
    const installed = page.getByRole("article").filter({ hasText: "Control Pack" });
    await installed.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("dialog", { name: "Remove installation" })
        .getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
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
    const commit = dialog.getByRole("button", { name: "Install", exact: true });
    await expect(commit).toBeEnabled({ timeout: 30_000 });
    await expect(dialog.getByRole("heading", { name: "Collection members" })).toBeVisible();
    await expect(dialog.getByText("Controllers", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Artifact-only dependencies" })).toBeVisible();
    await commit.click();
    await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible({ timeout: 30_000 });
    const member = page.getByRole("article").filter({ hasText: "Control Pack" });
    await expect(member.getByText(/Retained by collection ownership/u)).toBeVisible();
    await expect(member.getByRole("button", { name: "Remove", exact: true })).toHaveCount(0);
    const collection = page.getByRole("article").filter({ hasText: "Control Collection" });
    await collection.getByRole("button", { name: "Remove collection" }).click();
    await page.getByRole("dialog", { name: "Remove collection" }).getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your library is empty" })).toBeVisible();
});

test("MKT-16 primary tasks and URL-only source dialog are keyboard accessible @a11y", async ({ page, request }) => {
    test.setTimeout(60_000);
    await openMarketplace(page);
    const discover = page.getByRole("tab", { name: "Discover" });
    await discover.focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Library" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Publish" })).toBeFocused();

    let results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);

    await page.getByRole("button", { name: "Settings" }).focus();
    await page.keyboard.press("Enter");
    const settings = page.getByRole("dialog", { name: "Marketplace settings" });
    await settings.getByRole("button", { name: "Add source" }).focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("input")).toHaveCount(1);
    await dialog.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
    results = await new AxeBuilder({ page }).include(".sf-dialog").analyze();
    expect(results.violations).toEqual([]);
    const box = await dialog.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 720);
    await dialog.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await expect(settings.getByRole("button", { name: "Add source" })).toBeFocused();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("cev-sim-marketplace-reload-required", {
        detail: { packageHashes: ["a".repeat(64)] },
    })));
    await expect(page.getByRole("alert").filter({ hasText: "Reload required" })).toContainText("Reload required");
});

test("marketplace panel splitters resize, persist, and yield when the workspace stacks", async ({ page, request }) => {
    test.setTimeout(120_000);
    await openMarketplace(page);
    await trustSource(page, request, "Panel Layout Registry");

    const filtersSplitter = page.locator('[data-market-splitter="discover-filters"]');
    const detailSplitter = page.locator('[data-market-splitter="discover-detail"]');
    await expect(filtersSplitter).toHaveAttribute("aria-valuenow", "224");
    await filtersSplitter.focus();
    await page.keyboard.press("ArrowRight");
    await expect(filtersSplitter).toHaveAttribute("aria-valuenow", "232");
    await expect.poll(() => page.evaluate(() => localStorage.getItem("cev-sim.ui.marketplace.panelLayout"))).toContain('"size":232');
    await page.reload();
    await openMarketplace(page);
    await expect(filtersSplitter).toHaveAttribute("aria-valuenow", "232");
    await filtersSplitter.dblclick();
    await expect(filtersSplitter).toHaveAttribute("aria-valuenow", "224");

    await page.setViewportSize({ width: 800, height: 720 });
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
    await expect(filtersSplitter).toHaveCount(0);
    await expect(detailSplitter).toHaveAttribute("aria-orientation", "vertical");

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("tab", { name: "Publish" }).click();
    const columnSplitter = page.locator('[data-market-splitter="publish-column"]');
    const draftsSplitter = page.locator('[data-market-splitter="publish-drafts"]');
    await expect(page.getByRole("heading", { name: "Local catalog" })).toBeVisible();
    await expect(columnSplitter).toHaveAttribute("aria-valuenow", "392");
    await expect(draftsSplitter).toHaveAttribute("aria-valuenow", "220");
    await columnSplitter.focus();
    await page.keyboard.press("ArrowRight");
    await expect(columnSplitter).toHaveAttribute("aria-valuenow", "400");
    await draftsSplitter.focus();
    await page.keyboard.press("ArrowUp");
    await expect(draftsSplitter).toHaveAttribute("aria-valuenow", "228");
    await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Select content to publish" })).toBeVisible();

    await page.setViewportSize({ width: 800, height: 720 });
    await expect(columnSplitter).toHaveCount(0);
    await expect(draftsSplitter).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Local catalog" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Drafts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Select content to publish" })).toBeVisible();
});
