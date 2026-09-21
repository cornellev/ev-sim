import { expect } from "@playwright/test";

export async function openWorkspace(page, label) {
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    await expect(opener).toBeVisible({ timeout: 30_000 });
    for (let attempt = 0; attempt < 5 && !(await dialog.isVisible()); attempt += 1) {
        await opener.click({ force: true });
        try {
            await expect(dialog).toBeVisible({ timeout: 2_000 });
        } catch {
            await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
            await page.keyboard.press("Escape");
        }
    }
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
    const discard = page.getByRole("button", { name: "Discard and switch" });
    if (await discard.isVisible()) await discard.click();
}
