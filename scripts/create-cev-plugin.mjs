#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { defaultCevSimEngineRange } from "../app/plugin/PluginEngineRange.js";
import { assertPlantModuleBytes } from "../app/plugin/PlantModule.js";
import { PluginHost } from "../app/plugin/PluginHost.js";
import { PluginLoader } from "../app/plugin/PluginLoader.js";
import { createPluginPackage } from "../app/plugin/PluginPackage.js";
import { PLUGIN_ID_PATTERN } from "../app/plugin/PluginSelection.js";
import { buildLocalPlantPackage } from "../server/plugins/plantBuild.js";
import { BlockRegistry } from "../app/scripting/BlockRegistry.js";
import { NodePluginModuleSource } from "../server/plugins/NodePluginModuleSource.js";
import { PluginStore } from "../server/storage/PluginStore.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = JSON.parse(await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf8"));

const SVG_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor"/></svg>
`;

export function parseCreatePluginArgs(argv = process.argv.slice(2)) {
    const { values } = parseArgs({
        args: argv,
        options: {
            id: { type: "string" },
            out: { type: "string" },
            name: { type: "string" },
            category: { type: "string", default: "math" },
            "with-ui": { type: "boolean", default: true },
            "no-ui": { type: "boolean", default: false },
            verify: { type: "boolean", default: true },
            "no-verify": { type: "boolean", default: false },
            kind: { type: "string", default: "unit" },
            help: { type: "boolean", default: false },
        },
        allowPositionals: false,
    });
    const kind = values.kind || "unit";
    if (kind !== "unit" && kind !== "plant") throw new Error("--kind must be unit or plant.");
    return {
        id: values.id,
        out: values.out,
        name: values.name,
        kind,
        category: values.category,
        withUi: values["no-ui"] === true ? false : values["with-ui"] !== false,
        verify: values["no-verify"] === true ? false : values.verify !== false,
        help: values.help === true,
    };
}

export function assertPluginScaffoldId(id) {
    const normalized = String(id ?? "").trim();
    if (!PLUGIN_ID_PATTERN.test(normalized) || normalized === "cev" || normalized.startsWith("cev.")) {
        throw new Error("Plugin id must be a lowercase dotted ID outside the reserved cev namespace.");
    }
    return normalized;
}

function titleFromId(id) {
    const leaf = id.split(".").at(-1) || "plugin";
    return leaf.replace(/(^|[-])(\w)/g, (_match, _sep, letter) => letter.toUpperCase());
}

function crateName(pluginId) {
    return pluginId.replaceAll(".", "_").replaceAll("-", "_");
}

export function scaffoldPlantFiles({
    id,
    simulatorVersion = PACKAGE_JSON.version,
} = {}) {
    const pluginId = assertPluginScaffoldId(id);
    const plantId = `${pluginId}.bicycle`;
    const crate = crateName(pluginId);
    const document = {
        kind: "cev-sim.plugin",
        api: 1,
        id: pluginId,
        version: "1.0.0",
        engines: { cevSim: defaultCevSimEngineRange(simulatorVersion) },
        capabilities: ["plant.step"],
        units: [],
        systems: [],
        plants: [{
            id: plantId,
            abi: 1,
            module: "plant.wasm",
            parameters: [
                { key: "wheelbase", source: "kinematics.wheelbase" },
                { key: "maxSteeringAngle", source: "kinematics.maxSteeringAngle" },
            ],
        }],
    };
    const lib = `#![allow(static_mut_refs)]

mod abi;

pub struct PlantState {
    pub position: [f64; 3],
    pub rotation: [f64; 3],
    pub velocity: [f64; 3],
    pub acceleration: [f64; 3],
    pub steering: f64,
}

fn parameter(params: &[f64], index: usize, fallback: f64) -> f64 {
    params.get(index).copied().unwrap_or(fallback)
}

pub fn step(state: &mut PlantState, params: &[f64], dt: f64) -> i32 {
    let wheelbase = parameter(params, 0, 1.5).max(1.0e-9);
    let maximum = parameter(params, 1, 0.6).min(std::f64::consts::PI * 0.49);
    state.velocity[0] += state.acceleration[0] * dt;
    state.velocity[1] += state.acceleration[1] * dt;
    state.velocity[2] += state.acceleration[2] * dt;
    let speed = state.velocity[0];
    let steering = state.steering.clamp(-maximum, maximum);
    let yaw = state.rotation[1];
    state.position[0] += yaw.cos() * speed * dt;
    state.position[2] += -yaw.sin() * speed * dt;
    state.rotation[1] += (speed / wheelbase) * steering.tan() * dt;
    let _ = steering;
    0
}
`;
    const abi = `use crate::{step, PlantState};

const STATE_LEN: usize = 13;
const PARAM_CAP: usize = 32;

static mut PLANT_BUFFER: [f64; STATE_LEN + PARAM_CAP] = [0.0; STATE_LEN + PARAM_CAP];

