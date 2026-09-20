import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPluginRouter, sendPluginFileResponse } from "../server/routes/pluginRouter.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { pluginFixtureResource } from "./helpers/pluginFixtures.js";

test("plugin routes serve verified immutable members and survive library removal", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-routes-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new PluginStore(root);
    const resource = await pluginFixtureResource();
    await store.putPackage(resource);
    await store.installFromHash(resource.packageHash);
    const response = () => ({
        statusCode: 200,
        headers: new Map(),
        body: null,
        set(name, value) { this.headers.set(name.toLowerCase(), value); return this; },
        status(code) { this.statusCode = code; return this; },
        json(value) { this.body = value; return this; },
        send(value) { this.body = value; return this; },
        end() { this.ended = true; return this; },
    });
    const service = { plugins: store };
    const served = response();
    await sendPluginFileResponse(service, { packageHash: resource.packageHash, member: "runtime/index.js" }, served);
    assert.equal(served.statusCode, 200);
    assert.match(served.headers.get("content-type"), /text\/javascript/);
    assert.equal(served.headers.get("x-content-type-options"), "nosniff");
    assert.match(served.headers.get("cache-control"), /immutable/);
    assert.match(served.body.toString(), /fixtureResult/);
    const head = response();
    await sendPluginFileResponse(service, { packageHash: resource.packageHash, member: "runtime/index.js", head: true }, head);
    assert.equal(head.ended, true);
    const missing = response();
    await sendPluginFileResponse(service, { packageHash: resource.packageHash, member: "missing.js" }, missing);
    assert.equal(missing.statusCode, 404);
    const traversal = response();
    await sendPluginFileResponse(service, { packageHash: resource.packageHash, member: "../plugin.json" }, traversal);
    assert.equal(traversal.statusCode, 404);
    assert.ok(createPluginRouter(service));
    await store.removeFromLibrary("acme.example", resource.packageHash);
    const afterRemoval = response();
    await sendPluginFileResponse(service, { packageHash: resource.packageHash, member: "runtime/index.js" }, afterRemoval);
    assert.equal(afterRemoval.statusCode, 200);

    await fs.writeFile(path.join(store.casDir, resource.packageHash, "files", "runtime", "index.js"), "tampered");
    const tampered = response();
    await sendPluginFileResponse(service, { packageHash: resource.packageHash, member: "runtime/index.js" }, tampered);
    assert.equal(tampered.statusCode, 400);
});
