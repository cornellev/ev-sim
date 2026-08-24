import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

async function openWorkspace(page, label) {
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    if (await opener.isVisible()) await opener.click();
    else await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
}

function slug(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

async function roadPoints(map) {
    return map.evaluate((svg) => {
        const line = svg.querySelector("[data-map-layer='roads'] line");
        const matrix = svg.getScreenCTM();
        if (!line || !matrix) throw new Error("The route map has no screen-space road geometry.");
        const x1 = Number(line.getAttribute("x1"));
        const y1 = Number(line.getAttribute("y1"));
        const x2 = Number(line.getAttribute("x2"));
        const y2 = Number(line.getAttribute("y2"));
        const screenPoint = (fraction) => {
            const point = svg.createSVGPoint();
            point.x = x1 + ((x2 - x1) * fraction);
            point.y = y1 + ((y2 - y1) * fraction);
            const screen = point.matrixTransform(matrix);
            return { x: screen.x, y: screen.y };
        };
        return [screenPoint(0.25), screenPoint(0.5), screenPoint(0.75)];
    });
}

async function postJson(request, path, body) {
    const response = await request.post(path, { data: body });
    expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
    return response.json();
}

async function putJson(request, path, body) {
    const response = await request.put(path, { data: body });
    expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBeTruthy();
    return response.json();
}

test("scenario library drags scenarios between folders", async ({ page, request }) => {
    const suffix = Date.now().toString(36);
    const scenarioId = `pw-drag-scenario-${suffix}`;
    const sourceFolderId = `pw-drag-source-${suffix}`;
    const targetFolderId = `pw-drag-target-${suffix}`;
    let originalCatalog = null;

    try {
        const catalogResponse = await request.get("/api/storage/scenario-catalog");
        expect(catalogResponse.ok()).toBeTruthy();
        originalCatalog = await catalogResponse.json();
        await putJson(request, "/api/storage/scenario-catalog", {
            catalog: {
                ...originalCatalog,
                folders: [
                    ...originalCatalog.folders,
                    { id: sourceFolderId, name: `Drag source ${suffix}` },
                    { id: targetFolderId, name: `Drag target ${suffix}` },
                ],
            },
            expectedRevision: originalCatalog.revision,
        });
        await postJson(request, "/api/storage/scenarios", {
            kind: "cev-sim.scenario",
            version: 1,
            id: scenarioId,
            name: `Drag scenario ${suffix}`,
            description: "Scenario library drag-and-drop fixture.",
            folderId: sourceFolderId,
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

        await page.goto("/");
        await openWorkspace(page, "Scenarios");
        const scenario = page.locator(`[data-scenario-id="${scenarioId}"]`);
        const targetFolder = page.locator(`[data-folder-id="${targetFolderId}"]`);
        const unfiled = page.locator('[data-folder-id="__unfiled__"]');
        await expect(scenario).toBeVisible();

        await scenario.dragTo(targetFolder);
        await expect(targetFolder.locator(`[data-scenario-id="${scenarioId}"]`)).toBeVisible();
        let storedResponse = await request.get(`/api/storage/scenarios/${scenarioId}`);
        expect(storedResponse.ok()).toBeTruthy();
        expect((await storedResponse.json()).folderId).toBe(targetFolderId);

        await page.locator(`[data-scenario-id="${scenarioId}"]`).dragTo(unfiled);
        await expect(unfiled.locator(`[data-scenario-id="${scenarioId}"]`)).toBeVisible();
        storedResponse = await request.get(`/api/storage/scenarios/${scenarioId}`);
        expect(storedResponse.ok()).toBeTruthy();
        expect((await storedResponse.json()).folderId).toBeNull();
    } finally {
        await request.delete(`/api/storage/scenarios/${scenarioId}`);
        if (originalCatalog) {
            const currentResponse = await request.get("/api/storage/scenario-catalog");
            if (currentResponse.ok()) {
                const current = await currentResponse.json();
                await putJson(request, "/api/storage/scenario-catalog", {
                    catalog: originalCatalog,
                    expectedRevision: current.revision,
                });
            }
        }
    }
});

test("scenario authoring rejects off-road points, supports keyboard editing, and validates a zone finish", async ({ page, request }) => {
    test.setTimeout(240_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const name = `Playwright route ${Date.now()}`;
    const scenarioId = slug(name);

    try {
        await page.goto("/");
        await openWorkspace(page, "Scenarios");
        await page.getByRole("button", { name: "New" }).click();
        await page.getByRole("textbox", { name: "Scenario name" }).fill(name);
        await page.getByRole("textbox", { name: "Description" }).fill("Browser-authored deterministic finish-zone scenario.");
        await page.getByRole("button", { name: "Create scenario", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Routes" })).toBeVisible();
        await expect(page.getByRole("tab", { name: "Route editor" })).toHaveCount(0);
        await page.getByRole("button", { name: "Edit route" }).click();

        const map = page.getByRole("img", { name: /^Road map for placing/i });
        await expect(map).toBeVisible();
        const routeViewport = map.locator("..");
        const initialZoom = await routeViewport.getAttribute("data-map-zoom");
        await routeViewport.getByRole("button", { name: "Zoom in" }).click();
        await expect(routeViewport).not.toHaveAttribute("data-map-zoom", initialZoom);
        const bounds = await map.boundingBox();
        expect(bounds).not.toBeNull();
        const initialCenter = await routeViewport.getAttribute("data-map-center");
        await page.mouse.move(bounds.x + (bounds.width * 0.55), bounds.y + (bounds.height * 0.7));
        await page.mouse.down();
        await page.mouse.move(bounds.x + (bounds.width * 0.65), bounds.y + (bounds.height * 0.75));
        await page.mouse.up();
        await expect(routeViewport).not.toHaveAttribute("data-map-center", initialCenter);
        await page.mouse.click(bounds.x + 5, bounds.y + 5);
        await expect(page.getByText("Waypoints must sit on a road or intersection.")).toBeVisible();

        const [start, middle, finish] = await roadPoints(map);
        await page.mouse.click(start.x, start.y);
        await expect(map.getByRole("button", { name: "start S" })).toHaveCount(1);
        const transitionDuration = await map.getByRole("button", { name: "start S" }).locator("circle").evaluate(
            (element) => getComputedStyle(element).transitionDuration,
        );
        expect(transitionDuration).toBe("0s");

        await page.getByRole("button", { name: "Waypoint", exact: true }).click();
        await page.mouse.click(middle.x, middle.y);
        await expect(map.getByRole("button", { name: "intermediate 1" })).toHaveCount(1);
        await page.keyboard.press("Delete");
        await expect(map.getByRole("button", { name: "intermediate 1" })).toHaveCount(0);

        await page.getByRole("button", { name: "Finish", exact: true }).click();
        await page.mouse.click(finish.x, finish.y);
        await page.getByRole("button", { name: "Verify" }).click();
        await expect(page.getByText("Route verified against the directed road graph")).toBeVisible();
        await expect(page.getByRole("button", { name: /Continue/ })).toBeEnabled();
        await page.getByRole("button", { name: /Continue/ }).click();
        await expect(page.getByRole("heading", { name: "Routes" })).toBeVisible();
        await page.getByRole("button", { name: "Edit route" }).click();
        await expect(map).toBeVisible();
        await page.getByRole("button", { name: "Back to routes" }).click();

        await page.getByRole("button", { name: "Validate" }).click();
        await expect(page.getByText(/before this scenario can run/)).toBeVisible();
        await page.getByRole("button", { name: "Dismiss issues" }).click();
        await expect(page.getByText(/before this scenario can run/)).toHaveCount(0);

        await page.getByRole("tab", { name: "Zones & triggers" }).click();
        const zoneMap = page.getByRole("img", { name: /Scenario zone map/i });
        await expect(zoneMap.locator("[data-map-layer='roads'] line").first()).toBeVisible();
        const zoneViewport = zoneMap.locator("..");
        const zoneInitialZoom = await zoneViewport.getAttribute("data-map-zoom");
        await zoneViewport.getByRole("button", { name: "Zoom out" }).click();
        await expect(zoneViewport).not.toHaveAttribute("data-map-zoom", zoneInitialZoom);
        const mapInteraction = page.getByLabel("Map interaction");
        await mapInteraction.getByText("Pan", { exact: true }).click();
        const zoneBounds = await zoneMap.boundingBox();
        expect(zoneBounds).not.toBeNull();
        const zoneInitialCenter = await zoneViewport.getAttribute("data-map-center");
        await page.mouse.move(zoneBounds.x + (zoneBounds.width * 0.55), zoneBounds.y + (zoneBounds.height * 0.65));
        await page.mouse.down();
        await page.mouse.move(zoneBounds.x + (zoneBounds.width * 0.65), zoneBounds.y + (zoneBounds.height * 0.72));
        await page.mouse.up();
        await expect(zoneViewport).not.toHaveAttribute("data-map-center", zoneInitialCenter);
        await mapInteraction.getByText("Draw zone", { exact: true }).click();
        await page.mouse.move(zoneBounds.x + (zoneBounds.width * 0.25), zoneBounds.y + (zoneBounds.height * 0.3));
        await page.mouse.down();
        await page.mouse.move(zoneBounds.x + (zoneBounds.width * 0.45), zoneBounds.y + (zoneBounds.height * 0.5));
        await page.mouse.up();
        await expect(page.getByText("Zone 1", { exact: true }).first()).toBeVisible();
        const zoneInspector = page.getByRole("complementary", { name: "Zone inspector" });
        await expect(zoneInspector.getByText("Zone 1", { exact: true })).toBeVisible();
        await expect(zoneInspector.getByRole("button", { name: "Delete Zone 1" })).toBeVisible();
        const compactMapHeight = (await zoneMap.boundingBox()).height;
        await page.getByRole("button", { name: "Expand zone map" }).click();
        await expect(page.locator("[data-zone-map-fullscreen='true']")).toBeVisible();
        expect((await zoneMap.boundingBox()).height).toBeGreaterThan(compactMapHeight);
        await zoneInspector.getByRole("button", { name: "Details" }).click();
        await expect(page.locator("[data-zone-map-fullscreen='true']")).toHaveCount(0);
        await expect(page.getByLabel("Zone view").getByText("Cards", { exact: true })).toHaveAttribute("aria-checked", "true");

        await page.getByRole("button", { name: /Add trigger/i }).click();
        await page.getByRole("combobox", { name: "Trigger condition" }).selectOption("zone-enter");
        await page.getByRole("combobox", { name: "Zone", exact: true }).selectOption("zone-1");
        const nickname = page.getByRole("textbox", { name: "Trigger 1 nickname" });
        await nickname.focus();
        await expect(nickname).toBeFocused();
        await nickname.fill("Finish gate entered");

        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByText("Scenario saved")).toBeVisible();
        await page.getByRole("button", { name: "Validate" }).click();
        await expect(page.getByText("Scenario is valid")).toBeVisible();

        const axe = await new AxeBuilder({ page })
            .include(".sf-workspace")
            .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
            .analyze();
        expect(axe.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
    } finally {
        await request.delete(`/api/storage/scenarios/${scenarioId}`);
    }
});

test("experiment matrix, baseline comparison, and Replay/Analysis handoff use persisted evidence", async ({ page, request }) => {
    test.setTimeout(240_000);
    const suffix = Date.now().toString(36);
    const scenarioId = `pw-scenario-${suffix}`;
    const suiteId = `pw-suite-${suffix}`;
    const resultId = `pw-result-${suffix}`;
    const baselineId = `pw-baseline-${suffix}`;
    const suiteName = `Playwright suite ${suffix}`;
    const now = new Date().toISOString();

    const manifestResponse = await request.get("/api/storage/run-manifests");
    expect(manifestResponse.ok()).toBeTruthy();
    const manifestList = await manifestResponse.json();
    const manifest = (Array.isArray(manifestList) ? manifestList : manifestList.manifests || [])[0];
    expect(manifest?.id).toBeTruthy();

    const metrics = [
        { id: "passed", name: "Passed", source: { kind: "builtin", metric: "passed" }, direction: "higher", tolerance: { absolute: 0, relative: 0 }, gated: true },
        { id: "duration", name: "Duration", source: { kind: "builtin", metric: "duration" }, unit: "s", direction: "lower", tolerance: { absolute: 0, relative: 0 }, gated: true },
    ];
    const caseEvidence = {
        id: `case-${suffix}`,
        scenarioId,
        manifestId: manifest.id,
        seed: "17",
        parameters: {},
        status: "completed",
        completed: true,
        passed: true,
        terminationReason: "trigger:finish-gate",
        latestTrigger: { id: "finish-gate", name: "Finish gate" },
        terminalEvent: { kind: "trigger", id: "finish-gate" },
        assertions: [{ id: "lane", name: "Stay in lane", status: "passed", severity: "error" }],
        outcomes: [{ id: "finish", name: "Finish reached", passed: true, status: "passed" }],
        metrics: { passed: 1, duration: 4.2 },
        dependencyHashes: { scenario: "scenario-hash", manifest: "manifest-hash" },
        resolvedHash: "resolved-hash",
        logId: "playwright-log",
        startedAt: now,
        finishedAt: now,
    };

    try {
        await postJson(request, "/api/storage/scenarios", {
            kind: "cev-sim.scenario",
            version: 1,
            id: scenarioId,
            name: `Fixture scenario ${suffix}`,
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
        await postJson(request, "/api/storage/experiment-suites", {
            kind: "cev-sim.experiment-suite",
            version: 1,
            id: suiteId,
            name: suiteName,
            description: "Evidence review fixture",
            scenarioIds: [scenarioId],
            manifestIds: [manifest.id],
            exclusions: [],
            seeds: ["17"],
            sweeps: [],
            metrics,
            execution: { failurePolicy: "continue" },
        });
        await postJson(request, "/api/storage/experiment-results", {
            kind: "cev-sim.experiment-result",
            version: 1,
            id: resultId,
            suiteId,
            status: "completed",
            createdAt: now,
            startedAt: now,
            finishedAt: now,
            metricDefinitions: metrics,
            cases: [caseEvidence],
        });
        await postJson(request, "/api/storage/experiment-baselines", {
            kind: "cev-sim.experiment-baseline",
            version: 1,
            id: baselineId,
            name: `Reference ${suffix}`,
            suiteId,
            sourceResultId: resultId,
            createdAt: now,
            metricDefinitions: metrics,
            cases: [caseEvidence],
            provenance: { appVersion: "playwright", gitCommit: "fixture", dependencies: { runtime: "fixture" } },
        });

        await page.goto("/");
        await openWorkspace(page, "Experiment suite");
        const catalog = page.getByRole("navigation", { name: "Experiment suites" });
        await catalog.getByRole("button", { name: new RegExp(suiteName, "i") }).click();
        await page.getByRole("textbox", { name: "Seeds" }).fill("17, 23");
        await expect(page.getByText("2 cases", { exact: true }).first()).toBeVisible();

        await page.getByRole("tab", { name: /Matrix/ }).click();
        const matrixCell = page.getByRole("button", { name: /2 cases/i });
        await expect(matrixCell).toBeVisible();
        await matrixCell.click();
        await expect(page.getByRole("button", { name: /Excluded/i })).toBeVisible();
        await page.getByRole("button", { name: /Excluded/i }).click();
        await expect(page.getByRole("button", { name: /2 cases/i })).toBeVisible();
        await page.getByRole("button", { name: "Save" }).click();
        await expect(page.getByText("Suite saved")).toBeVisible();

        await page.getByRole("tab", { name: "Run" }).click();
        const diagnostics = page.getByRole("button", { name: "3D diagnostics" });
        await diagnostics.click();
        await expect(diagnostics).toHaveAttribute("aria-pressed", "true");
        await expect(page.getByRole("region", { name: "Scenario diagnostics 3D viewport" })).toBeVisible({ timeout: 30_000 });
        await diagnostics.click();
        await expect(diagnostics).toHaveAttribute("aria-pressed", "false");

        await page.getByRole("tab", { name: "Compare" }).click();
        await page.getByRole("combobox", { name: "Current result" }).selectOption(resultId);
        await page.getByRole("combobox", { name: "Saved baseline" }).selectOption(baselineId);
        await expect(page.getByText("VERDICT")).toBeVisible();
        await expect(page.getByText("unchanged", { exact: true }).first()).toBeVisible();
        await expect(page.getByText("Dependency hashes")).toBeVisible();

        await page.getByRole("tab", { name: "Review" }).click();
        await page.getByRole("combobox", { name: "Experiment result" }).selectOption(resultId);
        await page.getByRole("button", { name: "Replay" }).click();
        await expect(page.getByRole("combobox", { name: "Replay log" })).toBeVisible();

        await openWorkspace(page, "Experiment suite");
        await catalog.getByRole("button", { name: new RegExp(suiteName, "i") }).click();
        await page.getByRole("tab", { name: "Review" }).click();
        await page.getByRole("combobox", { name: "Experiment result" }).selectOption(resultId);
        await page.getByRole("button", { name: "Analysis" }).click();
        await expect(page.getByRole("combobox", { name: "Telemetry source" })).toBeVisible();
    } finally {
        await request.delete(`/api/storage/experiment-baselines/${baselineId}`);
        await request.delete(`/api/storage/experiment-results/${resultId}`);
        await request.delete(`/api/storage/experiment-suites/${suiteId}`);
        await request.delete(`/api/storage/scenarios/${scenarioId}`);
    }
});
