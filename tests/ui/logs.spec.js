import { expect, test } from "@playwright/test";

async function openWorkspace(page, label) {
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    if (await opener.isVisible()) await opener.click();
    else {
        await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
        await page.keyboard.press("Escape");
    }
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${label}`, "i") }).click();
    // Opening a pre-v10 manifest via deep link marks Config dirty for migration; discard when switching away.
    const discard = page.getByRole("button", { name: "Discard and switch" });
    if (await discard.isVisible()) await discard.click();
}

test("logs workspace files, renames, shows size, and deletes a recording", async ({ page, request }) => {
    test.setTimeout(90_000);
    const suffix = Date.now().toString(36);
    const logName = `PW log ${suffix}`;
    const renamed = `PW renamed ${suffix}`;
    const folderName = `PW folder ${suffix}`;
    let logId = null;
    let originalCatalog = null;

    try {
        const catalogResponse = await request.get("/api/logs/catalog");
        expect(catalogResponse.ok()).toBeTruthy();
        originalCatalog = await catalogResponse.json();

        const created = await request.post("/api/logs/sessions", { data: { name: logName } });
        expect(created.ok(), await created.text()).toBeTruthy();
        const session = await created.json();
        logId = session.id || session.metadata?.id;
        expect(logId).toBeTruthy();
        const finalized = await request.post(`/api/logs/sessions/${encodeURIComponent(logId)}/finalize`, { data: {} });
        expect(finalized.ok(), await finalized.text()).toBeTruthy();

        await page.goto("/");
        await openWorkspace(page, "Logs");
        await expect(page.getByRole("button", { name: "Open workspace switcher" })).toContainText("Logs");
        const row = page.locator(`[data-log-id="${logId}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });
        await expect(row).toContainText(/B|KiB|MiB/);
        await row.click();

        const nameField = page.getByRole("textbox", { name: "Log name" });
        await expect(nameField).toHaveValue(logName);
        await nameField.fill(renamed);
        await nameField.blur();
        await expect(row.getByText(renamed)).toBeVisible();

        await page.getByRole("button", { name: "Create log folder" }).click();
        await page.getByRole("textbox", { name: "Folder name" }).fill(folderName);
        await page.getByRole("button", { name: "Add" }).click();
        await expect(page.getByRole("button", { name: folderName, exact: true })).toBeVisible();
        await page.getByRole("combobox", { name: "Log folder" }).selectOption({ label: folderName });
        await expect(row.getByText(new RegExp(`${folderName} ·`))).toBeVisible();

        await page.getByRole("region", { name: "Recording details" }).getByRole("button", { name: "Delete" }).click();
        await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
        await expect(page.locator(`[data-log-id="${logId}"]`)).toHaveCount(0);
        logId = null;
    } finally {
        if (logId) await request.delete(`/api/logs/${encodeURIComponent(logId)}`);
        if (originalCatalog) {
            const latestResponse = await request.get("/api/logs/catalog");
            if (latestResponse.ok()) {
                const latest = await latestResponse.json();
                await request.put("/api/logs/catalog", {
                    data: { catalog: originalCatalog, expectedRevision: latest.revision },
                });
            }
        }
    }
});

