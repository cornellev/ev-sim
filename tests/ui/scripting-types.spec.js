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

async function addBlock(page, query, buttonName) {
    const expand = page.getByRole("button", { name: "Expand block library" });
    if (await expand.isVisible()) {
        await expand.click();
    }
    const search = page.getByPlaceholder("Search blocks");
    await expect(search).toBeVisible();
    await search.fill(query);
    await page.getByRole("button", { name: buttonName, exact: true }).click();
}

test("scripting canvas binds If ports from a Number wire and rejects a string conflict", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");

    await addBlock(page, "If Statement", "If Statement Logic");
    await addBlock(page, "Number", "Number Expressions");
    await addBlock(page, "String", "String Objects");

    const trueValue = page.getByRole("button", { name: "Connect input true value, generic" });
    await expect(trueValue).toBeVisible();
    await trueValue.focus();
    await page.keyboard.press("Enter");

    const numberOut = page.getByRole("button", { name: "Connect output number, float64" });
    await expect(numberOut).toBeVisible();
    await numberOut.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: "Connect input true value, float64" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input false value, float64" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, float64" })).toBeVisible();

    const falseValue = page.getByRole("button", { name: "Connect input false value, float64" });
    await falseValue.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Connect output out, string" }).focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: "Connect input false value, float64" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input false value, string" })).toHaveCount(0);
});

test("scripting canvas exposes unit sequencing ports on Write Signal, Sequence, and Nop", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");

    await addBlock(page, "Write Signal", "Write Signal Signals");
    await addBlock(page, "Sequence", "Sequence Logic");
    await addBlock(page, "Nop", "Nop Logic");

    await expect(page.getByRole("button", { name: "Connect output then, unit" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output written, boolean" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect output value, json" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input first, unit" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input second, unit" })).toBeVisible();

    const nopThen = page.getByRole("button", { name: "Connect output then, unit" }).last();
    await nopThen.focus();
    await page.keyboard.press("Enter");
    const sequenceFirst = page.getByRole("button", { name: "Connect input first, unit" });
    await sequenceFirst.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: "Connect input first, unit" })).toBeVisible();
});
