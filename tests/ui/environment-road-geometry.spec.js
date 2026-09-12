import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function activateBlank(request) {
    const id = `pw-ed04-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    expect((await request.post("/api/storage/environments", { data: { id, name: "ED-04 road geometry", templateId: "blank" } })).ok()).toBeTruthy();
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

test.afterEach(async ({ request }) => {
    await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
});

test("ED-04 Map stroke, reshape selection, undo/redo, view switch, and reload share one curve", async ({ page, request }) => {
    test.setTimeout(400_000);
    page.setDefaultTimeout(15_000);
    const id = await activateBlank(request);
    await openEditor(page);
    const toolbar = await enterMap(page);
    await toolbar.getByRole("button", { name: "Road pen" }).click();
    const surface = page.locator("[data-map-surface]");
    const bounds = await surface.boundingBox();
    expect(bounds).not.toBeNull();
    // Keep the stroke above the template roads so endpoint snapping cannot
    // finish it early and overlap validation has a clear surface to compile.
    await page.mouse.click(bounds.x + bounds.width * 0.20, bounds.y + bounds.height * 0.35);
    await page.mouse.click(bounds.x + bounds.width * 0.50, bounds.y + bounds.height * 0.18);
    await page.mouse.click(bounds.x + bounds.width * 0.80, bounds.y + bounds.height * 0.35);
    await page.keyboard.press("Enter");
    const v2Roads = page.locator('[data-road-geometry-version="2"]');
    await expect(v2Roads).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Convert to polyline" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+z");
    await expect(v2Roads).toHaveCount(0);
    await page.keyboard.press("Shift+ControlOrMeta+z");
    await expect(v2Roads).toHaveCount(1);
    const roadRow = page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: "Road", exact: true });
    await expect(roadRow).toBeVisible({ timeout: 15_000 });
    await roadRow.click();

    // Reshape the interior knot numerically, split the curve, and undo the
    // topology operation. The edited curve is the record that must persist.
    const interiorKnot = page.getByRole("button", { name: "k1", exact: true });
    await expect(interiorKnot).toBeVisible({ timeout: 15_000 });
    await interiorKnot.click();
    const knotY = page.getByRole("textbox", { name: "Knot position Y" });
    await knotY.fill("4");
    await knotY.press("Enter");
    await page.getByRole("button", { name: "Split", exact: true }).click();
    await expect(v2Roads).toHaveCount(2);
    await page.keyboard.press("ControlOrMeta+z");
    await expect(v2Roads).toHaveCount(1);

    await toolbar.getByRole("button", { name: "Scene view" }).click();
    await expect(page.locator("[data-map-surface]")).toHaveCount(0);
    await toolbar.getByRole("button", { name: "Map view" }).click();
    await expect(v2Roads).toHaveCount(1);

    // The SVG-to-world transform must be recomputed after layout changes;
    // select the compiled curve after a resize to exercise that pick path.
    await page.setViewportSize({ width: 1360, height: 760 });
    await toolbar.getByRole("button", { name: "Select", exact: true }).click();
    const resizedMapBounds = await surface.boundingBox();
    expect(resizedMapBounds).not.toBeNull();
    const centerlinePoints = await v2Roads.locator("polyline:not([data-road-boundary])").getAttribute("points");
    const centerline = centerlinePoints.trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
    const [pickX, pickY] = centerline[Math.floor(centerline.length / 2)];
    await page.mouse.click(
        resizedMapBounds.x + pickX,
        resizedMapBounds.y + pickY,
    );
    await expect(page.getByRole("button", { name: "Convert to polyline" })).toBeVisible();
    await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });

    const storedResponse = await request.get(`/api/storage/environments/${id}`);
    const stored = await storedResponse.json();
    const manifest = stored.manifest ?? stored;
    expect(manifest.document.roads.geometryVersion).toBe(2);
    const curve = manifest.document.roads.edges.find((edge) => edge.geometry?.kind === "cubic-bezier");
    expect(curve).toBeTruthy();
    expect(curve.geometry.knots).toHaveLength(3);
    expect(curve.geometry.knots[1].position.y).toBe(4);

    await page.reload();
    await openEditor(page);
    await enterMap(page);
    await expect(page.locator('[data-road-geometry-version="2"]')).toHaveCount(1);
});

test("ED-04 road geometry editor is accessible at 1280 by 720 @a11y", async ({ page, request }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await activateBlank(request);
    await openEditor(page);
    await enterMap(page);
    const results = await new AxeBuilder({ page }).include("[data-editor-workspace]").analyze();
    expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
});
