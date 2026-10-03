import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { defaultCevSimEngineRange } from "../app/plugin/PluginEngineRange.js";
import {
    scaffoldPluginFiles,
    verifyPluginDirectory,
    writePluginScaffold,
} from "../scripts/create-cev-plugin.mjs";

test("create-cev-plugin writes a loadable runtime-only package", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-scaffold-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const out = path.join(root, "acme.scaffold");
    const written = await writePluginScaffold({
        id: "acme.scaffold",
        out,
        name: "Scaffold Scale",
        withUi: false,
        verify: false,
    });
    assert.equal(written.pluginId, "acme.scaffold");
    assert.equal(written.document.entry.ui, undefined);
    const resource = await verifyPluginDirectory(out);
    assert.equal(resource.kind, "cev-sim.plugin-package");
    assert.match(await fs.readFile(`${out}.verify.mjs`, "utf8"), /verifyPluginDirectory/);
});

test("example pure-pursuit package verifies with a UI-independent runtime hash", async () => {
    const packageRoot = path.resolve("examples/plugins/acme.pure-pursuit");
    const resource = await verifyPluginDirectory(packageRoot);
    assert.equal(resource.kind, "cev-sim.plugin-package");
    assert.ok(resource.uiHash);
    assert.notEqual(resource.uiHash, resource.runtimeHash);
    assert.match(
        new TextDecoder().decode(Buffer.from(resource.files.find((entry) => entry.path === "runtime/index.js").data, "base64")),
        /SteerBlock/,
    );
});

test("scaffold rejects reserved plugin ids", () => {
    assert.throws(() => scaffoldPluginFiles({ id: "cev.demo" }), /reserved cev namespace/);
});

test("scaffold and marketplace defaults use next-minor ranges on 0.x hosts", () => {
    assert.equal(defaultCevSimEngineRange("0.1.0"), ">=0.1.0 <0.2.0");
    assert.equal(defaultCevSimEngineRange("0.2.0"), ">=0.2.0 <0.3.0");
    assert.equal(defaultCevSimEngineRange("1.2.3"), ">=1.0.0 <2.0.0");
    assert.equal(
        scaffoldPluginFiles({ id: "acme.demo", simulatorVersion: "0.2.0" }).document.engines.cevSim,
        ">=0.2.0 <0.3.0",
    );
    assert.equal(
        scaffoldPluginFiles({ id: "acme.demo", simulatorVersion: "0.1.0" }).document.engines.cevSim,
        ">=0.1.0 <0.2.0",
    );
});
