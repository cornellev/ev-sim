import AxeBuilder from "@axe-core/playwright";
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

test("workspace switcher reaches every workspace at laptop height", async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto("/");
    await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button")).toHaveCount(11);
    await expect(dialog.getByRole("button", { name: /^Run configuration/i })).toBeVisible();

    const activeWorkspace = dialog.getByRole("button", { name: /^Simulation/ });
    await expect(activeWorkspace).toHaveAttribute("data-active", "true");
    await expect(activeWorkspace).toHaveCSS("background-color", "rgb(33, 35, 37)");
    await activeWorkspace.hover();
    await expect(activeWorkspace).toHaveAttribute("data-active", "true");
    await expect(activeWorkspace).toHaveCSS("background-color", "rgb(33, 35, 37)");

    for (const label of ["Environment editor", "Run configuration", "Scenarios", "Experiment suite", "Vehicle editor", "Scripting canvas", "Bindings", "Replay", "Analysis"]) {
        if (!(await dialog.isVisible())) await page.keyboard.press("Escape");
        await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
        const discard = page.getByRole("button", { name: "Discard and switch" });
        if (await discard.isVisible()) await discard.click();
        await expect(dialog).toBeHidden();
        const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
        if (await opener.isVisible()) {
            await opener.click();
        } else {
            await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
            await page.keyboard.press("Escape");
        }
        await expect(dialog).toBeVisible();
    }
});

test("global workspace shortcut is suppressed while editing", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");
    const input = page.locator("input:visible").first();
    await expect(input).toBeVisible();
    await input.focus();
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Workspaces" })).toBeHidden();
});

test("run configuration tabs show only the selected section", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await openWorkspace(page, "Run configuration");

    const tabs = page.getByRole("tablist", { name: "Run manifest sections" });
    const overview = tabs.getByRole("tab", { name: "Overview" });
    const clock = tabs.getByRole("tab", { name: "Clock" });
    const nameField = page.getByRole("textbox", { name: "Name" });
    const stepField = page.getByRole("spinbutton", { name: "Step (nanoseconds)" });

    await expect(overview).toHaveAttribute("aria-selected", "true");
    await expect(nameField).toBeVisible();
    await expect(stepField).toBeHidden();

    await clock.click();
    await expect(clock).toHaveAttribute("aria-selected", "true");
    await expect(nameField).toBeHidden();
    await expect(stepField).toBeVisible();
});

test("phone widths show the deliberate desktop requirement", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Desktop workspace required" })).toBeVisible();
});

test("@a11y workspace switcher has no serious violations", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/");
    await page.keyboard.press("Escape");
    const results = await new AxeBuilder({ page })
        .include(".sf-workspace-menu")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
});

test("@a11y every workspace has no serious violations", async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto("/");

    const failures = [];
    const workspaces = [
        { name: "Simulation" },
        { name: "Environment editor", open: "Environment editor" },
        { name: "Run configuration", open: "Run configuration" },
        { name: "Vehicle editor", open: "Vehicle editor" },
        { name: "Scenarios", open: "Scenarios" },
        { name: "Experiment suite", open: "Experiment suite" },
        { name: "Scripting canvas", open: "Scripting canvas" },
        { name: "Bindings", open: "Bindings" },
        { name: "Replay", open: "Replay" },
        { name: "Analysis", open: "Analysis" },
    ];

    for (const workspace of workspaces) {
        if (workspace.open) await openWorkspace(page, workspace.open);
        const results = await new AxeBuilder({ page })
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
        for (const violation of results.violations) {
            if (!["critical", "serious"].includes(violation.impact)) continue;
            failures.push({
                workspace: workspace.name,
                id: violation.id,
                impact: violation.impact,
                targets: violation.nodes.slice(0, 5).map((node) => node.target),
            });
        }
    }

    expect(failures).toEqual([]);
});
