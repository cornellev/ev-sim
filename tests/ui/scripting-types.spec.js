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
    await page.getByRole("button", { name: "New" }).first().click();

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
    await page.getByRole("button", { name: "New" }).first().click();

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

test("scripting canvas exposes Make and Split Actor Command ports", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();

    await addBlock(page, "Make Actor Command", "Make Actor Command Mission");
    await addBlock(page, "Split Actor Command", "Split Actor Command Mission");
    await addBlock(page, "If Statement", "If Statement Logic");

    const closeLibrary = page.getByRole("button", { name: "Close block library" });
    if (await closeLibrary.isVisible()) await closeLibrary.click();

    await expect(page.getByRole("button", { name: "Connect output command, actor_command" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Connect input command, actor_command" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Connect input actorId, string" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Connect output actorId, string" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Connect input speed, float64" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Connect input steering, float64" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Connect output speed, float64" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Connect output steering, float64" })).toHaveCount(1);

    const trueValue = page.getByRole("button", { name: "Connect input true value, generic" });
    await trueValue.focus();
    await page.keyboard.press("Enter");
    const commandOut = page.getByRole("button", { name: "Connect output command, actor_command" });
    await commandOut.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: "Connect input true value, actor_command" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input false value, actor_command" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, actor_command" })).toBeVisible();
});

test("block library searches keywords and hides deprecated composite blocks", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");

    const expand = page.getByRole("button", { name: "Expand block library" });
    if (await expand.isVisible()) await expand.click();
    const search = page.getByPlaceholder("Search blocks");
    await search.fill("rng");
    await expect(page.getByRole("button", { name: "Random Number Expressions", exact: true })).toBeVisible();

    await search.fill("Calculation");
    await expect(page.getByRole("button", { name: /Calculation/ })).toHaveCount(0);
    await search.fill("scale scalar");
    await expect(page.getByRole("button", { name: "Scale Matrix (tex1d) Texture 1D", exact: true })).toBeVisible();
});

test("OutputNode rejects an incompatible typed edit without dropping its wire", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();

    await addBlock(page, "Number", "Number Expressions");
    const closeLibrary = page.getByRole("button", { name: "Close block library" });
    if (await closeLibrary.isVisible()) await closeLibrary.click();

    const headInput = page.getByRole("button", { name: "Connect input output, float64" });
    await headInput.focus();
    await page.keyboard.press("Enter");
    const numberOutput = page.getByRole("button", { name: "Connect output number, float64" });
    await numberOutput.focus();
    await page.keyboard.press("Enter");

    const typeSelect = page.getByLabel("Type").first();
    await typeSelect.selectOption("string");
    await expect(typeSelect).toHaveValue("float64");
    await expect(page.getByRole("alert").filter({ hasText: "Type mismatch" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input output, float64" })).toBeVisible();
});
