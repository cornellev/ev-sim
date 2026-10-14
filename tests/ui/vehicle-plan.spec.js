import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function openVehicleEditor(page) {
    await page.goto("/");
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Vehicle Editor/i }).click();
    await expect(page.getByRole("tab", { name: "Wheels" })).toBeVisible({ timeout: 180_000 });
}

async function openVehicleCatalog(page) {
    await page.getByRole("button", { name: /Open vehicle catalog/ }).click();
    const dialog = page.getByRole("dialog", { name: "Vehicles" });
    await expect(dialog).toBeVisible();
    return dialog;
}

test.describe("vehicle plan", () => {
    test("an axle nudge is one undo and a built-in plan stays locked", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const catalog = await openVehicleCatalog(page);
        await catalog.getByRole("button", { name: "New", exact: true }).click();
        await page.getByRole("tab", { name: "Wheels" }).click();
        const axle = page.getByRole("slider", { name: "Front axle position" });
        await expect(axle).toBeVisible();
        await expect(axle).toHaveAttribute("aria-valuetext", "0.750 meters forward");
        await axle.focus();
        await page.keyboard.press("ArrowUp");
        await expect(axle).toHaveAttribute("aria-valuetext", "0.760 meters forward");
        await page.keyboard.press("ControlOrMeta+z");
        await expect(axle).toHaveAttribute("aria-valuetext", "0.750 meters forward");
        const steering = page.getByRole("slider", { name: "Preview steering angle" });
        await steering.fill("12");
        await expect(steering).not.toHaveValue("0");
        await page.getByRole("button", { name: "Reset preview steering angle" }).click();
        await expect(steering).toHaveValue("0");

        page.once("dialog", (dialog) => dialog.accept());
        const builtIns = await openVehicleCatalog(page);
        await builtIns.getByRole("option", { name: /^Big Car/ }).click();
        await builtIns.getByRole("button", { name: "Open", exact: true }).click();
        await expect(page.getByRole("group", { name: "Vehicle plan, forward is up, left is left" })).toBeVisible();
        await expect(page.getByRole("slider", { name: "Preview steering angle" })).toBeDisabled();
        await expect(page.getByRole("slider", { name: "Front axle position" })).toHaveCount(0);
    });

    test("selecting a wheel expands its axle", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const catalog = await openVehicleCatalog(page);
        await catalog.getByRole("button", { name: "New", exact: true }).click();
        await page.getByRole("treeitem", { name: "front-left" }).click();
        await expect(page.getByRole("region", { name: "Front axle", exact: true })).toBeVisible();
    });

    test("@a11y the wheels panel has no serious violations", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const catalog = await openVehicleCatalog(page);
        await catalog.getByRole("listbox", { name: "Vehicle catalog" }).focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("Enter");
        await page.getByRole("tab", { name: "Wheels" }).click();
        await expect(page.locator("[data-vehicle-wheels]")).toBeVisible();
        const results = await new AxeBuilder({ page })
            .include("[data-vehicle-wheels]")
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
        expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
    });

    test("keyboard opens a built-in and returns focus to the catalog button", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const opener = page.getByRole("button", { name: /Open vehicle catalog/ });
        const catalog = await openVehicleCatalog(page);
        await catalog.getByRole("listbox", { name: "Vehicle catalog" }).focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("Enter");
        await page.getByRole("tab", { name: "Wheels" }).click();
        await expect(page.getByRole("slider", { name: "Preview steering angle" })).toBeDisabled();
        await opener.click();
        await expect(page.getByRole("dialog", { name: "Vehicles" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(opener).toBeFocused();
    });

    test("a save conflict keeps the typed name", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const catalog = await openVehicleCatalog(page);
        await catalog.getByRole("button", { name: "New", exact: true }).click();
        await page.getByRole("textbox", { name: "Vehicle name" }).fill("Conflict Name");
        await page.route("**/api/storage/vehicles/**", async (route) => {
            if (route.request().method() === "PUT") {
                await route.fulfill({
                    status: 409,
                    contentType: "application/json",
                    body: JSON.stringify({ error: "revision conflict" }),
                });
                return;
            }
            await route.continue();
        });
        await page.getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("[data-save-status='conflict']")).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Vehicle name" })).toHaveValue("Conflict Name");
    });

    test("@a11y the vehicle workspace and picker have no serious violations", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const workspace = await new AxeBuilder({ page })
            .include("[data-vehicle-workspace]")
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
        expect(workspace.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
        await openVehicleCatalog(page);
        const picker = await new AxeBuilder({ page })
            .include("[role='dialog']")
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
        expect(picker.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
    });
});
