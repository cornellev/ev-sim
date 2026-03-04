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
            vehicle.start(scene);
        }

        // setup update frames
        let lastTime = performance.now();
        const frame = (time) => {
            const deltaTime = (time - lastTime) / 1000; // in seconds
            lastTime = time;

            for (const vehicle of this.vehicles) {
                vehicle.update(deltaTime);
            }

            requestAnimationFrame(frame);
        };

        requestAnimationFrame(frame);
    }
}