import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../../simulation/vehicles/KinematicVehiclePlant.js";

function copyVector(target, source) {
    target?.set?.(source.x, source.y, source.z);
}

function copyRotation(target, source) {
    target?.set?.(source.x, source.y, source.z, source.order || "XYZ");
}

export function attachVehiclePlant(vehicle, entry, dependency = null, options = {}) {
    const plant = new KinematicVehiclePlant(createVehiclePlantDefinition(entry, dependency, options));
    vehicle.plant = plant;
    vehicle.collisionDimensions = { ...plant.collisionDimensions };
    syncPlantFromVehicle(vehicle);
    return plant;
}

export function syncPlantFromVehicle(vehicle) {
    if (!vehicle.plant) return;
    Object.assign(vehicle.plant.position, vehicle.position);
    Object.assign(vehicle.plant.rotation, {
        x: vehicle.rotation.x,
        y: vehicle.rotation.y,
        z: vehicle.rotation.z,
        order: vehicle.rotation.order,
    });
    Object.assign(vehicle.plant.velocity, vehicle.velocity);
    Object.assign(vehicle.plant.acceleration, vehicle.acceleration);
    vehicle.plant.steeringAngle = Number(vehicle.steeringAngle) || 0;
}

export function syncVehicleFromPlant(vehicle) {
    const plant = vehicle.plant;
    if (!plant) return;
    copyVector(vehicle.velocity, plant.velocity);
    copyVector(vehicle.acceleration, plant.acceleration);
    vehicle.steeringAngle = plant.steeringAngle;
    copyVector(vehicle.position, plant.position);
    copyRotation(vehicle.rotation, plant.rotation);
    vehicle.updatePosition(vehicle.position);
    vehicle.updateRotation(vehicle.rotation);
}

export function stepVehiclePlant(vehicle, deltaTime) {
    syncPlantFromVehicle(vehicle);
    vehicle.plant.update(deltaTime);
    syncVehicleFromPlant(vehicle);
}

export function resetVehiclePlant(vehicle, entry = {}) {
    if (!vehicle.plant) return;
    vehicle.plant.resetRunState(entry);
    syncVehicleFromPlant(vehicle);
}

