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

test("drive area width edit persists the resized footprint", async ({ page, request }) => {
    test.setTimeout(400_000);
    const id = `pw-drive-size-${Date.now().toString(36)}`;
    expect((await request.post("/api/storage/environments", { data: { id, name: "Drive area size", templateId: "blank" } })).ok()).toBeTruthy();
    const stored = await (await request.get(`/api/storage/environments/${id}`)).json();
    const manifest = stored.manifest ?? stored;
    manifest.document = {
        ...(manifest.document ?? {}),
        driveAreas: [{
            id: "lot",
            y: 0,
            footprint: [
                { x: 0, z: 0 },
                { x: 12, z: 0 },
                { x: 12, z: 8 },
                { x: 0, z: 8 },
            ],
        }],
    };
    const saved = await request.put(`/api/storage/environments/${id}`, {
        data: {
            manifest,
            expectedRevision: manifest.revision ?? stored.revision ?? 1,
            supportedDriveAreaVersions: [1],
        },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
    expect((await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: id } })).ok()).toBeTruthy();
    try {
        await openEditor(page);
        const areaRow = page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: "Drive area", exact: true });
        await expect(areaRow).toBeVisible();
        await areaRow.click();
        const inspector = page.locator("[data-object-inspector]");
        const width = inspector.getByRole("textbox", { name: "Width", exact: true });
        await expect(width).toBeVisible();
        await width.fill("20");
        await width.press("Enter");
        await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });
        await expect.poll(async () => {
            const body = await (await request.get(`/api/storage/environments/${id}`)).json();
            const footprint = (body.manifest ?? body).document?.driveAreas?.[0]?.footprint ?? body.document?.driveAreas?.[0]?.footprint;
            if (!footprint) return null;
            const xs = footprint.map((point) => point.x);
            const zs = footprint.map((point) => point.z);
            return {
                width: Math.max(...xs) - Math.min(...xs),
                depth: Math.max(...zs) - Math.min(...zs),
            };
        }).toEqual({ width: 20, depth: 8 });
    } finally {
        await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
    }
});
