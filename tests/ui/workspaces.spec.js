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
    await expect(dialog.getByRole("button")).toHaveCount(13);
    await expect(dialog.getByRole("button", { name: /^Run configuration/i })).toBeVisible();

    const activeWorkspace = dialog.getByRole("button", { name: /^Simulation/ });
    await expect(activeWorkspace).toHaveAttribute("data-active", "true");
    await expect(activeWorkspace).toHaveCSS("background-color", "rgb(33, 35, 37)");
    await activeWorkspace.hover();
    await expect(activeWorkspace).toHaveAttribute("data-active", "true");
    await expect(activeWorkspace).toHaveCSS("background-color", "rgb(33, 35, 37)");

    for (const label of ["Environment editor", "Run configuration", "Scenarios", "Experiment suite", "Headless runs", "Vehicle editor", "Scripting canvas", "Bindings", "Replay", "Logs", "Analysis"]) {
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

test("scenario, experiment, and run configuration restore the last open document after switching workspaces", async ({ page, request }) => {
    test.setTimeout(180_000);
    const suffix = Date.now().toString(36);
    const scenarioId = `pw-last-open-scenario-${suffix}`;
    const scenarioName = `Last-open scenario ${suffix}`;
    const suiteId = `pw-last-open-suite-${suffix}`;
    const suiteName = `Last-open suite ${suffix}`;
    const manifestId = `pw-last-open-run-${suffix}`;
    const manifestName = `Last-open run ${suffix}`;

    async function postJson(path, body) {
        const response = await request.post(path, { data: body });
        expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
        return response.json();
    }

    const manifestResponse = await request.get("/api/storage/run-manifests");
    expect(manifestResponse.ok()).toBeTruthy();
    const manifestList = await manifestResponse.json();
    const sourceManifest = (Array.isArray(manifestList) ? manifestList : manifestList.manifests || [])[0];
    expect(sourceManifest?.id).toBeTruthy();

    try {
        await postJson("/api/storage/scenarios", {
            kind: "cev-sim.scenario",
            version: 1,
            id: scenarioId,
            name: scenarioName,
            description: "Last-open workspace restoration fixture.",
            environment: { id: "igvc", expectedHash: null },
            actors: [{ id: "ego", name: "Ego", role: "ego", vehicleId: null, enabled: true }],
            routes: [],
            zones: [],
            triggers: [],
            completion: { conditions: [] },
            expectedOutcomes: [],
            sensorAliases: [],
            parameters: [],
        });
        await postJson(`/api/storage/run-manifests/${sourceManifest.id}/duplicate`, {
            id: manifestId,
            name: manifestName,
        });
        await postJson("/api/storage/experiment-suites", {
            kind: "cev-sim.experiment-suite",
            version: 1,
            id: suiteId,
            name: suiteName,
            description: "Last-open workspace restoration fixture.",
            scenarioIds: [scenarioId],
            manifestIds: [manifestId],
            exclusions: [],
            seeds: ["42"],
            sweeps: [],
            metrics: [
                { id: "passed", source: { kind: "builtin", metric: "passed" } },
                { id: "duration", source: { kind: "builtin", metric: "duration" } },
            ],
            execution: { failurePolicy: "continue" },
        });

        await page.goto("/");

        await openWorkspace(page, "Scenarios");
        const scenarioRow = page.locator(`[data-scenario-id="${scenarioId}"]`).getByRole("button");
        await expect(scenarioRow).toBeVisible({ timeout: 30_000 });
        await scenarioRow.click();
        await expect(scenarioRow).toHaveAttribute("aria-current", "page");
        await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.lastOpen.scenarios")).toBe(scenarioId);
        await openWorkspace(page, "Simulation");
        await openWorkspace(page, "Scenarios");
        await expect(page.locator(`[data-scenario-id="${scenarioId}"]`).getByRole("button")).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("button", { name: "Open workspace switcher" })).toContainText(scenarioName);

        await openWorkspace(page, "Experiment suite");
        const suiteButton = page.getByRole("navigation", { name: "Experiment suites" }).getByRole("button", { name: new RegExp(suiteName) });
        await expect(suiteButton).toBeVisible({ timeout: 60_000 });
        await suiteButton.click();
        await expect(suiteButton).toHaveAttribute("aria-current", "page");
        await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.lastOpen.experiment-suite")).toBe(suiteId);
        await openWorkspace(page, "Simulation");
        await openWorkspace(page, "Experiment suite");
        await expect(page.getByRole("navigation", { name: "Experiment suites" }).getByRole("button", { name: new RegExp(suiteName) })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("button", { name: "Open workspace switcher" })).toContainText(suiteName);

        await openWorkspace(page, "Run configuration");
        const manifestButton = page.getByRole("button", { name: new RegExp(`${manifestName}[\\s\\S]*${manifestId}`) });
        await expect(manifestButton).toBeVisible({ timeout: 30_000 });
        await manifestButton.click();
        await expect(manifestButton).toHaveAttribute("aria-current", "page");
        await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), "cev-sim.ui.lastOpen.run-config")).toBe(manifestId);
        await openWorkspace(page, "Simulation");
        await openWorkspace(page, "Run configuration");
        await expect(page.getByRole("button", { name: new RegExp(`${manifestName}[\\s\\S]*${manifestId}`) })).toHaveAttribute("aria-current", "page");
        await expect(page.getByRole("heading", { name: manifestName })).toBeVisible();
    } finally {
        await request.delete(`/api/storage/experiment-suites/${suiteId}`);
        await request.delete(`/api/storage/scenarios/${scenarioId}`);
        await request.delete(`/api/storage/run-manifests/${manifestId}`);
    }
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
        { name: "Logs", open: "Logs" },
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
