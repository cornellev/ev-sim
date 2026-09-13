import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let fixtureDir;
let modelPath;
let bufferPath;
let modelName;

test.beforeAll(async () => {
    const storage = path.join(process.cwd(), ".playwright-data", "storage");
    await fs.mkdir(storage, { recursive: true });
    const operations = ["display", "transient-cache", "persistent-cache", "derivatives", "machine-interpretation", "ml", "worker-access", "export", "retention", "attribution", "live-preview-display"];
    await fs.writeFile(path.join(storage, "visual-source-registry.json"), `${JSON.stringify({
        kind: "cev-sim.visual-source-registry",
        version: 1,
        sources: [{
            id: "pw-editor-assets", kind: "owned", status: "active", ancestorIds: [],
            permissions: Object.fromEntries(operations.map((operation) => [operation, true])),
        }],
    }, null, 2)}\n`);
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed06-ui-"));
    modelName = `triangle-${Date.now().toString(36)}`;
    const model = {
        asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", max: [1, 1, 0], min: [0, 0, 0] },
            { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
        buffers: [{ byteLength: 42, uri: `${modelName}.bin` }],
    };
    const bytes = Buffer.alloc(42);
    bytes.writeFloatLE(1, 12);
    bytes.writeFloatLE(1, 28);
    bytes.writeUInt16LE(0, 36);
    bytes.writeUInt16LE(1, 38);
    bytes.writeUInt16LE(2, 40);
    modelPath = path.join(fixtureDir, `${modelName}.gltf`);
    bufferPath = path.join(fixtureDir, `${modelName}.bin`);
    await fs.writeFile(modelPath, JSON.stringify(model));
    await fs.writeFile(bufferPath, bytes);
});

test.afterAll(async () => {
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

async function activateBlank(request, name = "ED-06 assets") {
    const id = `pw-ed06-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    expect((await request.post("/api/storage/environments", { data: { id, name, templateId: "blank" } })).ok()).toBeTruthy();
    expect((await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: id } })).ok()).toBeTruthy();
    return id;
}

async function openEditor(page) {
    await page.goto("/");
    const opener = page.getByRole("button", { name: "Open workspace switcher" }).first();
    if (await opener.isVisible()) await opener.click();
    else await page.keyboard.press("Escape");
    const dialog = page.getByRole("dialog", { name: "Workspaces" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /^Environment editor/i }).click();
    await expect(page.locator("[data-editor-asset-library]")).toBeVisible({ timeout: 180_000 });
}

async function importModel(page, reimportName = null) {
    const library = page.locator("[data-editor-asset-library]");
    await expect(library.getByRole("combobox", { name: "Import source" })).toHaveValue("pw-editor-assets");
    if (reimportName) {
        const item = library.locator("[data-asset-id]").filter({ hasText: reimportName });
        await item.hover();
        await item.getByRole("button", { name: `Reimport ${reimportName}` }).click();
    }
    await library.locator('input[type="file"]').setInputFiles([modelPath, bufferPath]);
    await library.getByRole("button", { name: "Publish" }).click();
    const published = library.locator("[data-asset-id]").filter({ hasText: reimportName ?? modelName });
    if (reimportName) await expect(published).toContainText("r2", { timeout: 60_000 });
    else await expect(published).toBeVisible({ timeout: 60_000 });
}

async function placeFromLibrary(page, name) {
    const item = page.locator("[data-editor-asset-library] [data-asset-id]").filter({ hasText: name });
    await item.hover();
    await item.getByRole("button", { name: `Place ${name}` }).click();
    const host = page.locator("[data-editor-canvas-host]");
    const box = await host.boundingBox();
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.55);
}

test.afterEach(async ({ request }) => {
    await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
});

test("ED-06 imports, previews, places, pins, updates, archives, reloads, and isolates editor models", async ({ page, request }) => {
    test.setTimeout(600_000);
    const environmentId = await activateBlank(request);
    await openEditor(page);
    await importModel(page);

    const model = page.locator("[data-editor-asset-library] [data-asset-id]").filter({ hasText: modelName });
    await model.getByRole("button", { name: `Open asset ${modelName}` }).click();
    await expect(page.locator("[data-asset-preview-tab]")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("img", { name: new RegExp(`${modelName} revision 1`, "i") })).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Scene", exact: true }).click();
    const sceneToolbar = page.getByRole("toolbar", { name: "Scene tools" });

    await placeFromLibrary(page, modelName);
    await expect(page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: modelName, exact: true })).toBeVisible();
    const positionX = page.getByRole("textbox", { name: "Position X" });
    await positionX.fill("5");
    await positionX.press("Enter");
    await expect(positionX).toHaveValue(/5/);
    await sceneToolbar.getByRole("button", { name: "Undo" }).click();
    await sceneToolbar.getByRole("button", { name: "Redo" }).click();
    await model.hover();
    await model.getByRole("button", { name: `Place ${modelName}` }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: modelName, exact: true })).toHaveCount(1);
    await page.getByRole("button", { name: "Duplicate", exact: true }).click();
    const sceneAssets = page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: new RegExp(`^${modelName}`) });
    await expect(sceneAssets).toHaveCount(2);
    await sceneAssets.first().click();
    await sceneAssets.nth(1).click({ modifiers: ["ControlOrMeta"] });
    await sceneAssets.first().click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: /Group/ }).click();
    await sceneToolbar.getByRole("button", { name: "Undo" }).click();
    await sceneToolbar.getByRole("button", { name: "Redo" }).click();
    await sceneToolbar.getByRole("button", { name: "Undo" }).click();

    const toolbar = page.getByRole("toolbar", { name: "Scene tools" });
    await toolbar.getByRole("button", { name: "Map view" }).click();
    await placeFromLibrary(page, modelName);
    await expect(page.locator("[data-map-asset-id]")).toHaveCount(3);
    await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });

    const before = await (await request.get(`/api/storage/environments/${environmentId}`)).json();
    const beforeManifest = before.manifest ?? before;
    const beforeAssets = beforeManifest.document.objects.filter((record) => record.typeId === "asset-instance");
    expect(beforeAssets).toHaveLength(3);
    expect(beforeAssets.every((record) => record.components.asset.revision === 1)).toBeTruthy();
    const otherId = `${environmentId}-copy`;
    expect((await request.post(`/api/storage/environments/${environmentId}/duplicate`, { data: { id: otherId, name: "Pinned copy", expectedRevision: beforeManifest.revision ?? before.revision } })).ok()).toBeTruthy();

    await importModel(page, modelName);
    await expect(model).toContainText("r2");
    const firstAsset = page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: modelName, exact: true }).first();
    await firstAsset.click();
    const revisionSection = page.locator("[data-asset-instance-section]");
    await expect(revisionSection).toContainText("Revision 2 is available");
    await revisionSection.getByRole("button", { name: "Update instances" }).click();
    await expect(revisionSection.getByLabel("Target revision")).toHaveValue("2");
    await revisionSection.getByLabel(/Selected matching/).check();
    await revisionSection.getByRole("button", { name: /^Update 1$/ }).click();
    await expect(revisionSection.getByRole("status")).toContainText("1 instance updated", { timeout: 30_000 });
    await revisionSection.getByRole("button", { name: "Update instances" }).click();
    await revisionSection.getByLabel(/All in this environment/).check();
    await revisionSection.getByRole("button", { name: /^Update 3$/ }).click();
    await expect(revisionSection.getByRole("status")).toContainText("3 instances updated", { timeout: 30_000 });
    await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });

    const current = await (await request.get(`/api/storage/environments/${environmentId}`)).json();
    expect((current.manifest ?? current).document.objects.filter((record) => record.typeId === "asset-instance").every((record) => record.components.asset.revision === 2)).toBeTruthy();
    const copy = await (await request.get(`/api/storage/environments/${otherId}`)).json();
    expect((copy.manifest ?? copy).document.objects.filter((record) => record.typeId === "asset-instance").every((record) => record.components.asset.revision === 1)).toBeTruthy();

    await model.hover();
    await model.getByRole("button", { name: `Archive ${modelName}` }).click();
    await page.reload();
    await openEditor(page);
    const reloaded = await (await request.get(`/api/storage/environments/${environmentId}`)).json();
    expect((reloaded.manifest ?? reloaded).document.objects.filter((record) => record.typeId === "asset-instance")).toHaveLength(3);

    const workspaces = page.getByRole("dialog", { name: "Workspaces" });
    for (let attempt = 0; attempt < 5 && !(await workspaces.isVisible()); attempt += 1) {
        await page.keyboard.press("Escape");
    }
    await expect(workspaces).toBeVisible();
    await workspaces.getByRole("button", { name: /^Simulation/i }).click();
    await expect(page.locator("[data-editor-workspace]")).toHaveCount(0);
});

test("ED-06 asset library and keyboard preview flow are accessible at 1280 by 720 @a11y", async ({ page, request }) => {
    test.setTimeout(300_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    await activateBlank(request, "ED-06 accessibility");
    await openEditor(page);
    const builtIn = page.getByRole("button", { name: "Place Cone" });
    await builtIn.focus();
    await page.keyboard.press("Enter");
    await expect(builtIn).toHaveAttribute("aria-pressed", "true");
    const results = await new AxeBuilder({ page }).include("[data-editor-workspace]").analyze();
    expect(results.violations.filter((violation) => violation.impact === "critical" || violation.impact === "serious")).toEqual([]);
});
