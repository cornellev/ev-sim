import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

import { createPluginPackage, verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import {
    collectPluginDirectory,
    parsePortablePluginFile,
} from "./PortablePluginFile.js";

function usage() {
    return [
        "cev-sim-plugin pack --directory <plugin-dir> --output <package.json>",
        "cev-sim-plugin verify --file <package.json>",
    ].join("\n");
}

function fail(message, code = 1) {
    const error = new Error(message);
    error.exitCode = code;
    throw error;
}

export function parsePluginPackageCliArgs(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            directory: { type: "string" },
            output: { type: "string" },
            file: { type: "string" },
            help: { type: "boolean", default: false },
        },
    });
    return {
        command: positionals[0] || null,
        extra: positionals.slice(1),
        directory: values.directory || null,
        output: values.output || null,
        file: values.file || null,
        help: values.help === true,
    };
}

export async function packPluginDirectory({ directory, output }) {
    if (!directory || !output) fail("pack requires --directory and --output.");
    const files = await collectPluginDirectory(directory);
    const resource = createPluginPackage(files);
    const destination = path.resolve(output);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, `${JSON.stringify(resource)}\n`);
    return resource;
}

export async function verifyPluginFile({ file }) {
    if (!file) fail("verify requires --file.");
    const absolute = path.resolve(file);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        fail("Plugin verification requires a regular, non-symlink file.");
    }
    const bytes = new Uint8Array(await fs.readFile(absolute));
    const resource = parsePortablePluginFile(bytes);
    return verifyPluginPackage(resource);
}

export async function main(argv = process.argv.slice(2), io = {}) {
    const stdout = io.stdout ?? process.stdout;
    const stderr = io.stderr ?? process.stderr;
    try {
        const parsed = parsePluginPackageCliArgs(argv);
        if (parsed.help || !parsed.command) {
            stdout.write(`${usage()}\n`);
            return parsed.command && !parsed.help ? 2 : 0;
        }
        if (parsed.extra.length > 0) fail(`Unexpected argument: ${parsed.extra[0]}`, 2);
        if (parsed.command === "pack") {
            const resource = await packPluginDirectory(parsed);
            stdout.write(`${JSON.stringify({
                ok: true,
                command: "pack",
                output: path.resolve(parsed.output),
                packageHash: resource.packageHash,
                runtimeHash: resource.runtimeHash,
                ...(resource.uiHash ? { uiHash: resource.uiHash } : {}),
            })}\n`);
            return 0;
        }
        if (parsed.command === "verify") {
            const verified = await verifyPluginFile(parsed);
            stdout.write(`${JSON.stringify({
                ok: true,
                command: "verify",
                pluginId: verified.document.id,
                version: verified.document.version,
                packageHash: verified.resource.packageHash,
                runtimeHash: verified.resource.runtimeHash,
                ...(verified.resource.uiHash ? { uiHash: verified.resource.uiHash } : {}),
            })}\n`);
            return 0;
        }
        fail(`Unknown command ${parsed.command}.`, 2);
    } catch (error) {
        stderr.write(`${JSON.stringify({
            ok: false,
            error: error.code || "PLUGIN_REQUEST_INVALID",
            message: error.message,
            path: error.path ?? null,
        })}\n`);
        if (error.exitCode === 2) stderr.write(`${usage()}\n`);
        return error.exitCode || 1;
    }
    return 0;
}
