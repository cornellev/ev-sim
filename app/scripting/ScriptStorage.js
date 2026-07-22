import { storageDelete, storageGet, storagePut } from "../client/storageClient.js";

/**
 * Persistence for visual scripts and their settings.
 *
 * Previously this used the browser's IndexedDB. It now reads and writes through
 * the server storage API instead, so edits are saved on the backend rather than
 * locally in the browser. The exported function signatures are unchanged, so
 * callers (Scripting.js, ScriptRuntime.js, BindingStorage.js, ...) need no edits.
 */

export async function listScriptDocuments() {
    const documents = await storageGet("scripts");
    return Array.isArray(documents) ? documents : [];
}

export async function getScriptDocument(id) {
    return storageGet(`scripts/${encodeURIComponent(id)}`);
}

export async function putScriptDocument(document) {
    await storagePut(`scripts/${encodeURIComponent(document.id)}`, document);
    return document;
}

export async function deleteScriptDocument(id) {
    await storageDelete(`scripts/${encodeURIComponent(id)}`);
    return true;
}

export async function getScriptSetting(key) {
    const result = await storageGet(`settings/${encodeURIComponent(key)}`);
    return result?.value ?? null;
}

export async function putScriptSetting(key, value) {
    await storagePut(`settings/${encodeURIComponent(key)}`, { value });
    return value;
}
