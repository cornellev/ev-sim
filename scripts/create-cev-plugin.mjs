#!/usr/bin/env node

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { PluginHost } from "../app/plugin/PluginHost.js";
import { PluginLoader } from "../app/plugin/PluginLoader.js";
import { createPluginPackage } from "../app/plugin/PluginPackage.js";
import { PLUGIN_ID_PATTERN } from "../app/plugin/PluginSelection.js";
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
            help: { type: "boolean", default: false },
        },
        allowPositionals: false,
    });
    return {
        id: values.id,
        out: values.out,
        name: values.name,
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

export function scaffoldPluginFiles({
    id,
    name,
    category = "math",
    withUi = true,
    simulatorVersion = PACKAGE_JSON.version,
} = {}) {
    const pluginId = assertPluginScaffoldId(id);
    const catalogName = String(name || titleFromId(pluginId)).trim();
    const unitType = `${pluginId}.ScaleBlock`;
    const major = Number.parseInt(String(simulatorVersion).split(".")[0], 10);
    const nextMajor = Number.isFinite(major) ? major + 1 : 1;
    const document = {
        kind: "cev-sim.plugin",
        api: 1,
        id: pluginId,
        version: "1.0.0",
        engines: { cevSim: `>=${simulatorVersion} <${nextMajor}.0.0` },
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
    await fs.writeFile(verifyPath, `#!/usr/bin/env node
import { verifyPluginDirectory } from ${JSON.stringify(helperUrl)};

await verifyPluginDirectory(${JSON.stringify(out)});
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

function helpText() {
    return `Create a cev-sim simulator plugin package.

Usage:
  node --experimental-default-type=module scripts/create-cev-plugin.mjs --id acme.demo --out ./plugins/acme.demo

Options:
  --id          Lowercase dotted plugin id (not under cev.*)
  --out         Package directory to write
  --name        Catalog display name
  --category    Catalog category (default: math)
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
        await verifyPluginDirectory(written.out);
        process.stdout.write("plugin verify ok\n");
    }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
    main().catch((error) => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
    });
}
