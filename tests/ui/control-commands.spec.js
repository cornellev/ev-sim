import { test, expect } from "@playwright/test";

async function openRunConfiguration(page) {
    await page.goto("/");
    await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Run configuration/i }).click();
}

test.describe("control commands", () => {
    test("config exposes controls tab with canonical endpoint", async ({ page }) => {
        await openRunConfiguration(page);
        await expect(page.getByRole("tab", { name: "Controls" })).toBeVisible({ timeout: 30_000 });
        await page.getByRole("tab", { name: "Controls" }).click();
        await expect(page.getByTestId("controls-config")).toBeVisible();
        await expect(page.getByTestId("controls-config")).toContainText("/controls/command");
        await expect(page.getByTestId("controls-config")).toContainText("Stale policy");
        await expect(page.getByTestId("controls-config")).toContainText("Max speed");
        await expect(page.getByTestId("controls-config")).toContainText("Max steer rate");
    });

    test("topics catalog adds controls-command not ackdrive", async ({ page }) => {
        await openRunConfiguration(page);
        await page.getByRole("tab", { name: "Topics" }).click();
        // Ensure the live page text does not advertise /ackdrive as an option.
        await expect(page.locator("body")).not.toContainText("/ackdrive");
    });
});
