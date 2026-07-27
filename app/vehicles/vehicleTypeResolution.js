import { BUILT_IN_VEHICLE_TYPES } from "./VehicleManifest.js";

export function isBuiltInVehicleType(type) {
    return BUILT_IN_VEHICLE_TYPES.includes(type);
}

/** Runtime class name that VehicleDatabase spawns for a manifest type string. */
export function vehicleClassNameForType(type) {
    if (type === "igvc-car") return "IGVCCar";
    if (type === "scenario-car") return "ScenarioCar";
    if (type && !isBuiltInVehicleType(type)) return "ManifestVehicle";
    return "BigCar";
}

/** Whether an existing vehicle instance already satisfies a manifest type. */
export function matchesVehicleType(vehicle, type) {
    const expected = vehicleClassNameForType(type);
    if (expected === "ManifestVehicle") {
        return vehicle.constructor?.name === "ManifestVehicle" && vehicle.vehicleManifestId === type;
    }
    return vehicle.constructor?.name === expected;
}
