import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const sourceOperations = ["display", "transient-cache", "persistent-cache", "derivatives", "machine-interpretation", "ml", "worker-access", "export", "retention", "attribution", "live-preview-display"];
let gltfFixtureDir;
let gltfModelPath;
let gltfBufferPath;

test.beforeAll(async () => {
    const storage = path.resolve(process.env.CEV_SIM_DATA_DIR ?? path.join(process.cwd(), ".playwright-data", "storage"));
    await fs.mkdir(storage, { recursive: true });
    await fs.writeFile(path.join(storage, "visual-source-registry.json"), `${JSON.stringify({
        kind: "cev-sim.visual-source-registry", version: 1,
        sources: [{
            id: "pw-editor-assets", kind: "owned", status: "active", ancestorIds: [],
            permissions: Object.fromEntries(sourceOperations.map((operation) => [operation, true])),
        }],
    }, null, 2)}\n`);
    gltfFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed08-gltf-"));
    const name = `ed08-tile-${Date.now().toString(36)}`;
    const model = {
        asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ name, mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", max: [1, 1, 0], min: [0, 0, 0] },
            { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
        buffers: [{ byteLength: 42, uri: `${name}.bin` }],
    };
    const bytes = Buffer.alloc(42);
    bytes.writeFloatLE(1, 12);
    bytes.writeFloatLE(1, 28);
    bytes.writeUInt16LE(0, 36);
    bytes.writeUInt16LE(1, 38);
    bytes.writeUInt16LE(2, 40);
    gltfModelPath = path.join(gltfFixtureDir, `${name}.gltf`);
    gltfBufferPath = path.join(gltfFixtureDir, `${name}.bin`);
    await fs.writeFile(gltfModelPath, JSON.stringify(model));
    await fs.writeFile(gltfBufferPath, bytes);
});

test.afterAll(async () => {
    if (gltfFixtureDir) await fs.rm(gltfFixtureDir, { recursive: true, force: true });
});

async function openWorkspace(page) {
    await page.goto("/");
    await page.getByRole("button", { name: "Open workspace switcher" }).first().click();
    const workspaces = page.getByRole("dialog", { name: "Workspaces" });
    await expect(workspaces).toBeVisible();
    await workspaces.getByRole("button", { name: /^Environment editor/i }).click();
    await expect(page.locator("[data-editor-workspace]")).toBeVisible({ timeout: 180_000 });
}

async function openCreation(page) {
    const environments = page.getByRole("dialog", { name: "Environments" });
    if (!await environments.isVisible()) {
        await page.getByRole("button", { name: "Environment", exact: true }).click();
    }
    await expect(environments).toBeVisible();
    await environments.getByRole("button", { name: "New", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Create environment" });
    await expect(dialog).toBeVisible();
    return dialog;
}

async function storedEnvironment(request, environmentId) {
    const response = await request.get(`/api/storage/environments/${environmentId}`);
    if (!response.ok()) return null;
    const payload = await response.json();
    return payload.manifest ?? payload;
}

test.beforeEach(async ({ page }) => {
    await page.route("**/v1/3dtiles/root.json?*", (route) => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ asset: { version: "1.1" }, geometricError: 0, root: { boundingVolume: { region: [-1.34, 0.74, -1.33, 0.75, 0, 100] }, geometricError: 0 } }),
    }));
    await page.route("https://overpass-api.de/api/interpreter", (route) => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ elements: [
            { type: "node", id: 1, lat: 42.442, lon: -76.504 },
            { type: "node", id: 2, lat: 42.444, lon: -76.500 },
            { type: "way", id: 10, nodes: [1, 2], tags: { highway: "residential", lanes: "2" } },
        ] }),
    }));
});

test("ED-08 creates Blank atomically and keeps the current environment on cancel", async ({ page, request }) => {
    test.setTimeout(300_000);
    await openWorkspace(page);
    const activeBefore = await page.getByRole("button", { name: "Environment", exact: true }).textContent();
    let dialog = await openCreation(page);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Environment", exact: true })).toContainText(activeBefore.trim());

    dialog = await openCreation(page);
    const id = `pw-ed08-blank-${Date.now().toString(36)}`;
    await dialog.getByLabel("Name").fill("ED-08 Blank");
    await dialog.getByLabel("Environment ID").fill(id);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const response = await request.get(`/api/storage/environments/${id}`);
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    const stored = payload.manifest ?? payload;
    expect(stored.revision).toBe(1);
    expect(stored.document.roads.edges).toHaveLength(0);
});

