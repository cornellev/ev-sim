import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { GitHubUrdfSession } from "../app/vehicles/urdf/GitHubUrdfSession.js";
import { createStorageRouter } from "../server/routes/storageRouter.js";
import { StorageService } from "../server/storage/StorageService.js";
import { GitHubUrdfService } from "../server/vehicles/GitHubUrdfService.js";
import { createGitHubFixture } from "./helpers/github-urdf-fixtures.js";

function urls(calls) {
    return calls.map((call) => call.url);
}

async function invoke(router, routePath, body) {
    const layer = router.stack.find((entry) => entry.route?.path === routePath && entry.route.methods.post);
    let response = null;
    let status = 200;
    await layer.route.stack[0].handle(
        { body, params: {}, method: "POST", originalUrl: `/api/storage${routePath}`, signal: undefined },
        {
            json: (value) => { response = value; },
            status(code) { status = code; return this; },
        },
    );
    return { response, status };
}

test("VEH-07d inspect lists candidates and does not write a vehicle", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-github-urdf-"));
    try {
        const service = new StorageService(directory);
        const fixture = createGitHubFixture({
            files: {
                "urdf/car.urdf": "<robot name=\"car\"/>",
                "urdf/van.urdf": "<robot name=\"van\"/>",
                "meshes/body.stl": "solid",
            },
        });
        const router = createStorageRouter(service, { githubUrdf: new GitHubUrdfService({ fetchImpl: fixture.fetchImpl }) });
        const before = await fs.readdir(directory);
        const inspected = await invoke(router, "/vehicle-urdf/github/inspect", {
            url: "https://github.com/acme/robot",
        });
        assert.equal(inspected.status, 200);
        assert.equal(inspected.response.ok, false);
        assert.equal(inspected.response.selectionRequired, true);
        assert.deepEqual(inspected.response.candidates.map((candidate) => candidate.path), ["urdf/car.urdf", "urdf/van.urdf"]);
        assert.equal(inspected.response.review.repository, "acme/robot");
        assert.notEqual(inspected.response.review.commitSha, inspected.response.review.treeSha);
        assert.equal(inspected.response.review.license.status, "spdx");
        assert.equal(inspected.response.review.license.spdxId, "Apache-2.0");
        assert.equal(urls(fixture.calls).some((url) => url.includes("/git/blobs/")), false);
        assert.deepEqual(await fs.readdir(directory), before);
        assert.equal(await service.listVehicleManifests().then((rows) => rows.length), 0);

        const fetched = await invoke(router, "/vehicle-urdf/github/fetch", {
            url: "https://github.com/acme/robot",
        });
        assert.equal(fetched.response.ok, false);
        assert.equal(fetched.response.package, null);
        assert.equal(fetched.response.diagnostics[0].code, "vehicle.github.selection-required");
        assert.equal(urls(fixture.calls).some((url) => url.includes("/git/blobs/")), false);
        assert.deepEqual(await fs.readdir(directory), before);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test("VEH-07d returns canonical base64 and ignores a stale session response", async () => {
    const fixture = createGitHubFixture({
        files: { "robot.urdf": "<robot name=\"panel\"><link name=\"base_link\"/></robot>" },
    });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cev-github-fetch-"));
    try {
        const storage = new StorageService(directory);
        const router = createStorageRouter(storage, { githubUrdf: new GitHubUrdfService({ fetchImpl: fixture.fetchImpl }) });
        const fetched = await invoke(router, "/vehicle-urdf/github/fetch", {
            url: "https://github.com/acme/robot/blob/main/robot.urdf",
        });
        assert.equal(fetched.response.ok, true, JSON.stringify(fetched.response.diagnostics));
        const file = fetched.response.package.files[0];
        assert.equal(file.path, "robot.urdf");
        assert.equal(Buffer.from(file.bytes, "base64").toString("base64"), file.bytes);
        assert.equal(Buffer.from(file.bytes, "base64").toString(), "<robot name=\"panel\"><link name=\"base_link\"/></robot>");
        assert.equal(await fs.readdir(path.join(directory, "vehicles")).then((names) => names.length).catch(() => 0), 0);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }

    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const session = new GitHubUrdfSession({
        fetchImpl: async () => {
            calls += 1;
            const current = calls;
            await gate;
            return new Response(JSON.stringify({
                ok: true,
                review: { repository: current === 1 ? "old/repo" : "new/repo", commitSha: "a", treeSha: "b" },
                package: null,
            }), { status: 200, headers: { "content-type": "application/json" } });
        },
    });
    const first = session.inspect("https://github.com/old/repo");
    const second = session.inspect("https://github.com/new/repo");
    release();
    const [stale, current] = await Promise.all([first, second]);
    assert.equal(stale.ignored, true);
    assert.equal(current.ignored, false);
    assert.equal(session.review.repository, "new/repo");
    assert.equal(session.package, null);
});
