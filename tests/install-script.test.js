import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    VISUAL_SOURCE_OPERATIONS,
    normalizeVisualSourceRegistry,
    parseExactJson,
} from "../app/simulation/visual/VisualLayer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installScript = path.join(repoRoot, "install.sh");

function runConfigure(dir, extraEnv = {}) {
    const env = { ...process.env, EV_SIM_DIR: dir };
    delete env.CEV_SIM_DATA_DIR;
    delete env.CEV_SIM_VISUAL_SOURCE_REGISTRY;
    Object.assign(env, extraEnv);
    return spawnSync(
        "bash",
        [
            "-c",
            'install_script="$1"; set --; source "$install_script"; configure_visual_source_registry',
            "bash",
            installScript,
        ],
        { env, encoding: "utf8" },
    );
}

function assertOk(result) {
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
}

function assertFailed(result) {
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /not a regular file|Unsupported /);
}

function defaultRegistry(dir) {
    return path.join(dir, "server", "data", "visual-source-registry.json");
}

async function withDir(fn) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-install-registry-"));
    try {
        return await fn(dir);
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
}

async function assertMissing(filePath) {
    await assert.rejects(fs.lstat(filePath), (error) => error?.code === "ENOENT");
}

async function assertOwnedLabGrant(filePath) {
    const st = await fs.lstat(filePath);
    assert.equal(st.isSymbolicLink(), false);
    assert.equal(st.isFile(), true);
    assert.equal(st.mode & 0o777, 0o644);
    const document = normalizeVisualSourceRegistry(parseExactJson(await fs.readFile(filePath, "utf8")));
    assert.equal(document.kind, "cev-sim.visual-source-registry");
    assert.equal(document.version, 1);
    assert.equal(document.sources.length, 1);
    const source = document.sources[0];
    assert.equal(source.id, "owned-lab");
    assert.equal(source.kind, "owned");
    assert.equal(source.status, "active");
    assert.deepEqual(source.ancestorIds, []);
    assert.deepEqual(
        Object.keys(source.permissions).sort(),
        [...VISUAL_SOURCE_OPERATIONS].sort(),
    );
    for (const operation of VISUAL_SOURCE_OPERATIONS) {
        assert.equal(source.permissions[operation], true, operation);
    }
}

test("install script creates the owned-lab visual source registry", async () => {
    await withDir(async (dir) => {
        const registry = defaultRegistry(dir);
        const result = runConfigure(dir);
        assertOk(result);
        assert.match(result.stdout, /Created visual-source-registry\.json with the owned-lab grant/);
        await assertOwnedLabGrant(registry);
    });
});

test("install script keeps an existing visual source registry", async () => {
    await withDir(async (dir) => {
        const registry = defaultRegistry(dir);
        await fs.mkdir(path.dirname(registry), { recursive: true });
        const original = "{\"custom\":true}\n";
        await fs.writeFile(registry, original);
        const before = await fs.lstat(registry);

        const result = runConfigure(dir);
        assertOk(result);
        assert.match(result.stdout, /Kept existing visual-source-registry\.json/);
        assert.equal(await fs.readFile(registry, "utf8"), original);
        assert.equal((await fs.lstat(registry)).ino, before.ino);

        const again = runConfigure(dir);
        assertOk(again);
        assert.match(again.stdout, /Kept existing visual-source-registry\.json/);
        assert.equal(await fs.readFile(registry, "utf8"), original);
        assert.equal((await fs.lstat(registry)).ino, before.ino);
    });
});

test("install script keeps the registry across a second run", async () => {
    await withDir(async (dir) => {
        const registry = defaultRegistry(dir);
        assertOk(runConfigure(dir));
        const before = await fs.lstat(registry);
        const bytes = await fs.readFile(registry);

        const again = runConfigure(dir);
        assertOk(again);
        assert.match(again.stdout, /Kept existing visual-source-registry\.json/);
        assert.deepEqual(await fs.readFile(registry), bytes);
        assert.equal((await fs.lstat(registry)).ino, before.ino);
    });
});

test("install script refuses a symlink visual source registry", async () => {
    await withDir(async (dir) => {
        const registry = defaultRegistry(dir);
        const target = path.join(dir, "target.json");
        await fs.mkdir(path.dirname(registry), { recursive: true });
        await fs.writeFile(target, "original\n");
        await fs.symlink(target, registry);

        const result = runConfigure(dir);
        assertFailed(result);
        assert.match(result.stderr, /not a regular file/);
        assert.equal(await fs.readFile(target, "utf8"), "original\n");
        assert.equal((await fs.lstat(registry)).isSymbolicLink(), true);
    });
});

test("install script refuses a directory at the visual source registry path", async () => {
    await withDir(async (dir) => {
        const registry = defaultRegistry(dir);
        await fs.mkdir(registry, { recursive: true });
        const result = runConfigure(dir);
        assertFailed(result);
        assert.equal((await fs.lstat(registry)).isDirectory(), true);
    });
});

