import { Vehicle } from "../vehicles/Vehicle";
import { Database } from "./Database";
import { isBuiltInVehicleType, matchesVehicleType } from "../../vehicles/vehicleTypeResolution.js";


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

    async configureFromManifest(entries = [], scene = this.parent?.scene) {
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
            if (vehicle && !matchesVehicleType(vehicle, entry.type)) {
                vehicle.sceneObject?.removeFromParent?.();
                vehicle.dispose?.();
                this.removeVehicle(vehicle);
                vehicle = null;
            }
            if (vehicle) continue;
            const position = entry.pose?.position || { x: 0, y: 0, z: 0 };
            const rotation = entry.pose?.rotation || { x: 0, y: 0, z: 0, order: "XYZ" };
            if (entry.type === "igvc-car") {
                const [{ IGVCCar }, THREE] = await Promise.all([import("../vehicles/IGVCCar.js"), import("three")]);
                vehicle = new IGVCCar(this, new THREE.Vector3(position.x, position.y, position.z), new THREE.Euler(rotation.x, rotation.y, rotation.z, rotation.order || "XYZ"));
            } else if (entry.type === "scenario-car") {
                const { ScenarioCar } = await import("../vehicles/ScenarioCar.js");
                vehicle = new ScenarioCar(this, { id: entry.id, keyframes: entry.keyframes || [{ x: position.x, y: position.z, yaw: -rotation.y }] });
            } else if (entry.type && !isBuiltInVehicleType(entry.type)) {
                const manifest = await this._loadVehicleManifest(entry.type);
                if (!manifest) {
                    throw new Error(`Vehicle "${entry.id}" references unknown type "${entry.type}"; no built-in or saved vehicle manifest matches.`);
                }
                const [{ ManifestVehicle }, THREE] = await Promise.all([import("../vehicles/ManifestVehicle.js"), import("three")]);
                vehicle = new ManifestVehicle(this, manifest, new THREE.Vector3(position.x, position.y, position.z), new THREE.Euler(rotation.x, rotation.y, rotation.z, rotation.order || "XYZ"));
            } else {
                const [{ BigCar }, THREE] = await Promise.all([import("../vehicles/BigCar.js"), import("three")]);
                vehicle = new BigCar(this, new THREE.Vector3(position.x, position.y, position.z), new THREE.Euler(rotation.x, rotation.y, rotation.z, rotation.order || "XYZ"));
            }
            vehicle.telemetryId = entry.id;
            vehicle.manifestManaged = true;
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
