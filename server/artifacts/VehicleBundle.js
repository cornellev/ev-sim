import { verifyPluginPackage } from "../../app/plugin/PluginPackage.js";
import {
    normalizeVehiclePluginLocks,
    verifyVehiclePluginLockAgainstPackage,
} from "../../app/plugin/PluginSensorAuthoring.js";
import { computeResolvedRunHash } from "../../app/simulation/RunManifest.js";
import { createSensorDefinitionRegistry } from "../../app/simulation/sensors/SensorTypeRegistry.js";
import {
    VEHICLE_BUNDLE_KIND,
    VEHICLE_BUNDLE_VERSION,
    normalizeVehicleManifest,
    validateVehicleManifest,
} from "../../app/vehicles/VehicleManifest.js";
import { comparePluginText } from "../../app/plugin/PluginSelection.js";

function vehicleValidationError(issues) {
    const detail = issues.map((issue) => `${issue.path || "manifest"}: ${issue.message}`).join("; ");
    return new Error(`Vehicle manifest validation failed: ${detail}`);
}

function validateAssetName(value) {
    const name = String(value ?? "");
    if (!name || name !== name.trim() || name === "." || name === ".." || /[\\/\0]/u.test(name)) {
        throw new Error(`Invalid vehicle asset member name: ${JSON.stringify(value)}.`);
    }
    return name;
}

function decodeCanonicalBase64(value, name) {
    if (typeof value !== "string" || value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
        throw new Error(`Vehicle asset "${name}" must be canonical base64.`);
    }
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) throw new Error(`Vehicle asset "${name}" must be canonical base64.`);
    return bytes;
}

export function vehicleBundleHashSource(bundle = {}) {
    const source = {
        manifest: bundle.manifest,
        assets: bundle.assets,
    };
    if (!Array.isArray(bundle.pluginPackages)) return source;
    const pluginPackages = [...bundle.pluginPackages].sort((left, right) => comparePluginText(
        verifyPluginPackage(left).document.id,
        verifyPluginPackage(right).document.id,
    ));
    return { ...source, pluginPackages };
}

export function computeVehicleBundleHash(bundle = {}) {
    return computeResolvedRunHash(vehicleBundleHashSource(bundle));
}

export function verifyVehicleBundle(bundle = {}) {
    if (bundle.kind !== VEHICLE_BUNDLE_KIND || Number(bundle.version) !== VEHICLE_BUNDLE_VERSION) {
        throw new Error(`Unsupported vehicle bundle; expected ${VEHICLE_BUNDLE_KIND} version ${VEHICLE_BUNDLE_VERSION}.`);
    }
    const assets = bundle.assets == null ? {} : bundle.assets;
    if (typeof assets !== "object" || Array.isArray(assets)) {
        throw new Error("Vehicle bundle assets must be an object.");
    }
    const decodedAssets = {};
    for (const [rawName, encoded] of Object.entries(assets)) {
        const name = validateAssetName(rawName);
        decodedAssets[name] = decodeCanonicalBase64(encoded, name);
    }
    const computedBundleHash = computeVehicleBundleHash({
        manifest: bundle.manifest,
        assets,
        ...(Array.isArray(bundle.pluginPackages) ? { pluginPackages: bundle.pluginPackages } : {}),
    });
    if (bundle.bundleHash !== undefined && bundle.bundleHash !== computedBundleHash) {
        throw new Error("Vehicle bundle hash is invalid.");
    }
    const locks = normalizeVehiclePluginLocks(bundle.manifest?.pluginLocks) ?? [];
    const embedded = Array.isArray(bundle.pluginPackages) ? bundle.pluginPackages : [];
    const verifiedById = new Map();
    for (const resource of embedded) {
        const verified = verifyPluginPackage(resource);
        if (verifiedById.has(verified.document.id)) {
            throw new Error(`Vehicle bundle contains duplicate plugin package "${verified.document.id}".`);
        }
        verifiedById.set(verified.document.id, verified);
    }
    for (const [index, lock] of locks.entries()) {
        const verified = verifiedById.get(lock.pluginId);
        if (!verified) throw new Error(`Vehicle bundle is missing embedded plugin package "${lock.pluginId}".`);
        verifyVehiclePluginLockAgainstPackage(lock, verified, `pluginLocks.${index}`);
    }
    const verifiedPluginPackages = [...verifiedById.values()].sort((left, right) => (
        comparePluginText(left.document.id, right.document.id)
    ));
    const sensorRegistry = createSensorDefinitionRegistry(verifiedPluginPackages);
    const manifest = normalizeVehicleManifest(bundle.manifest, { sensorRegistry });
    const validation = validateVehicleManifest(manifest, { sensorRegistry });
    if (!validation.ok) throw vehicleValidationError(validation.issues);
    return {
        manifest: validation.manifest,
        decodedAssets,
        verifiedPluginPackages,
        computedBundleHash,
    };
}
