import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServer } from "node:http";
import { mountStorageApi } from "../server/routes/storageApi.js";
import { StorageService } from "../server/storage/StorageService.js";
import { importInput, protoV2, temporaryStore, uploadedSource } from "./helpers/protobufFixtures.js";

async function api(t) {
    const { directory } = await temporaryStore(t);
    const service = new StorageService(directory);
    const app = express();
    mountStorageApi(app, service, { jsonParser: express.json({ limit: "8mb" }) });
    const server = createServer(app);
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/storage/protobuf-interfaces`;
    const request = async (path, body) => {
        const response = await fetch(`${url}${path}`, { method: body === undefined ? "GET" : "POST",
            headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json() };
    };
    return { service, request };
}

test("ZPB-02 REST imports, previews, disables broken routes, and retrieves both immutable revisions", async (t) => {
    const { request } = await api(t);
    const imported = await request("/import-sources", importInput());
    assert.equal(imported.status, 200);
    const oldHash = imported.body.hash;
    const check = await request("/sources/autonomy/check-update", { schemaId: "main", expectedRevision: 1, source: uploadedSource(protoV2) });
    assert.equal(check.status, 200);
    assert.equal(check.body.invalidatedRoutes.length, 2);
    assert.equal((await request("/sources/autonomy")).body.interfaceHash, oldHash);
    const apply = { checkId: check.body.checkId, expectedRevision: check.body.revision };
    const unaccepted = await request("/sources/autonomy/apply-update", apply);
    assert.equal(unaccepted.status, 409);
    assert.equal(unaccepted.body.issues.length, 3);
    const applied = await request("/sources/autonomy/apply-update", { ...apply, acceptInvalidations: true });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.document.routes.length, 1);
    assert.deepEqual((await request(`/sha256/${oldHash}`)).body, imported.body.document);
    assert.deepEqual((await request(`/sha256/${applied.body.hash}`)).body, applied.body.document);
    assert.equal((await request("")).body.interfaces.length, 2);
});

test("ZPB-02 REST reports missing/conflicting resources and rejects filesystem imports", async (t) => {
    const { request } = await api(t);
    assert.equal((await request(`/sha256/${"0".repeat(64)}`)).status, 404);
    assert.equal((await request("/sources/missing")).body.code, "PROTOBUF_NOT_FOUND");
    assert.equal((await request("/import-sources", { sourceId: "local", schemaId: "main", source: { kind: "local-proto", entryFiles: ["sample.proto"] } })).status, 400);
    await request("/import-sources", importInput());
    const conflict = await request("/sources/autonomy/check-update", { schemaId: "main", expectedRevision: 0, source: uploadedSource() });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.currentRevision, 1);
});

test("ZPB-02 REST uses its bounded parser before the shared 8 MiB storage parser", async (t) => {
    const { request } = await api(t);
    const admitted = await request("", { document: { padding: "x".repeat(9 * 1024 * 1024) } });
    assert.equal(admitted.status, 400);
    assert.equal(admitted.body.code, "PROTOBUF_INVALID");
    const rejected = await request("", { document: { padding: "x".repeat(17 * 1024 * 1024) } });
    assert.equal(rejected.status, 413);
    assert.equal(rejected.body.code, "PROTOBUF_TOO_LARGE");
});
