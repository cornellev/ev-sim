import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createPluginPackage, verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../../app/plugin/PluginErrors.js";

const LIBRARY_KIND = "cev-sim.plugin-library";
const LIBRARY_VERSION = 1;

async function syncDirectory(directory) {
    const handle = await fs.open(directory, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function writeDurable(filePath, bytes) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const handle = await fs.open(filePath, "wx");
    try {
        await handle.writeFile(bytes);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function collectDirectoryFiles(root) {
    const files = [];
    const visit = async (directory, prefix = "") => {
        let names;
        try {
            names = await fs.readdir(directory);
        } catch (error) {
            if (error.code === "ENOENT") return;
            throw error;
        }
        names.sort();
        for (const name of names) {
            const relative = prefix ? `${prefix}/${name}` : name;
            const filePath = path.join(directory, name);
            const stat = await fs.lstat(filePath);
            if (stat.isSymbolicLink()) {
                throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin package member "${relative}" is a symlink.`, { path: relative });
            }
            if (stat.isDirectory()) await visit(filePath, relative);
            else if (stat.isFile()) files.push({ path: relative, bytes: new Uint8Array(await fs.readFile(filePath)) });
            else throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin package member "${relative}" is not a regular file.`, { path: relative });
        }
    };
    await visit(root);
    return files;
}

function packageMetadata(verified) {
    return Object.freeze({
        pluginId: verified.document.id,
        version: verified.document.version,
        packageHash: verified.resource.packageHash,
        runtimeHash: verified.resource.runtimeHash,
        ...(verified.resource.uiHash ? { uiHash: verified.resource.uiHash } : {}),
    });
}

export class PluginStore {
    constructor(dataDir) {
        this.root = path.join(dataDir, "plugins");
        this.casDir = path.join(this.root, "cas", "sha256");
        this.stagingDir = path.join(this.root, "staging");
        this.runtimeDir = path.join(this.root, "runtime");
        this.libraryPath = path.join(this.root, "library.json");
        this.libraryWrite = Promise.resolve();
    }

    _casPath(packageHash) {
        if (!/^[a-f0-9]{64}$/.test(String(packageHash))) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin package hash must be lowercase SHA-256.", { packageHash });
        }
        return path.join(this.casDir, packageHash);
    }

    async putPackage(resource) {
        const verified = verifyPluginPackage(resource);
        const destination = this._casPath(verified.resource.packageHash);
        try {
            const existing = await this.verifyPackage(verified.resource.packageHash);
            return existing.resource;
        } catch (error) {
            if (error.code !== "ENOENT") throw error;
        }
        await fs.mkdir(this.stagingDir, { recursive: true });
        await fs.mkdir(this.casDir, { recursive: true });
        const staging = path.join(this.stagingDir, randomUUID());
        try {
            await fs.mkdir(path.join(staging, "files"), { recursive: true });
            await writeDurable(path.join(staging, "resource.json"), `${JSON.stringify(verified.resource)}\n`);
            for (const [member, bytes] of verified.fileBytes) {
                await writeDurable(path.join(staging, "files", ...member.split("/")), bytes);
            }
            await syncDirectory(staging);
            try {
                await fs.rename(staging, destination);
                await syncDirectory(this.casDir);
            } catch (error) {
                if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
                await this.verifyPackage(verified.resource.packageHash);
            }
            return verified.resource;
        } finally {
            await fs.rm(staging, { recursive: true, force: true });
        }
    }

    async verifyPackage(packageHash) {
        const root = this._casPath(packageHash);
        const resource = JSON.parse(await fs.readFile(path.join(root, "resource.json"), "utf8"));
        const verified = verifyPluginPackage(resource);
        if (verified.resource.packageHash !== packageHash) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin CAS directory does not match its package hash.", { packageHash });
        }
        const diskFiles = await collectDirectoryFiles(path.join(root, "files"));
        const expected = [...verified.fileBytes.keys()].sort();
        const actual = diskFiles.map((entry) => entry.path).sort();
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin CAS membership does not match resource.json.", { packageHash });
        }
        for (const entry of diskFiles) {
            const wanted = verified.fileBytes.get(entry.path);
            if (wanted.byteLength !== entry.bytes.byteLength || !wanted.every((byte, index) => byte === entry.bytes[index])) {
                throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin CAS member "${entry.path}" is corrupt.`, { packageHash, path: entry.path });
            }
        }
        return verified;
    }

    async getPackage(packageHash) {
        return (await this.verifyPackage(packageHash)).resource;
    }

    async readFile(packageHash, relativePath) {
        const verified = await this.verifyPackage(packageHash);
        const member = String(relativePath ?? "");
        const bytes = verified.fileBytes.get(member);
        if (!bytes) throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin package does not contain "${member}".`, { packageHash, path: member });
        return new Uint8Array(bytes);
    }

    async installFromDirectory(directory) {
        const root = path.resolve(directory);
        const stat = await fs.lstat(root);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin install source must be a regular directory.");
        }
        const files = await collectDirectoryFiles(root);
        const resource = createPluginPackage(files);
        await this.putPackage(resource);
        return this.installFromHash(resource.packageHash);
    }

    async _readLibrary() {
        try {
            const document = JSON.parse(await fs.readFile(this.libraryPath, "utf8"));
            if (document.kind !== LIBRARY_KIND || document.version !== LIBRARY_VERSION
                || !Number.isSafeInteger(document.revision) || document.revision < 0 || !Array.isArray(document.packages)) {
                throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin library index is invalid.");
            }
            return document;
        } catch (error) {
            if (error.code === "ENOENT") return { kind: LIBRARY_KIND, version: LIBRARY_VERSION, revision: 0, packages: [] };
            throw error;
        }
    }

    async _writeLibrary(document) {
        await fs.mkdir(this.root, { recursive: true });
        const temporary = `${this.libraryPath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeDurable(temporary, `${JSON.stringify(document, null, 2)}\n`);
            await fs.rename(temporary, this.libraryPath);
            await syncDirectory(this.root);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }

    _withLibraryWrite(operation) {
        const request = this.libraryWrite.catch(() => {}).then(operation);
        this.libraryWrite = request;
        return request;
    }

    async installFromHash(packageHash) {
        const verified = await this.verifyPackage(packageHash);
        const metadata = packageMetadata(verified);
        return this._withLibraryWrite(async () => {
            const library = await this._readLibrary();
            if (library.packages.some((entry) => entry.pluginId === metadata.pluginId && entry.packageHash === metadata.packageHash)) {
                return metadata;
            }
            const packages = [...library.packages, metadata]
                .sort((left, right) => left.pluginId.localeCompare(right.pluginId)
                    || left.version.localeCompare(right.version)
                    || left.packageHash.localeCompare(right.packageHash));
            await this._writeLibrary({ ...library, revision: library.revision + 1, packages });
            return metadata;
        });
    }

    async listInstalled() {
        await this.libraryWrite.catch(() => {});
        const library = await this._readLibrary();
        return { revision: library.revision, packages: library.packages.map((entry) => ({ ...entry })) };
    }

    async removeFromLibrary(pluginId, packageHash) {
        return this._withLibraryWrite(async () => {
            const library = await this._readLibrary();
            const packages = library.packages.filter((entry) => !(entry.pluginId === pluginId && entry.packageHash === packageHash));
            if (packages.length === library.packages.length) return false;
            await this._writeLibrary({ ...library, revision: library.revision + 1, packages });
            return true;
        });
    }
}
