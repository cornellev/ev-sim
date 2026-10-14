import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const BOX_GLB = Buffer.from(
    "Z2xURgIAAACMAgAAyAEAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAifSwic2NlbmUiOjAsInNjZW5lcyI6W3sibm9kZXMiOlswXX1dLCJub2RlcyI6W3sibmFtZSI6ImJvZHkiLCJtZXNoIjowfV0sIm1lc2hlcyI6W3sicHJpbWl0aXZlcyI6W3siYXR0cmlidXRlcyI6eyJQT1NJVElPTiI6MH0sImluZGljZXMiOjEsIm1vZGUiOjR9XX1dLCJhY2Nlc3NvcnMiOlt7ImJ1ZmZlclZpZXciOjAsImNvbXBvbmVudFR5cGUiOjUxMjYsImNvdW50Ijo4LCJ0eXBlIjoiVkVDMyJ9LHsiYnVmZmVyVmlldyI6MSwiY29tcG9uZW50VHlwZSI6NTEyMywiY291bnQiOjM2LCJ0eXBlIjoiU0NBTEFSIn1dLCJidWZmZXJWaWV3cyI6W3siYnVmZmVyIjowLCJieXRlT2Zmc2V0IjowLCJieXRlTGVuZ3RoIjo5Nn0seyJidWZmZXIiOjAsImJ5dGVPZmZzZXQiOjk2LCJieXRlTGVuZ3RoIjo3Mn1dLCJidWZmZXJzIjpbeyJieXRlTGVuZ3RoIjoxNjh9XX0gICCoAAAAQklOAAAAAL8AAAAAAAAAvwAAAD8AAAAAAAAAvwAAAD8AAIA/AAAAvwAAAL8AAIA/AAAAvwAAAL8AAAAAAAAAPwAAAD8AAAAAAAAAPwAAAD8AAIA/AAAAPwAAAL8AAIA/AAAAPwAAAQACAAAAAgADAAQABgAFAAQABwAGAAAABAAFAAAABQABAAIABgAHAAIABwADAAAAAwAHAAAABwAEAAEABQAGAAEABgACAA==",
    "base64",
);

test.use({ viewport: { width: 1280, height: 720 } });

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

async function seriousViolations(page, include) {
    const results = await new AxeBuilder({ page })
        .include(include)
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    return results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
}

test.describe("vehicle acceptance", () => {
    test("keyboard opens the catalog, saves a new name, undoes it, and restores focus", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const opener = page.getByRole("button", { name: /Open vehicle catalog/ });
        const catalog = await openVehicleCatalog(page);
        await catalog.getByRole("listbox", { name: "Vehicle catalog" }).focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("Enter");
        await expect(page.getByText("Built-in · read only")).toBeVisible();
        await opener.click();
        await page.getByRole("dialog", { name: "Vehicles" }).getByRole("button", { name: "New", exact: true }).click();
        const name = page.getByRole("textbox", { name: "Vehicle name" });
        await expect(name).toBeEnabled();
        await expect(name).toHaveValue("Untitled Vehicle");
        await name.fill("Acceptance Car");
        await page.keyboard.press("ControlOrMeta+s");
        await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "idle");
        await expect(page.locator("[data-save-status]")).toContainText("Saved");
        await page.keyboard.press("ControlOrMeta+z");
        await expect(name).toHaveValue("Untitled Vehicle");
        await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "dirty");
        await opener.click();
        await expect(page.getByRole("dialog", { name: "Vehicles" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(opener).toBeFocused();
    });

    test("a dirty vehicle blocks an id change until undo or save", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const catalog = await openVehicleCatalog(page);
        await catalog.getByRole("button", { name: "New", exact: true }).click();
        const name = page.getByRole("textbox", { name: "Vehicle name" });
        await name.fill("Needs Save");
        const dirtyCatalog = await openVehicleCatalog(page);
        await expect(dirtyCatalog.getByText("Save or discard the open draft before renaming, deleting, or changing this id.")).toBeVisible();
        await expect(dirtyCatalog.getByRole("button", { name: "Change id", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await page.keyboard.press("ControlOrMeta+z");
        await expect(name).toHaveValue("Untitled Vehicle");
        const discarded = await openVehicleCatalog(page);
        await expect(discarded.getByRole("button", { name: "Change id", exact: true })).toBeEnabled();
        await page.keyboard.press("Escape");
        await name.fill("Needs Save");
        await page.keyboard.press("ControlOrMeta+s");
        await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "idle");
        const saved = await openVehicleCatalog(page);
        await expect(saved.getByRole("button", { name: "Change id", exact: true })).toBeEnabled();
        await saved.getByRole("button", { name: "Change id", exact: true }).click();
        const confirm = page.getByRole("dialog", { name: "Change vehicle id" });
        await expect(confirm).toContainText("Runs and scenarios that name the old id are not rewritten.");
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(confirm).toBeHidden();
        await expect(page.getByRole("dialog", { name: "Vehicles" })).toBeVisible();
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
        await page.keyboard.press("ControlOrMeta+s");
        await expect(page.locator("[data-save-status='conflict']")).toBeVisible();
        await expect(page.getByRole("textbox", { name: "Vehicle name" })).toHaveValue("Conflict Name");
    });

    test("Escape on the URDF review and wheel assignment dialogs restores the opener", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        const catalog = await openVehicleCatalog(page);
        await catalog.getByRole("button", { name: "New", exact: true }).click();
        const urdf = page.getByRole("button", { name: "URDF", exact: true });
        await urdf.click();
        const review = page.getByRole("dialog", { name: "Create from URDF" });
        await expect(review).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(review).toBeHidden();
        await expect(urdf).toBeFocused();

        await page.locator("input[type='file'][accept*='.glb']").setInputFiles({
            name: "box.glb",
            mimeType: "model/gltf-binary",
            buffer: BOX_GLB,
        });
        await expect(page.getByText(/^[a-f0-9]{64}\.glb$/)).toBeVisible({ timeout: 30_000 });
        await page.getByRole("tab", { name: "Wheels" }).click();
        const assign = page.getByRole("button", { name: "Assign wheels", exact: true });
        await expect(assign).toBeEnabled();
        await expect(async () => {
            await assign.click();
            await expect(page.getByRole("dialog", { name: "Assign wheels" })).toBeVisible({ timeout: 1_000 });
        }).toPass({ timeout: 30_000 });
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog", { name: "Assign wheels" })).toBeHidden();
        await expect(assign).toBeFocused();
    });

    test("@a11y the workspace, catalog, wheels, and URDF review have no serious violations", async ({ page }) => {
        test.setTimeout(300_000);
        await openVehicleEditor(page);
        expect(await seriousViolations(page, "[data-vehicle-workspace]")).toEqual([]);
        await openVehicleCatalog(page);
        expect(await seriousViolations(page, "[role='dialog']")).toEqual([]);
        await page.getByRole("listbox", { name: "Vehicle catalog" }).focus();
        await page.keyboard.press("Home");
        await page.keyboard.press("Enter");
        await page.getByRole("tab", { name: "Wheels" }).click();
        await expect(page.locator("[data-vehicle-wheels]")).toBeVisible();
        expect(await seriousViolations(page, "[data-vehicle-wheels]")).toEqual([]);
        await page.getByRole("button", { name: "URDF", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Create from URDF" })).toBeVisible();
        expect(await seriousViolations(page, "[role='dialog']")).toEqual([]);
    });
});
