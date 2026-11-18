import { promises as fs } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { createDefaultRunManifest } from "../../app/simulation/RunManifest.js";
import { createDefaultVehicleManifest } from "../../app/vehicles/VehicleManifest.js";
import { verifyRunTemplatePackage } from "../../server/marketplace/RunTemplatePackage.js";

async function openWorkspace(page, name) {
    await page.getByRole("button", { name: "Open workspace switcher" }).first().evaluate((button) => button.click());
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: new RegExp(`^${name}`, "i") }).click();
}

async function removeFixture(request, route) {
    const current = await (await request.get(`/api/storage/${route}`)).json();
    if (!current) return;
    const removed = await request.delete(`/api/storage/${route}?expectedRevision=${current.revision}`);
    expect(removed.ok(), await removed.text()).toBeTruthy();
}

test("MKT-17 exports a draft, imports its tar without a registry, and opens the restored run", async ({ page, request }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    const suffix = Date.now().toString(36);
    const runId = `file-run-${suffix}`;
    const environmentId = `file-yard-${suffix}`;
    const vehicleId = `file-rover-${suffix}`;
    const name = `Shared file ${suffix}`;
    const modelBytes = Buffer.from("portable vehicle asset");
    let importId;
    try {
        let sources = await (await request.get("/api/marketplace/sources")).json();
        for (const source of sources.sources) {
            const removed = await request.delete(`/api/marketplace/sources/${source.sourceId}?expectedRevision=${sources.revision}`);
            expect(removed.ok(), await removed.text()).toBeTruthy();
            sources = await removed.json();
        }
        const installedBefore = await (await request.get("/api/marketplace/installed")).json();
        const env = await request.post("/api/storage/environments", { data: { id: environmentId, name: "Shared yard", supportedEditorSourceVersions: [1] } });
        expect(env.ok(), await env.text()).toBeTruthy();
        const vehicle = await request.post("/api/storage/vehicles", { data: createDefaultVehicleManifest({ id: vehicleId }) });
        expect(vehicle.ok(), await vehicle.text()).toBeTruthy();
        const asset = await request.put(`/api/storage/vehicle-assets/${vehicleId}/extra.bin`, { data: modelBytes, headers: { "Content-Type": "application/octet-stream" } });
        expect(asset.ok(), await asset.text()).toBeTruthy();
        const base = createDefaultRunManifest({ id: runId, name, environment: { id: environmentId, expectedHash: null } });
        const created = await request.post("/api/storage/run-manifests", { data: { ...base, initialState: { ...base.initialState, vehicles: base.initialState.vehicles.map((entry) => ({ ...entry, type: vehicleId })) } } });
        expect(created.ok(), await created.text()).toBeTruthy();

        await page.goto("/");
        await openWorkspace(page, "Run configuration");
        await page.getByRole("button", { name: new RegExp(`${name}.*${runId}`) }).click();
        await page.locator("#simple-field-name").fill(`${name} restored`);
        const downloading = page.waitForEvent("download");
        await page.getByRole("button", { name: "Export template", exact: true }).filter({ visible: true }).click();
        const download = await downloading;
        expect(download.suggestedFilename()).toBe(`${runId}.run-template.tar`);
        const file = await download.path();
        const bytes = await fs.readFile(file);
        const verified = await verifyRunTemplatePackage(bytes);
        expect(verified.manifest.version).toBe(2);
        expect(verified.root.name).toBe(`${name} restored`);
        await verified.cleanup();
        for (const route of [`run-manifests/${runId}`, `vehicles/${vehicleId}`, `environments/${environmentId}`]) {
            await removeFixture(request, route);
        }

        await openWorkspace(page, "Marketplace");
        await page.getByRole("tab", { name: "Library" }).click();
        await page.getByRole("button", { name: "Import package", exact: true }).first().click();
        const dialog = page.getByRole("dialog", { name: "Import package" });
        await expect(dialog.getByText("Unverified file", { exact: true })).toBeVisible();
        await dialog.getByLabel("Run-template tar").setInputFiles({ name: download.suggestedFilename(), mimeType: "application/x-tar", buffer: bytes });
        await expect(dialog.getByRole("button", { name: "Import", exact: true })).toBeEnabled();
        await expect(dialog.getByText(`${runId} → ${runId}`, { exact: true })).toBeVisible();
        const planned = await (await request.get("/api/marketplace/local-imports")).json();
        importId = planned.entries.find((entry) => entry.name === `${name} restored`).importId;
        expect(await (await request.get(`/api/storage/run-manifests/${runId}`)).json()).toBeNull();
        const axe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
        expect(axe.violations).toEqual([]);
        await page.setViewportSize({ width: 800, height: 720 });
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBeTruthy();
        await dialog.getByRole("button", { name: "Import", exact: true }).click();
        await expect(dialog.getByText("Import complete", { exact: true })).toBeVisible({ timeout: 30_000 });
        await dialog.getByRole("button", { name: "Open in Run Configuration" }).click();
        await expect(page.locator("#simple-field-name")).toHaveValue(`${name} restored`);
        const restored = await (await request.get(`/api/storage/run-manifests/${runId}`)).json();
        expect(restored.scripts.bindingSource).toBe("embedded");
        expect(restored.initialState.vehicles[0].type).toBe(vehicleId);
        expect(await (await request.get(`/api/storage/vehicle-assets/${vehicleId}/extra.bin`)).body()).toEqual(modelBytes);
        expect((await (await request.get("/api/marketplace/sources")).json()).sources).toEqual([]);
        expect(await (await request.get("/api/marketplace/installed")).json()).toEqual(installedBefore);
        const repeated = await request.post("/api/marketplace/local-imports", { data: bytes, headers: { "Content-Type": "application/vnd.cev-sim.run-template-package+tar" } });
        expect(repeated.ok(), await repeated.text()).toBeTruthy();
        expect((await repeated.json()).phase).toBe("complete");
        expect((await (await request.get(`/api/storage/run-manifests/${runId}`)).json()).revision).toBe(restored.revision);
    } finally {
        for (const route of [`run-manifests/${runId}`, `vehicles/${vehicleId}`, `environments/${environmentId}`]) await removeFixture(request, route).catch(() => {});
        if (importId) await fs.rm(path.resolve(process.env.CEV_SIM_DATA_DIR ?? ".playwright-data/storage", "marketplace/local-imports", importId), { recursive: true, force: true });
    }
});
