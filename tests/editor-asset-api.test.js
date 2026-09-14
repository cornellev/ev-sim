import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { compileAssetDefinition } from "../app/editor-assets/AssetCompiler.js";
import { createEmptyAssetDefinition } from "../app/editor-assets/AssetDefinition.js";
import { createEditorAssetRouter } from "../server/routes/editorAssetRouter.js";
import { StorageService } from "../server/storage/StorageService.js";
import { makeTriangleGlb, ownedGrant, publishAsset, restrictedGrant, writeRegistry } from "./helpers/visual-assets.js";

const execFileAsync = promisify(execFile);

function routerRequest(router) {
    return async (routePath, { method = "GET", body = {}, query = {}, params = {} } = {}) => {
        const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method.toLowerCase()]);
        assert.ok(layer, `${method} ${routePath} is registered`);
        const req = { method, body, query, params, originalUrl: routePath };
        const response = { statusCode: 200, payload: null };
        const res = {
            set() { return this; },
            status(code) { response.statusCode = code; return this; },
            json(payload) { response.payload = payload; return this; },
        };
        await layer.route.stack[0].handle(req, res, () => {});
        return { response: { status: response.statusCode }, body: response.payload };
    };
}

async function withApi(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-editor-asset-api-"));
    await writeRegistry(dir, [ownedGrant("owned")]);
    const service = new StorageService(dir, { visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") } });
    const model = await publishAsset(service.visualAssets, makeTriangleGlb(), { mediaType: "model/gltf-binary", role: "mesh", sourceIds: ["owned"] });
    t.after(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });
    const router = createEditorAssetRouter(service);
    const request = routerRequest(router);
    return { service, model, request, router };
}

test("ED-06 editor asset HTTP API exposes static routes, catalog concurrency, immutable revisions, folders, and references", async (t) => {
    const { service, model, request, router } = await withApi(t);
    assert.ok(router.stack.findIndex((entry) => entry.route?.path === "/folders") < router.stack.findIndex((entry) => entry.route?.path === "/:assetId"));
    const capabilities = await request("/capabilities");
    assert.equal(capabilities.response.status, 200);
    assert.deepEqual(capabilities.body.sources, [{ id: "owned", label: "owned" }]);

    const published = await request("/", {
        method: "POST",
        body: {
            expectedRevision: 0, assetId: "crate", name: "Crate",
            publicationId: "publish-http-1", modelUseHash: model.useHash,
        },
    });
    assert.equal(published.response.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.catalogRevision, 1);
    assert.equal(published.body.revision.revision, 1);

    const list = await request("/", { query: { search: "crate", sort: "updated", direction: "desc" } });
    assert.equal(list.body.assets[0].id, "crate");
    const revision = await request("/:assetId/revisions/:revision", { params: { assetId: "crate", revision: "1" } });
    assert.equal(revision.body.modelUseHash, model.useHash);

    const conflict = await request("/:assetId", { method: "PATCH", params: { assetId: "crate" }, body: { expectedRevision: 0, name: "Box" } });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, "EDITOR_ASSET_REVISION_CONFLICT");
    assert.equal(conflict.body.currentRevision, 1);

    const folder = await request("/folders", { method: "POST", body: { expectedRevision: 1, id: "yard", name: "Yard" } });
    assert.equal(folder.response.status, 200, JSON.stringify(folder.body));
    const moved = await request("/:assetId", { method: "PATCH", params: { assetId: "crate" }, body: { expectedRevision: 2, folderId: "yard", tags: ["cargo"] } });
    assert.equal(moved.response.status, 200);
    const nonempty = await request("/folders/:folderId", { method: "DELETE", params: { folderId: "yard" }, query: { expectedRevision: "3" } });
    assert.equal(nonempty.response.status, 409);
    assert.equal(nonempty.body.code, "EDITOR_ASSET_FOLDER_NOT_EMPTY");

    service.findEditorAssetReferences = async (assetId, targetRevision) => [{ environmentId: "yard", environmentRevision: 4, objectIds: [`${assetId}-${targetRevision}`] }];
    const references = await request("/:assetId/references", { params: { assetId: "crate" }, query: { revision: "1" } });
    assert.deepEqual(references.body.references, [{ environmentId: "yard", environmentRevision: 4, objectIds: ["crate-1"] }]);
});

