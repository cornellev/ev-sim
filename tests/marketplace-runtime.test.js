import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("MKT-01 runtime and dependency declarations are pinned consistently", async () => {
    const packageDocument = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
    assert.equal(packageDocument.engines.node, ">=22.22.2 <23");
    assert.equal((await readFile(new URL(".nvmrc", root), "utf8")).trim(), "22.22.2");
    assert.equal((await readFile(new URL(".npmrc", root), "utf8")).trim(), "engine-strict=true");
    assert.equal(packageDocument.dependencies.ajv, "8.20.0");
    assert.equal(packageDocument.dependencies["spdx-expression-parse"], "4.0.0");
    assert.equal(packageDocument.dependencies["@tufjs/models"], "5.0.0");
    assert.equal(packageDocument.dependencies["@tufjs/canonical-json"], "2.0.0");
    assert.equal(packageDocument.dependencies["tuf-js"], "6.0.0");
    for (const workflow of ["ci.yml", "headless-nightly.yml", "headless-hardware.yml", "internal-candidate.yml"]) {
        const source = await readFile(new URL(`.github/workflows/${workflow}`, root), "utf8");
        assert.doesNotMatch(source, /node-version:\s*22\.14/);
        assert.match(source, /node-version-file:\s*\.nvmrc/);
    }
});

test("MKT-01 TUF client can be imported without network access or updater construction", async () => {
    const tuf = await import("tuf-js");
    assert.equal(typeof tuf.Updater, "function");
    assert.equal(typeof tuf.BaseFetcher, "function");
});
