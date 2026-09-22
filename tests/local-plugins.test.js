import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { pluginFixtureFiles } from "./helpers/pluginFixtures.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { installDetectedPlugin, listLocalPlugins } from "../server/plugins/localPlugins.js";

async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
}

test("listLocalPlugins reads direct and packed plugin documents and skips everything else", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugins-"));
    try {
        await writeJson(path.join(root, "acme.controls", "plugin.json"), {
            id: "acme.controls",
            version: "1.0.0",
        });
        await writeJson(path.join(root, "helios32", "package", "plugin.json"), {
            id: "vendor.robosense.helios32",
            version: "0.1.0",
        });
        await writeJson(path.join(root, "helios32", "notes", "plugin.json"), { id: "ignored.notes", version: "9.9.9" });
        await writeJson(path.join(root, "broken", "plugin.json"), "{");
        await fs.writeFile(path.join(root, "loose.json"), "{}");
        await fs.symlink(path.join(root, "acme.controls"), path.join(root, "linked"), "dir");

        const rows = await listLocalPlugins(root);
        assert.deepEqual(rows.map((row) => row.directory), ["acme.controls", "broken", "helios32/package"]);
        assert.equal(rows[0].id, "acme.controls");
        assert.equal(rows[0].document.version, "1.0.0");
        assert.equal(rows[1].error, "plugin.json is not valid JSON.");
        assert.equal(rows[1].document, null);
        assert.equal(rows[2].id, "vendor.robosense.helios32");
        assert.equal(rows[2].version, "0.1.0");
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test("listLocalPlugins returns an empty list when the folder is missing", async () => {
    const root = path.join(os.tmpdir(), `cev-plugins-missing-${process.pid}`);
    assert.deepEqual(await listLocalPlugins(root), []);
});

test("installDetectedPlugin installs only a detected package and leaves the source folder unchanged", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugins-install-"));
    const pluginsRoot = path.join(root, "plugins");
    const dataDir = path.join(root, "data");
    try {
        const files = await pluginFixtureFiles("acme.controls");
        const sourceDocument = path.join(pluginsRoot, "acme.controls", "plugin.json");
        for (const [relative, bytes] of Object.entries(files)) {
            const target = path.join(pluginsRoot, "acme.controls", relative);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, bytes);
        }
        await writeJson(path.join(pluginsRoot, "helios32", "package", "plugin.json"), {
            id: "vendor.robosense.helios32",
            version: "0.1.0",
        });
        await writeJson(path.join(pluginsRoot, "helios32", "notes", "plugin.json"), { id: "ignored.notes" });
        await writeJson(path.join(pluginsRoot, "broken", "plugin.json"), "{");
        const before = await fs.readFile(sourceDocument);

        const store = new PluginStore(dataDir);
        const storage = {
            installPluginFromDirectory: (directory) => store.installFromDirectory(directory),
        };
        await assert.rejects(installDetectedPlugin(storage, "../data", pluginsRoot), /inside plugins/);
        await assert.rejects(installDetectedPlugin(storage, path.join(pluginsRoot, "acme.controls"), pluginsRoot), /relative path/);
        await assert.rejects(installDetectedPlugin(storage, "helios32", pluginsRoot), /not a detected plugin/);
        await assert.rejects(installDetectedPlugin(storage, "helios32/notes", pluginsRoot), /not a detected plugin/);
        await assert.rejects(installDetectedPlugin(storage, "broken", pluginsRoot), /not a detected plugin/);
        await assert.rejects(installDetectedPlugin(storage, "acme.controls/../../plugins/acme.controls", pluginsRoot), /inside plugins/);

        const metadata = await installDetectedPlugin(storage, "acme.controls", pluginsRoot);
        assert.equal(metadata.pluginId, "acme.controls");
        assert.equal(metadata.version, "1.0.0");
        assert.equal((await store.listInstalled()).packages.length, 1);
        assert.deepEqual(await fs.readFile(sourceDocument), before);
        await fs.access(path.join(dataDir, "plugins", "library.json"));
        await assert.rejects(fs.access(path.join(pluginsRoot, "library.json")));
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});
