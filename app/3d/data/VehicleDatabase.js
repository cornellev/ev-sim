import { Vehicle } from "../vehicles/Vehicle";
import { Database } from "./Database";


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
        return true;
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
        for (const vehicle of this.vehicles) {
            const result = vehicle.update?.(dt);

            if (result?.catch) {
                result.catch(err => {
                    console.error("Error updating vehicle:", err);
                });
            }
        }
    }
}