test("logs evidence search and provenance deep links open manifest, result, case, and baseline", async ({ page, request }) => {
    test.setTimeout(180_000);
    const suffix = Date.now().toString(36);
    const logName = `PW evidence ${suffix}`;
    const suiteId = `pw-log-suite-${suffix}`;
    const resultId = `pw-log-result-${suffix}`;
    const baselineId = `pw-log-baseline-${suffix}`;
    const scenarioId = `pw-log-scenario-${suffix}`;
    const caseId = `pw-log-case-${suffix}`;
    const modelId = `planner-${suffix}`;
    const now = new Date().toISOString();
    let logId = null;

    const manifestResponse = await request.get("/api/storage/run-manifests");
    expect(manifestResponse.ok()).toBeTruthy();
    const manifestList = await manifestResponse.json();
    const manifest = (Array.isArray(manifestList) ? manifestList : manifestList.manifests || [])[0];
    expect(manifest?.id).toBeTruthy();

    const metrics = [
        { id: "passed", name: "Passed", source: { kind: "builtin", metric: "passed" }, direction: "higher", tolerance: { absolute: 0, relative: 0 }, gated: true },
    ];
    const caseEvidence = {
        id: caseId,
        scenarioId,
        manifestId: manifest.id,
        seed: "17",
        parameters: {},
        status: "completed",
        completed: true,
        passed: true,
        metrics: { passed: 1 },
        dependencyHashes: {},
        resolvedHash: "r".repeat(64),
        logId: null,
        startedAt: now,
        finishedAt: now,
    };

    try {
        await request.post("/api/storage/scenarios", {
            data: {
                kind: "cev-sim.scenario",
                version: 1,
                id: scenarioId,
                name: `Log evidence scenario ${suffix}`,
                environment: { id: "igvc", expectedHash: null },
                actors: [{ id: "ego", name: "Ego", role: "ego", vehicleId: null, enabled: true }],
                routes: [],
                zones: [],
                triggers: [],
                completion: { conditions: [] },
                expectedOutcomes: [],
                sensorAliases: [],
                parameters: [],
            },
        });
        await request.post("/api/storage/experiment-suites", {
            data: {
                kind: "cev-sim.experiment-suite",
                version: 1,
                id: suiteId,
                name: `Log evidence suite ${suffix}`,
                scenarioIds: [scenarioId],
                manifestIds: [manifest.id],
                exclusions: [],
                seeds: ["17"],
                sweeps: [],
                metrics,
                execution: { failurePolicy: "continue" },
            },
        });
        await request.post("/api/storage/experiment-results", {
            data: {
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
            },
        });
        await request.post("/api/storage/experiment-baselines", {
            data: {
                kind: "cev-sim.experiment-baseline",
                version: 1,
                id: baselineId,
                name: `Log evidence baseline ${suffix}`,
                suiteId,
                sourceResultId: resultId,
                createdAt: now,
                metricDefinitions: metrics,
                cases: [caseEvidence],
                provenance: { appVersion: "playwright" },
            },
        });

        const created = await request.post("/api/logs/sessions", {
            data: {
                name: logName,
                runId: `run-${suffix}`,
                manifestId: manifest.id,
                definitionHash: "d".repeat(64),
                resolvedHash: "r".repeat(64),
                evidence: {
                    kind: "cev-sim.log-evidence",
                    version: 1,
                    manifestId: manifest.id,
                    runId: `run-${suffix}`,
                    definitionHash: "d".repeat(64),
                    resolvedHash: "r".repeat(64),
                    simulationSemanticHash: "s".repeat(64),
                    episodeHash: "e".repeat(64),
                    trajectoryHash: "t".repeat(64),
                    worldHash: "w".repeat(64),
                    calibrationHash: "c".repeat(64),
                    suiteId,
                    resultId,
                    caseId,
                    gitCommit: "g".repeat(40),
                    candidateModels: [{
                        role: "planning",
                        modelId,
                        version: "1.0.0",
                        digest: "a".repeat(64),
                    }],
                },
            },
        });
        expect(created.ok(), await created.text()).toBeTruthy();
        const session = await created.json();
        logId = session.id || session.metadata?.id;
        const finalized = await request.post(`/api/logs/sessions/${encodeURIComponent(logId)}/finalize`, { data: {} });
        expect(finalized.ok(), await finalized.text()).toBeTruthy();
        const patched = await request.patch(`/api/logs/${encodeURIComponent(logId)}`, {
            data: {
                evidence: {
                    suiteId,
                    resultId,
                    caseId,
                },
            },
        });
        expect(patched.ok(), await patched.text()).toBeTruthy();

        await page.goto("/");
        await openWorkspace(page, "Logs");
        const row = page.locator(`[data-log-id="${logId}"]`);
        await expect(row).toBeVisible({ timeout: 30_000 });

        const metadata = await request.get(`/api/logs/${encodeURIComponent(logId)}/metadata`);
        expect(metadata.ok()).toBeTruthy();
        const metaBody = await metadata.json();
        expect(metaBody.evidence?.resultId, JSON.stringify(metaBody.evidence)).toBe(resultId);
        expect(metaBody.evidence?.candidateModels?.[0]?.modelId).toBe(modelId);

        await page.getByPlaceholder("Search recordings").fill(logName);
        await expect(row).toBeVisible();
        await page.getByPlaceholder("Search recordings").fill(resultId);
        await expect(row).toBeVisible({ timeout: 10_000 });
        await page.getByPlaceholder("Search recordings").fill(modelId);
        await expect(row).toBeVisible();
        await page.getByPlaceholder("Search recordings").fill("");
        await row.click();

        const inspector = page.getByRole("region", { name: "Recording details" });
        await expect(inspector.getByText("Run identity")).toBeVisible();
        await expect(inspector.getByText("Experiment lineage")).toBeVisible();
        await expect(inspector.getByText(new RegExp(modelId))).toBeVisible();

        await inspector.getByRole("button", { name: "Manifest" }).click();
        await expect(page.getByRole("button", { name: "Open workspace switcher" })).toContainText(/Run Configuration|Config/i);

        await openWorkspace(page, "Logs");
        await page.locator(`[data-log-id="${logId}"]`).click();
        await page.getByRole("region", { name: "Recording details" }).getByRole("button", { name: "Result" }).click();
        await expect(page.getByRole("tab", { name: "Review" })).toHaveAttribute("data-state", "active");
        await expect(page.getByRole("combobox", { name: "Experiment result" })).toHaveValue(resultId);

        await openWorkspace(page, "Logs");
        await page.locator(`[data-log-id="${logId}"]`).click();
        await page.getByRole("region", { name: "Recording details" }).getByRole("button", { name: "Case" }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "Close" }).click();

        await openWorkspace(page, "Logs");
        await page.locator(`[data-log-id="${logId}"]`).click();
        await page.getByRole("region", { name: "Recording details" }).getByRole("button", { name: "Baseline" }).click();
        await expect(page.getByRole("tab", { name: "Compare" })).toHaveAttribute("data-state", "active");
        await expect(page.getByRole("combobox", { name: "Saved baseline" })).toHaveValue(baselineId);

        await openWorkspace(page, "Logs");
        await page.locator(`[data-log-id="${logId}"]`).click();
        await page.getByRole("region", { name: "Recording details" }).getByRole("button", { name: "Replay" }).click();
        await expect(page.getByRole("combobox", { name: "Replay log" })).toBeVisible();

        await openWorkspace(page, "Logs");
        await page.locator(`[data-log-id="${logId}"]`).click();
        await page.getByRole("region", { name: "Recording details" }).getByRole("button", { name: "Analyze" }).click();
        await expect(page.getByRole("combobox", { name: "Telemetry source" })).toBeVisible();
    } finally {
        if (logId) await request.delete(`/api/logs/${encodeURIComponent(logId)}`);
        await request.delete(`/api/storage/experiment-baselines/${baselineId}`);
        await request.delete(`/api/storage/experiment-results/${resultId}`);
        await request.delete(`/api/storage/experiment-suites/${suiteId}`);
        await request.delete(`/api/storage/scenarios/${scenarioId}`);
    }
});
