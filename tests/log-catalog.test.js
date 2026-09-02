import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
    LOG_CATALOG_KIND,
    createLogCatalog,
    normalizeLogCatalog,
    normalizeLogFolderId,
} from "../app/logging/LogCatalogDocument.js";
import { LogService } from "../server/logging/LogService.js";

async function withLogs(fn) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fusion-log-catalog-"));
    const service = new LogService(directory);
    try {
        return await fn(service, directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test("log catalog normalize keeps revision metadata and rejects unknown kinds", () => {
    const created = createLogCatalog({ folders: [{ id: "nightly", name: "Nightly" }] });
    assert.equal(created.kind, LOG_CATALOG_KIND);
    assert.deepEqual(created.folders, [{ id: "nightly", name: "Nightly" }]);

    const persisted = normalizeLogCatalog({
        ...created,
        revision: 4,
        definitionHash: "abc",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
    });
    assert.equal(persisted.revision, 4);
    assert.equal(persisted.definitionHash, "abc");
    assert.equal(normalizeLogFolderId("  nightly  "), "nightly");
    assert.equal(normalizeLogFolderId(""), null);
    assert.throws(() => normalizeLogCatalog({ kind: "other" }), /Unsupported log catalog kind/);
});

test("LogService ignores reserved catalog JSON and files logs into folders", async () => {
    await withLogs(async (service, directory) => {
        await writeFile(path.join(directory, "catalog.json"), JSON.stringify({ kind: "not-a-log" }));
        await writeFile(path.join(directory, "orphan.json"), JSON.stringify({ id: "orphan", name: "Orphan" }));

        const session = await service.createSession({ id: "filed-log", name: "Filed log" });
        await service.finalize(session.id);
        await service.updateMetadata(session.id, { folderId: "nightly" });

        const empty = await service.getCatalog();
        assert.equal(empty.revision, 0);
        const created = await service.putCatalog({
            catalog: createLogCatalog({ folders: [{ id: "nightly", name: "Nightly" }] }),
            expectedRevision: 0,
        });
        assert.equal(created.revision, 1);
        assert.deepEqual(created.folders.map((folder) => folder.id), ["nightly"]);

        await assert.rejects(
            service.putCatalog({
                catalog: { ...created, folders: [] },
                expectedRevision: 0,
            }),
            /revision conflict/i,
        );

        const listed = await service.listLogs();
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, session.id);
        assert.equal(listed[0].folderId, "nightly");
        assert.ok(Number(listed[0].bytes) > 0);

        const unfiled = await service.putCatalog({
            catalog: { ...created, folders: [] },
            expectedRevision: created.revision,
        });
        assert.equal(unfiled.revision, 2);
        assert.equal((await service.getMetadata(session.id)).folderId, null);
    });
});

test("LogService refuses to delete an active recording and reports batch failures", async () => {
    await withLogs(async (service) => {
        const session = await service.createSession({ id: "live-log", name: "Live" });
        await assert.rejects(service.deleteLog(session.id), /Stop the active recording/);
        const batch = await service.deleteLogs([session.id, "missing-log"]);
        assert.equal(batch.results[0].deleted, false);
        assert.match(batch.results[0].error, /Stop the active recording/);
        await service.finalize(session.id);
        const deleted = await service.deleteLogs([session.id]);
        assert.equal(deleted.results[0].deleted, true);
        assert.equal((await service.listLogs()).length, 0);
    });
});
