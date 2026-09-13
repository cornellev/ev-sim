export function isAssetBackedObject(record) {
    return record?.typeId === "asset-instance"
        || (record?.typeId === "tile" && Number(record?.typeVersion) === 2 && record?.components?.tile?.provider === "gltf");
}

export function readAssetBinding(record) {
    return isAssetBackedObject(record) && record?.components?.asset ? record.components.asset : null;
}

export function assetBindingRevisionVersion(record) {
    if (!isAssetBackedObject(record)) return null;
    return record.typeId === "tile" ? Number(record.components?.tile?.assetTypeVersion ?? 1) : Number(record.typeVersion ?? 1);
}

export function updateAssetRevisionBinding(record, revision, assetTypeVersion = null) {
    const asset = readAssetBinding(record);
    if (!asset || !Number.isInteger(revision) || revision <= 0) throw new TypeError("An asset-backed object and positive revision are required.");
    const next = structuredClone(record);
    next.components.asset.revision = revision;
    if (next.typeId === "tile") {
        next.typeVersion = 2;
        next.components.tile = { ...next.components.tile, provider: "gltf", assetTypeVersion: assetTypeVersion ?? next.components.tile?.assetTypeVersion ?? 1 };
    } else if (assetTypeVersion !== null) next.typeVersion = assetTypeVersion;
    return next;
}
