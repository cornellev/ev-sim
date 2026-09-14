import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PANE_LAYOUT_KEY = "cev-sim.ui.environmentEditor.paneLayout";
const CATALOG_COUNT = 800;
const NOW = "2026-09-13T16:00:00.000Z";

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

async function openEditor(page) {
    await page.goto("/");
    await openWorkspace(page, "Environment editor");
    await expect(page.locator("[data-editor-workspace]")).toBeVisible({ timeout: 180_000 });
    await expect(page.locator("#canvas-container")).toBeVisible({ timeout: 180_000 });
    await expect(page.locator("#canvas-container")).toHaveAttribute("data-render-viewport", "workspace", { timeout: 30_000 });
}

async function openCreation(page) {
    const environments = page.getByRole("dialog", { name: "Environments" });
    if (!await environments.isVisible()) {
        await page.getByRole("button", { name: "Environment", exact: true }).click();
    }
    await expect(environments).toBeVisible();
    await environments.getByRole("button", { name: "New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create environment" });
    await expect(dialog).toBeVisible();
    return dialog;
}

function largeCatalogPayload() {
    return {
        catalogRevision: 1,
        folders: [],
        assets: Array.from({ length: CATALOG_COUNT }, (_, index) => ({
            id: `model-${String(index).padStart(4, "0")}`,
            name: `Catalog model ${index}`,
            folderId: null,
            tags: [],
            archived: false,
            latestRevision: 1,
            thumbnails: {},
            createdAt: NOW,
            updatedAt: NOW,
        })),
    };
}

