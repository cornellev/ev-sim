import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function activateBlank(request) {
    const id = `pw-ed05-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    expect((await request.post("/api/storage/environments", { data: { id, name: "ED-05 lane authoring", templateId: "blank" } })).ok()).toBeTruthy();
    expect((await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: id } })).ok()).toBeTruthy();
    return id;
}

async function openEditor(page) {
    await page.goto("/");
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    if (await opener.isVisible()) await opener.click();
    else await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Environment editor/i }).click();
    await expect(page.locator("[data-editor-workspace]")).toBeVisible({ timeout: 180_000 });
}

async function enterMap(page) {
    const toolbar = page.getByRole("toolbar", { name: "Scene tools" });
    await toolbar.getByRole("button", { name: "Map view" }).click();
    await expect(page.locator("[data-map-surface]")).toBeVisible();
    return toolbar;
}

/** Draw one straight road across the map and select it in the hierarchy. */
async function drawAndSelectRoad(page, toolbar) {
    await toolbar.getByRole("button", { name: "Road pen" }).click();
    const surface = page.locator("[data-map-surface]");
    const bounds = await surface.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.3);
    await page.mouse.click(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.3);
    await page.keyboard.press("Enter");
    const road = page.locator('[data-road-geometry-version="2"]');
    await expect(road).toHaveCount(1);
    const roadRow = page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: "Road", exact: true });
    await expect(roadRow).toBeVisible({ timeout: 15_000 });
    await roadRow.click();
    return road;
}

test.afterEach(async ({ request }) => {
    await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
});

test("ED-05 lane diagram authors asymmetric lanes through validated commands with map markings, undo, and reload", async ({ page, request }) => {
    test.setTimeout(400_000);
    page.setDefaultTimeout(15_000);
    const id = await activateBlank(request);
    await openEditor(page);
    const toolbar = await enterMap(page);
    const road = await drawAndSelectRoad(page, toolbar);
    const inspector = page.locator("[data-object-inspector]");
    const display = inspector.locator("[data-road-display]");
    await expect(display).toBeVisible();
    await expect(display).toHaveAttribute("data-lane-count", "2");
    await expect(display.locator("[data-road-lane]")).toHaveCount(2);
    await expect(road).toHaveAttribute("data-lane-count", "2");
    await expect(road.locator("[data-lane-divider]")).toHaveCount(1);

    // Insert a second forward lane left of lane-0: two forward, one backward.
    await display.getByRole("button", { name: "Insert lane left of lane-0" }).click();
    await expect(display).toHaveAttribute("data-lane-count", "3");
    await expect(display).toHaveAttribute("data-lanes-explicit", "true");
    await expect(road.locator("[data-lane-divider]")).toHaveCount(2);
    await expect(road.locator('[data-lane-divider="same-direction"]')).toHaveCount(1);
    await expect(road.locator('[data-lane-divider="opposing"]')).toHaveCount(1);
    await expect(road.locator("[data-one-way-arrow]")).toHaveCount(3);
    await expect(display.locator('[data-road-lane-row="lane-2"][data-lane-selected]')).toHaveCount(1, { timeout: 5_000 });

    // Reverse the new lane: the divider toward lane-0 becomes opposing.
    await display.getByRole("combobox", { name: "Lane lane-2 direction" }).selectOption("-1");
    await expect(road.locator('[data-lane-divider="opposing"]')).toHaveCount(1);
    await expect(road.locator('[data-lane-divider="same-direction"]')).toHaveCount(1);
    await expect(display.locator('[data-road-lane="lane-2"]')).toHaveAttribute("data-lane-direction", "-1");

    // An interleaved layout (+1, -1, +1) is rejected by the same validation
    // path as field edits: the issue is shown and the document is unchanged.
    await display.getByRole("combobox", { name: "Lane lane-1 direction" }).selectOption("1");
    await expect(display.getByRole("alert").first()).toBeVisible();
    await expect(display.locator('[data-road-lane="lane-1"]')).toHaveAttribute("data-lane-direction", "-1");
    await expect(display).toHaveAttribute("data-lane-count", "3");

    // A valid per-lane width widens the road; the Width option shows the sum.
    const width = display.getByRole("textbox", { name: "Lane lane-2 width" });
    await width.fill("4");
    await width.press("Enter");
    await expect(display.getByRole("alert")).toHaveCount(0);
    await expect(inspector.getByRole("textbox", { name: "Width", exact: true })).toHaveValue(/^11(\.0+)?$/);

    // The Width field scales every lane proportionally.
    const roadWidth = inspector.getByRole("textbox", { name: "Width", exact: true });
    await roadWidth.fill("22");
    await roadWidth.press("Enter");
    await expect(display.getByRole("textbox", { name: "Lane lane-2 width" })).toHaveValue(/^8(\.0+)?$/);
    await expect(display.getByRole("textbox", { name: "Lane lane-0 width" })).toHaveValue(/^7(\.0+)?$/);

    // Shortcuts never fire inside a field: move focus to the lane button first.
    await display.getByRole("button", { name: "Select lane lane-2" }).click();
    // Undo restores the previous width and then the previous direction.
    await page.keyboard.press("ControlOrMeta+z");
    await expect(display.getByRole("textbox", { name: "Lane lane-2 width" })).toHaveValue(/^4(\.0+)?$/);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(display.getByRole("textbox", { name: "Lane lane-2 width" })).toHaveValue(/^3\.5(0+)?$/);
    await page.keyboard.press("Shift+ControlOrMeta+z");
    await expect(display.getByRole("textbox", { name: "Lane lane-2 width" })).toHaveValue(/^4(\.0+)?$/);

    // Delete removes the selected lane rather than the road.
    await display.getByRole("button", { name: "Select lane lane-2" }).click();
    await page.keyboard.press("Delete");
    await expect(display).toHaveAttribute("data-lane-count", "2");
    await expect(road).toHaveCount(1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(display).toHaveAttribute("data-lane-count", "3");

    await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });
    const stored = await (await request.get(`/api/storage/environments/${id}`)).json();
    const manifest = stored.manifest ?? stored;
    const edge = manifest.document.roads.edges.find((entry) => Array.isArray(entry.lanes));
    expect(edge).toBeTruthy();
    expect(edge.lanes.map((lane) => [lane.id, lane.direction, lane.width])).toEqual([["lane-0", 1, 3.5], ["lane-2", -1, 4], ["lane-1", -1, 3.5]]);
    expect(edge.width).toBeCloseTo(11, 6);
    expect(edge.laneCount).toBe(3);

    await page.reload();
    await openEditor(page);
    await enterMap(page);
    await expect(page.locator('[data-road-geometry-version="2"]')).toHaveAttribute("data-lane-count", "3");
});

test("ED-05 lane diagram is accessible at 1280 by 720 with a lane selected @a11y", async ({ page, request }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await activateBlank(request);
    await openEditor(page);
    const toolbar = await enterMap(page);
    await drawAndSelectRoad(page, toolbar);
    const display = page.locator("[data-object-inspector] [data-road-display]");
    await expect(display).toBeVisible();
    await display.getByRole("button", { name: "Select lane lane-0" }).click();
    const results = await new AxeBuilder({ page }).include("[data-editor-workspace]").analyze();
    expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
});
