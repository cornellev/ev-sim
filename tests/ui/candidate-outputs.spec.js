import { expect, test } from "@playwright/test";

async function openWorkspace(page, label) {
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    if (await opener.isVisible()) {
        await opener.click();
    } else {
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("Escape");
    }
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
    const discard = page.getByRole("button", { name: "Discard and switch" });
    if (await discard.isVisible()) await discard.click();
}

test("run configuration catalogs candidate perception and localization return contracts", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");

    const tabs = page.getByRole("tablist", { name: "Run manifest sections" });
    await tabs.getByRole("tab", { name: "Topics" }).click();

    const panel = page.getByRole("tabpanel", { name: "Topics" });
    const catalog = panel.getByRole("combobox").first();
    await expect(catalog).toBeVisible();
    for (const label of [
        "perception-detections-2d (input)",
        "perception-detections-3d (input)",
        "perception-lanes (input)",
        "perception-semantic (input)",
        "localization-estimate (input)",
    ]) {
        await expect(catalog.locator("option", { hasText: label })).toHaveCount(1);
    }

    await expect(panel.getByRole("heading", { name: /Team returns/i })).toBeVisible();
    await expect(panel.getByText("/perception/detections_2d", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("/perception/detections_3d", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("/perception/lanes", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("/perception/semantic", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("/localization/odometry", { exact: true }).first()).toBeVisible();
});

test("analysis workspace exposes autonomy spatial view", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await openWorkspace(page, "Analysis");
    const tabs = page.getByRole("tablist", { name: "Analysis view" });
    await expect(tabs.getByRole("tab", { name: "Autonomy" })).toBeVisible();
    await tabs.getByRole("tab", { name: "Autonomy" }).click();
    await expect(page.getByText(/capture-aligned/i)).toBeVisible();
});
