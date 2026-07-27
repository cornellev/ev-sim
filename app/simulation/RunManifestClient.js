import {
    storageDelete,
    storageGet,
    storagePost,
    storagePut,
} from "../client/storageClient.js";

const collection = "run-manifests";

export function listRunManifests() {
    return storageGet(collection);
}

export function getRunManifest(id) {
    return storageGet(`${collection}/${encodeURIComponent(id)}`);
}

export function createRunManifest(manifest) {
    return storagePost(collection, manifest);
}

export function saveRunManifest(id, manifest, expectedRevision) {
    return storagePut(`${collection}/${encodeURIComponent(id)}`, { manifest, expectedRevision });
}

export function duplicateRunManifest(id, input) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/duplicate`, input);
}

export function deleteRunManifest(id) {
    return storageDelete(`${collection}/${encodeURIComponent(id)}`);
}

export function validateRunManifestOnServer(id, manifest) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/validate`, { manifest });
}

export function resolveRunManifest(id, manifest = null) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/resolve`, manifest ? { manifest } : {});
}

export function exportRunManifest(id) {
    return storageGet(`${collection}/${encodeURIComponent(id)}/export`);
}

export function importRunBundle(bundle) {
    return storagePost(`${collection}/import`, bundle);
}