test.describe("ED-09 environment editor acceptance", () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript((key) => {
            if (window.sessionStorage.getItem("pw-pane-layout-cleared")) return;
            window.sessionStorage.setItem("pw-pane-layout-cleared", "1");
            window.localStorage.removeItem(key);
        }, PANE_LAYOUT_KEY);
    });

    test.afterEach(async ({ request }) => {
        await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
    });

    test("creates a blank environment, places a cone, groups, undoes, reloads, and stays accessible", async ({ page }) => {
        test.setTimeout(400_000);
        await page.setViewportSize({ width: 1280, height: 720 });
        await openEditor(page);

        const dialog = await openCreation(page);
        const id = `pw-ed09-${Date.now().toString(36)}`;
        await dialog.getByLabel("Name").fill("ED-09 Acceptance");
        await dialog.getByLabel("Environment ID").fill(id);
        await dialog.getByRole("button", { name: "Create", exact: true }).click();
        await expect(dialog).toBeHidden({ timeout: 30_000 });

        const tree = page.getByRole("tree", { name: "Environment objects" });
        await expect(tree.getByRole("button", { name: "Skybox", exact: true })).toBeVisible({ timeout: 60_000 });
        await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });

        const cone = page.locator('[data-pane="assets"]').getByRole("button", { name: "Place Cone" });
        await cone.click();
        await expect(cone).toHaveAttribute("aria-pressed", "true");
        const host = page.locator("[data-editor-canvas-host]");
        const box = await host.boundingBox();
        await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.55);
        const placed = tree.getByRole("button", { name: "Cone", exact: true });
        await expect(placed).toBeVisible({ timeout: 30_000 });
        const inspectorName = page.locator("[data-object-inspector]").getByRole("textbox", { name: "Object name" });
        await expect(inspectorName).toHaveValue("Cone");

        await placed.click();
        await page.keyboard.press("ControlOrMeta+g");
        await expect(inspectorName).not.toHaveValue("Cone");
        await inspectorName.fill("Markers");
        await inspectorName.press("Enter");
        await expect(inspectorName).toHaveValue("Markers");
        await page.keyboard.press("ControlOrMeta+z");
        await expect(inspectorName).not.toHaveValue("Markers");
        await page.keyboard.press("Shift+ControlOrMeta+z");
        await expect(inspectorName).toHaveValue("Markers");
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("ControlOrMeta+d");
        await expect(tree.getByRole("button", { name: "Markers copy", exact: true })).toBeVisible();
        await page.keyboard.press("ControlOrMeta+z");
        await expect(tree.getByRole("button", { name: "Markers copy", exact: true })).toBeHidden();
        await page.keyboard.press("Shift+ControlOrMeta+z");
        await expect(tree.getByRole("button", { name: "Markers copy", exact: true })).toBeVisible();
        await expect(tree.getByRole("button", { name: "Cone copy", exact: true })).toBeVisible();

        await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });
        await page.reload();
        await openEditor(page);
        await expect(page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: "Cone", exact: true })).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: "Markers copy", exact: true })).toBeVisible();
        await expect(page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: "Skybox", exact: true })).toBeVisible();
    });

    test("@a11y the ED-09 acceptance workspace has no serious violations", async ({ page }) => {
        test.setTimeout(400_000);
        await page.setViewportSize({ width: 1280, height: 720 });
        await openEditor(page);
        const results = await new AxeBuilder({ page })
            .include("[data-editor-workspace]")
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
        expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
    });

    test("a large asset catalog renders only a window of rows", async ({ page, request }) => {
        test.setTimeout(400_000);
        const payload = largeCatalogPayload();
        await page.route("**/api/storage/editor-assets/**", async (route) => {
            const url = new URL(route.request().url());
            const pathname = url.pathname.replace(/\/$/, "");
            if (route.request().method() !== "GET" || pathname !== "/api/storage/editor-assets") {
                await route.continue();
                return;
            }
            const query = url.searchParams.get("search")?.trim().toLowerCase() ?? "";
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    ...payload,
                    assets: query
                        ? payload.assets.filter((asset) => asset.name.toLowerCase().includes(query))
                        : payload.assets,
                }),
            });
        });
        const id = `pw-ed09-catalog-${Date.now().toString(36)}`;
        expect((await request.post("/api/storage/environments", { data: { id, name: "Large catalog", templateId: "blank" } })).ok()).toBeTruthy();
        expect((await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: id } })).ok()).toBeTruthy();
        await openEditor(page);
        const assets = page.locator('[data-pane="assets"]');
        await assets.getByRole("combobox", { name: "Asset kind" }).selectOption("models");
        await assets.getByRole("button", { name: "List view" }).click();
        const list = assets.getByRole("list", { name: "Assets" });
        await expect.poll(async () => Number(await list.getAttribute("data-row-count")), { timeout: 30_000 }).toBe(CATALOG_COUNT);
        expect(Number(await list.getAttribute("data-rendered-rows"))).toBeLessThan(80);
        expect(await list.getByRole("listitem").count()).toBeLessThan(80);

        await list.evaluate((element) => { element.scrollTop = element.scrollHeight / 2; element.dispatchEvent(new Event("scroll")); });
        await expect(list.locator('[data-asset-id="model-0400"]')).toBeVisible({ timeout: 30_000 });
        await list.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
        const finalItem = list.locator('[data-asset-id="model-0799"]');
        await expect(finalItem).toBeVisible({ timeout: 30_000 });
        await finalItem.getByRole("button", { name: "Place Catalog model 799" }).click();
        await expect(finalItem.getByRole("button", { name: "Place Catalog model 799" })).toHaveAttribute("aria-pressed", "true");

        const search = assets.getByRole("searchbox", { name: "Search assets" });
        await search.fill("Catalog model 317");
        await expect.poll(async () => Number(await list.getAttribute("data-row-count")), { timeout: 30_000 }).toBe(1);
        await expect(list.locator('[data-asset-id="model-0317"]')).toBeVisible();
        expect(await list.evaluate((element) => element.scrollTop)).toBe(0);

        await search.fill("");
        await expect.poll(async () => Number(await list.getAttribute("data-row-count")), { timeout: 30_000 }).toBe(CATALOG_COUNT);
        await assets.getByRole("button", { name: "Grid view" }).click();
        const splitter = page.locator('[data-pane-splitter="assets"]');
        const initialSize = Number(await splitter.getAttribute("aria-valuenow"));
        await splitter.focus();
        await page.keyboard.press("ArrowUp");
        await expect(splitter).toHaveAttribute("aria-valuenow", String(initialSize + 8));
        await list.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
        await expect(list.locator('[data-asset-id="model-0799"]')).toBeVisible({ timeout: 30_000 });
        expect(Number(await list.getAttribute("data-rendered-rows"))).toBeLessThan(160);
        expect(await list.getByRole("listitem").count()).toBeLessThan(160);

        await assets.getByRole("button", { name: "List view" }).click();
        await expect(list.locator('[data-asset-id="model-0000"]')).toBeVisible({ timeout: 30_000 });
        expect(await list.evaluate((element) => element.scrollTop)).toBe(0);
    });
});
