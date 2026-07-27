export const CONFIG_CATALOG_TIMEOUT_MS = 10_000;

export async function withConfigLoadTimeout(promise, message, timeoutMs = CONFIG_CATALOG_TIMEOUT_MS) {
    let timeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

export async function loadRunManifestCatalog({
    listManifests,
    getManifest,
    preferredId = null,
    timeoutMs = CONFIG_CATALOG_TIMEOUT_MS,
}) {
    const response = await withConfigLoadTimeout(
        Promise.resolve().then(() => listManifests()),
        "Manifest catalog loading timed out. Check the storage server and try again.",
        timeoutMs,
    );
    const catalog = Array.isArray(response) ? response : [];
    if (catalog.length === 0) {
        return { status: "empty", catalog, selectedId: null, document: null };
    }

    const selectedId = catalog.some((entry) => entry.id === preferredId)
        ? preferredId
        : catalog[0].id;
    const document = await withConfigLoadTimeout(
        Promise.resolve().then(() => getManifest(selectedId)),
        `Manifest "${selectedId}" loading timed out. Check the storage server and try again.`,
        timeoutMs,
    );
    if (!document) throw new Error(`Manifest "${selectedId}" no longer exists.`);

    return { status: "ready", catalog, selectedId, document };
}
