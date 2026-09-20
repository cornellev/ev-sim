import path from "node:path";

import { PLUGIN_ERROR_CODES, pluginError } from "../../app/plugin/PluginErrors.js";

export async function installPluginSource(storage, source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw pluginError(PLUGIN_ERROR_CODES.DOCUMENT_INVALID, "Plugin install source must be an object.");
    }
    if (source.kind === "directory") {
        const directory = String(source.path ?? "").trim();
        if (!directory || !path.isAbsolute(directory)) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin directory installs require an absolute path.");
        }
        return storage.installPluginFromDirectory(directory);
    }
    if (source.kind === "digest") {
        const packageHash = String(source.packageHash ?? "").trim();
        if (!/^[a-f0-9]{64}$/.test(packageHash)) {
            throw pluginError(PLUGIN_ERROR_CODES.INTEGRITY, "Plugin digest installs require a lowercase SHA-256 packageHash.");
        }
        return storage.installPluginFromHash(packageHash);
    }
    throw pluginError(PLUGIN_ERROR_CODES.DOCUMENT_INVALID, `Unsupported plugin install kind "${source.kind}".`);
}

export async function removePluginSource(storage, { pluginId, packageHash } = {}) {
    const id = String(pluginId ?? "").trim();
    const hash = String(packageHash ?? "").trim();
    if (!id || !/^[a-f0-9]{64}$/.test(hash)) {
        throw pluginError(PLUGIN_ERROR_CODES.DOCUMENT_INVALID, "Plugin removal requires pluginId and packageHash.");
    }
    return storage.removePluginFromLibrary(id, hash);
}
