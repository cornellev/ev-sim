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

    await addBlock(page, "If Statement", "If Statement Statements");
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
    await addBlock(page, "Sequence", "Sequence Statements");
    await addBlock(page, "Nop", "Nop Statements");

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
    await addBlock(page, "If Statement", "If Statement Statements");

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
    await search.fill("plus");
    await expect(page.getByRole("button", { name: "Add Math", exact: true })).toBeVisible();
    await search.fill("and");
    await expect(page.getByRole("button", { name: "And Logic", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /Conjugation/ })).toHaveCount(0);
    await search.fill("concat");
    await expect(page.getByRole("button", { name: "Concat String Strings", exact: true })).toBeVisible();
    await search.fill("floor");
    await expect(page.getByRole("button", { name: "Floor to Int Conversions", exact: true })).toBeVisible();
    await search.fill("scale scalar");
    await expect(page.getByRole("button", { name: "Scale Texture Texture 1D", exact: true })).toBeVisible();
    await search.fill("vehicle state");
    await expect(page.getByRole("button", { name: "Vehicle State Simulator", exact: true })).toBeVisible();
    await search.fill("sim clock");
    await expect(page.getByRole("button", { name: "Simulation Clock Simulator", exact: true })).toBeVisible();
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

test("scripting canvas wires Add, Equal, Boolean Not, and Integer Less", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();

    await addBlock(page, "Add", "Add Math");
    await addBlock(page, "Number", "Number Expressions");
    await expect(page.getByRole("button", { name: "Connect input a, float64" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, float64" })).toBeVisible();

    const addA = page.getByRole("button", { name: "Connect input a, float64" });
    await addA.focus();
    await page.keyboard.press("Enter");
    const numberOut = page.getByRole("button", { name: "Connect output number, float64" });
    await numberOut.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Connect input a, float64" })).toBeVisible();

    await addBlock(page, "Equal", "Equal Logic");
    const equalNode = page.getByRole("group", { name: /Equal node/ });
    const equalA = equalNode.getByRole("button", { name: "Connect input a, generic" });
    await expect(equalA).toBeVisible();
    await equalA.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Connect output number, float64" }).focus();
    await page.keyboard.press("Enter");
    await expect(equalNode.getByRole("button", { name: "Connect input a, float64" })).toBeVisible();
    await expect(equalNode.getByRole("button", { name: "Connect input b, float64" })).toBeVisible();

    await addBlock(page, "Boolean", "Boolean Logic");
    await addBlock(page, "Not", "Not Logic");
    const booleanNode = page.getByRole("group", { name: /Boolean node/ });
    const notNode = page.getByRole("group", { name: /Not node/ });
    const notIn = notNode.getByRole("button", { name: "Connect input value, boolean" });
    await expect(notIn).toBeVisible();
    await notIn.focus();
    await page.keyboard.press("Enter");
    await booleanNode.getByRole("button", { name: "Connect output out, boolean" }).focus();
    await page.keyboard.press("Enter");
    await expect(notNode.getByRole("button", { name: "Connect output out, boolean" })).toBeVisible();

    await addBlock(page, "Integer", "Integer Math");
    await addBlock(page, "Less", "Less Logic");
    const lessNode = page.getByRole("group", { name: /Less node/ });
    const lessA = lessNode.getByRole("button", { name: "Connect input a, generic" });
    await lessA.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Connect output out, int32" }).focus();
    await page.keyboard.press("Enter");
    await expect(lessNode.getByRole("button", { name: "Connect input a, int32" })).toBeVisible();
    await expect(lessNode.getByRole("button", { name: "Connect input b, int32" })).toBeVisible();

    await addBlock(page, "String", "String Objects");
    const lessB = lessNode.getByRole("button", { name: "Connect input b, int32" });
    await lessB.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Connect output out, string" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Connect input b, int32" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input b, string" })).toHaveCount(0);
});

test("block library places stdlib blocks and rejects an incompatible Array Get item type", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();

    await addBlock(page, "Array Get", "Array Get Collections");
    await addBlock(page, "Add", "Add Math");
    await addBlock(page, "JSON Get", "JSON Get Objects");
    await addBlock(page, "Floor to Int", "Floor to Int Conversions");
    await addBlock(page, "Concat String", "Concat String Strings");

    const closeLibrary = page.getByRole("button", { name: "Close block library" });
    if (await closeLibrary.isVisible()) await closeLibrary.click();

    await expect(page.getByRole("group", { name: /Array Get node/ })).toBeVisible();
    await expect(page.getByRole("group", { name: /JSON Get node/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, float64" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, string" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, int32" }).first()).toBeVisible();

    const arrayGet = page.getByRole("group", { name: /Array Get node/ });
    const addNode = page.getByRole("group", { name: /Add node/ });
    await addNode.getByRole("button", { name: "Connect input a, float64" }).focus();
    await page.keyboard.press("Enter");
    await arrayGet.getByRole("button", { name: "Connect output out, float64" }).focus();
    await page.keyboard.press("Enter");
    await expect(addNode.getByRole("button", { name: "Connect input a, float64" })).toBeVisible();

    const itemType = arrayGet.getByLabel("Item type");
    await itemType.selectOption("string");
    await expect(itemType).toHaveValue("float64");
    await expect(page.getByRole("alert").filter({ hasText: "Type mismatch" })).toBeVisible();
    await expect(arrayGet.getByRole("button", { name: "Connect output out, float64" })).toBeVisible();
    await expect(arrayGet.getByRole("button", { name: "Connect output out, string" })).toHaveCount(0);
});

test("block library places geometry and route helper blocks", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();

    await addBlock(page, "Make Vec2", "Make Vec2 Geometry");
    await addBlock(page, "Route Length", "Route Length Mission");

    await expect(page.getByRole("group", { name: /Make Vec2 node/ })).toBeVisible();
    await expect(page.getByRole("group", { name: /Route Length node/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, vec2" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output length, float64" })).toBeVisible();
});

test("block library places control temporal and pid blocks", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();

    await addBlock(page, "Integrator", "Integrator Control");
    await addBlock(page, "Previous", "Previous Control");
    await addBlock(page, "PID Controller", "PID Controller Control");

    await expect(page.getByRole("group", { name: /Integrator node/ })).toBeVisible();
    await expect(page.getByRole("group", { name: /Previous node/ })).toBeVisible();
    await expect(page.getByRole("group", { name: /PID Controller node/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, float64" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output previous, generic" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output command, float64" })).toBeVisible();
});

test("block library places simulator adapters and texture ops", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();

    await addBlock(page, "Simulation Clock", "Simulation Clock Simulator");
    await addBlock(page, "Scale Texture", "Scale Texture Texture 1D");

    await expect(page.getByRole("group", { name: /Simulation Clock node/ })).toBeVisible();
    await expect(page.getByRole("group", { name: /Scale Texture node/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output time, float64" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output dt, float64" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect input tex, tex1d" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect output out, tex1d" })).toBeVisible();
});

test("clicking a connection shows the exact port type", async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto("/");
    await openWorkspace(page, "Scripting canvas");
    await page.getByRole("button", { name: "New" }).first().click();

    await addBlock(page, "Number", "Number Expressions");
    const closeLibrary = page.getByRole("button", { name: "Close block library" });
    if (await closeLibrary.isVisible()) await closeLibrary.click();

    const outputIn = page.getByRole("button", { name: "Connect input output, float64" });
    await expect(outputIn).toBeVisible();
    await outputIn.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Connect output number, float64" }).focus();
    await page.keyboard.press("Enter");

    await page.locator("[data-connection-hit]").click({ force: true });
    await expect(page.locator("[data-connection-type-chip]")).toHaveText("float64");
});

