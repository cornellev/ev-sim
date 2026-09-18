import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";

const repositoryRoot = process.cwd();
const operations = ["display", "transient-cache", "persistent-cache", "derivatives", "machine-interpretation", "ml", "worker-access", "export", "retention", "attribution", "live-preview-display"];

let fixtureDir;
let primary;
let child;
let environmentId;
let texture;

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typeBytes = Buffer.from(type, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
    return Buffer.concat([length, typeBytes, data, crc]);
}

function makePng({ red, green, blue }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk("IHDR", ihdr),
        pngChunk("IDAT", deflateSync(Buffer.from([0, red, green, blue]))),
        pngChunk("IEND", Buffer.alloc(0)),
    ]);
}

function sha256Hex(bytes) {
    return createHash("sha256").update(bytes).digest("hex");
}

function triangleFixture(name, xScale = 1) {
    const model = {
        asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }],
        nodes: [{ name, mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
        accessors: [
            { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", max: [xScale, 1, 0], min: [0, 0, 0] },
            { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" },
        ],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 6 }],
        buffers: [{ byteLength: 42, uri: `${name}.bin` }],
    };
    const bytes = Buffer.alloc(42);
    bytes.writeFloatLE(xScale, 12);
    bytes.writeFloatLE(1, 28);
    bytes.writeUInt16LE(0, 36);
    bytes.writeUInt16LE(1, 38);
    bytes.writeUInt16LE(2, 40);
    return { name, model, bytes };
}

async function writeFixture(fixture) {
    const modelPath = path.join(fixtureDir, `${fixture.name}.gltf`);
    const bufferPath = path.join(fixtureDir, `${fixture.name}.bin`);
    await fs.writeFile(modelPath, JSON.stringify(fixture.model));
    await fs.writeFile(bufferPath, fixture.bytes);
    return { ...fixture, modelPath, bufferPath };
}

test.beforeAll(async () => {
    const storage = path.resolve(process.env.CEV_SIM_DATA_DIR ?? path.join(process.cwd(), ".playwright-data", "storage"));
    await fs.mkdir(storage, { recursive: true });
    await fs.writeFile(path.join(storage, "visual-source-registry.json"), `${JSON.stringify({
        kind: "cev-sim.visual-source-registry", version: 1,
        sources: [{
            id: "pw-editor-assets", kind: "owned", status: "active", ancestorIds: [],
            permissions: Object.fromEntries(operations.map((operation) => [operation, true])),
        }],
    }, null, 2)}\n`);
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-ed07-ui-"));
    const suffix = Date.now().toString(36);
    primary = await writeFixture(triangleFixture(`studio-primary-${suffix}`, 1.25));
    child = await writeFixture(triangleFixture(`studio-child-${suffix}`, 0.75));
});

test.afterAll(async () => {
    if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

test.afterEach(async ({ request }) => {
    await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: "igvc" } });
});

