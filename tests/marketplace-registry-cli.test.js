import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);

async function run(script, args) {
    const child = spawn(process.execPath, ["--experimental-default-type=module", script, ...args], {
        cwd: repositoryRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    return { exitCode, stdout, stderr };
}

async function waitForPath(target, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fs.access(target);
            return;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    }
    throw new Error(`Timed out waiting for ${target}`);
}

test("MKT-03 cev-sim-marketplace, cev-mkt, and cev-sim mkt use one parser and identical behavior", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cli-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = path.join(parent, "registry");
    const standalone = "server/marketplace/cev-mkt.js";
    const umbrella = "bin/cev-sim.js";
    const helps = await Promise.all([
        run(standalone, ["--help"]),
        run(standalone, ["--help"]),
        run(umbrella, ["mkt", "--help"]),
    ]);
    assert.ok(helps.every((entry) => entry.exitCode === 0 && entry.stdout === helps[0].stdout && entry.stderr === ""));
    assert.match(helps[0].stdout, /cev-sim-marketplace.*cev-mkt.*cev-sim mkt/su);

    const initialized = await run(standalone, ["init", "--root", registry]);
    assert.equal(initialized.exitCode, 0);
    const command = ["list", "--root", registry, "--kind", "items"];
    const listed = [
        await run(standalone, command),
        await run(standalone, command),
        await run(umbrella, ["mkt", ...command]),
    ];
    assert.ok(listed.every((entry) => entry.exitCode === 0 && entry.stdout === listed[0].stdout && entry.stderr === ""));
    assert.deepEqual(JSON.parse(listed[0].stdout).entries, []);
    const invalid = [
        await run(standalone, ["gc", "--root", registry]),
        await run(standalone, ["gc", "--root", registry]),
        await run(umbrella, ["mkt", "gc", "--root", registry]),
    ];
    assert.ok(invalid.every((entry) => entry.exitCode === invalid[0].exitCode
        && entry.stdout === invalid[0].stdout && entry.stderr === invalid[0].stderr));
});

test("MKT-03 CLI emits one redacted JSON failure and requires literal --dry-run", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cli-errors-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = path.join(parent, "registry");
    await run("server/marketplace/cev-mkt.js", ["init", "--root", registry]);
    const failed = await run("server/marketplace/cev-mkt.js", ["gc", "--root", registry]);
    assert.equal(failed.exitCode, 2);
    assert.equal(failed.stdout, "");
    const lines = failed.stderr.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
        ok: false,
        error: { code: "USAGE", message: "This command requires --dry-run." },
    });
    assert.doesNotMatch(failed.stderr, /stack|cause|credential/u);
});

test("MKT-03 CLI aborts streaming and releases writer ownership on SIGINT", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cli-signal-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = path.join(parent, "registry");
    const artifact = path.join(parent, "large.plugin.json");
    await run("server/marketplace/cev-mkt.js", ["init", "--root", registry]);
    await fs.writeFile(artifact, Buffer.alloc(1));
    await fs.truncate(artifact, 256 * 1024 * 1024);
    const child = spawn(process.execPath, [
        "--experimental-default-type=module",
        "server/marketplace/cev-mkt.js",
        "admit", "artifact", "--root", registry, "--content-kind", "plugin", "--file", artifact,
    ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    await waitForPath(path.join(registry, ".writer-lock", "owner.json"));
    child.kill("SIGINT");
    const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    assert.equal(exitCode, 130);
    assert.equal(stdout, "");
    assert.equal(JSON.parse(stderr).ok, false);
    await assert.rejects(fs.access(path.join(registry, ".writer-lock")));
    assert.deepEqual(await fs.readdir(path.join(registry, "staging", "uploads")), []);
});
