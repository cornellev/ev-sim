import { expect, test } from "@playwright/test";

async function openWorkspace(page, label) {
    await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
    const discard = page.getByRole("button", { name: "Discard and switch" });
    if (await discard.isVisible()) await discard.click();
}

test("headless runs workspace loads launch dialog", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await openWorkspace(page, "Headless runs");
    await expect(page.getByRole("button", { name: "Launch suite" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Launch", exact: true })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Headless runs" })).toBeVisible();
    await page.getByRole("button", { name: "Launch suite" }).click();
    await expect(page.getByRole("dialog")).toContainText("Queue headless run");
    await expect(page.getByRole("button", { name: "Queue run" })).toBeVisible();
});
