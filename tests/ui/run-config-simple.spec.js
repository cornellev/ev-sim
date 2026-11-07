import AxeBuilder from "@axe-core/playwright";
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
    await expect(page.getByRole("group", { name: "Execution profile" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tablist", { name: "Run manifest sections" })).toBeHidden();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.runConfig.mode")).toBeNull();

    const renamed = `Simple run ${Date.now().toString(36)}`;
    const simpleName = page.getByRole("textbox", { name: "Name" });
    await simpleName.fill(renamed);
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.advancedAuthoring")).toBe(advancedAuthoring);

    await view.getByRole("button", { name: "Advanced" }).click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.runConfig.mode")).toBe("advanced");
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

test("a global advanced preference opens advanced until the run view is chosen", async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem("cev-sim.ui.advancedAuthoring", "true");
    });
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await expect(page.getByRole("tablist", { name: "Run manifest sections" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.runConfig.mode")).toBeNull();
    await page.getByRole("group", { name: "Run configuration view" }).getByRole("button", { name: "Simple" }).click();
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.runConfig.mode")).toBe("simple");
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.advancedAuthoring")).toBe("true");
});

test("a storage failure keeps the chosen view for the session", async ({ page }) => {
    await page.addInitScript(() => {
        const key = "cev-sim.ui.runConfig.mode";
        const storage = window.localStorage;
        const getItem = storage.getItem.bind(storage);
        const setItem = storage.setItem.bind(storage);
        window.__runModeWrites = 0;
        storage.getItem = (name) => {
            if (name === key) throw new Error("storage unavailable");
            return getItem(name);
        };
        storage.setItem = (name, value) => {
            if (name === key) {
                window.__runModeWrites += 1;
                throw new Error("storage unavailable");
            }
            return setItem(name, value);
        };
    });
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await expect(page.getByRole("group", { name: "Execution profile" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tablist", { name: "Run manifest sections" })).toBeHidden();
    const advanced = page.getByRole("group", { name: "Run configuration view" }).getByRole("button", { name: "Advanced" });
    await advanced.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tablist", { name: "Run manifest sections" })).toBeVisible();
    await page.evaluate(() => {
        window.dispatchEvent(new StorageEvent("storage", { key: "cev-sim.ui.runConfig.mode" }));
    });
    await expect(page.getByRole("tablist", { name: "Run manifest sections" })).toBeVisible();
    const writes = await page.evaluate(() => window.__runModeWrites);
    expect(writes).toBeGreaterThan(0);
});

test("catalog actions stay in the header below 1024px", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await expect(page.getByRole("group", { name: "Execution profile" })).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("aside")).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Select run manifest" })).toBeVisible();
    for (const name of ["New", "Import", "Duplicate", "Export bundle", "Export template", "Delete"]) {
        await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
    }
});

test("keyboard stays out of the hidden advanced editor", async ({ page }) => {
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    const name = page.getByRole("textbox", { name: "Name" });
    await expect(name).toBeVisible({ timeout: 30_000 });
    await name.focus();
    for (let step = 0; step < 12; step += 1) {
        await page.keyboard.press("Tab");
        const insideHidden = await page.evaluate(() => Boolean(document.activeElement?.closest("[aria-hidden='true']")));
        expect(insideHidden).toBe(false);
    }
    const advanced = page.getByRole("group", { name: "Run configuration view" }).getByRole("button", { name: "Advanced" });
    await advanced.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tablist", { name: "Run manifest sections" })).toBeVisible();
});

test("cancelling an execution profile leaves the control source unchanged", async ({ page }) => {
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    const profile = page.getByRole("group", { name: "Execution profile" });
    await expect(profile).toBeVisible({ timeout: 30_000 });
    const source = page.getByText(/^Control source:/);
    const before = await source.innerText();
    const external = profile.getByRole("button", { name: "External Controller" });
    const standard = profile.getByRole("button", { name: "Standard Simulation" });
    const externalOn = await external.getAttribute("data-state") === "on";
    await (externalOn ? standard : external).click();
    const dialog = page.getByRole("dialog", { name: externalOn ? "Standard Simulation" : "External Controller" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(source).toHaveText(before);
});

test("simple recording policy survives save and reload", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    const policy = page.getByRole("combobox", { name: "Recording policy" });
    await expect(policy).toBeVisible({ timeout: 30_000 });
    const current = await policy.inputValue();
    const next = current === "disabled" ? "optional" : "disabled";
    await policy.selectOption(next);
    const save = page.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(save).toBeDisabled({ timeout: 15_000 });
    await page.reload();
    await openWorkspace(page, "Run configuration");
    await expect(page.getByRole("combobox", { name: "Recording policy" })).toHaveValue(next, { timeout: 30_000 });
});

test("simple run configuration is accessible at the narrow breakpoint @a11y", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 900, height: 720 });
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    await expect(page.getByRole("group", { name: "Run configuration view" })).toBeVisible({ timeout: 30_000 });
    const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
});