test("ED-08 Google creation exposes filters and commits the staged bounded import atomically", async ({ page, request }) => {
    test.setTimeout(300_000);
    await openWorkspace(page);
    const dialog = await openCreation(page);
    await dialog.getByRole("button", { name: "Google Earth" }).click();
    await expect(dialog.getByText("Highway classes")).toBeVisible();
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByText(/Preview ready:/)).toBeVisible({ timeout: 30_000 });
    const id = `pw-ed08-google-${Date.now().toString(36)}`;
    await dialog.getByLabel("Name").fill("ED-08 Google");
    await dialog.getByLabel("Environment ID").fill(id);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const stored = await storedEnvironment(request, id);
    expect(stored.revision).toBe(1);
    expect(stored.document.geoFrame.version).toBe(1);
    expect(stored.document.earth.version).toBe(2);
    expect(stored.document.roads.edges).toHaveLength(1);
    await expect(page.locator('[data-pane="hierarchy"]')).toBeVisible();
    await expect(page.locator('[data-pane="inspector"]')).toBeVisible();
});

test("ED-08 GLTF creation uploads, previews, transforms, and pins tile@2 atomically", async ({ page, request }) => {
    test.setTimeout(300_000);
    await openWorkspace(page);
    const dialog = await openCreation(page);
    await dialog.getByRole("button", { name: "GLTF Tile" }).click();
    await dialog.locator('input[type="file"]').setInputFiles([gltfModelPath, gltfBufferPath]);
    await expect(dialog.getByLabel("GLTF Tile preview")).toBeVisible({ timeout: 90_000 });
    await dialog.getByLabel("x", { exact: true }).fill("12");
    await dialog.getByLabel("rotationY", { exact: true }).fill("0.5");
    await dialog.getByLabel("scale", { exact: true }).fill("2");
    const id = `pw-ed08-gltf-${Date.now().toString(36)}`;
    await dialog.getByLabel("Name").fill("ED-08 GLTF");
    await dialog.getByLabel("Environment ID").fill(id);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    const response = await request.get(`/api/storage/environments/${id}`);
    expect(response.ok()).toBeTruthy();
    const payload = await response.json();
    const stored = payload.manifest ?? payload;
    const tile = stored.document.objects.find((entry) => entry.typeId === "tile");
    expect(tile.typeVersion).toBe(2);
    expect(tile.components.asset.position.x).toBe(12);
    expect(tile.components.asset.rotationY).toBe(0.5);
    expect(tile.components.asset.scale).toEqual({ x: 2, y: 2, z: 2 });
});

