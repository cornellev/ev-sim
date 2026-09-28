import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import semver from "semver";

import { compareUtf8 } from "../../app/math/compareUtf8.js";
import { createPluginPackage, verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../../app/plugin/PluginErrors.js";
import {
    assertCanonicalUuid,
    assertMarketplaceId,
    assertReleaseVersion,
    assertSha256,
} from "../marketplace/MarketplaceFormats.js";
import {
    PORTABLE_PLUGIN_MAX_JSON_BYTES,
    assertPortablePluginLimits,
    collectPluginDirectory,
    parsePortablePluginFile,
} from "../plugins/PortablePluginFile.js";

const LIBRARY_KIND = "cev-sim.plugin-library";
const LEGACY_LIBRARY_VERSION = 1;
const LIBRARY_VERSION = 2;

function invalidLibrary(message) {
    throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, `Plugin library index is invalid: ${message}`);
}

function exactKeys(value, required, optional, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalidLibrary(`${label} must be an object.`);
    const allowed = new Set([...required, ...optional]);
    for (const key of required) if (!Object.hasOwn(value, key)) invalidLibrary(`${label}.${key} is required.`);
    for (const key of Object.keys(value)) if (!allowed.has(key)) invalidLibrary(`${label}.${key} is not allowed.`);
}

function libraryHash(value, label) {
    try {
        assertSha256(value, label);
    } catch {
        invalidLibrary(`${label} must be lowercase SHA-256.`);
    }
    return value;
}

function normalizePackageMetadata(value, label, { ownership = false } = {}) {
    exactKeys(
        value,
        ["pluginId", "version", "packageHash", "runtimeHash", ...(ownership ? ["ownership"] : [])],
        ["uiHash"],
        label,
    );
    try {
        assertMarketplaceId(value.pluginId, `${label}.pluginId`);
        if (value.pluginId === "cev" || value.pluginId.startsWith("cev.")) {
            invalidLibrary(`${label}.pluginId uses the reserved cev namespace.`);
        }
        if (typeof value.version !== "string" || !semver.valid(value.version)) {
            invalidLibrary(`${label}.version must be valid SemVer.`);
        }
    } catch (error) {
        invalidLibrary(error.message);
    }
    const metadata = {
        pluginId: value.pluginId,
        version: value.version,
        packageHash: libraryHash(value.packageHash, `${label}.packageHash`),
        runtimeHash: libraryHash(value.runtimeHash, `${label}.runtimeHash`),
        ...(value.uiHash === undefined ? {} : { uiHash: libraryHash(value.uiHash, `${label}.uiHash`) }),
    };
    return ownership ? { ...metadata, ownership: normalizeOwnership(value.ownership, `${label}.ownership`) } : metadata;
}

function normalizeMarketplaceOwner(value, label = "marketplace owner") {
    exactKeys(value, ["sourceId", "itemId", "releaseVersion", "artifactSha256"], [], label);
    try {
        assertCanonicalUuid(value.sourceId, `${label}.sourceId`);
        assertMarketplaceId(value.itemId, `${label}.itemId`);
        assertReleaseVersion(value.releaseVersion, `${label}.releaseVersion`);
        assertSha256(value.artifactSha256, `${label}.artifactSha256`);
    } catch (error) {
        invalidLibrary(error.message);
    }
    return {
        sourceId: value.sourceId,
        itemId: value.itemId,
        releaseVersion: value.releaseVersion,
        artifactSha256: value.artifactSha256,
    };
}

function marketplaceOwnerKey(value) {
    return `${value.sourceId}\u0000${value.itemId}\u0000${value.releaseVersion}\u0000${value.artifactSha256}`;
}

function normalizeOwnership(value, label = "ownership") {
    exactKeys(value, ["manual", "marketplace"], [], label);
    if (typeof value.manual !== "boolean" || !Array.isArray(value.marketplace)) {
        invalidLibrary(`${label} must contain a boolean manual flag and marketplace array.`);
    }
    const marketplace = value.marketplace.map((entry, index) => normalizeMarketplaceOwner(entry, `${label}.marketplace.${index}`))
        .sort((left, right) => compareUtf8(marketplaceOwnerKey(left), marketplaceOwnerKey(right)));
    if (new Set(marketplace.map(marketplaceOwnerKey)).size !== marketplace.length) {
        invalidLibrary(`${label}.marketplace contains duplicate owners.`);
    }
    if (!value.manual && marketplace.length === 0) invalidLibrary(`${label} has no owner.`);
    return { manual: value.manual, marketplace };
}

