import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function newVehicle(page) {
    await page.goto("/");
    await page.getByRole("button", { name: "Open workspace switcher" }).first().click();
    await page.getByRole("dialog", { name: "Workspaces" }).getByRole("button", { name: /^Vehicle Editor/i }).click();
    await expect(page.getByRole("tab", { name: "Wheels" })).toBeVisible({ timeout: 180_000 });
    await page.getByRole("button", { name: /Open vehicle catalog/ }).click();
    await page.getByRole("dialog", { name: "Vehicles" }).getByRole("button", { name: "New", exact: true }).click();
}

async function addOdometry(page) {
    await page.getByRole("tab", { name: "JSON", exact: true }).click();
    const raw = page.getByRole("textbox", { name: "Raw vehicle manifest JSON" });
    const manifest = JSON.parse(await raw.inputValue());
    manifest.sensors = [{ id: "odo", type: "wheel-odometry", config: { wheelRadius: 0.15, trackWidth: 1.2 } }];
    await raw.fill(JSON.stringify(manifest, null, 2));
    return raw;
}

test("RC mass and inertia save from the focused field and undo without implicit edits", async ({ page }) => {
    test.setTimeout(300_000);
    await newVehicle(page);
    await page.getByRole("tab", { name: "Wheels" }).click();
    await expect(page.getByRole("textbox", { name: "Mass (kg)", exact: true })).toHaveValue("1500");
    await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "idle");
    const mass = page.getByRole("textbox", { name: "Mass (kg)", exact: true });
    await mass.fill("3.123456");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "idle");
    await expect(mass).toHaveValue("3.123456");
    const inertia = page.getByRole("textbox", { name: "Turning inertia (kg·m²)", exact: true });
    await inertia.fill("0.032661");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "idle");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(inertia).toHaveValue("2250");
});

test("odometry save warning supports Escape, cancel, skip and sync through both save entry points", async ({ page }) => {
    test.setTimeout(300_000);
    await newVehicle(page);
    const raw = await addOdometry(page);
    let writes = 0;
    await page.route("**/api/storage/vehicles/**", async (route) => {
        if (route.request().method() === "PUT") writes += 1;
        await route.continue();
    });
    await raw.focus();
    await page.keyboard.press("ControlOrMeta+s");
    const review = page.getByRole("dialog", { name: "Wheel odometry geometry mismatch" });
    await expect(review).toBeVisible();
    expect(writes).toBe(0);
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
    await expect(raw).toBeFocused();
    const save = page.getByRole("button", { name: "Save", exact: true });
    await save.click();
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(writes).toBe(0);
    await expect(save).toBeFocused();
    await save.click();
    await review.getByRole("button", { name: "Save without syncing" }).click();
    await expect(review).toBeHidden();
    expect(writes).toBe(1);
    expect(JSON.parse(await raw.inputValue()).sensors[0].config.wheelRadius).toBe(0.15);
    const manifest = JSON.parse(await raw.inputValue());
    manifest.description = "Sync on the next save";
    await raw.fill(JSON.stringify(manifest, null, 2));
    await page.keyboard.press("ControlOrMeta+s");
    await review.getByRole("button", { name: "Sync and save" }).click();
    await expect(review).toBeHidden();
    const synced = JSON.parse(await raw.inputValue());
    const rear = synced.wheels.filter((wheel) => wheel.axle === "rear");
    expect(synced.sensors[0].config.trackWidth).toBe(Math.abs(rear[0].position.z - rear[1].position.z));
    expect(synced.sensors[0].config.wheelRadius).toBe((rear[0].radius + rear[1].radius) / 2);
    await page.keyboard.press("ControlOrMeta+z");
    expect(JSON.parse(await raw.inputValue()).sensors[0].config.wheelRadius).toBe(0.15);
});

test("odometry review and physics fields are accessible @a11y", async ({ page }) => {
    test.setTimeout(300_000);
    await newVehicle(page);
    await addOdometry(page);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByRole("dialog", { name: "Wheel odometry geometry mismatch" })).toBeVisible();
    expect((await new AxeBuilder({ page }).include("[role=dialog]").analyze()).violations).toEqual([]);
    await page.keyboard.press("Escape");
    await page.getByRole("tab", { name: "Wheels" }).click();
    expect((await new AxeBuilder({ page }).include("[role=tabpanel][data-state=active]").analyze()).violations).toEqual([]);
});

test("compatible plant switches keep values and incompatible switches require confirmation", async ({ page }) => {
    test.setTimeout(300_000);
    const parameters = Object.entries({ mass: 1500, yawInertia: 2250, corneringStiffnessFront: 80000, corneringStiffnessRear: 80000, frictionMu: 0.9, rollingResistance: 0.015 })
        .map(([key, value]) => ({ key, source: "default", default: value }));
    const contact = { id: "test.dynamics.contact", pluginId: "test.dynamics", version: "1.0.0", packageHash: "a".repeat(64), runtimeHash: "b".repeat(64), model: "contact-bicycle-v1", parameters };
    const generic = { id: "test.generic.plant", pluginId: "test.generic", version: "1.0.0", packageHash: "c".repeat(64), runtimeHash: "d".repeat(64), parameters: [] };
    await page.route("**/api/storage/plugins/plants", (route) => route.fulfill({ json: { ok: true, plants: [contact, generic] } }));
    await newVehicle(page);
    await page.getByRole("tab", { name: "Wheels" }).click();
    const mass = page.getByRole("textbox", { name: "Mass (kg)", exact: true });
    await mass.fill("3");
    await mass.blur();
    const dynamics = page.getByRole("combobox", { name: "Dynamics", exact: true });
    await dynamics.selectOption(`${contact.packageHash}:${contact.id}`);
    await expect(mass).toHaveValue("3");
    await dynamics.selectOption("");
    await expect(mass).toHaveValue("3");
    await dynamics.selectOption(`${generic.packageHash}:${generic.id}`);
    const confirm = page.getByRole("dialog", { name: "Clear unsupported physics overrides?" });
    await expect(confirm).toContainText("mass");
    await page.keyboard.press("Escape");
    await expect(dynamics).toHaveValue("");
    await expect(mass).toHaveValue("3");
    await dynamics.selectOption(`${generic.packageHash}:${generic.id}`);
    await confirm.getByRole("button", { name: "Clear and switch" }).click();
    await expect(mass).toBeHidden();
    await page.keyboard.press("ControlOrMeta+z");
    await expect(mass).toHaveValue("3");
});