test("ED-08 active import exposes Add/Replace and legacy correction exposes both scopes", async ({ page, request }) => {
    test.setTimeout(600_000);
    const id = `pw-ed08-legacy-${Date.now().toString(36)}`;
    const name = `ED-08 Legacy ${id}`;
    const initialManifest = {
        environmentId: id, templateId: "blank", roadsAuthored: true,
        document: {
            environmentId: id, roadsAuthored: true,
            roads: { nodes: [{ id: "a", x: 0, z: 0 }, { id: "b", x: 10, z: 0 }], edges: [{ id: "road", startNodeId: "a", endNodeId: "b", width: 7, laneCount: 2, bidirectional: true }], turnRules: [] },
            buildings: [], features: [],
            earth: { anchor: { lat: 42.443, lng: -76.502 }, bounds: { north: 42.448, south: 42.438, east: -76.497, west: -76.507 }, tileProvider: "google-photorealistic", roadProvider: "overpass", importedLayerIds: [], importedAt: null },
        },
    };
    const created = await request.post("/api/storage/environments", { data: { id, name, templateId: "blank", initialManifest } });
    expect(created.ok()).toBeTruthy();
    await openWorkspace(page);
    await page.getByRole("button", { name: "Environment", exact: true }).click();
    await page.getByRole("dialog", { name: "Environments" }).getByRole("button", { name, exact: true }).click();
    const toolbar = page.getByRole("toolbar", { name: "Scene tools" });
    const moveTool = toolbar.getByRole("button", { name: "Move", exact: true });
    await moveTool.click();
    await expect(moveTool).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Earth import" }).click();
    await expect(page.locator('[data-pane="hierarchy"]')).toBeVisible();
    await expect(page.locator('[data-pane="inspector"]')).toBeVisible();
    const importTitle = page.getByText("Google Earth Import", { exact: true });
    await expect(importTitle).toBeVisible();
    const roadMode = page.getByLabel("Existing roads");
    await expect(roadMode).toHaveValue("add");
    const tilesToggle = page.getByText("Show Earth tiles", { exact: true });
    await tilesToggle.scrollIntoViewIfNeeded();
    await expect(tilesToggle).toBeInViewport();
    const panelPreview = page.getByTitle("Load tiles and roads without committing");
    await panelPreview.scrollIntoViewIfNeeded();
    await expect(panelPreview).toBeInViewport();
    const splitter = page.locator('[data-pane-splitter="hierarchy"]');
    const initialSize = Number(await splitter.getAttribute("aria-valuenow"));
    await splitter.focus();
    await page.keyboard.press("ArrowRight");
    await expect(splitter).toHaveAttribute("aria-valuenow", String(initialSize + 8));

    // Import chrome owns Escape in capture phase. Each press performs exactly
    // one stage and never mutates the editor or opens the workspace switcher.
    await page.getByRole("button", { name: "Expand map picker" }).click();
    await expect(page.getByRole("button", { name: "Close expanded map" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Close expanded map" })).toBeHidden();
    await expect(importTitle).toBeVisible();
    await expect(moveTool).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("dialog", { name: "Workspaces" })).toBeHidden();

    const firstPreview = page.getByTitle("Preview import");
    await firstPreview.click();
    await expect(page.getByText(/Preview ready \(1 road segments staged\)/)).toBeVisible({ timeout: 30_000 });
    await firstPreview.focus();
    await page.keyboard.press("Escape");
    await expect(importTitle).toBeVisible();
    await expect(page.getByText(/Preview ready \(1 road segments staged\)/)).toBeHidden();
    await expect(moveTool).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("dialog", { name: "Workspaces" })).toBeHidden();

    await roadMode.focus();
    await page.keyboard.press("Escape");
    await expect(importTitle).toBeHidden();
    await expect(moveTool).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("dialog", { name: "Workspaces" })).toBeHidden();

    await toolbar.getByRole("button", { name: "Map view" }).click();
    await expect(page.getByRole("region", { name: "Map view" })).toBeVisible();
    await page.getByRole("button", { name: "Earth import" }).click();
    await expect(page.getByRole("region", { name: "Map view" })).toBeVisible();
    await page.getByLabel("Existing roads").focus();
    await page.keyboard.press("Escape");
    await expect(importTitle).toBeHidden();
    await expect(page.getByRole("region", { name: "Map view" })).toBeVisible();
    await toolbar.getByRole("button", { name: "Scene view" }).click();

    await page.getByRole("button", { name: "Earth import" }).click();
    await page.getByTitle("Preview import").click();
    await expect(page.getByText(/Preview ready \(1 road segments staged\)/)).toBeVisible({ timeout: 30_000 });
    await page.getByTitle("Apply import").click();
    await expect(page.getByRole("button", { name: "Earth import" })).toBeVisible();
    await expect.poll(async () => (await storedEnvironment(request, id))?.document?.roads?.edges?.length, { timeout: 30_000 }).toBe(2);

    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await storedEnvironment(request, id))?.document?.roads?.edges?.length, { timeout: 30_000 }).toBe(1);
    await page.keyboard.press("Shift+ControlOrMeta+z");
    await expect.poll(async () => (await storedEnvironment(request, id))?.document?.roads?.edges?.length, { timeout: 30_000 }).toBe(2);

    await openWorkspace(page);
    await expect(page.getByRole("button", { name: "Environment", exact: true })).toContainText(name);
    await page.getByRole("button", { name: "Earth import" }).click();
    await page.getByLabel("Existing roads").selectOption("replace");
    await page.getByTitle("Preview import").click();
    await expect(page.getByText(/Preview ready \(1 road segments staged\)/)).toBeVisible({ timeout: 30_000 });
    await page.getByTitle("Apply import").click();
    await expect.poll(async () => (await storedEnvironment(request, id))?.document?.roads?.edges?.length, { timeout: 30_000 }).toBe(1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await storedEnvironment(request, id))?.document?.roads?.edges?.length, { timeout: 30_000 }).toBe(2);

    await page.getByRole("button", { name: "Correct georegistration" }).click();
    let correction = page.getByRole("dialog", { name: "Correct georegistration" });
    await expect(correction.getByLabel("Roads only")).toBeChecked();
    await correction.getByRole("button", { name: "Apply correction" }).click();
    await expect.poll(async () => (await storedEnvironment(request, id))?.document?.geoFrame?.version, { timeout: 30_000 }).toBe(1);
    await page.keyboard.press("ControlOrMeta+z");
    await expect.poll(async () => (await storedEnvironment(request, id))?.document?.geoFrame ?? null, { timeout: 30_000 }).toBeNull();

    await page.getByRole("button", { name: "Correct georegistration" }).click();
    correction = page.getByRole("dialog", { name: "Correct georegistration" });
    await correction.getByLabel("Whole environment").check();
    await expect(correction.getByLabel("Whole environment")).toBeChecked();
    await correction.getByRole("button", { name: "Apply correction" }).click();
    await expect.poll(async () => (await storedEnvironment(request, id))?.document?.earth?.version, { timeout: 30_000 }).toBe(2);
});

