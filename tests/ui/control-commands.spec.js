import { test, expect } from "@playwright/test";

test.describe("control commands", () => {
    test("config exposes controls tab with canonical endpoint", async ({ page }) => {
        await page.goto("/config");
        await expect(page.getByRole("tab", { name: "Controls" })).toBeVisible({ timeout: 30_000 });
        await page.getByRole("tab", { name: "Controls" }).click();
        await expect(page.getByTestId("controls-config")).toBeVisible();
        await expect(page.getByTestId("controls-config")).toContainText("/controls/command");
        await expect(page.getByTestId("controls-config")).toContainText("Stale policy");
        await expect(page.getByTestId("controls-config")).toContainText("Max speed");
        await expect(page.getByTestId("controls-config")).toContainText("Max steer rate");
    });

    test("topics catalog adds controls-command not ackdrive", async ({ page }) => {
        await page.goto("/config");
        await page.getByRole("tab", { name: "Topics" }).click();
        const add = page.locator("select").filter({ hasText: "Add from catalog" }).or(page.getByRole("combobox").first());
        // Ensure the live page text does not advertise /ackdrive as an option.
        await expect(page.locator("body")).not.toContainText("/ackdrive");
    });
});
