import { storageGet, storagePost } from "../client/storageClient.js";

export function listPluginLibrary() {
    return storageGet("plugins/library");
}

export async function listLocalPlugins() {
    const payload = await storageGet("plugins/local");
    if (!payload || payload.ok === false) {
        throw new Error(payload?.message || payload?.error || "Could not load local plugins.");
    }
    return payload;
}

export async function getPluginDocument(packageHash) {
    const document = await storageGet(`plugins/packages/${encodeURIComponent(packageHash)}/files/plugin.json`);
    if (!document || typeof document !== "object" || Array.isArray(document)) {
        throw new Error(`Plugin package ${packageHash} is missing plugin.json.`);
    }
    return document;
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

export async function installPluginFile(file) {
    const response = await fetch("/api/storage/plugins/install-file", {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/vnd.cev-sim.plugin-package+json",
        },
        body: file,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.message || payload?.error || "Plugin file install failed.");
    }
    return payload;
}

export function removePlugin({ pluginId, packageHash }) {
    return storagePost("plugins/remove", { pluginId, packageHash });
}

export async function fetchSensorCatalog() {
    const response = await fetch("/api/storage/plugins/sensors", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || payload?.message || "Could not load the sensor catalog.");
    }
    return payload;
}

export async function fetchUnitCatalog() {
    const response = await fetch("/api/scripting/units", { headers: { Accept: "application/json" } });
    const payload = await response.json();
    if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || "Could not load the unit catalog.");
    }
    return payload;
}
