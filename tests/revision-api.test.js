import assert from "node:assert/strict";
import { createServer } from "node:http";
import os from "node:os";
import test from "node:test";

import express from "express";
import { RemoteRevisionProbe } from "../server/revision/RemoteRevisionProbe.js";
import { revisionStatus } from "../server/revision/revisionStatus.js";
import { createRevisionRouter } from "../server/routes/revisionRouter.js";

test("GET /api/revision returns the probe status document", async (t) => {
    const document = revisionStatus({
        state: "behind",
        runningCommit: "a".repeat(40),
        remoteCommit: "b".repeat(40),
        remoteName: "origin",
        remoteBranch: "main",
        remoteRef: "origin/main",
        ahead: 0,
        behind: 2,
        checkedAt: "2026-09-27T00:00:00.000Z",
    });
    const app = express();
    app.use("/api/revision", createRevisionRouter({
        status: async () => document,
    }));
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/api/revision`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), document);
    assert.equal(JSON.stringify(document).includes("http"), false);
});

test("GET /api/revision reports disabled when CEV_SIM_REVISION_CHECK=0", async (t) => {
    let called = false;
    const probe = new RemoteRevisionProbe({
        repoRoot: os.tmpdir(),
        env: { CEV_SIM_REVISION_CHECK: "0" },
        runGit() {
            called = true;
            return { ok: false, stdout: "", stderr: "", code: 1 };
        },
    });
    await probe.start();
    const app = express();
    app.use("/api/revision", createRevisionRouter(probe));
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();

    const response = await fetch(`http://127.0.0.1:${port}/api/revision`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).state, "disabled");
    assert.equal(called, false);
});
