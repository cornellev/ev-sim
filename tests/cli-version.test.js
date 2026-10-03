import assert from "node:assert/strict";
import test from "node:test";
import { Writable } from "node:stream";

import { CEV_SIM_VERSION } from "../app/version.js";
import { main as headlessMain } from "../server/headless/Cli.js";
import { main as pluginMain } from "../server/plugins/PluginPackageCli.js";
import { main as marketplaceMain } from "../server/marketplace/RegistryCli.js";

function capture() {
    let text = "";
    const stream = new Writable({
        write(chunk, _encoding, callback) {
            text += String(chunk);
            callback();
        },
    });
    return {
        stream,
        text: () => text,
    };
}

test("shipped CLIs report CEV_SIM_VERSION", async () => {
    for (const [name, main] of [
        ["cev-sim", headlessMain],
        ["cev-sim-plugin", pluginMain],
        ["cev-mkt", marketplaceMain],
    ]) {
        const stdout = capture();
        const stderr = capture();
        const code = await main(["--version"], { stdout: stdout.stream, stderr: stderr.stream });
        assert.equal(code, 0, name);
        assert.equal(stdout.text().trim(), CEV_SIM_VERSION, name);
        assert.equal(stderr.text(), "", name);
    }
});
