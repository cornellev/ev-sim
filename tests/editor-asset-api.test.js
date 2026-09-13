import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createEditorAssetRouter } from "../server/routes/editorAssetRouter.js";
import { StorageService } from "../server/storage/StorageService.js";
import { makeTriangleGlb, ownedGrant, publishAsset, writeRegistry } from "./helpers/visual-assets.js";

async function withApi(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-editor-asset-api-"));
    await writeRegistry(dir, [ownedGrant("owned")]);
    const service = new StorageService(dir, { visualAssets: { registryPath: path.join(dir, "visual-source-registry.json") } });
    const model = await publishAsset(service.visualAssets, makeTriangleGlb(), { mediaType: "model/gltf-binary", role: "mesh", sourceIds: ["owned"] });
    t.after(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });
    const router = createEditorAssetRouter(service);
    const request = async (routePath, { method = "GET", body = {}, query = {}, params = {} } = {}) => {
        const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods[method.toLowerCase()]);
        assert.ok(layer, `${method} ${routePath} is registered`);
        const req = { method, body, query, params, originalUrl: routePath };
        const response = { statusCode: 200, payload: null };
        const res = {
            status(code) { response.statusCode = code; return this; },
            json(payload) { response.payload = payload; return this; },
        };
        await layer.route.stack[0].handle(req, res, () => {});
        return { response: { status: response.statusCode }, body: response.payload };
    };
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