async function activateBlank(request, name) {
    const id = `pw-ed07-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
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

async function importModel(page, fixture) {
    const library = page.locator("[data-editor-asset-library]");
    await expect(library.getByRole("combobox", { name: "Import source" })).toHaveValue("pw-editor-assets");
    const [chooser] = await Promise.all([
        page.waitForEvent("filechooser"),
        library.locator("[data-editor-asset-import]").click(),
    ]);
    await chooser.setFiles([fixture.modelPath, fixture.bufferPath]);
    const item = library.locator("[data-asset-id]").filter({ hasText: fixture.name });
    for (let attempt = 0; attempt < 3 && await item.count() === 0; attempt += 1) {
        await library.getByRole("button", { name: "Publish" }).click();
        await Promise.race([
            item.waitFor({ state: "visible", timeout: 30_000 }),
            library.getByRole("status").filter({ hasText: /catalog changed/i }).waitFor({ state: "visible", timeout: 30_000 }),
        ]).catch(() => {});
    }
    await expect(item).toBeVisible({ timeout: 60_000 });
    await item.locator("img").waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    return item;
}

async function uploadTexture(request) {
    const bytes = makePng({ red: 0xd8, green: 0x35, blue: 0x35 });
    const digest = sha256Hex(bytes);
    const created = await request.post("/api/storage/visual-assets/uploads", { data: {
        asset: { sha256: digest, mediaType: "image/png", sizeBytes: bytes.length, role: "texture" },
        sourceIds: ["pw-editor-assets"], dependencies: {},
    } });
    expect(created.ok()).toBeTruthy();
    const upload = await created.json();
    const published = await request.put(`/api/storage/visual-assets/uploads/${upload.id}/content`, {
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) },
        data: bytes,
    });
    expect(published.ok()).toBeTruthy();
    return { ...(await published.json()), digest };
}

async function replaceBaseColorTexture(page, useHash, digest) {
    const answers = [useHash, digest];
    const accept = async (dialog) => dialog.accept(answers.shift());
    page.on("dialog", accept);
    try {
        await page.getByRole("button", { name: "Replace base color texture" }).click();
        await expect.poll(() => answers.length).toBe(0);
    } finally {
        page.off("dialog", accept);
    }
}

async function placeFromLibrary(page, name) {
    const item = page.locator("[data-editor-asset-library] [data-asset-id]").filter({ hasText: name });
    await item.click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: "Place" }).click();
    const host = page.locator("[data-editor-canvas-host]");
    const bounds = await host.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.55);
}

async function commitNumber(locator, value) {
    await locator.fill(String(value));
    await locator.press("Enter");
}

async function formattedNumber(value) {
    return Number(value).toFixed(2);
}

async function installModuleRoutes(page) {
    await page.route("**/test-modules/**", async (route) => {
        const marker = "/test-modules/";
        const pathname = new URL(route.request().url()).pathname;
        const relative = decodeURIComponent(pathname.slice(pathname.indexOf(marker) + marker.length));
        if (relative.split("/").includes("..")) return route.abort();
        await route.fulfill({
            status: 200,
            contentType: "text/javascript; charset=utf-8",
            body: await fs.readFile(`${repositoryRoot}/${relative}`, "utf8"),
        });
    });
}

async function capturePublishedAsset(page, targetEnvironmentId, assetId) {
    await installModuleRoutes(page);
    await page.setContent(`<script type="importmap">${JSON.stringify({ imports: {
        three: "/test-modules/node_modules/three/build/three.module.js",
        "three/examples/jsm/": "/test-modules/node_modules/three/examples/jsm/",
        "@noble/hashes/sha2.js": "/test-modules/node_modules/@noble/hashes/sha2.js",
        "@noble/hashes/utils.js": "/test-modules/node_modules/@noble/hashes/utils.js",
    } })}</script>`);
    return page.evaluate(async ({ targetEnvironmentId: targetId, assetId: targetAssetId }) => {
        const THREE = await import("three");
        const { BrowserPbrRenderRuntime } = await import("/test-modules/app/3d/perception/BrowserPbrRenderRuntime.js");
        const { CameraRenderProducts } = await import("/test-modules/app/3d/perception/CameraRenderProducts.js");
        const { createVisualCameraCalibration, createVisualCaptureInput } = await import("/test-modules/app/3d/environment/visual/VisualCapturePipeline.js");
        const { compileAssetVisualLayer } = await import("/test-modules/app/editor-assets/AssetVisualLayerCompiler.js");
        const { createWorldResource } = await import("/test-modules/app/simulation/world/WorldDescription.js");
        const { getBuiltInVehicleManifest } = await import("/test-modules/app/vehicles/BuiltInVehicleManifests.js");
        const {
            createPbrRenderSceneResource, defaultPbrRenderRecipe,
            normalizePbrAssetClosure, normalizePbrRunEvidence,
        } = await import("/test-modules/app/simulation/render/PbrRenderScene.js");
        const {
            hashVisualLayer, hashVisualLayerAccess, normalizeVisualLayerAccess,
        } = await import("/test-modules/app/simulation/visual/VisualLayer.js");

        const environmentPayload = await (await fetch(`/api/storage/environments/${targetId}`)).json();
        const environment = environmentPayload.manifest ?? environmentPayload;
        const record = environment.document.objects.find((entry) => entry.typeId === "asset-instance" && entry.components.asset.assetId === targetAssetId);
        if (!record) throw new Error("Published asset instance is missing from the environment.");
        const revision = await (await fetch(`/api/storage/editor-assets/${targetAssetId}/revisions/${record.components.asset.revision}`)).json();
        const rootUseHashes = [revision.modelUseHash, ...revision.appearance.flatMap((material) => material.textures.map((entry) => entry.useHash))];
        const uses = new Map();
        const visit = async (useHash) => {
            if (uses.has(useHash)) return;
            const use = await (await fetch(`/api/storage/visual-assets/uses/sha256/${useHash}`)).json();
            uses.set(useHash, use);
            for (const childUseHash of Object.values(use.dependencies ?? {})) await visit(childUseHash);
        };
        for (const useHash of rootUseHashes) await visit(useHash);
        const closureUses = [...uses].map(([useHash, use]) => ({ useHash, use }));
        const world = createWorldResource(environment);
        const compiled = compileAssetVisualLayer({ world, inputs: [{ record, revision }], closureUses });
        const visualLayer = { description: compiled.description, hash: hashVisualLayer(compiled.description) };
        const access = normalizeVisualLayerAccess({ descriptorHash: visualLayer.hash, assets: compiled.assetUses });
        const assetClosure = normalizePbrAssetClosure({ assets: closureUses.map((entry) => entry.use.asset) });
        const renderScene = createPbrRenderSceneResource({
            worldResource: world,
            vehicleDependencies: [{ actorId: "ego", manifest: getBuiltInVehicleManifest("big-car") }],
            selection: { provider: { id: "pbr-mesh", version: 1 }, productProfile: { id: "measured-rgba-analytic-oracle", version: 1 } },
            visualLayerResource: visualLayer,
            renderRecipe: defaultPbrRenderRecipe(),
            assetClosure,
        });
        const evaluatedSourceIds = [...new Set(closureUses.flatMap((entry) => entry.use.sourceIds))].sort();
        const evidence = normalizePbrRunEvidence({
            visualAssets: {
                descriptorHash: visualLayer.hash,
                accessHash: hashVisualLayerAccess(access),
                access,
                roots: access.assets.map(({ sha256, useHash }) => ({ scope: "visual-layer", sha256, useHash })),
                uses: closureUses,
                assetClosureHash: renderScene.description.assetClosureHash,
                permissions: {
                    operations: ["display", "machine-interpretation"], evaluatedSourceIds,
                    obligations: { attribution: [], requirements: [], retentionUntil: null },
                },
            },
            correspondence: null,
        });
        const width = 48;
        const height = 36;
        const canvas = document.createElement("canvas");
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        const asset = record.components.asset;
        const vehicle = { telemetryId: "ego", position: new THREE.Vector3(asset.position.x, asset.position.y, asset.position.z), rotation: new THREE.Euler() };
        const runtime = new BrowserPbrRenderRuntime({ renderer, vehicles: () => [vehicle] });
        await runtime.prepare({ world, visualLayer, renderScene, evidence }, { interest: { position: asset.position }, vehicles: [vehicle] });
        const calibration = createVisualCameraCalibration({
            width, height, intrinsics: { fx: 42, fy: 42, cx: 23.5, cy: 17.5 },
            near: 0.1, far: 20, distortionModel: "none", distortion: [],
        });
        const camera = new THREE.PerspectiveCamera();
        const cameraMatrix = new THREE.Matrix4().makeTranslation(asset.position.x + 1.1, asset.position.y + 0.7, asset.position.z + 4);
        const options = runtime.cameraOptions();
        const products = new CameraRenderProducts({
            renderer, camera, captureMode: options.captureMode, calibration,
            sceneHandle: options.captureSceneHandle, analyticSceneHandle: options.analyticSceneHandle,
            authorizeSourceUse: options.authorizeSourceUse, renderPolicy: options.renderPolicy,
        });
        await runtime.prepareCapture({ devices: [{ renderRuntime: runtime, getPosition: () => new THREE.Vector3().setFromMatrixPosition(cameraMatrix) }], vehicles: [vehicle] });
        const output = await runtime.captureCamera({
            captureInput: createVisualCaptureInput({ calibration, pose: { matrixWorld: cameraMatrix.elements }, sceneHandle: runtime.appearanceSceneHandle, captureTimeNs: 700n }),
            enabled: { rgb: true, depth: false, semantic: false, instance: false },
            renderProducts: products,
            signal: new AbortController().signal,
        });
        const result = {
            nonBlackRgb: [...output.rgb].some((value, index) => index % 4 !== 3 && value > 0),
            visualLayerHash: visualLayer.hash,
            instanceCount: compiled.description.instances.length,
            materialCount: compiled.description.materials.length,
            status: runtime.status.state,
        };
        products.dispose();
        runtime.dispose();
        renderer.dispose();
        return result;
    }, { targetEnvironmentId, assetId });
}

test("ED-07 authors isolated revisions, nested proxies, explicit instance updates, reload, and measured PBR", async ({ page, request }) => {
    test.setTimeout(900_000);
    page.setDefaultTimeout(30_000);
    environmentId = await activateBlank(request, "ED-07 asset studio");
    texture = await uploadTexture(request);
    await openEditor(page);
    const primaryItem = await importModel(page, primary);
    const childItem = await importModel(page, child);

    await childItem.dblclick();
    await expect(page.getByLabel(`${child.name} asset studio viewport`)).toBeVisible({ timeout: 60_000 });
    let inspector = page.locator("[data-asset-catalog-inspector]");
    const childAssetId = await childItem.getAttribute("data-asset-id");
    await expect(inspector.locator("[data-asset-id]")).toHaveText(`Asset ID ${childAssetId}`);
    await commitNumber(inspector.getByLabel("Pivot Y"), "0.5");
    await page.getByRole("tree", { name: "Asset parts" }).getByRole("treeitem", { name: child.name }).click();
    await inspector.getByRole("button", { name: "Add", exact: true }).click();
    await inspector.getByLabel("Material").selectOption("material-1");
    await inspector.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${child.name} · r2`) })).toBeVisible({ timeout: 60_000 });

    await primaryItem.dblclick();
    const canvas = page.getByLabel(`${primary.name} asset studio viewport`);
    await expect(canvas).toBeVisible({ timeout: 60_000 });
    await expect.poll(async () => canvas.getAttribute("data-appearance-rebuilds")).not.toBeNull();
    const rebuildsAfterOpen = await canvas.getAttribute("data-appearance-rebuilds");
    const canvasBox = await canvas.boundingBox();
    expect(canvasBox).not.toBeNull();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.5);
    await page.mouse.wheel(0, 240);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.5 + 48, canvasBox.y + canvasBox.height * 0.5 + 28, { steps: 6 });
    await page.mouse.up();
    await expect(canvas).toHaveAttribute("data-appearance-rebuilds", rebuildsAfterOpen);
    inspector = page.locator("[data-asset-catalog-inspector]");
    const parts = page.getByRole("tree", { name: "Asset parts" });
    await page.mouse.click(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + canvasBox.height * 0.45);
    if (await parts.locator("[data-selected]").count() === 0) {
        await parts.getByRole("treeitem", { name: primary.name }).click();
    }
    await expect(parts.getByRole("treeitem", { name: primary.name })).toHaveAttribute("data-selected", "true");
    await expect(parts.getByRole("treeitem", { name: primary.name })).toHaveAttribute("aria-current", "true");
    await inspector.getByLabel("Collision overlay").uncheck();
    await inspector.getByLabel("LiDAR overlay").uncheck();
    await expect(parts.getByRole("treeitem", { name: primary.name })).toHaveAttribute("data-selected", "true");
    await expect(canvas).toHaveAttribute("data-appearance-rebuilds", rebuildsAfterOpen);
    await inspector.getByLabel("Collision overlay").check();
    await inspector.getByLabel("LiDAR overlay").check();
    await commitNumber(inspector.getByLabel("Meters per unit"), "1.5");
    await commitNumber(inspector.getByLabel("Pivot X"), "0.25");
    await expect(canvas).toHaveAttribute("data-appearance-rebuilds", rebuildsAfterOpen);
    await expect(inspector.getByLabel("Meters per unit")).toHaveValue(await formattedNumber("1.5"));
    await parts.getByRole("treeitem", { name: primary.name }).click();
    await inspector.getByRole("button", { name: "Add", exact: true }).click();
    await inspector.getByLabel("Material").selectOption("material-1");
    await commitNumber(inspector.getByLabel("Metallic"), "0.2");
    await commitNumber(inspector.getByLabel("Roughness"), "0.65");
    await replaceBaseColorTexture(page, texture.useHash, texture.digest);
    await expect(inspector.locator("[data-texture-id]")).toContainText(`Texture ID · baseColor: ${texture.useHash}`);

    await page.getByRole("button", { name: new RegExp(`^${child.name} · r2`) }).click();
    inspector = page.locator("[data-asset-catalog-inspector]");
    await commitNumber(inspector.getByLabel("Pivot Z"), "1");
    await expect(inspector.getByRole("button", { name: "Undo" })).toBeEnabled();
    await inspector.getByRole("button", { name: "Undo" }).click();
    await expect(inspector.getByLabel("Pivot Z")).toHaveValue(await formattedNumber(0));
    await page.getByRole("button", { name: new RegExp(`^${primary.name} · r1`) }).click();
    await expect(inspector.getByLabel("Meters per unit")).toHaveValue(await formattedNumber("1.5"));

    await expect(page.getByLabel(`${primary.name} asset studio viewport`)).toBeVisible();
    await childItem.dragTo(page.locator("[data-editor-canvas-host]"));
    const droppedParts = page.getByRole("tree", { name: "Asset parts" });
    await expect(droppedParts.getByRole("treeitem", { name: child.name })).toBeVisible({ timeout: 30_000 });
    const rebuildsAfterDrop = await canvas.getAttribute("data-appearance-rebuilds");
    await droppedParts.evaluate((el) => { el.style.maxHeight = "40px"; });
    await droppedParts.getByRole("treeitem", { name: child.name }).click();
    await expect(droppedParts.getByRole("treeitem", { name: child.name })).toHaveAttribute("data-selected", "true");
    const childRowVisible = await droppedParts.getByRole("treeitem", { name: child.name }).evaluate((el) => {
        const root = el.closest('[role="tree"]');
        const row = el.getBoundingClientRect();
        const tree = root.getBoundingClientRect();
        return row.bottom <= tree.bottom + 2 && row.top >= tree.top - 2;
    });
    expect(childRowVisible).toBeTruthy();
    await commitNumber(inspector.getByLabel("Position X"), "3");
    await expect(inspector.getByLabel("Position X")).toHaveValue(await formattedNumber(3));
    await expect(canvas).toHaveAttribute("data-appearance-rebuilds", rebuildsAfterDrop);
    await expect(inspector.getByLabel("Pinned revision")).toHaveValue("2");

    await droppedParts.getByRole("treeitem", { name: primary.name }).click();
    await inspector.getByRole("button", { name: "Select All" }).click();
    await expect(inspector.getByLabel(`Include ${primary.name}`)).toBeChecked();
    await expect(inspector.getByLabel(`Include ${child.name}`)).toBeChecked();
    await inspector.getByLabel(`Include ${child.name}`).uncheck();
    await inspector.getByRole("button", { name: "Generate LiDAR" }).click();
    await expect(inspector.getByText("lidar-generated-1 · lidar", { exact: true })).toBeVisible();
    await commitNumber(inspector.getByLabel("Position X"), "1");
    await expect(inspector.getByText("lidar-generated-1 · lidar · stale", { exact: true })).toBeVisible();
    await inspector.getByRole("button", { name: "Save revision" }).click();
    await expect(inspector.getByRole("alert")).toContainText("Regenerate or disable stale proxies");
    await inspector.getByRole("button", { name: "Regenerate LiDAR" }).click();
    await expect(inspector.getByText("lidar-generated-1 · lidar", { exact: true })).toBeVisible();
    await inspector.getByRole("button", { name: "Add collision box" }).click();
    await inspector.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${primary.name} · r2`) })).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "Scene", exact: true }).click();
    await placeFromLibrary(page, primary.name);
    const primaryAssetId = await primaryItem.getAttribute("data-asset-id");
    await expect.poll(async () => {
        const stored = await (await request.get(`/api/storage/environments/${environmentId}`)).json();
        const storedManifest = stored.manifest ?? stored;
        return storedManifest.document.objects.find((record) => (
            record.typeId === "asset-instance" && record.components.asset.assetId === primaryAssetId
        ))?.components.asset.revision ?? null;
    }, { timeout: 30_000 }).toBe(2);
    let persisted = await (await request.get(`/api/storage/environments/${environmentId}`)).json();
    let manifest = persisted.manifest ?? persisted;
    let instance = manifest.document.objects.find((record) => record.typeId === "asset-instance" && record.components.asset.assetId === primaryAssetId);
    expect(instance.components.asset.revision).toBe(2);
    expect(instance.typeVersion).toBe(2);
    expect(manifest.document.assetMetrics.definitions.some((entry) => entry.assetId === primaryAssetId && entry.revision === 2)).toBeTruthy();

    await page.getByRole("button", { name: new RegExp(`^${primary.name} · r2`) }).click();
    inspector = page.locator("[data-asset-catalog-inspector]");
    await inspector.getByLabel("Roughness").fill("0.4");
    await inspector.getByLabel("Roughness").press("Enter");
    await inspector.getByRole("button", { name: "Save revision" }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^${primary.name} · r3`) })).toBeVisible({ timeout: 60_000 });
    persisted = await (await request.get(`/api/storage/environments/${environmentId}`)).json();
    manifest = persisted.manifest ?? persisted;
    expect(manifest.document.objects.find((record) => record.id === instance.id).components.asset.revision).toBe(2);

    await page.getByRole("button", { name: "Scene", exact: true }).click();
    const sceneAsset = page.getByRole("tree", { name: "Environment objects" }).getByRole("button", { name: primary.name, exact: true });
    await sceneAsset.click();
    const revisionSection = page.locator("[data-asset-instance-section]");
    await expect(revisionSection).toContainText("Revision 3 is available");
    await revisionSection.getByRole("button", { name: "Update instances" }).click();
    await revisionSection.getByLabel(/Selected matching/).check();
    await revisionSection.getByRole("button", { name: /^Update 1$/ }).click();
    await expect(revisionSection.getByRole("status")).toContainText("1 instance updated", { timeout: 30_000 });
    await expect(page.locator("[data-save-status]")).toHaveAttribute("data-save-status", "saved", { timeout: 30_000 });

    await page.reload();
    await openEditor(page);
    persisted = await (await request.get(`/api/storage/environments/${environmentId}`)).json();
    manifest = persisted.manifest ?? persisted;
    instance = manifest.document.objects.find((record) => record.id === instance.id);
    expect(instance.components.asset.revision).toBe(3);
    expect(manifest.document.assetMetrics.definitions.some((entry) => entry.assetId === primaryAssetId && entry.revision === 3)).toBeTruthy();

    const capture = await capturePublishedAsset(page, environmentId, primaryAssetId);
    expect(capture.instanceCount).toBe(1);
    expect(capture.materialCount).toBeGreaterThanOrEqual(2);
    expect(capture.nonBlackRgb).toBeTruthy();
    expect(["ready", "streaming", "degraded"]).toContain(capture.status);
});

