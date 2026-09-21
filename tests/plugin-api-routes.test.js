import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPluginRouter, sendPluginFileResponse } from "../server/routes/pluginRouter.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { StorageService } from "../server/storage/StorageService.js";
import { storageEvents } from "../server/mcp/events.js";
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

test("plugin library HTTP installs, lists, removes, and publishes audit events", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-library-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const storage = new StorageService(root);
    const resource = await pluginFixtureResource();
    await storage.plugins.putPackage(resource);
    const app = (await import("express")).default();
    const parser = (await import("express")).default.json();
    app.use("/api/storage/plugins", createPluginRouter(storage, { jsonParser: parser }));
    const { createServer } = await import("node:http");
    const server = createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address();
    const origin = `http://127.0.0.1:${port}`;
    const events = [];
    const onChange = (event) => events.push(event);
    storageEvents.on("change", onChange);
    t.after(() => storageEvents.off("change", onChange));

    const listed = await (await fetch(`${origin}/api/storage/plugins/library`)).json();
    assert.equal(listed.ok, true);
    assert.equal(listed.revision, 0);

    const relative = await fetch(`${origin}/api/storage/plugins/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "directory", path: "tests/fixtures/plugins/acme.example" } }),
    });
    assert.equal(relative.status, 400);

    const installed = await (await fetch(`${origin}/api/storage/plugins/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "digest", packageHash: resource.packageHash } }),
    })).json();
    assert.equal(installed.ok, true);
    assert.equal(installed.package.pluginId, "acme.example");
    const afterInstall = events.find((event) => event.domain === "plugin" && event.action === "installed");
    assert.equal(afterInstall.data.packageHash, resource.packageHash);
    assert.equal(afterInstall.data.revision, installed.revision);

    const directory = await (await fetch(`${origin}/api/storage/plugins/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            source: { kind: "directory", path: path.resolve("tests/fixtures/plugins/acme.example") },
        }),
    })).json();
    assert.equal(directory.ok, true);

    const packedPath = path.join(root, "acme.example.plugin.json");
    await fs.writeFile(packedPath, JSON.stringify(resource));
    const fromFileSource = await (await fetch(`${origin}/api/storage/plugins/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: { kind: "file", path: packedPath } }),
    })).json();
    assert.equal(fromFileSource.ok, true);
    assert.equal(fromFileSource.package.packageHash, resource.packageHash);

    const uploaded = await (await fetch(`${origin}/api/storage/plugins/install-file`, {
        method: "POST",
        headers: { "content-type": "application/vnd.cev-sim.plugin-package+json" },
        body: JSON.stringify(resource),
    })).json();
    assert.equal(uploaded.ok, true);
    assert.equal(uploaded.package.runtimeHash, resource.runtimeHash);

    const removed = await (await fetch(`${origin}/api/storage/plugins/remove`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pluginId: "acme.example", packageHash: resource.packageHash }),
    })).json();
    assert.equal(removed.ok, true);
    const afterRemove = events.find((event) => event.domain === "plugin" && event.action === "removed");
    assert.equal(afterRemove.data.packageHash, resource.packageHash);
    const library = await (await fetch(`${origin}/api/storage/plugins/library`)).json();
    assert.equal(library.packages.length, 0);
    const served = await fetch(`${origin}/api/storage/plugins/packages/${resource.packageHash}/files/runtime/index.js`);
    assert.equal(served.status, 200);
});

