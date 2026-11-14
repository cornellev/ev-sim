import { planSensorAdmission } from "../interfaces/historical/SensorAdmission.js";
import { createSensorDefinitionRegistry } from "../interfaces/historical/SensorTypes.js";
import { verifyRunBundleIntegrityUsing, verifyRunBundleIntegrity as verifyNative, verifyRunBundleBytesUsing, verifyRunBundle } from "./RunBundle.js";
import { planHistoricalProtobufRouteAdmission } from "../interfaces/historical/ProtobufBinding.js";
export { runBundleBytes, canonicalRunBundleStringify } from "./RunBundle.js";

export function verifyRunBundleIntegrity(bundle) {
    return bundle?.resolved?.version === 13 ? verifyNative(bundle)
        : verifyRunBundleIntegrityUsing(bundle, planHistoricalProtobufRouteAdmission, createSensorDefinitionRegistry, planSensorAdmission);
}

export function verifyRunBundleBytes(input, { execution = true, ...options } = {}) {
    return verifyRunBundleBytesUsing(input, options, execution ? verifyRunBundle : verifyRunBundleIntegrity);
}

export async function inspectRunPackageArchive(input, options = {}) {
    return (await import("./VisualAssetPack.js")).verifyRunPackageArchive(input, { ...options, verifyBundleBytes: verifyRunBundleBytes });
}
