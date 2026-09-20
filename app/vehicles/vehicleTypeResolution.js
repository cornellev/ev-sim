import { BUILT_IN_VEHICLE_TYPES } from "./VehicleManifest.js";

export function isBuiltInVehicleType(type) {
    return BUILT_IN_VEHICLE_TYPES.includes(type);
}

/** Runtime class name that VehicleDatabase spawns for a manifest type string. */
export function vehicleClassNameForType(type) {
    if (type === "scenario-car") return "ScenarioCar";
    return "ManifestVehicle";
}

/** Whether an existing vehicle instance already satisfies a manifest type. */
export function matchesVehicleType(vehicle, type) {
    const expected = vehicleClassNameForType(type);
    if (expected === "ManifestVehicle") {
        const expectedId = type || "big-car";
        return vehicle.constructor?.name === "ManifestVehicle" && vehicle.vehicleManifestId === expectedId;
    }
    return vehicle.constructor?.name === expected;
}
