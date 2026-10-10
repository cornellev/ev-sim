import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { localPackageInstallState } from "../app/plugin/ui/pluginSelection.js";
import { installDetectedPlugin, listLocalPlugins } from "../server/plugins/localPlugins.js";
import { plantSourceFingerprint, readLocalBuilds } from "../server/plugins/plantBuild.js";
import { PluginStore } from "../server/storage/PluginStore.js";
import { encodeBicyclePlantModule, encodeCountingPlantModule } from "../scripts/plant-wasm-module.mjs";
import { verifyPlantDirectory } from "../scripts/create-cev-plugin.mjs";

const wasm32 = spawnSync("rustup", ["target", "list", "--installed"], { encoding: "utf8" });
const cargoReady = wasm32.status === 0 && wasm32.stdout.includes("wasm32-unknown-unknown");

function document() {
    return {
        kind: "cev-sim.plugin",
        api: 1,
        id: "acme.dynamics",
        version: "1.0.0",
        engines: { cevSim: ">=0.1.0 <0.3.0" },
        capabilities: ["plant.step"],
        units: [],
        systems: [],
        plants: [{
            id: "acme.dynamics.bicycle",
            abi: 1,
            module: "plant.wasm",
            parameters: [{ key: "wheelbase", source: "kinematics.wheelbase" }],
        }],
    };
}

async function writePackage(root) {
    const directory = path.join(root, "acme.dynamics");
    await fs.mkdir(path.join(directory, "src"), { recursive: true });
    await fs.writeFile(path.join(directory, "plugin.json"), JSON.stringify(document()));
    await fs.writeFile(path.join(directory, "Cargo.toml"), "[package]\nname = \"acme_dynamics\"\nversion = \"1.0.0\"\n");
    await fs.writeFile(path.join(directory, "src", "lib.rs"), "pub fn step() {}\n");
    return directory;
}

function fakeCargo(artifactBytes) {
    return async ({ cwd, targetDir }) => {
        await fs.mkdir(targetDir, { recursive: true });
        const artifact = path.join(targetDir, "acme_dynamics.wasm");
        await fs.writeFile(artifact, artifactBytes);
        return {
            stdout: `${JSON.stringify({
                reason: "compiler-artifact",
                target: { src_path: path.join(cwd, "src", "lib.rs"), kind: ["cdylib"] },
                filenames: [artifact],
            })}\n`,
            stderr: "",
        };
    };
}

test("local install builds a plant package without writing the source tree", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plant-build-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const pluginsRoot = path.join(root, "plugins");
    const source = await writePackage(pluginsRoot);
    const before = await fs.readFile(path.join(source, "src", "lib.rs"));
    const store = new PluginStore(path.join(root, "data"));
    const storage = {
        plugins: store,
        installPluginFromDirectory: (directory) => store.installFromDirectory(directory),
    };
    const metadata = await installDetectedPlugin(storage, "acme.dynamics", pluginsRoot, {
        runCargo: fakeCargo(encodeBicyclePlantModule()),
    });
    assert.equal(metadata.pluginId, "acme.dynamics");
    assert.deepEqual(await fs.readFile(path.join(source, "src", "lib.rs")), before);
    await assert.rejects(fs.access(path.join(source, "plant.wasm")));
    const builds = await readLocalBuilds(store.root);
    assert.equal(builds.length, 1);
    assert.equal(builds[0].packageHash, metadata.packageHash);
    const rows = await listLocalPlugins(pluginsRoot);
    assert.equal(rows[0].sourceFingerprint, builds[0].sourceFingerprint);
    assert.equal(localPackageInstallState(rows[0], [metadata], builds), "installed");

    await fs.writeFile(path.join(source, "src", "lib.rs"), "pub fn step() { let _ = 1; }\n");
    const updated = await listLocalPlugins(pluginsRoot);
    assert.equal(localPackageInstallState(updated[0], [metadata], builds), "update-available");
    const sibling = path.join(pluginsRoot, "acme-dynamics-zenoh", "src");
    await fs.mkdir(sibling, { recursive: true });
    const fingerprint = await plantSourceFingerprint(source);
    await fs.writeFile(path.join(sibling, "main.rs"), "fn main() {}\n");
    assert.equal(await plantSourceFingerprint(source), fingerprint);

    const next = await installDetectedPlugin(storage, "acme.dynamics", pluginsRoot, {
        runCargo: fakeCargo(encodeCountingPlantModule()),
    });
    assert.notEqual(next.packageHash, metadata.packageHash);
    assert.equal((await store.getPackage(metadata.packageHash)).packageHash, metadata.packageHash);
    assert.equal((await store.listInstalled()).packages.length, 2);
});

test("a failed plant build reports diagnostics and leaves the library empty", async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plant-fail-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const pluginsRoot = path.join(root, "plugins");
    await writePackage(pluginsRoot);
    const store = new PluginStore(path.join(root, "data"));
    const storage = {
        plugins: store,
        installPluginFromDirectory: (directory) => store.installFromDirectory(directory),
    };
    await assert.rejects(() => installDetectedPlugin(storage, "acme.dynamics", pluginsRoot, {
        runCargo: async () => {
            throw new Error("rustc failed: unresolved import");
        },
    }), (error) => error.code === "PLUGIN_BUILD_FAILED" && /unresolved import/.test(error.message));
    assert.equal((await store.listInstalled()).packages.length, 0);
    assert.deepEqual(await readLocalBuilds(store.root), []);
});

test("cargo plant verify runs only when CEV_PLANT_CARGO=1 and wasm32 is installed", {
    skip: process.env.CEV_PLANT_CARGO !== "1" || !cargoReady,
}, async () => {
    await verifyPlantDirectory(path.resolve("tests/fixtures/plugins/test.plant-fixture"));
});
