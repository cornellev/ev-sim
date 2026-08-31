import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../vehicles/KinematicVehiclePlant.js";
import { compareUtf8 } from "../world/WorldDescription.js";

export class HeadlessVehicleManager {
    constructor() {
        this.vehicles = [];
        this.initialState = { vehicles: [] };
    }

    async configureFromManifest(entries = [], _scene = null, { resolvedVehicles = [] } = {}) {
        const dependencies = new Map(resolvedVehicles.map((entry) => [entry.actorId, entry]));
        this.vehicles = [...entries]
            .sort((left, right) => compareUtf8(left.id, right.id))
            .map((entry) => new KinematicVehiclePlant(
                createVehiclePlantDefinition(entry, dependencies.get(entry.id)),
            ));
        this.initialState = { vehicles: structuredClone(entries) };
        return this.vehicles;
    }

    update(deltaTime) {
        for (const vehicle of this.vehicles) vehicle.update(deltaTime);
    }

    resetRun(initialState = this.initialState) {
        const entries = initialState?.vehicles ?? [];
        const byId = new Map(entries.map((entry) => [entry.id, entry]));
        for (const vehicle of this.vehicles) {
            vehicle.resetRunState(byId.get(vehicle.telemetryId) ?? {});
        }
        return this.getDeterministicState();
    }

    finalizeRun() {
        return this.getDeterministicState();
    }

    disposeRun() {
        this.vehicles = [];
        this.initialState = { vehicles: [] };
    }

    getDeterministicState() {
        return this.vehicles
            .map((vehicle) => vehicle.getDeterministicState())
            .sort((left, right) => compareUtf8(left.id, right.id));
    }
}
