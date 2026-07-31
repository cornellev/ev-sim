import { Vehicle } from "../vehicles/Vehicle";
import { Database } from "./Database";
import { isBuiltInVehicleType, matchesVehicleType } from "../../vehicles/vehicleTypeResolution.js";
import { vehicleAssetUrl } from "../../vehicles/VehicleManifest.js";

const ASSET_MIME_TYPES = Object.freeze({
    bin: "application/octet-stream",
    glb: "model/gltf-binary",
    gltf: "model/gltf+json",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    png: "image/png",
    webp: "image/webp",
});

function assetMimeType(fileName) {
    const extension = String(fileName).split(".").pop()?.toLowerCase();
    return ASSET_MIME_TYPES[extension] || "application/octet-stream";
}

function bytesToBase64(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
}

function bytesToDataUrl(bytes, mimeType) {
    return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

async function sha256Hex(bytes) {
    if (!globalThis.crypto?.subtle) {
        throw new Error("This browser cannot verify frozen vehicle assets because Web Crypto is unavailable.");
    }
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function resolvedAssetKey(uri) {
    const value = String(uri ?? "").trim();
    if (!value || /^(?:data:|blob:|https?:)/i.test(value)) return null;
    const pathname = decodeURIComponent(value.split(/[?#]/, 1)[0]);
    return pathname.startsWith("/") ? pathname : pathname.replace(/^\.\//, "");
}

function freezeGltfDocument(bytes, assetDataUrls, modelAsset) {
    let document;
    try {
        document = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
        throw new Error(`Vehicle model asset "${modelAsset}" is not valid glTF JSON: ${error.message}`);
    }
    for (const collection of [document.buffers, document.images]) {
        for (const entry of Array.isArray(collection) ? collection : []) {
            const assetKey = resolvedAssetKey(entry?.uri);
            if (!assetKey) continue;
            const frozenUrl = assetDataUrls.get(assetKey);
            if (!frozenUrl) {
                throw new Error(`Vehicle model asset "${modelAsset}" references missing asset "${assetKey}".`);
            }
            entry.uri = frozenUrl;
        }
    }
    return new TextEncoder().encode(JSON.stringify(document));
}

/**
 * Verify every resolved asset and replace a stored glTF/GLB model with an
 * in-memory data URL. The model therefore executes the exact bytes included in
 * the resolved dependency hash even if the saved vehicle changes mid-run.
 */
async function materializeResolvedVehicleManifest(dependency) {
    const manifest = structuredClone(dependency.manifest);
    const expectedHashes = dependency.assetHashes || {};
    if (Object.keys(expectedHashes).length === 0) return manifest;

    const bytesByName = new Map();
    const dataUrls = new Map();
    for (const [fileName, expectedHash] of Object.entries(expectedHashes).sort(([left], [right]) => left.localeCompare(right))) {
        const assetUrl = fileName.startsWith("/") ? fileName : vehicleAssetUrl(dependency.vehicleId, fileName);
        const response = await fetch(assetUrl, { cache: "no-store" });
        if (!response.ok) {
            throw new Error(`Could not load frozen vehicle asset "${dependency.vehicleId}/${fileName}" (${response.status}).`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const actualHash = await sha256Hex(bytes);
        if (actualHash !== expectedHash) {
            throw new Error(`Vehicle asset "${dependency.vehicleId}/${fileName}" changed after resolution; resolve the run again.`);
        }
        bytesByName.set(fileName, bytes);
        dataUrls.set(fileName, bytesToDataUrl(bytes, assetMimeType(fileName)));
    }

    const modelAsset = resolvedAssetKey(manifest.model?.asset);
    if (!modelAsset) return manifest;
    if (modelAsset.startsWith("/")) {
        const modelDirectory = modelAsset.slice(0, modelAsset.lastIndexOf("/") + 1);
        for (const [assetKey, dataUrl] of [...dataUrls]) {
            if (assetKey.startsWith(modelDirectory)) {
                dataUrls.set(assetKey.slice(modelDirectory.length), dataUrl);
            }
        }
    }
    let modelBytes = bytesByName.get(modelAsset);
    if (!modelBytes) {
        throw new Error(`Resolved vehicle "${dependency.vehicleId}" is missing model asset "${modelAsset}".`);
    }
    if (modelAsset.toLowerCase().endsWith(".gltf")) {
        modelBytes = freezeGltfDocument(modelBytes, dataUrls, modelAsset);
    }
    manifest.model.asset = bytesToDataUrl(modelBytes, assetMimeType(modelAsset));
    return manifest;
}

export class VehicleDatabase extends Database {
    constructor(parent) {
        super(parent);

        this.vehicles = [];
    }
    /**
     * 
     * @param {Vehicle} vehicle 
     */
    addVehicle(vehicle) {
        if (!vehicle.telemetryId) {
            vehicle.telemetryId = `vehicle-${this.vehicles.length + 1}`;
        }
        this.vehicles.push(vehicle);
        vehicle.parent = this;
        this.parent?.bindings?.()?.signalStore?.emitTelemetryEvent?.({
            category: "vehicles",
            name: "vehicle-spawned",
            payload: { id: vehicle.telemetryId, type: vehicle.constructor?.name || "Vehicle" },
        });
    }

    removeVehicle(vehicle) {
        const index = this.vehicles.indexOf(vehicle);
        if (index < 0) return false;
        this.vehicles.splice(index, 1);
        this.parent?.bindings?.()?.signalStore?.emitTelemetryEvent?.({
            category: "vehicles",
            name: "vehicle-despawned",
            payload: { id: vehicle.telemetryId },
        });
        const store = this.parent?.bindings?.()?.signalStore;
        for (const suffix of ["pose", "velocity", "steeringAngle"]) {
            store?.removeSignal?.(`vehicles.${vehicle.telemetryId}.${suffix}`);
        }
        return true;
    }

    async configureFromManifest(entries = [], scene = this.parent?.scene, { resolvedVehicles = [] } = {}) {
        const dependencies = new Map(resolvedVehicles.map((entry) => [entry.actorId, entry]));
        const desired = [...entries].sort((left, right) => left.id.localeCompare(right.id));
        const desiredIds = new Set(desired.map((entry) => entry.id));
        for (const vehicle of [...this.vehicles]) {
            if (desiredIds.has(vehicle.telemetryId)) continue;
            vehicle.sceneObject?.removeFromParent?.();
            vehicle.dispose?.();
            this.removeVehicle(vehicle);
        }

        for (const entry of desired) {
            let vehicle = this.vehicles.find((candidate) => candidate.telemetryId === entry.id);
            const dependency = dependencies.get(entry.id);
            if (vehicle && (!matchesVehicleType(vehicle, entry.type)
                || (dependency?.hash && vehicle.resolvedVehicleHash !== dependency.hash))) {
                vehicle.sceneObject?.removeFromParent?.();
                vehicle.dispose?.();
                this.removeVehicle(vehicle);
                vehicle = null;
            }
            if (vehicle) continue;
            const position = entry.pose?.position || { x: 0, y: 0, z: 0 };
            const rotation = entry.pose?.rotation || { x: 0, y: 0, z: 0, order: "XYZ" };
            const frozenManifest = dependency?.manifest
                ? await materializeResolvedVehicleManifest(dependency)
                : null;
            if (entry.type === "igvc-car") {
                const [{ IGVCCar }, THREE] = await Promise.all([import("../vehicles/IGVCCar.js"), import("three")]);
                vehicle = new IGVCCar(this, new THREE.Vector3(position.x, position.y, position.z), new THREE.Euler(rotation.x, rotation.y, rotation.z, rotation.order || "XYZ"));
            } else if (entry.type === "scenario-car") {
                const { ScenarioCar } = await import("../vehicles/ScenarioCar.js");
                vehicle = new ScenarioCar(this, { id: entry.id, keyframes: entry.keyframes || [{ x: position.x, y: position.z, yaw: -rotation.y }] });
            } else if (entry.type && !isBuiltInVehicleType(entry.type)) {
                const manifest = frozenManifest ?? await this._loadVehicleManifest(entry.type);
                if (!manifest) {
                    throw new Error(`Vehicle "${entry.id}" references unknown type "${entry.type}"; no built-in or saved vehicle manifest matches.`);
                }
                const [{ ManifestVehicle }, THREE] = await Promise.all([import("../vehicles/ManifestVehicle.js"), import("three")]);
                vehicle = new ManifestVehicle(this, manifest, new THREE.Vector3(position.x, position.y, position.z), new THREE.Euler(rotation.x, rotation.y, rotation.z, rotation.order || "XYZ"));
            } else {
                const [{ BigCar }, THREE] = await Promise.all([import("../vehicles/BigCar.js"), import("three")]);
                vehicle = new BigCar(
                    this,
                    new THREE.Vector3(position.x, position.y, position.z),
                    new THREE.Euler(rotation.x, rotation.y, rotation.z, rotation.order || "XYZ"),
                    { modelUrl: frozenManifest?.model?.asset },
                );
            }
            vehicle.telemetryId = entry.id;
            vehicle.manifestManaged = true;
            vehicle.resolvedVehicleHash = dependency?.hash || null;
            if (scene) await vehicle.addToScene?.(scene);
            vehicle.start?.(scene);
        }
        this.vehicles.sort((left, right) => String(left.telemetryId).localeCompare(String(right.telemetryId)));
    }

    /**
     * Resolve a custom vehicle type against the saved vehicle catalog.
     * Overridable in tests to avoid network access.
     * @returns {Promise<object|null>}
     */
    async _loadVehicleManifest(type) {
        try {
            const { getVehicleManifest } = await import("../../vehicles/VehicleManifestClient.js");
            return await getVehicleManifest(type);
        } catch (error) {
            console.warn(`Could not load vehicle manifest "${type}":`, error);
            return null;
        }
    }

    /**
     * @param {THREE.Scene} scene
     */
    setup(scene) {
        for (const vehicle of this.vehicles) {
            vehicle.start?.(scene);
        }
    }

    update(dt) {
        const ordered = [...this.vehicles].sort((left, right) =>
            String(left.telemetryId || "").localeCompare(String(right.telemetryId || ""))
        );
        for (const vehicle of ordered) {
            const result = vehicle.update?.(dt);

            if (result && typeof result.then === "function") {
                throw new Error(`Vehicle "${vehicle.telemetryId || vehicle.constructor?.name}" returned asynchronous work from a deterministic update.`);
            }
        }
    }
}
