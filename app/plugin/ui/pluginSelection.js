export function localPackageImported(entry, installedPackages) {
    const pluginId = typeof entry?.document?.id === "string" && entry.document.id ? entry.document.id : entry?.id;
    if (!pluginId) return false;
    return (Array.isArray(installedPackages) ? installedPackages : []).some((item) => item?.pluginId === pluginId);
}

export function formatReimportResult(result) {
    if (result?.unchanged) return "Already current.";
    const vehicles = result?.updated?.vehicles?.length ?? 0;
    const scripts = result?.updated?.scripts?.length ?? 0;
    const runManifests = result?.updated?.runManifests?.length ?? 0;
    if (vehicles + scripts + runManifests === 0) return "Imported.";
    const parts = [];
    if (vehicles) parts.push(`${vehicles} ${vehicles === 1 ? "vehicle" : "vehicles"}`);
    if (scripts) parts.push(`${scripts} ${scripts === 1 ? "script" : "scripts"}`);
    if (runManifests) parts.push(`${runManifests} ${runManifests === 1 ? "run manifest" : "run manifests"}`);
    return `Updated ${parts.join(", ")}.`;
}

export function localPackageInstallState(entry, installedPackages, builds = []) {
    if (!entry?.document || entry.error) return "unavailable";
    const pluginId = typeof entry.document.id === "string" && entry.document.id ? entry.document.id : entry.id;
    const version = typeof entry.document.version === "string" ? entry.document.version : "";
    const packages = Array.isArray(installedPackages) ? installedPackages : [];
    const installed = packages.some((item) => item?.pluginId === pluginId && item?.version === version);
    const record = (Array.isArray(builds) ? builds : []).find((item) => item?.directoryKey === entry.directory);
    if (record && entry.sourceFingerprint && record.sourceFingerprint !== entry.sourceFingerprint) return "update-available";
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