test("install script selects the registry path from the environment", async () => {
    await withDir(async (dir) => {
        const dataDir = path.join(dir, "env-data");
        const dataResult = runConfigure(dir, { CEV_SIM_DATA_DIR: dataDir });
        assertOk(dataResult);
        await assertOwnedLabGrant(path.join(dataDir, "visual-source-registry.json"));
        await assertMissing(defaultRegistry(dir));

        const registry = path.join(dir, "env-registry.json");
        const registryResult = runConfigure(dir, {
            CEV_SIM_DATA_DIR: path.join(dir, "unused-data"),
            CEV_SIM_VISUAL_SOURCE_REGISTRY: registry,
        });
        assertOk(registryResult);
        await assertOwnedLabGrant(registry);
        await assertMissing(path.join(dir, "unused-data", "visual-source-registry.json"));

        const relative = runConfigure(dir, { CEV_SIM_VISUAL_SOURCE_REGISTRY: "relative/registry.json" });
        assertOk(relative);
        await assertOwnedLabGrant(path.join(dir, "relative", "registry.json"));

        const home = path.join(dir, "home");
        const tilde = runConfigure(dir, {
            HOME: home,
            CEV_SIM_VISUAL_SOURCE_REGISTRY: "~/grants.json",
        });
        assertOk(tilde);
        await assertOwnedLabGrant(path.join(home, "grants.json"));
    });
});

test("install script selects the registry path from .env.local", async () => {
    await withDir(async (dir) => {
        const envFile = path.join(dir, ".env.local");
        const dataEnv = [
            "# comment",
            "CEV_SIM_MARKETPLACE_ENABLED=1",
            "CEV_SIM_DATA_DIR='from-local'",
            "CEV_SIM_DATA_DIR=second-dir",
        ].join("\n");
        await fs.writeFile(envFile, `${dataEnv}\n`);
        assertOk(runConfigure(dir));
        await assertOwnedLabGrant(path.join(dir, "from-local", "visual-source-registry.json"));
        await assertMissing(path.join(dir, "second-dir", "visual-source-registry.json"));
        await assertMissing(defaultRegistry(dir));
        assert.equal(await fs.readFile(envFile, "utf8"), `${dataEnv}\n`);

        const registryEnv = 'CEV_SIM_DATA_DIR=unused-data\nCEV_SIM_VISUAL_SOURCE_REGISTRY="quoted/registry.json"\n';
        await fs.writeFile(envFile, registryEnv);
        const quotedDir = await fs.mkdtemp(path.join(os.tmpdir(), "cev-install-registry-"));
        try {
            await fs.writeFile(path.join(quotedDir, ".env.local"), registryEnv);
            assertOk(runConfigure(quotedDir));
            await assertOwnedLabGrant(path.join(quotedDir, "quoted", "registry.json"));
            await assertMissing(path.join(quotedDir, "unused-data", "visual-source-registry.json"));
            assert.equal(await fs.readFile(path.join(quotedDir, ".env.local"), "utf8"), registryEnv);
        } finally {
            await fs.rm(quotedDir, { recursive: true, force: true });
        }
    });
});

test("install script lets the process environment override .env.local", async () => {
    await withDir(async (dir) => {
        const envFile = path.join(dir, ".env.local");
        const contents = "CEV_SIM_VISUAL_SOURCE_REGISTRY=from-file.json\nCEV_SIM_DATA_DIR=from-file-data\n";
        await fs.writeFile(envFile, contents);
        const registry = path.join(dir, "from-env.json");
        assertOk(runConfigure(dir, { CEV_SIM_VISUAL_SOURCE_REGISTRY: registry }));
        await assertOwnedLabGrant(registry);
        await assertMissing(path.join(dir, "from-file.json"));
        await assertMissing(path.join(dir, "from-file-data", "visual-source-registry.json"));
        assert.equal(await fs.readFile(envFile, "utf8"), contents);
    });
});

test("install script follows an empty registry assignment to the data directory", async () => {
    await withDir(async (dir) => {
        await fs.writeFile(
            path.join(dir, ".env.local"),
            "CEV_SIM_VISUAL_SOURCE_REGISTRY=\nCEV_SIM_VISUAL_SOURCE_REGISTRY=\"\"\nCEV_SIM_DATA_DIR=after-empty\n",
        );
        assertOk(runConfigure(dir));
        await assertOwnedLabGrant(path.join(dir, "after-empty", "visual-source-registry.json"));
        await assertMissing(defaultRegistry(dir));
    });
});

test("install script stops when .env.local has an unsupported registry path", async () => {
    await withDir(async (dir) => {
        await fs.writeFile(
            path.join(dir, ".env.local"),
            "CEV_SIM_VISUAL_SOURCE_REGISTRY=\"unterminated\n",
        );
        const result = runConfigure(dir);
        assertFailed(result);
        assert.match(result.stderr, /Unsupported CEV_SIM_VISUAL_SOURCE_REGISTRY assignment/);
        await assertMissing(defaultRegistry(dir));
    });
});
