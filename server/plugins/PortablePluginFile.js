import { promises as fs } from "node:fs";
import path from "node:path";

import { PLUGIN_PACKAGE_KIND, PLUGIN_PACKAGE_VERSION } from "../../app/plugin/PluginPackage.js";
import { PLUGIN_ERROR_CODES, pluginError } from "../../app/plugin/PluginErrors.js";

export const PLUGIN_PACKAGE_MEDIA_TYPE = "application/vnd.cev-sim.plugin-package+json";
export const PORTABLE_PLUGIN_MAX_JSON_BYTES = 16 * 1024 * 1024;
export const PORTABLE_PLUGIN_MAX_MEMBERS = 256;
export const PORTABLE_PLUGIN_MAX_DECODED_BYTES = 8 * 1024 * 1024;
export const PORTABLE_PLUGIN_MAX_MEMBER_BYTES = 4 * 1024 * 1024;
export const PORTABLE_PLUGIN_MAX_PATH_BYTES = 240;

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

function integrity(message, fields = {}) {
    return pluginError(PLUGIN_ERROR_CODES.INTEGRITY, message, fields);
}

function pathByteLength(value) {
    return textEncoder.encode(String(value ?? "")).byteLength;
}

function memberSize(record) {
    if (Number.isSafeInteger(record?.sizeBytes) && record.sizeBytes >= 0) return record.sizeBytes;
    return null;
}

export async function collectPluginDirectory(directory) {
    const root = path.resolve(directory);
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw integrity("Plugin install source must be a regular directory.");
    }
    const files = [];
    const visit = async (current, prefix = "") => {
        const names = (await fs.readdir(current)).sort();
        for (const name of names) {
            const relative = prefix ? `${prefix}/${name}` : name;
            const filePath = path.join(current, name);
            const entry = await fs.lstat(filePath);
            if (entry.isSymbolicLink()) {
                throw integrity(`Plugin package member "${relative}" is a symlink.`, { path: relative });
            }
            if (entry.isDirectory()) {
                await visit(filePath, relative);
                continue;
            }
            if (!entry.isFile()) {
                throw integrity(`Plugin package member "${relative}" is not a regular file.`, { path: relative });
            }
            if (pathByteLength(relative) > PORTABLE_PLUGIN_MAX_PATH_BYTES) {
                throw integrity(
                    `Plugin package member "${relative}" path exceeds ${PORTABLE_PLUGIN_MAX_PATH_BYTES} UTF-8 bytes.`,
                    { path: relative },
                );
            }
            if (entry.size > PORTABLE_PLUGIN_MAX_MEMBER_BYTES) {
                throw integrity(
                    `Plugin package member "${relative}" exceeds ${PORTABLE_PLUGIN_MAX_MEMBER_BYTES} decoded bytes.`,
                    { path: relative },
                );
            }
            files.push({ path: relative, bytes: new Uint8Array(await fs.readFile(filePath)) });
            if (files.length > PORTABLE_PLUGIN_MAX_MEMBERS) {
                throw integrity(`Plugin package exceeds ${PORTABLE_PLUGIN_MAX_MEMBERS} members.`);
            }
        }
    };
    await visit(root);
    const decodedBytes = files.reduce((total, entry) => total + entry.bytes.byteLength, 0);
    if (decodedBytes > PORTABLE_PLUGIN_MAX_DECODED_BYTES) {
        throw integrity(`Plugin package decoded members exceed ${PORTABLE_PLUGIN_MAX_DECODED_BYTES} bytes.`);
    }
    return files;
}

export function assertPortablePluginLimits(resource) {
    if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
        throw integrity("Plugin package resource must be an object.");
    }
    if (resource.kind !== PLUGIN_PACKAGE_KIND || resource.version !== PLUGIN_PACKAGE_VERSION) {
        throw integrity(`Expected ${PLUGIN_PACKAGE_KIND} version ${PLUGIN_PACKAGE_VERSION}.`);
    }
    if (!Array.isArray(resource.files)) throw integrity("Plugin package files must be an array.");
    if (resource.files.length > PORTABLE_PLUGIN_MAX_MEMBERS) {
        throw integrity(`Plugin package exceeds ${PORTABLE_PLUGIN_MAX_MEMBERS} members.`);
    }
    let decodedBytes = 0;
    for (const record of resource.files) {
        const memberPath = String(record?.path ?? "");
        if (pathByteLength(memberPath) > PORTABLE_PLUGIN_MAX_PATH_BYTES) {
            throw integrity(
                `Plugin package member "${memberPath}" path exceeds ${PORTABLE_PLUGIN_MAX_PATH_BYTES} UTF-8 bytes.`,
                { path: memberPath },
            );
        }
        const size = memberSize(record);
        if (size == null) {
            throw integrity(`Plugin member "${memberPath}" metadata is invalid.`, { path: memberPath });
        }
        if (size > PORTABLE_PLUGIN_MAX_MEMBER_BYTES) {
            throw integrity(
                `Plugin package member "${memberPath}" exceeds ${PORTABLE_PLUGIN_MAX_MEMBER_BYTES} decoded bytes.`,
                { path: memberPath },
            );
        }
        decodedBytes += size;
        if (decodedBytes > PORTABLE_PLUGIN_MAX_DECODED_BYTES) {
            throw integrity(`Plugin package decoded members exceed ${PORTABLE_PLUGIN_MAX_DECODED_BYTES} bytes.`);
        }
    }
    return resource;
}

export function parsePortablePluginFile(bytes) {
    if (!(bytes instanceof Uint8Array) && !ArrayBuffer.isView(bytes) && !(bytes instanceof ArrayBuffer)) {
        throw integrity("Portable plugin file bytes are required.");
    }
    const buffer = bytes instanceof Uint8Array
        ? bytes
        : bytes instanceof ArrayBuffer
            ? new Uint8Array(bytes)
            : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (buffer.byteLength > PORTABLE_PLUGIN_MAX_JSON_BYTES) {
        throw integrity(`Portable plugin file exceeds ${PORTABLE_PLUGIN_MAX_JSON_BYTES} bytes.`);
    }
    let text;
    try {
        text = textDecoder.decode(buffer);
    } catch (error) {
        throw integrity("Portable plugin file is not valid UTF-8.", { cause: error });
    }
    let resource;
    try {
        resource = JSON.parse(text);
    } catch (error) {
        throw integrity(`Portable plugin file is not valid JSON: ${error.message}`, { cause: error });
    }
    return assertPortablePluginLimits(resource);
}
