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
