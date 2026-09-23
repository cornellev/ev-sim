import { ManifestCamera } from "../devices/ManifestCamera.js";

const DEFAULT_TARGET_ID = "ego";

function vehicleRank(vehicle, targetId, index) {
    const id = String(vehicle?.telemetryId || "");
    return {
        vehicle,
        index,
        preferred: id === targetId ? 0 : 1,
    };
}

/**
 * Playground and vehicle-manifest cameras are `StereoCamera` instances.
 * That class is not imported here: its lidar shader uses extensionless
 * imports, which the headless Node loader cannot resolve. The fields below
 * are assigned in the `StereoCamera` constructor.
 */
export function isStereoPerspectiveCamera(device) {
    return Boolean(device)
        && typeof device._applyPose !== "function"
        && device.cameraSettings
        && Array.isArray(device.tags)
        && device.tags.includes("camera")
        && typeof device.getPosition === "function"
        && typeof device.getRotation === "function";
}

export function isPerspectiveCameraDevice(device) {
    return device instanceof ManifestCamera || isStereoPerspectiveCamera(device);
}

/**
 * First enabled vehicle camera. The run target vehicle wins, otherwise the
 * playground ego car, then every other vehicle in list order.
 * @returns {{ vehicle: object, device: object } | null}
 */
export function selectVehicleCamera(data) {
    const vehicles = data?.vehicles?.()?.vehicles ?? [];
    const targetId = String(
        data?.simulation?.()?.resolvedRun?.manifest?.controls?.targetVehicleId
        || DEFAULT_TARGET_ID,
    );
    const ranked = vehicles
        .map((vehicle, index) => vehicleRank(vehicle, targetId, index))
        .sort((left, right) => left.preferred - right.preferred || left.index - right.index);

    for (const entry of ranked) {
        for (const device of entry.vehicle?.devices ?? []) {
            if (device?.enabled === false) continue;
            if (isPerspectiveCameraDevice(device)) return { vehicle: entry.vehicle, device };
        }
    }
    return null;
}