test("ED-07 dirty-close and publication-conflict actions are accessible at 1280 by 720 @a11y", async ({ page, request }) => {
    test.setTimeout(360_000);
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1280, height: 720 });
    environmentId ??= await activateBlank(request, "ED-07 asset studio accessibility");
    expect((await request.put("/api/storage/settings/activeEnvironmentId", { data: { value: environmentId } })).ok()).toBeTruthy();
    await openEditor(page);
    let primaryItem = page.locator("[data-editor-asset-library] [data-asset-id]").filter({ hasText: primary.name });
    if (await primaryItem.count() === 0) {
        primaryItem = await importModel(page, primary);
        await importModel(page, child);
    }
    const primaryAssetId = await primaryItem.getAttribute("data-asset-id");
    await primaryItem.dblclick();
    const inspector = page.locator("[data-asset-catalog-inspector]");
    const selectAll = inspector.getByRole("button", { name: "Select All" });
    await expect(selectAll).toBeEnabled();
    await selectAll.click();
    await expect(inspector.getByLabel(`Include ${primary.name}`)).toBeChecked();
    await expect(selectAll).toBeDisabled();
    await commitNumber(inspector.getByLabel("Pivot Z"), "0.2");
    await page.getByRole("button", { name: `Close ${primary.name} studio` }).click();
    const closeDialog = page.getByRole("dialog", { name: `Save changes to ${primary.name}?` });
    await expect(closeDialog).toBeVisible();
    let results = await new AxeBuilder({ page }).include("[data-editor-workspace]").analyze();
    expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
    await closeDialog.getByRole("button", { name: "Cancel" }).click();

    const catalogResponse = await request.get("/api/storage/editor-assets/?archived=true");
    const catalog = await catalogResponse.json();
    const childRecord = catalog.assets.find((entry) => entry.name === child.name);
    expect((await request.patch(`/api/storage/editor-assets/${childRecord.id}`, {
        data: { tags: ["publication-conflict"], expectedRevision: catalog.catalogRevision },
    })).ok()).toBeTruthy();
    await inspector.getByRole("button", { name: "Save revision" }).click();
    const conflict = inspector.getByRole("alert");
    await expect(conflict).toContainText(/catalog revision conflict|revision conflict/i);
    await expect(conflict.getByRole("button", { name: "Reload latest" })).toBeVisible();
    await expect(conflict.getByRole("button", { name: "Save as new asset" })).toBeVisible();
    results = await new AxeBuilder({ page }).include("[data-editor-workspace]").analyze();
    expect(results.violations.filter((violation) => ["critical", "serious"].includes(violation.impact))).toEqual([]);
    expect(primaryAssetId).toBeTruthy();
});
