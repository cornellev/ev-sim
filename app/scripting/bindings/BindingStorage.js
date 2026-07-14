import { getScriptSetting, putScriptSetting } from "../ScriptStorage.js";
import { createBindingManifest, normalizeBindingManifest } from "./BindingDocument.js";

const MANIFEST_KEY = "bindings:manifest";

export async function getBindingManifest() {
    const stored = await getScriptSetting(MANIFEST_KEY);
    if (!stored) return createBindingManifest();

    try {
        return normalizeBindingManifest(stored);
    } catch {
        return createBindingManifest();
    }
}

export async function putBindingManifest(manifest) {
    const normalized = normalizeBindingManifest({
        ...manifest,
        updatedAt: new Date().toISOString()
    });
    await putScriptSetting(MANIFEST_KEY, normalized);
    return normalized;
}

export function serializeBindingManifest(manifest) {
    return JSON.stringify(normalizeBindingManifest(manifest), null, 2);
}

export function parseBindingManifest(json) {
    return normalizeBindingManifest(JSON.parse(json));
}
