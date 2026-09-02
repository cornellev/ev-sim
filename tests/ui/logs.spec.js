import { expect, test } from "@playwright/test";

async function openWorkspace(page, label) {
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    if (await opener.isVisible()) await opener.click();
    else await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
}

test("logs workspace files, renames, shows size, and deletes a recording", async ({ page, request }) => {
    test.setTimeout(90_000);
    const suffix = Date.now().toString(36);
    const logName = `PW log ${suffix}`;
    const renamed = `PW renamed ${suffix}`;
    const folderName = `PW folder ${suffix}`;
    let logId = null;
    let originalCatalog = null;

    try {
        const catalogResponse = await request.get("/api/logs/catalog");
        expect(catalogResponse.ok()).toBeTruthy();
        originalCatalog = await catalogResponse.json();

        const created = await request.post("/api/logs/sessions", { data: { name: logName } });
        expect(created.ok(), await created.text()).toBeTruthy();
        const session = await created.json();
        logId = session.id || session.metadata?.id;
        expect(logId).toBeTruthy();
        const finalized = await request.post(`/api/logs/sessions/${encodeURIComponent(logId)}/finalize`, { data: {} });
        expect(finalized.ok(), await finalized.text()).toBeTruthy();

        await page.goto("/");
        await openWorkspace(page, "Logs");
        await expect(page.getByRole("button", { name: "Open workspace switcher" })).toContainText("Logs");
        const row = page.locator(`[data-log-id="${logId}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row).toContainText(/B|KiB|MiB/);
        await row.click();

        const nameField = page.getByRole("textbox", { name: "Log name" });
        await expect(nameField).toHaveValue(logName);
        await nameField.fill(renamed);
        await nameField.blur();
        await expect(row.getByText(renamed)).toBeVisible();

        await page.getByRole("button", { name: "Create log folder" }).click();
        await page.getByRole("textbox", { name: "Folder name" }).fill(folderName);
        await page.getByRole("button", { name: "Add" }).click();
        await expect(page.getByRole("button", { name: folderName, exact: true })).toBeVisible();
        await page.getByRole("combobox", { name: "Log folder" }).selectOption({ label: folderName });
        await expect(row.getByText(new RegExp(`${folderName} ·`))).toBeVisible();

        await page.getByRole("region", { name: "Recording details" }).getByRole("button", { name: "Delete" }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
        await expect(page.locator(`[data-log-id="${logId}"]`)).toHaveCount(0);
        logId = null;
    } finally {
        if (logId) await request.delete(`/api/logs/${encodeURIComponent(logId)}`);
        if (originalCatalog) {
            const latestResponse = await request.get("/api/logs/catalog");
            if (latestResponse.ok()) {
                const latest = await latestResponse.json();
                await request.put("/api/logs/catalog", {
                    data: { catalog: originalCatalog, expectedRevision: latest.revision },
                });
            }
        }
    }
});
