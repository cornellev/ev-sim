import { expect, test } from "@playwright/test";

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

test("drive area draw, hide, elevation edit, save, and reload preserve authoring state", async ({ page, request }) => {
    test.setTimeout(400_000);
    const id = `pw-drive-repair-${Date.now().toString(36)}`;
    expect((await request.post("/api/storage/environments", { data: { id, name: "Drive area repair", templateId: "blank" } })).ok()).toBeTruthy();
    expect((await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: id } })).ok()).toBeTruthy();
    try {
        await openEditor(page);
        const toolbar = page.getByRole("toolbar", { name: "Scene tools" });
        await toolbar.getByRole("button", { name: "Map view", exact: true }).click();
        const surface = page.locator("[data-map-surface]");
        await expect(surface).toBeVisible();
        await toolbar.getByRole("button", { name: "Drive area", exact: true }).click();
        const bounds = await surface.boundingBox();
        expect(bounds).not.toBeNull();
        await page.mouse.move(bounds.x + bounds.width * 0.3, bounds.y + bounds.height * 0.3);
        await page.mouse.down();
        await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + bounds.height * 0.7, { steps: 5 });
        await page.mouse.up();
        const areaRow = page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: "Drive area", exact: true });
        await expect(areaRow).toBeVisible();
        await areaRow.click();
        const inspector = page.locator("[data-object-inspector]");
        await inspector.getByRole("button", { name: "Hide", exact: true }).click();
        const elevation = inspector.getByRole("textbox", { name: "Elevation", exact: true });
        await elevation.fill("2");
        await elevation.press("Enter");
        await expect(inspector.getByRole("button", { name: "Show", exact: true })).toBeVisible();
        await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });
        await expect.poll(async () => {
            const saved = await (await request.get(`/api/storage/environments/${id}`)).json();
            return saved.document?.driveAreas?.[0]?.y;
        }).toBe(2);
        await openEditor(page);
        await expect(areaRow).toBeVisible();
        await areaRow.click();
        await expect(inspector.getByRole("textbox", { name: "Elevation", exact: true })).toHaveValue(/^2(?:\.0+)?$/);
        await expect(inspector.getByRole("button", { name: "Show", exact: true })).toBeVisible();
    } finally {
        await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
    }
});