#[no_mangle]
pub extern "C" fn cev_plant_abi() -> i32 {
    1
}

#[no_mangle]
pub extern "C" fn cev_plant_buffer() -> *mut f64 {
    unsafe { PLANT_BUFFER.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn cev_plant_step(params_len: i32, dt: f64) -> i32 {
    unsafe {
        let values = &mut PLANT_BUFFER;
        let mut state = PlantState {
            position: [values[0], values[1], values[2]],
            rotation: [values[3], values[4], values[5]],
            velocity: [values[6], values[7], values[8]],
            acceleration: [values[9], values[10], values[11]],
            steering: values[12],
        };
        let count = usize::try_from(params_len.max(0)).unwrap_or(0).min(PARAM_CAP);
        let code = step(&mut state, &values[STATE_LEN..STATE_LEN + count], dt);
        values[0] = state.position[0];
        values[1] = state.position[1];
        values[2] = state.position[2];
        values[3] = state.rotation[0];
        values[4] = state.rotation[1];
        values[5] = state.rotation[2];
        values[6] = state.velocity[0];
        values[7] = state.velocity[1];
        values[8] = state.velocity[2];
        values[9] = state.acceleration[0];
        values[10] = state.acceleration[1];
        values[11] = state.acceleration[2];
        values[12] = state.steering;
        code
    }
}
`;
    return {
        pluginId,
        plantId,
        document,
        files: {
            "plugin.json": `${JSON.stringify(document, null, 2)}\n`,
            "Cargo.toml": `[package]
name = "${crate}"
version = "1.0.0"
edition = "2021"

[lib]
crate-type = ["rlib", "cdylib"]

[profile.release]
opt-level = "s"
lto = true
panic = "abort"
strip = true
`,
            "Cargo.lock": `# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 3

[[package]]
name = "${crate}"
version = "1.0.0"
`,
            "rust-toolchain.toml": `[toolchain]
channel = "1.81.0"
targets = ["wasm32-unknown-unknown"]
`,
            "src/lib.rs": lib,
            "src/abi.rs": abi,
            ".gitignore": "/target/\n*.wasm\n",
        },
    };
}

export function scaffoldPluginFiles({
    id,
    name,
    kind = "unit",
    category = "math",
    withUi = true,
    simulatorVersion = PACKAGE_JSON.version,
} = {}) {
    if (kind === "plant") return scaffoldPlantFiles({ id, simulatorVersion });
    const pluginId = assertPluginScaffoldId(id);
    const catalogName = String(name || titleFromId(pluginId)).trim();
    const unitType = `${pluginId}.ScaleBlock`;
    const document = {
        kind: "cev-sim.plugin",
        api: 1,
        id: pluginId,
        version: "1.0.0",
        engines: { cevSim: defaultCevSimEngineRange(simulatorVersion) },
        entry: {
            runtime: "runtime/index.js",
            ...(withUi ? { ui: "ui/index.js" } : {}),
        },
        capabilities: [],
        units: [{
            type: unitType,
            ports: {
                inputs: { value: "float64" },
                outputs: { result: "float64" },
            },
            settings: [{
                target: "state",
                key: "factor",
                valueType: "float64",
                default: 2,
            }],
            defaults: { factor: 2 },
            catalog: {
                name: catalogName,
                category,
                keywords: ["scale"],
                placeable: true,
                deprecated: false,
                requiresSignals: false,
            },
        }],
        systems: [],
        ...(withUi ? { editor: { assets: ["ui/icon.svg"] } } : {}),
    };
    const runtime = `const plugin = {
    register(api) {
        class ScaleBlock extends api.UnitBlock {
            register() {
                this.registerInput("value", "float64");
                this.registerOutput("result", "float64");
            }

            valid() {
                return this.hasInput("value");
            }

            execute() {
                return new api.BlockOutput().set("result", this.getInput("value") * this.state.factor);
            }
        }

        api.contributeUnit({ type: "${unitType}", blockClass: ScaleBlock });
    },
};

export default plugin;
`;
    const files = {
        "plugin.json": `${JSON.stringify(document, null, 2)}\n`,
        "runtime/index.js": runtime,
    };
    if (withUi) {
        files["ui/index.js"] = `const pluginUi = {
    registerUi(uiApi) {
        const { React, SettingsForm } = uiApi;
        function ScaleView(props) {
            return React.createElement(
                "div",
                { "data-plugin-view": "${pluginId}" },
                React.createElement(SettingsForm, {
                    uuid: props.uuid,
                    settings: props.settings,
                    state: props.state,
                }),
            );
        }
        uiApi.contributeUnitView({ type: "${unitType}", component: ScaleView });
    },
};

export default pluginUi;
`;
        files["ui/icon.svg"] = SVG_ICON;
    }
    return { pluginId, unitType, document, files };
}

export async function writePluginScaffold(options) {
    const out = path.resolve(String(options.out ?? "").trim());
    if (!out) throw new Error("--out is required.");
    const scaffold = scaffoldPluginFiles(options);
    for (const [relative, contents] of Object.entries(scaffold.files)) {
        const filePath = path.join(out, relative);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, contents);
    }
    const verifyPath = `${out}.verify.mjs`;
    const helperUrl = pathToFileURL(path.join(REPO_ROOT, "scripts/create-cev-plugin.mjs")).href;
    const verifySymbol = scaffold.document.plants ? "verifyPlantDirectory" : "verifyPluginDirectory";
    await fs.writeFile(verifyPath, `#!/usr/bin/env node
import { ${verifySymbol} } from ${JSON.stringify(helperUrl)};

await ${verifySymbol}(${JSON.stringify(out)});
process.stdout.write("plugin verify ok\\n");
`);
    return { ...scaffold, out, verifyPath };
}

async function collectPackageFiles(root, directory = root, files = {}) {
    for (const name of (await fs.readdir(directory)).sort()) {
        const filePath = path.join(directory, name);
        const stat = await fs.lstat(filePath);
        if (stat.isDirectory()) await collectPackageFiles(root, filePath, files);
        else files[path.relative(root, filePath).split(path.sep).join("/")] = new Uint8Array(await fs.readFile(filePath));
    }
    return files;
}

export async function verifyPluginDirectory(directory) {
    const root = path.resolve(directory);
    const files = await collectPackageFiles(root);
    const resource = createPluginPackage(files);
    assert.equal(resource.kind, "cev-sim.plugin-package");
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plugin-scaffold-"));
    try {
        const store = new PluginStore(temp);
        await store.putPackage(resource);
        const host = new PluginHost({ blockRegistry: new BlockRegistry({ allowPlugins: true }) });
        await new PluginLoader({
            host,
            moduleSource: new NodePluginModuleSource({ pluginStore: store }),
        }).loadPackage(resource);
        const document = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
        const type = document.units[0].type;
        const Block = host.blockRegistry.get(type);
        assert.equal(typeof Block, "function");
        const unit = new Block("scaffold");
        try {
            const state = unit.serializeState();
            assert.equal(typeof state, "object");
            assert.notEqual(state, null);
        } finally {
            unit.dispose();
        }
        return resource;
    } finally {
        await fs.rm(temp, { recursive: true, force: true });
    }
}

export async function verifyPlantDirectory(directory, { runCargo } = {}) {
    const root = path.resolve(directory);
    const document = JSON.parse(await fs.readFile(path.join(root, "plugin.json"), "utf8"));
    if (!Array.isArray(document.plants) || document.plants.length === 0) {
        throw new Error("Plant package must declare plants.");
    }
    const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cev-plant-verify-"));
    try {
        const built = await buildLocalPlantPackage({
            sourceDirectory: root,
            directoryKey: path.basename(root),
            storeRoot,
            document,
            ...(runCargo ? { runCargo } : {}),
        });
        try {
            const wasm = await fs.readFile(path.join(built.packageDirectory, document.plants[0].module));
            assertPlantModuleBytes(wasm, document.plants[0].module);
        } finally {
            await fs.rm(built.packageDirectory, { recursive: true, force: true });
        }
        return { skipped: false };
    } catch (error) {
        if (String(error?.message || "").includes("Install rustup to build plant plugins.")) {
            return { skipped: true, reason: error.message };
        }
        throw error;
    } finally {
        await fs.rm(storeRoot, { recursive: true, force: true });
    }
}

function helpText() {
    return `Create a cev-sim simulator plugin package.

Usage:
  node --experimental-default-type=module scripts/create-cev-plugin.mjs --id acme.demo --out ./plugins/acme.demo

Options:
  --id          Lowercase dotted plugin id (not under cev.*)
  --out         Package directory to write
  --name        Catalog display name
  --category    Catalog category (default: math)
  --kind        unit (default) or plant
  --with-ui     Include a UI entry and generic SettingsForm view (default)
  --no-ui       Runtime-only package
  --verify      Load the package after writing (default)
  --no-verify   Skip the load check
`;
}

async function main() {
    const options = parseCreatePluginArgs();
    if (options.help || !options.id || !options.out) {
        process.stdout.write(helpText());
        if (!options.help && (!options.id || !options.out)) process.exitCode = 1;
        return;
    }
    const written = await writePluginScaffold(options);
    process.stdout.write(`Wrote ${written.pluginId} to ${written.out}\n`);
    if (options.verify) {
        if (options.kind === "plant") {
            const result = await verifyPlantDirectory(written.out);
            process.stdout.write(result.skipped
                ? "plant verify skipped: cargo is not available\n"
                : "plugin verify ok\n");
        } else {
            await verifyPluginDirectory(written.out);
            process.stdout.write("plugin verify ok\n");
        }
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}
