import { storageGet, storagePost } from "../client/storageClient.js";

export function listPluginLibrary() {
    return storageGet("plugins/library");
}

export function getPluginPackage(packageHash) {
    return storageGet(`plugins/packages/${encodeURIComponent(packageHash)}`);
}

export async function getPluginManifest(packageHash) {
    const resource = await getPluginPackage(packageHash);
    const record = resource?.files?.find((entry) => entry.path === "plugin.json");
    if (!record?.data) throw new Error(`Plugin package ${packageHash} is missing plugin.json.`);
    const json = typeof atob === "function"
        ? atob(record.data)
        : Buffer.from(record.data, "base64").toString("utf8");
    return { resource, document: JSON.parse(json) };
}

export function installPlugin(source) {
    return storagePost("plugins/install", { source });
}

export function removePlugin({ pluginId, packageHash }) {
    return storagePost("plugins/remove", { pluginId, packageHash });
}

export async function fetchUnitCatalog() {
    const response = await fetch("/api/scripting/units", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || "Could not load the unit catalog.");
    }
    return payload;
}
