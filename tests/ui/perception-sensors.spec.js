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

test("run configuration catalogs synchronized perception and oracle topic contracts", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");

    const tabs = page.getByRole("tablist", { name: "Run manifest sections" });
    await tabs.getByRole("tab", { name: "Topics" }).click();

    const panel = page.getByRole("tabpanel", { name: "Topics" });
    const catalog = panel.getByRole("combobox").first();
    await expect(catalog).toBeVisible();
    for (const label of [
        "front-camera-image (output)",
        "front-lidar-points (output)",
        "front-camera-depth (output)",
        "front-lidar-semantic (output)",
        "oracle-detections-2d (output)",
        "oracle-lanes (output)",
        "front-camera-diagnostics (output)",
    ]) {
        await expect(catalog.locator("option", { hasText: label })).toHaveCount(1);
    }
});

test("run configuration exposes oracle product toggles on sensors", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");

    const tabs = page.getByRole("tablist", { name: "Run manifest sections" });
    await tabs.getByRole("tab", { name: "Sensors" }).click();

    const panel = page.getByRole("tabpanel", { name: "Sensors" });
    await expect(panel.getByText("Oracle products").first()).toBeVisible();
    await expect(panel.getByRole("switch", { name: "Depth" }).first()).toBeVisible();
    await expect(panel.getByRole("switch", { name: "Semantic" }).first()).toBeVisible();
    await expect(panel.getByRole("switch", { name: "Semantic point cloud" })).toBeVisible();
});