test("ED-06 capabilities list only active upload-capable sources", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-editor-asset-caps-"));
    t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
    await writeRegistry(dir, [
        ownedGrant("owned"),
        ownedGrant("lab"),
        restrictedGrant("display-only", { permissions: { display: true } }),
        ownedGrant("revoked-lab", { status: "revoked" }),
        ownedGrant("expired-lab", { expiresAt: "2000-01-01T00:00:00.000Z" }),
        ownedGrant("future-lab", { notBefore: "2999-01-01T00:00:00.000Z" }),
        ownedGrant("revoked-parent", { status: "revoked" }),
        ownedGrant("revoked-child", { ancestorIds: ["revoked-parent"] }),
        ownedGrant("missing-parent-child", { ancestorIds: ["missing-parent"] }),
    ]);
    const service = new StorageService(dir, { visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") } });
    const capabilities = await service.getEditorAssetCapabilities();
    assert.deepEqual(Object.keys(capabilities).sort(), ["assetStudio", "limits", "sources"]);
    assert.ok(capabilities.sources.every((source) => Object.keys(source).sort().join(",") === "id,label"));
    assert.deepEqual(capabilities.sources.map((source) => source.id).sort(), ["lab", "owned"]);
});

test("ED-06 capabilities are empty when the registry has no upload sources", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-editor-asset-caps-empty-"));
    t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
    await writeRegistry(dir, []);
    const service = new StorageService(dir, { visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") } });
    const capabilities = await service.getEditorAssetCapabilities();
    assert.deepEqual(capabilities.sources, []);
});

test("ED-06 capabilities are empty when the registry file is missing", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-editor-asset-caps-missing-"));
    t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
    const service = new StorageService(dir, { visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") } });
    const capabilities = await service.getEditorAssetCapabilities();
    assert.deepEqual(capabilities.sources, []);
});

test("ED-09 CEV_SIM_ASSET_STUDIO=0 disables capabilities and both v2 publication routes", async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-editor-asset-disabled-"));
    t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
    await writeRegistry(dir, [ownedGrant("owned")]);
    const storageModule = pathToFileURL(path.resolve("server/storage/StorageService.js")).href;
    const isolated = await execFileAsync(process.execPath, [
        "--input-type=module",
        "-e",
        `import { StorageService } from ${JSON.stringify(storageModule)}; const service = new StorageService(process.argv[1]); console.log(JSON.stringify(await service.getEditorAssetCapabilities()));`,
        dir,
    ], { env: { ...process.env, CEV_SIM_ASSET_STUDIO: "0" } });
    assert.equal(JSON.parse(isolated.stdout.trim()).assetStudio, false, "the environment switch is honored in an isolated process");

    const previous = process.env.CEV_SIM_ASSET_STUDIO;
    process.env.CEV_SIM_ASSET_STUDIO = "0";
    const service = new StorageService(dir, { visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") } });
    if (previous === undefined) delete process.env.CEV_SIM_ASSET_STUDIO;
    else process.env.CEV_SIM_ASSET_STUDIO = previous;

    const capabilities = await service.getEditorAssetCapabilities();
    assert.equal(capabilities.assetStudio, false);
    const rootsBefore = structuredClone(service.visualAssets._roots.roots);
    const definition = createEmptyAssetDefinition({ modelUseHash: "a".repeat(64), name: "Disabled" });
    const compiled = compileAssetDefinition(definition, { sourceGeometries: { source: { 0: { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], triangles: [[0, 1, 2]] } } } });
    const body = {
        expectedRevision: 0,
        expectedAssetRevision: 0,
        assetId: "disabled",
        name: "Disabled",
        publicationId: "disabled-publication",
        modelUseHash: "a".repeat(64),
        definition,
        metric: compiled.metric,
        metricHash: compiled.metricHash,
        appearance: compiled.materials,
    };
    const request = routerRequest(createEditorAssetRouter(service));
    for (const [routePath, params] of [["/", {}], ["/:assetId/revisions", { assetId: "disabled" }]]) {
        const response = await request(routePath, { method: "POST", body, params });
        assert.equal(response.response.status, 400);
        assert.match(response.body.error, /publication is disabled/);
    }
    assert.equal((await service.editorAssets.list({ archived: true })).catalogRevision, 0);
    assert.deepEqual(service.visualAssets._roots.roots, rootsBefore);
});
