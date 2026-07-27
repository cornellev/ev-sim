import { storageGet, storagePut } from "../../client/storageClient.js";
import { getScriptSetting } from "../ScriptStorage.js";
import { createBindingManifest, normalizeBindingManifest } from "./BindingDocument.js";

const MANIFEST_KEY = "bindings:manifest";

export async function getBindingManifest() {
    const canonical = await storageGet("bindings");
    if (canonical) {
        const normalized = normalizeBindingManifest(canonical);
        if (canonical.version !== normalized.version) {
            await storagePut("bindings", normalized);
        }
        return normalized;
    }

    const legacy = await getScriptSetting(MANIFEST_KEY);
    if (!legacy) return createBindingManifest();

    try {
        const migrated = normalizeBindingManifest(legacy);
        await storagePut("bindings", migrated);
        return migrated;
    } catch {
        return createBindingManifest();
    }
}

export async function putBindingManifest(manifest) {
    const normalized = normalizeBindingManifest({
        ...manifest,
        updatedAt: new Date().toISOString()
    });
    return storagePut("bindings", normalized);
}

export function serializeBindingManifest(manifest) {
    return JSON.stringify(normalizeBindingManifest(manifest), null, 2);
}

export function parseBindingManifest(json) {
    return normalizeBindingManifest(JSON.parse(json));
}
