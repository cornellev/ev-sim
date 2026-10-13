import {
    storageDelete,
    storageGet,
    storagePost,
    storagePut,
} from "../client/storageClient.js";
import { vehicleAssetUrl } from "./VehicleManifest.js";

const collection = "vehicles";

export function createVehicleOperationId() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function listVehicleManifests() {
    return storageGet(collection);
}

export function getVehicleManifest(id) {
    return storageGet(`${collection}/${encodeURIComponent(id)}`);
}

export function createVehicleManifest(manifest, { stageId, operationId } = {}) {
    if (stageId || operationId) return storagePost(collection, { manifest, stageId, operationId });
    return storagePost(collection, manifest);
}

export function saveVehicleManifest(id, manifest, expectedRevision, { stageId, operationId } = {}) {
    return storagePut(`${collection}/${encodeURIComponent(id)}`, {
        manifest,
        expectedRevision,
        ...(stageId ? { stageId } : {}),
        ...(operationId ? { operationId } : {}),
    });
}

export function publishVehicleMigration(id, { manifest, expectedRevision, stageId, operationId }) {
    return storagePost(`${collection}/${encodeURIComponent(id)}/migrate`, {
        manifest,
        expectedRevision,
        stageId,
        operationId,
    });
}

export function createVehicleStage() {
    return storagePost("vehicle-stages", {});
}

export function renewVehicleStage(stageId) {
    return storagePost(`vehicle-stages/${encodeURIComponent(stageId)}/renew`, {});
}

export function abandonVehicleStage(stageId) {
    return storageDelete(`vehicle-stages/${encodeURIComponent(stageId)}`);
}

export async function uploadVehicleStageMember(stageId, name, data) {
    const response = await fetch(`/api/storage/vehicle-stages/${encodeURIComponent(stageId)}/members/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: data,
    });
    if (!response.ok) throw new Error(await storageError(response, "Stage upload failed"));
    return response.json();
}

export async function readVehicleStageMember(stageId, name) {
    const response = await fetch(`/api/storage/vehicle-stages/${encodeURIComponent(stageId)}/members/${encodeURIComponent(name)}`);
    if (!response.ok) throw new Error(await storageError(response, "Stage read failed"));
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
        name,
        bytes,
        sha256: response.headers.get("X-Content-SHA256"),
        size: Number(response.headers.get("Content-Length")),
        mediaType: response.headers.get("Content-Type"),
    };
}

async function storageError(response, label) {
    let detail = "";
    try {
        const payload = await response.json();
        detail = payload?.error ? `: ${payload.error}` : "";
    } catch {
        // The status text is enough when the body is not JSON.
    }
    return `${label} (${response.status} ${response.statusText})${detail}`;
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
