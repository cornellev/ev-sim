import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PANE_LAYOUT_KEY = "cev-sim.ui.environmentEditor.paneLayout";

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

async function box(locator) {
    const bounds = await locator.boundingBox();
    expect(bounds).not.toBeNull();
    return bounds;
}

function expectClose(actual, expected, tolerance = 2) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance);
}

test.describe("environment editor workspace", () => {
    test.beforeEach(async ({ page }) => {
        // Start every test from the default layout, but only once per test so
        // reloads within a test observe persisted preferences.
        await page.addInitScript((key) => {
            if (window.sessionStorage.getItem("pw-pane-layout-cleared")) return;
            window.sessionStorage.setItem("pw-pane-layout-cleared", "1");
            window.localStorage.removeItem(key);
        }, PANE_LAYOUT_KEY);
    });

    test("panes take their default sizes and the canvas fills the scene pane", async ({ page }) => {
        test.setTimeout(300_000);
        await openEditor(page);
        const hierarchy = page.locator('[data-pane="hierarchy"]');
        const inspector = page.locator('[data-pane="inspector"]');
        const assets = page.locator('[data-pane="assets"]');
        await expect(hierarchy).toBeVisible();
        await expect(inspector).toBeVisible();
        await expect(assets).toBeVisible();
        expectClose((await box(hierarchy)).width, 232);
        expectClose((await box(inspector)).width, 304);
        expectClose((await box(assets)).height, 208);

        const host = await box(page.locator("[data-editor-canvas-host]"));
        const canvas = await box(page.locator("#canvas-container"));
        expectClose(canvas.x, host.x);
        expectClose(canvas.y, host.y);
        expectClose(canvas.width, host.width);
        expectClose(canvas.height, host.height);
        expect(host.width).toBeGreaterThanOrEqual(480);
        expect(host.height).toBeGreaterThanOrEqual(240);
        await expect(page.getByRole("toolbar", { name: "Scene tools" })).toBeVisible();
        await expect(page.getByRole("region", { name: "Scene view" })).toBeVisible();
    });

    test("dragging and keyboard-resizing the hierarchy splitter resizes the canvas and remembers the layout", async ({ page }) => {
        test.setTimeout(300_000);
        await openEditor(page);
        const splitter = page.locator('[data-pane-splitter="hierarchy"]');
        const canvasBefore = await box(page.locator("#canvas-container"));
        const handle = await box(splitter);
        await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x + handle.width / 2 + 40, handle.y + handle.height / 2, { steps: 4 });
        await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + handle.height / 2, { steps: 4 });
        await page.mouse.up();
        await expect.poll(async () => Math.round((await box(page.locator('[data-pane="hierarchy"]'))).width)).toBe(312);
        await expect.poll(async () => Math.round((await box(page.locator("#canvas-container"))).width)).toBe(Math.round(canvasBefore.width) - 80);
        const host = await box(page.locator("[data-editor-canvas-host]"));
        const canvas = await box(page.locator("#canvas-container"));
        expectClose(canvas.x, host.x);
        expectClose(canvas.width, host.width);

        await splitter.focus();
        await expect(splitter).toHaveAttribute("aria-valuenow", "312");
        await page.keyboard.press("ArrowLeft");
        await expect(splitter).toHaveAttribute("aria-valuenow", "304");
        await page.keyboard.press("Shift+ArrowRight");
        await expect(splitter).toHaveAttribute("aria-valuenow", "336");

        const stored = await page.evaluate((key) => JSON.parse(window.localStorage.getItem(key)), PANE_LAYOUT_KEY);
        expect(stored.panes.hierarchy.size).toBe(336);
    });

    test("collapsing a pane persists across reloads and Escape falls through to the workspace switcher", async ({ page }) => {
        test.setTimeout(400_000);
        await openEditor(page);
        await page.getByRole("button", { name: "Collapse inspector" }).click();
        const inspector = page.locator('[data-pane="inspector"]');
        await expect(inspector).toHaveAttribute("data-collapsed", "true");
        expectClose((await box(inspector)).width, 28);
        const canvas = await box(page.locator("#canvas-container"));
        const host = await box(page.locator("[data-editor-canvas-host]"));
        expectClose(canvas.width, host.width);

        await openEditor(page);
        await expect(page.locator('[data-pane="inspector"]')).toHaveAttribute("data-collapsed", "true");
        await page.getByRole("button", { name: "Expand inspector" }).click();
        await expect(page.locator('[data-pane="inspector"]')).not.toHaveAttribute("data-collapsed", "true");

        // Nothing selected, select tool active: Escape is not consumed, so the switcher opens.
        await page.locator("body").click({ position: { x: 5, y: 5 } }).catch(() => {});
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog", { name: "Workspaces" })).toBeVisible();
    });

    test("tool shortcuts are scoped to the workspace and never fire while typing", async ({ page }) => {
        test.setTimeout(300_000);
        await openEditor(page);
        const toolbar = page.getByRole("toolbar", { name: "Scene tools" });
        const move = toolbar.getByRole("button", { name: "Move", exact: true });
        const select = toolbar.getByRole("button", { name: "Select", exact: true });
        await expect(select).toHaveAttribute("aria-pressed", "true");
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("w");
        await expect(move).toHaveAttribute("aria-pressed", "true");
        await page.keyboard.press("Escape");
        await expect(select).toHaveAttribute("aria-pressed", "true");

        const search = page.getByRole("searchbox", { name: "Search hierarchy" });
        await search.click();
        await search.type("we");
        await expect(search).toHaveValue("we");
        await expect(select).toHaveAttribute("aria-pressed", "true");
        await expect(move).toHaveAttribute("aria-pressed", "false");

        // Toolbar roving focus.
        await select.focus();
        await page.keyboard.press("ArrowRight");
        await expect(move).toBeFocused();
    });

    test("map view is another view of the same document with hierarchy and inspector still visible", async ({ page }) => {
        test.setTimeout(300_000);
        await openEditor(page);
        const toolbar = page.getByRole("toolbar", { name: "Scene tools" });
        await toolbar.getByRole("button", { name: "Map view" }).click();
        await expect(page.locator("[data-map-surface]")).toBeVisible();
        await expect(page.getByRole("region", { name: "Map view" })).toBeVisible();
        await expect(page.locator('[data-pane="hierarchy"]')).toBeVisible();
        await expect(page.locator('[data-pane="inspector"]')).toBeVisible();
        await expect(toolbar.getByRole("button", { name: "Road pen" })).toBeVisible();
        const host = await box(page.locator("[data-editor-canvas-host]"));
        const surface = await box(page.locator("[data-map-surface]"));
        expectClose(surface.width, host.width);
        expectClose(surface.height, host.height);
        await toolbar.getByRole("button", { name: "Scene view" }).click();
        await expect(page.locator("[data-map-surface]")).toHaveCount(0);
        await expect(toolbar.getByRole("button", { name: "Move", exact: true })).toBeVisible();
    });

    test("the inspector edits skybox fields through the command bus with undo and inline validation", async ({ page }) => {
        test.setTimeout(300_000);
        await openEditor(page);
        const tree = page.getByRole("tree", { name: "Environment objects" });
        await tree.getByRole("treeitem").filter({ hasText: "Skybox" }).getByRole("button", { name: "Skybox" }).click();
        const inspector = page.locator("[data-object-inspector]");
        await expect(inspector.getByRole("textbox", { name: "Object name" })).toHaveValue("Skybox");
        const timeOfDay = inspector.getByRole("textbox", { name: "Time of day" });
        const initial = await timeOfDay.inputValue();
        const target = initial === "6.0" ? "8" : "6";
        const shown = `${target}.0`;

        await timeOfDay.fill(target);
        await timeOfDay.press("Enter");
        await expect(timeOfDay).toHaveValue(shown);

        await timeOfDay.fill("30");
        await timeOfDay.press("Enter");
        await expect(inspector.getByRole("alert")).toContainText("Time of day must be at most 23.99");
        await expect(timeOfDay).toHaveValue("30", "the rejected draft stays visible");
        await timeOfDay.press("Escape");
        await expect(timeOfDay).toHaveValue(shown, "the document kept the last committed value");

        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("ControlOrMeta+z");
        await expect(timeOfDay).toHaveValue(initial);
        await page.keyboard.press("Shift+ControlOrMeta+z");
        await expect(timeOfDay).toHaveValue(shown);
        await page.keyboard.press("ControlOrMeta+z");
        await expect(timeOfDay).toHaveValue(initial);
    });

    test("road option edits persist through autosave and a multi-selection shows mixed values", async ({ page, request }) => {
        test.setTimeout(300_000);
        await openEditor(page);
        const search = page.getByRole("searchbox", { name: "Search hierarchy" });
        await search.fill("road");
        const tree = page.getByRole("tree", { name: "Environment objects" });
        const rows = tree.getByRole("treeitem");
        await expect.poll(async () => rows.count()).toBeGreaterThanOrEqual(2);
        const firstLabel = await rows.nth(0).getByRole("button").first().textContent();
        await rows.nth(0).getByRole("button", { name: firstLabel.trim(), exact: true }).click();

        const inspector = page.locator("[data-object-inspector]");
        const width = inspector.getByRole("textbox", { name: "Width" });
        await expect(width).toBeVisible();
        const original = await width.inputValue();
        await width.fill("9.5");
        await width.press("Enter");
        await expect(width).toHaveValue("9.5");
        await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 20_000 });

        const stored = await request.get("/api/storage/environments/igvc");
        expect(stored.ok()).toBeTruthy();
        const manifest = await stored.json();
        const edges = manifest?.manifest?.document?.roads?.edges ?? manifest?.document?.roads?.edges ?? [];
        expect(edges.some((edge) => edge.width === 9.5)).toBeTruthy();

        const secondLabel = await rows.nth(1).getByRole("button").first().textContent();
        await rows.nth(1).getByRole("button", { name: secondLabel.trim(), exact: true }).click({ modifiers: ["ControlOrMeta"] });
        await expect(inspector.getByText("2 objects")).toBeVisible();
        const mixedWidth = inspector.getByRole("textbox", { name: "Width" });
        await expect(mixedWidth).toHaveAttribute("placeholder", "Mixed");
        await mixedWidth.fill("8");
        await mixedWidth.press("Enter");
        await expect(mixedWidth).toHaveValue("8.0");

        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("ControlOrMeta+z");
        await expect(inspector.getByRole("textbox", { name: "Width" })).toHaveAttribute("placeholder", "Mixed");
        await page.keyboard.press("ControlOrMeta+z");
        await rows.nth(0).getByRole("button", { name: firstLabel.trim(), exact: true }).click();
        await expect(inspector.getByRole("textbox", { name: "Width" })).toHaveValue(original);
    });

    test("a large hierarchy renders only a window of rows and keyboard navigation reaches the end", async ({ page, request }) => {
        test.setTimeout(400_000);
        const id = `pw-large-${Date.now().toString(36)}`;
        const created = await request.post("/api/storage/environments", { data: { id, name: "Large hierarchy", templateId: "blank" } });
        expect(created.ok()).toBeTruthy();
        const stored = await (await request.get(`/api/storage/environments/${id}`)).json();
        const manifest = stored.manifest ?? stored;
        const features = Array.from({ length: 1500 }, (_, index) => ({
            id: `cone-${String(index).padStart(4, "0")}`,
            type: "cone",
            x: (index % 50) * 2,
            z: Math.floor(index / 50) * 2,
            dir: 0,
            rotationY: 0,
            tags: ["cone"],
        }));
        manifest.document = { ...(manifest.document ?? {}), features, featuresAuthored: true };
        const saved = await request.put(`/api/storage/environments/${id}`, { data: { manifest, expectedRevision: manifest.revision ?? stored.revision ?? 1 } });
        expect(saved.ok(), await saved.text()).toBeTruthy();
        const activated = await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: id } });
        expect(activated.ok()).toBeTruthy();

        await openEditor(page);
        await expect(page.locator("[data-hierarchy-summary]")).toContainText("1501 objects", { timeout: 60_000 });
        const tree = page.getByRole("tree", { name: "Environment objects" });
        await expect.poll(async () => Number(await tree.getAttribute("data-row-count"))).toBe(1501);
        const rendered = Number(await tree.getAttribute("data-rendered-rows"));
        expect(rendered).toBeLessThan(80);
        expect(await tree.getByRole("treeitem").count()).toBeLessThan(80);

        await tree.getByRole("treeitem").first().getByRole("button").nth(1).click();
        await tree.focus();
        await page.keyboard.press("End");
        await expect.poll(async () => tree.getAttribute("aria-activedescendant")).toBe("hierarchy-row-cone-1499");
        await expect(page.locator("#hierarchy-row-cone-1499")).toBeVisible();
        await expect(page.locator("[data-object-inspector]").getByRole("textbox", { name: "Object name" })).toHaveValue(/cone/i);
        await page.keyboard.press("ArrowUp");
        await expect.poll(async () => tree.getAttribute("aria-activedescendant")).toBe("hierarchy-row-cone-1498");
        expect(await tree.getByRole("treeitem").count()).toBeLessThan(80);

        await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
    });

    test("the asset pane arms placement in the scene view", async ({ page }) => {
        test.setTimeout(300_000);
        await openEditor(page);
        const assets = page.locator('[data-pane="assets"]');
        const cone = assets.getByRole("button", { name: "Place Cone" });
        await cone.click();
        await expect(cone).toHaveAttribute("aria-pressed", "true");
        const toolbar = page.getByRole("toolbar", { name: "Scene tools" });
        await expect(toolbar.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "false");
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("Escape");
        await expect(cone).toHaveAttribute("aria-pressed", "false");
        await expect(toolbar.getByRole("button", { name: "Select", exact: true })).toHaveAttribute("aria-pressed", "true");
        await assets.getByRole("searchbox", { name: "Search assets" }).fill("bar");
        await expect(assets.getByRole("button", { name: "Place Barrel" })).toBeVisible();
        await expect(assets.getByRole("button", { name: "Place Cone" })).toHaveCount(0);
    });

    test("@a11y the environment workspace has no serious violations", async ({ page }) => {
        test.setTimeout(300_000);
        await openEditor(page);
        const results = await new AxeBuilder({ page })
            .include("[data-editor-workspace]")
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
        expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
    });
});
