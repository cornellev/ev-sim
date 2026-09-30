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

test("MKT-04 cev-sim-marketplace, cev-mkt, and cev-sim mkt use one parser and identical behavior", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cli-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = path.join(parent, "registry");
    const offlineRootKey = path.join(parent, "offline-root.pem");
    const standalone = "server/marketplace/cev-mkt.js";
    const umbrella = "bin/cev-sim.js";
    const helps = await Promise.all([
        run(standalone, ["--help"]),
        run(standalone, ["--help"]),
        run(umbrella, ["mkt", "--help"]),
    ]);
    assert.ok(helps.every((entry) => entry.exitCode === 0 && entry.stdout === helps[0].stdout && entry.stderr === ""));
    assert.match(helps[0].stdout, /cev-sim-marketplace.*cev-mkt.*cev-sim mkt/su);

    const initialized = await run(standalone, ["init", "--root", registry, "--offline-root-key", offlineRootKey]);
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

test("MKT-04 CLI emits one redacted JSON failure and requires literal --dry-run", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cli-errors-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = path.join(parent, "registry");
    const offlineRootKey = path.join(parent, "offline-root.pem");
    await run("server/marketplace/cev-mkt.js", ["init", "--root", registry, "--offline-root-key", offlineRootKey]);
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

test("MKT-16 publisher provision writes one owner-only connection bundle and refuses overwrite", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-provision-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = path.join(parent, "registry");
    const offlineRootKey = path.join(parent, "offline-root.pem");
    const bundles = path.join(parent, "connections.d");
    await fs.mkdir(bundles, { mode: 0o700 });
    const executable = "server/marketplace/cev-mkt.js";
    assert.equal((await run(executable, ["init", "--root", registry, "--offline-root-key", offlineRootKey])).exitCode, 0);
    const output = path.join(bundles, "company");
    const provisioned = await run(executable, [
        "publisher", "provision",
        "--root", registry,
        "--origin", "https://marketplace.example",
        "--display-name", "Company Marketplace",
        "--namespace", "acme.example",
        "--output", output,
    ]);
    assert.equal(provisioned.exitCode, 0, provisioned.stderr);
    const result = JSON.parse(provisioned.stdout);
    assert.equal(result.publisherId, "acme.example");
    assert.doesNotMatch(provisioned.stdout, /token|PRIVATE KEY/u);
    assert.equal((await fs.lstat(output)).mode & 0o077, 0);
    for (const name of ["connection.json", "read-credential.json", "publisher.token", "publisher.pk8.pem"]) {
        const stat = await fs.lstat(path.join(output, name));
        assert.equal(stat.isFile(), true);
        assert.equal(stat.mode & 0o077, 0);
    }
    const connection = JSON.parse(await fs.readFile(path.join(output, "connection.json"), "utf8"));
    assert.equal(connection.origin, "https://marketplace.example/");
    assert.equal(connection.publishingIdentities[0].publisherId, "acme.example");
    const repeated = await run(executable, [
        "publisher", "provision", "--root", registry,
        "--origin", "https://marketplace.example", "--display-name", "Company Marketplace",
        "--namespace", "acme.example", "--output", output,
    ]);
    assert.equal(repeated.exitCode, 2);
    assert.match(repeated.stderr, /refuses to overwrite/u);
});

test("MKT-04 CLI aborts streaming and releases writer ownership on SIGINT", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cli-signal-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = path.join(parent, "registry");
    const offlineRootKey = path.join(parent, "offline-root.pem");
    const artifact = path.join(parent, "large.plugin.json");
    await run("server/marketplace/cev-mkt.js", ["init", "--root", registry, "--offline-root-key", offlineRootKey]);
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

test("MKT-04 CLI refreshes, rotates, and runs one quiet loopback process", async (t) => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "cev-mkt-cli-serve-"));
    t.after(() => fs.rm(parent, { recursive: true, force: true }));
    const registry = path.join(parent, "registry");
    const currentRootKey = path.join(parent, "current-root.pem");
    const newRootKey = path.join(parent, "new-root.pem");
    const executable = "server/marketplace/cev-mkt.js";
    assert.equal((await run(executable, ["init", "--root", registry, "--offline-root-key", currentRootKey])).exitCode, 0);
    const refreshed = await run(executable, ["tuf", "refresh", "--root", registry]);
    assert.equal(refreshed.exitCode, 0);
    assert.equal(JSON.parse(refreshed.stdout).timestampVersion, 2);
    const rotated = await run(executable, [
        "tuf", "rotate-root", "--root", registry,
        "--current-root-key", currentRootKey, "--new-root-key", newRootKey,
    ]);
    assert.equal(rotated.exitCode, 0);
    assert.equal(JSON.parse(rotated.stdout).rootVersion, 3);
    const verified = await run(executable, ["verify", "--root", registry]);
    assert.equal(JSON.parse(verified.stdout).tuf.rootVersion, 3);

    const rejected = await run(executable, ["serve", "--root", registry, "--host", "0.0.0.0", "--port", "0"]);
    assert.notEqual(rejected.exitCode, 0);
    const child = spawn(process.execPath, [
        "--experimental-default-type=module", executable,
        "serve", "--root", registry, "--port", "0",
    ], { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const startup = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out waiting for marketplace server startup.")), 5_000);
        child.once("error", reject);
        child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const newline = stdout.indexOf("\n");
            if (newline < 0) return;
            clearTimeout(timeout);
            resolve(JSON.parse(stdout.slice(0, newline)));
        });
    });
    const response = await fetch(`http://127.0.0.1:${startup.address.port}/.well-known/cev-sim-marketplace`);
    assert.equal(response.status, 200);
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
    });
    assert.equal(exitCode, 0);
    assert.equal(stderr, "");
    assert.equal(stdout.trim().split("\n").length, 1);
});
