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
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Camera clip" }).click();
    const clipDialog = page.getByRole("dialog", { name: "Camera clip" });
    await expect(clipDialog.getByText("4 seconds")).toBeVisible();
    await expect(clipDialog.getByText("1280×720", { exact: false })).toBeVisible();
    await clipDialog.getByLabel("Profile").selectOption("cosmos-nano");
    await expect(clipDialog).toContainText("1280×720");
    await expect(clipDialog).toContainText("121 frames");
    await expect(clipDialog).toContainText("30 fps");
    await clipDialog.getByLabel("Profile").selectOption("corridor");
    await expect(clipDialog).toContainText("cosmos-nano-clip");
    await expect(clipDialog).toContainText("121 frames");
    await clipDialog.getByLabel("Profile").selectOption("environment");
    await clipDialog.getByLabel("Camera", { exact: true }).selectOption("viewport");
    await expect(clipDialog.getByLabel("Viewport attachment")).toBeVisible();
    await clipDialog.getByLabel("Viewport attachment").selectOption("vehicle");
    await expect(clipDialog.getByLabel("Vehicle")).toBeVisible();
});
