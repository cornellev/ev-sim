import { Vehicle } from "../vehicles/Vehicle";
import { Database } from "./Database";
import { isBuiltInVehicleType, matchesVehicleType } from "../../vehicles/vehicleTypeResolution.js";
import { bindRoadGroundSampler } from "../../simulation/vehicles/roadGroundSampler.js";
import { syncVehicleFromPlant } from "../vehicles/VehiclePlantAdapter.js";
import { createBrowserVehicle } from "../vehicles/createBrowserVehicle.js";

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
        vehicle.dispose?.();
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

    async configureFromManifest(entries = [], scene = this.parent?.scene, options = {}) {
        const resolvedVehicles = options.resolvedVehicles ?? [];
        const dependencies = new Map(resolvedVehicles.map((entry) => [entry.actorId, entry]));
        const desired = [...entries].sort((left, right) => left.id.localeCompare(right.id));
        const desiredIds = new Set(desired.map((entry) => entry.id));
        for (const vehicle of [...this.vehicles]) {
            if (desiredIds.has(vehicle.telemetryId)) continue;
            this.removeVehicle(vehicle);
        }

        for (const entry of desired) {
            let vehicle = this.vehicles.find((candidate) => candidate.telemetryId === entry.id);
            const dependency = dependencies.get(entry.id);
            if (vehicle && (!matchesVehicleType(vehicle, entry.type)
                || (dependency?.hash && vehicle.resolvedVehicleHash !== dependency.hash))) {
                this.removeVehicle(vehicle);
                vehicle = null;
            }
            if (vehicle) continue;
            const position = entry.pose?.position || { x: 0, y: 0, z: 0 };
            const rotation = entry.pose?.rotation || { x: 0, y: 0, z: 0, order: "XYZ" };
            const manifest = dependency?.manifest
                ?? (entry.type && !isBuiltInVehicleType(entry.type)
                    ? await this._loadVehicleManifest(entry.type)
                    : null);
            vehicle = createBrowserVehicle(this, {
                type: entry.type,
                id: entry.id,
                pose: { position, rotation },
                manifest,
                keyframes: entry.keyframes,
            });
            vehicle.telemetryId = entry.id;
            if (vehicle.plant) {
                vehicle.plant.id = entry.id;
                vehicle.plant.telemetryId = entry.id;
                vehicle.plant.definition.id = entry.id;
            }
            vehicle.manifestManaged = true;
            vehicle.resolvedVehicleHash = dependency?.hash || null;
            if (scene) await vehicle.addToScene?.(scene);
            vehicle.start?.(scene);
        }
        this.vehicles.sort((left, right) => String(left.telemetryId).localeCompare(String(right.telemetryId)));
        bindRoadGroundSampler(this.vehicles, options);
        for (const vehicle of this.vehicles) {
            if (vehicle.plant) syncVehicleFromPlant(vehicle);
        }
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

    resetRun(initialState = {}) {
        const entries = initialState.vehicles || [];
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        for (const [index, vehicle] of this.vehicles.entries()) {
            const entry = byId.get(vehicle.telemetryId) || entries[index];
            if (!entry) continue;
            if (typeof vehicle.resetRunState === "function") {
                vehicle.resetRunState(entry);
            }
        }
    }

    getDeterministicState() {
        return this.vehicles
            .map((vehicle, index) => vehicle.getDeterministicState?.() ?? {
                id: String(vehicle.telemetryId || `vehicle-${index + 1}`),
            })
            .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    }

    finalizeRun() {
        return this.getDeterministicState();
    }

    disposeRun() {
        for (const vehicle of [...this.vehicles]) this.removeVehicle(vehicle);
    }
}
