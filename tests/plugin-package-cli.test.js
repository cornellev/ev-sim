import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../server/plugins/PluginPackageCli.js";
import { pluginFixtureFiles, pluginFixtureResource } from "./helpers/pluginFixtures.js";

async function captureMain(argv) {
    let stdout = "";
    let stderr = "";
    const code = await main(argv, {
        stdout: { write(chunk) { stdout += chunk; return true; } },
        stderr: { write(chunk) { stderr += chunk; return true; } },
    });
    return { code, stdout, stderr };
}

test("cev-sim-plugin packs and verifies without loading runtime modules", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-cli-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const files = await pluginFixtureFiles();
    const directory = path.join(root, "plugin");
    for (const [member, bytes] of Object.entries(files)) {
        const destination = path.join(directory, ...member.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, bytes);
    }
    const packed = path.join(root, "acme.example.plugin.json");
    const packedResult = await captureMain(["pack", "--directory", directory, "--output", packed]);
    assert.equal(packedResult.code, 0, packedResult.stderr);
    const packedJson = JSON.parse(packedResult.stdout);
    const resource = await pluginFixtureResource();
    assert.equal(packedJson.packageHash, resource.packageHash);
    const verified = await captureMain(["verify", "--file", packed]);
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).runtimeHash, resource.runtimeHash);

    const missing = await captureMain(["verify", "--file", path.join(root, "missing.json")]);
    assert.notEqual(missing.code, 0);
});
