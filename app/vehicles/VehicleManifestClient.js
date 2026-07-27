import {
    storageDelete,
    storageGet,
    storagePost,
    storagePut,
} from "../client/storageClient.js";
import { vehicleAssetUrl } from "./VehicleManifest.js";

const collection = "vehicles";

export function listVehicleManifests() {
    return storageGet(collection);
}

export function getVehicleManifest(id) {
    return storageGet(`${collection}/${encodeURIComponent(id)}`);
}

export function createVehicleManifest(manifest) {
    return storagePost(collection, manifest);
}

export function saveVehicleManifest(id, manifest, expectedRevision) {
    return storagePut(`${collection}/${encodeURIComponent(id)}`, { manifest, expectedRevision });
}

export function duplicateVehicleManifest(id, input) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/duplicate`, input);
}

export function deleteVehicleManifest(id) {
    return storageDelete(`${collection}/${encodeURIComponent(id)}`);
}

export function validateVehicleManifestOnServer(id, manifest) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/validate`, { manifest });
}

export function exportVehicleBundle(id) {
    return storageGet(`${collection}/${encodeURIComponent(id)}/export`);
}

export function importVehicleBundle(bundle) {
    return storagePost(`${collection}/import`, bundle);
}

/** Upload a binary model asset (glb/gltf) for a vehicle. */
export async function uploadVehicleAsset(vehicleId, fileName, data) {
    const response = await fetch(vehicleAssetUrl(vehicleId, fileName), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
    });
    if (!response.ok) {
        let detail = "";
        try {
            const payload = await response.json();
            detail = payload?.error ? `: ${payload.error}` : "";
        } catch {
            // No JSON body; the status text is enough.
        }
        throw new Error(`Model upload failed (${response.status} ${response.statusText})${detail}`);
    }
    return response.json();
}

export function deleteVehicleAsset(vehicleId, fileName) {
    return fetch(vehicleAssetUrl(vehicleId, fileName), { method: "DELETE" });
}

export { vehicleAssetUrl };
