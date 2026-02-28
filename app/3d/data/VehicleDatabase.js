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
        this.vehicles.push(vehicle);
        vehicle.parent = this;
    }

    /**
     * @param {THREE.Scene} scene
     */
    setup(scene) {
        for (const vehicle of this.vehicles) {
            vehicle.setup(scene);
        }
    }
}