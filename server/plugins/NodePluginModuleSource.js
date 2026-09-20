import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PLUGIN_ERROR_CODES, pluginError } from "../../app/plugin/PluginErrors.js";
import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";

async function regularFileBytes(filePath) {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Expected a regular file.");
    return new Uint8Array(await fs.readFile(filePath));
}

function bytesEqual(left, right) {
    if (left.byteLength !== right.byteLength) return false;
    return left.every((byte, index) => byte === right[index]);
}

async function collectRegularFiles(root, prefix = "") {
    const result = [];
    for (const name of (await fs.readdir(root)).sort()) {
        const filePath = path.join(root, name);
        const relative = prefix ? `${prefix}/${name}` : name;
        const stat = await fs.lstat(filePath);
        if (stat.isSymbolicLink()) throw new Error(`Materialized member "${relative}" is a symlink.`);
        if (stat.isDirectory()) result.push(...await collectRegularFiles(filePath, relative));
        else if (stat.isFile()) result.push(relative);
        else throw new Error(`Materialized member "${relative}" is not a regular file.`);
    }
    return result;
}

export class NodePluginModuleSource {
    constructor({ pluginStore, runtimeRoot = pluginStore?.runtimeDir } = {}) {
        if (!runtimeRoot) throw new Error("NodePluginModuleSource requires a runtime root or PluginStore.");
        this.runtimeRoot = runtimeRoot;
        this.materializations = new Map();
    }

    async _materialize(verified) {
        let operation = this.materializations.get(verified.resource.runtimeHash);
        if (!operation) {
            operation = this._materializeOnce(verified);
            this.materializations.set(verified.resource.runtimeHash, operation);
        }
        try {
            return await operation;
        } catch (error) {
            throw error;
        } finally {
            if (this.materializations.get(verified.resource.runtimeHash) === operation) {
                this.materializations.delete(verified.resource.runtimeHash);
            }
        }
    }

    async _materializeOnce(verified) {
        const root = path.join(this.runtimeRoot, verified.resource.runtimeHash);
        const filesRoot = path.join(root, "files");
        try {
            const stat = await fs.lstat(root);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Runtime root is not a regular directory.");
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
            return this._publishMaterialization(verified, root);
        }
        await this._verifyMaterialization(verified, root);
        return root;
    }

    async _verifyMaterialization(verified, root) {
        try {
            const rootMembers = (await fs.readdir(root)).sort();
            if (JSON.stringify(rootMembers) !== JSON.stringify(["files", "package.json"])) throw new Error("Runtime root membership is invalid.");
            const filesStat = await fs.lstat(path.join(root, "files"));
            if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) throw new Error("Runtime files root is invalid.");
            const markerBytes = await regularFileBytes(path.join(root, "package.json"));
            if (new TextDecoder().decode(markerBytes) !== "{\"type\":\"module\"}\n") throw new Error("Invalid ESM marker.");
            const actual = await collectRegularFiles(path.join(root, "files"));
            const expected = [...verified.runtimeFiles].sort();
            if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Runtime file membership is invalid.");
            for (const member of expected) {
                const disk = await regularFileBytes(path.join(root, "files", ...member.split("/")));
                if (!bytesEqual(disk, verified.fileBytes.get(member))) throw new Error(`Materialized member "${member}" is corrupt.`);
            }
        } catch (error) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin runtime cache ${verified.resource.runtimeHash} is invalid: ${error.message}`, {
                pluginId: verified.document.id,
                packageHash: verified.resource.packageHash,
                cause: error,
            });
        }
    }

    async _publishMaterialization(verified, root) {
        await fs.mkdir(this.runtimeRoot, { recursive: true });
        const staging = path.join(this.runtimeRoot, `.${verified.resource.runtimeHash}.${process.pid}.tmp`);
        await fs.rm(staging, { recursive: true, force: true });
        try {
            await fs.mkdir(path.join(staging, "files"), { recursive: true });
            await fs.writeFile(path.join(staging, "package.json"), "{\"type\":\"module\"}\n");
            for (const member of verified.runtimeFiles) {
                const destination = path.join(staging, "files", ...member.split("/"));
                await fs.mkdir(path.dirname(destination), { recursive: true });
                await fs.writeFile(destination, verified.fileBytes.get(member));
            }
            await fs.rename(staging, root);
        } catch (error) {
            if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
        }
        await this._verifyMaterialization(verified, root);
        return root;
    }

    async importRuntime(input) {
        const verified = input?.resource ? input : verifyPluginPackage(input);
        const root = await this._materialize(verified);
        const entry = path.join(root, "files", ...verified.document.entry.runtime.split("/"));
        return import(pathToFileURL(entry).href);
    }
}