function packageKey(value) {
    return `${value.pluginId}\u0000${value.version}\u0000${value.packageHash}`;
}

function normalizeLibraryDocument(value) {
    exactKeys(value, ["kind", "version", "revision", "packages"], [], "library");
    if (value.kind !== LIBRARY_KIND || ![LEGACY_LIBRARY_VERSION, LIBRARY_VERSION].includes(value.version)
        || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.packages)) {
        invalidLibrary("unsupported document header.");
    }
    const migrated = value.version === LEGACY_LIBRARY_VERSION;
    const packages = value.packages.map((entry, index) => {
        const metadata = normalizePackageMetadata(entry, `library.packages.${index}`, { ownership: !migrated });
        return migrated ? { ...metadata, ownership: { manual: true, marketplace: [] } } : metadata;
    }).sort((left, right) => compareUtf8(packageKey(left), packageKey(right)));
    if (new Set(packages.map(packageKey)).size !== packages.length) invalidLibrary("packages contains duplicate entries.");
    return {
        document: { kind: LIBRARY_KIND, version: LIBRARY_VERSION, revision: value.revision, packages },
        migrated,
    };
}

function publicMetadata(entry) {
    const { ownership: _ownership, ...metadata } = entry;
    return metadata;
}

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

async function collectCasFiles(root) {
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
        const diskFiles = await collectCasFiles(path.join(root, "files"));
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
        const files = await collectPluginDirectory(directory);
        const resource = createPluginPackage(files);
        assertPortablePluginLimits(resource);
        return this.installFromBytes(new TextEncoder().encode(JSON.stringify(resource)));
    }

    async installFromFile(filePath) {
        const absolute = path.resolve(filePath);
        const stat = await fs.lstat(absolute);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin file installs require a regular, non-symlink file.");
        }
        if (stat.size > PORTABLE_PLUGIN_MAX_JSON_BYTES) {
            throw pluginError(
                PLUGIN_ERROR_CODES.INTEGRITY,
                `Portable plugin file exceeds ${PORTABLE_PLUGIN_MAX_JSON_BYTES} bytes.`,
            );
        }
        const bytes = new Uint8Array(await fs.readFile(absolute));
        if (bytes.byteLength !== stat.size) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Portable plugin file is truncated.");
        }
        return this.installFromBytes(bytes);
    }

    async installFromBytes(bytes) {
        const resource = parsePortablePluginFile(bytes);
        const verified = verifyPluginPackage(resource);
        await this.putPackage(verified.resource);
        return this.installFromHash(verified.resource.packageHash);
    }

    async _readLibrary() {
        try {
            const document = JSON.parse(await fs.readFile(this.libraryPath, "utf8"));
            return normalizeLibraryDocument(document);
        } catch (error) {
            if (error.code === "ENOENT") return {
                document: { kind: LIBRARY_KIND, version: LIBRARY_VERSION, revision: 0, packages: [] },
                migrated: false,
            };
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

    ensureOwnershipMigration() {
        return this._withLibraryWrite(async () => {
            const { document, migrated } = await this._readLibrary();
            if (migrated) await this._writeLibrary(document);
            return { revision: document.revision, migrated };
        });
    }

    async snapshotWithOwners() {
        await this.ensureOwnershipMigration();
        await this.libraryWrite.catch(() => {});
        const { document } = await this._readLibrary();
        return structuredClone(document);
    }

    async addManualOwner(packageHash) {
        const verified = await this.verifyPackage(packageHash);
        const metadata = packageMetadata(verified);
        return this._withLibraryWrite(async () => {
            const { document: library, migrated } = await this._readLibrary();
            const current = library.packages.find((entry) => entry.pluginId === metadata.pluginId && entry.packageHash === metadata.packageHash);
            if (current?.ownership.manual) {
                if (migrated) await this._writeLibrary(library);
                return metadata;
            }
            const packages = current
                ? library.packages.map((entry) => entry === current
                    ? { ...entry, ownership: { ...entry.ownership, manual: true } }
                    : entry)
                : [...library.packages, { ...metadata, ownership: { manual: true, marketplace: [] } }];
            packages.sort((left, right) => compareUtf8(packageKey(left), packageKey(right)));
            await this._writeLibrary({ ...library, revision: library.revision + 1, packages });
            return metadata;
        });
    }

    installFromHash(packageHash) {
        return this.addManualOwner(packageHash);
    }

    async addMarketplaceOwner(resource, rawOwner) {
        const verified = verifyPluginPackage(resource);
        const owner = normalizeMarketplaceOwner(rawOwner);
        const metadata = packageMetadata(verified);
        await this.putPackage(verified.resource);
        return this._withLibraryWrite(async () => {
            const { document: library } = await this._readLibrary();
            const current = library.packages.find((entry) => entry.pluginId === metadata.pluginId && entry.packageHash === metadata.packageHash);
            if (current && (current.version !== metadata.version || current.runtimeHash !== metadata.runtimeHash
                || (current.uiHash ?? null) !== (metadata.uiHash ?? null))) {
                invalidLibrary("existing package metadata disagrees with verified CAS content.");
            }
            const key = marketplaceOwnerKey(owner);
            if (current?.ownership.marketplace.some((entry) => marketplaceOwnerKey(entry) === key)) {
                return {
                    package: metadata,
                    revision: library.revision,
                    membershipChanged: false,
                    ownerChanged: false,
                };
            }
            const marketplace = [...(current?.ownership.marketplace ?? []), owner]
                .sort((left, right) => compareUtf8(marketplaceOwnerKey(left), marketplaceOwnerKey(right)));
            const replacement = {
                ...(current ? publicMetadata(current) : metadata),
                ownership: { manual: current?.ownership.manual ?? false, marketplace },
            };
            const packages = current
                ? library.packages.map((entry) => entry === current ? replacement : entry)
                : [...library.packages, replacement];
            packages.sort((left, right) => compareUtf8(packageKey(left), packageKey(right)));
            const target = { ...library, revision: library.revision + 1, packages };
            await this._writeLibrary(target);
            return {
                package: metadata,
                revision: target.revision,
                membershipChanged: !current,
                ownerChanged: true,
            };
        });
    }

    async listInstalled() {
        await this.ensureOwnershipMigration();
        await this.libraryWrite.catch(() => {});
        const { document: library } = await this._readLibrary();
        return { revision: library.revision, packages: library.packages.map((entry) => ({ ...publicMetadata(entry) })) };
    }

    async removeManualOwner(pluginId, packageHash) {
        return this._withLibraryWrite(async () => {
            const { document: library, migrated } = await this._readLibrary();
            const current = library.packages.find((entry) => entry.pluginId === pluginId && entry.packageHash === packageHash);
            if (!current?.ownership.manual) {
                if (migrated) await this._writeLibrary(library);
                return { ownerChanged: false, membershipChanged: false, revision: library.revision };
            }
            const keepMembership = current.ownership.marketplace.length > 0;
            const packages = keepMembership
                ? library.packages.map((entry) => entry === current
                    ? { ...entry, ownership: { ...entry.ownership, manual: false } }
                    : entry)
                : library.packages.filter((entry) => entry !== current);
            const target = { ...library, revision: library.revision + 1, packages };
            await this._writeLibrary(target);
            return { ownerChanged: true, membershipChanged: !keepMembership, revision: target.revision };
        });
    }

    async removeMarketplaceOwner(pluginId, packageHash, rawOwner) {
        const owner = normalizeMarketplaceOwner(rawOwner);
        const ownerKey = marketplaceOwnerKey(owner);
        return this._withLibraryWrite(async () => {
            const { document: library } = await this._readLibrary();
            const current = library.packages.find((entry) => entry.pluginId === pluginId && entry.packageHash === packageHash);
            const hasOwner = current?.ownership.marketplace.some((entry) => marketplaceOwnerKey(entry) === ownerKey);
            if (!hasOwner) return { ownerChanged: false, membershipChanged: false, revision: library.revision };
            const marketplace = current.ownership.marketplace.filter((entry) => marketplaceOwnerKey(entry) !== ownerKey);
            const keepMembership = current.ownership.manual || marketplace.length > 0;
            const packages = keepMembership
                ? library.packages.map((entry) => entry === current
                    ? { ...entry, ownership: { ...entry.ownership, marketplace } }
                    : entry)
                : library.packages.filter((entry) => entry !== current);
            const target = { ...library, revision: library.revision + 1, packages };
            await this._writeLibrary(target);
            return { ownerChanged: true, membershipChanged: !keepMembership, revision: target.revision };
        });
    }

    async removeFromLibrary(pluginId, packageHash) {
        return (await this.removeManualOwner(pluginId, packageHash)).ownerChanged;
    }
}
