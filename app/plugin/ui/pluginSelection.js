export function localPackageInstallState(entry, installedPackages) {
    if (!entry?.document || entry.error) return "unavailable";
    const pluginId = typeof entry.document.id === "string" && entry.document.id ? entry.document.id : entry.id;
    const version = typeof entry.document.version === "string" ? entry.document.version : "";
    const packages = Array.isArray(installedPackages) ? installedPackages : [];
    const installed = packages.some((item) => item?.pluginId === pluginId && item?.version === version);
    return installed ? "installed" : "detected";
}

export function selectLocalPackage(packages, currentDirectory) {
    const entries = Array.isArray(packages) ? packages : [];
    if (currentDirectory && entries.some((entry) => entry?.directory === currentDirectory)) return currentDirectory;
    return entries[0]?.directory ?? null;
}

export function selectPackageHash(packages, currentHash) {
    const entries = Array.isArray(packages) ? packages : [];
    if (currentHash && entries.some((entry) => entry?.packageHash === currentHash)) return currentHash;
    return entries[0]?.packageHash ?? null;
}