test("@a11y ED-09 transient import and correction chrome have no serious accessibility violations", async ({ page, request }) => {
    test.setTimeout(400_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    const id = `pw-ed09-a11y-earth-${Date.now().toString(36)}`;
    const name = `ED-09 A11y Earth ${id}`;
    const initialManifest = {
        environmentId: id,
        templateId: "blank",
        roadsAuthored: true,
        document: {
            environmentId: id,
            roadsAuthored: true,
            roads: { nodes: [], edges: [], turnRules: [] },
            buildings: [],
            features: [],
            earth: {
                anchor: { lat: 42.443, lng: -76.502 },
                bounds: { north: 42.448, south: 42.438, east: -76.497, west: -76.507 },
                tileProvider: "google-photorealistic",
                roadProvider: "overpass",
                importedLayerIds: [],
                importedAt: null,
            },
        },
    };
    expect((await request.post("/api/storage/environments", { data: { id, name, templateId: "blank", initialManifest } })).ok()).toBeTruthy();
    await openWorkspace(page);
    await page.getByRole("button", { name: "Environment", exact: true }).click();
    await page.getByRole("dialog", { name: "Environments" }).getByRole("button", { name, exact: true }).click();

    await page.getByRole("button", { name: "Earth import" }).click();
    const importResults = await new AxeBuilder({ page })
        .include("[data-editor-workspace]")
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    expect(importResults.violations.filter((entry) => ["serious", "critical"].includes(entry.impact))).toEqual([]);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Correct georegistration" }).click();
    const correction = page.getByRole("dialog", { name: "Correct georegistration" });
    await expect(correction).toBeVisible();
    const correctionResults = await new AxeBuilder({ page })
        .include('[role="dialog"][aria-label="Correct georegistration"]')
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
    expect(correctionResults.violations.filter((entry) => ["serious", "critical"].includes(entry.impact))).toEqual([]);
});

test("@a11y ED-08 creation dialog has no serious accessibility violations", async ({ page }) => {
    test.setTimeout(300_000);
    await openWorkspace(page);
    await openCreation(page);
    const results = await new AxeBuilder({ page }).include('[role="dialog"][aria-label="Create environment"]').analyze();
    expect(results.violations.filter((entry) => ["serious", "critical"].includes(entry.impact))).toEqual([]);
});
