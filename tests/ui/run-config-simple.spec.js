import { expect, test } from "@playwright/test";

async function openWorkspace(page, label) {
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    if (await opener.isVisible()) {
        await opener.evaluate((button) => button.click());
    } else {
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("Escape");
    }
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
    const discard = page.getByRole("button", { name: "Discard and switch" });
    if (await discard.isVisible()) await discard.click();
}

test("simple and advanced keep the draft, invalid JSON, and the other editor preference", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");

    const view = page.getByRole("group", { name: "Run configuration view" });
    const advancedAuthoring = await page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.advancedAuthoring");
    await expect(page.getByRole("tablist", { name: "Run manifest sections" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.runConfig.mode")).toBeNull();

    const renamed = `Simple run ${Date.now().toString(36)}`;
    await view.getByRole("button", { name: "Simple" }).click();
    await expect(page.getByRole("tablist", { name: "Run manifest sections" })).toBeHidden();
    const simpleName = page.getByRole("textbox", { name: "Name" });
    await simpleName.fill(renamed);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.runConfig.mode")).toBe("simple");
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.advancedAuthoring")).toBe(advancedAuthoring);

    await view.getByRole("button", { name: "Advanced" }).click();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(renamed);
    await view.getByRole("button", { name: "Simple" }).click();
    await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue(renamed);

    await view.getByRole("button", { name: "Advanced" }).click();
    await page.getByRole("tab", { name: "JSON" }).click();
    const raw = page.getByRole("textbox", { name: "Raw run manifest JSON" });
    await raw.fill("{");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await view.getByRole("button", { name: "Simple" }).click();
    await expect(page.getByRole("alert").getByText("Unapplied JSON blocks save and launch")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await view.getByRole("button", { name: "Advanced" }).click();
    await expect(page.getByRole("textbox", { name: "Raw run manifest JSON" })).toHaveValue("{");
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.advancedAuthoring")).toBe(advancedAuthoring);
});

test("simple mode can select a scenario and vehicle, save, and launch", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await page.getByRole("group", { name: "Run configuration view" }).getByRole("button", { name: "Simple" }).click();

    const scenario = page.getByRole("combobox", { name: "Scenario" });
    await expect(scenario).toBeVisible({ timeout: 30_000 });
    await page.getByText("Refreshing scenario catalog").waitFor({ state: "hidden", timeout: 30_000 }).catch(() => {});
    const scenarioCount = await scenario.locator("option").count();
    if (scenarioCount > 1) {
        const value = await scenario.locator("option").nth(1).getAttribute("value");
        await scenario.selectOption(value);
        const vehicle = page.getByRole("combobox", { name: "Ego vehicle" });
        await expect(vehicle).toBeVisible();
        const vehicleValue = await vehicle.locator("option").evaluateAll((options) => (
            options.map((option) => option.value).find((entry) => entry && !entry.endsWith(" (missing)"))
        ));
        if (vehicleValue) await vehicle.selectOption(vehicleValue);
    } else {
        await page.getByRole("textbox", { name: "Name" }).fill(`Simple launch ${Date.now().toString(36)}`);
    }

    const save = page.getByRole("button", { name: "Save", exact: true });
    if (await save.isEnabled()) await save.click();
    await page.getByRole("button", { name: "Launch", exact: true }).click();
    await expect.poll(async () => {
        const label = await page.getByRole("button", { name: "Open workspace switcher" }).innerText();
        if (/Simulation/.test(label)) return "simulation";
        if (await page.getByRole("alert").count()) return "error";
        return "";
    }, { timeout: 90_000 }).not.toBe("");
});
