import {
    createVehiclePlantDefinition,
    KinematicVehiclePlant,
} from "../vehicles/KinematicVehiclePlant.js";
import { compilePlantModules, resolveVehiclePlantMount } from "../vehicles/WasmPlantStepper.js";
import { bindRoadGroundSampler } from "../vehicles/roadGroundSampler.js";
import { compareUtf8 } from "../world/WorldDescription.js";

export class HeadlessVehicleManager {
    constructor() {
        this.vehicles = [];
        this.initialState = { vehicles: [] };
    }

    async configureFromManifest(entries = [], _scene = null, options = {}) {
        const resolvedVehicles = options.resolvedVehicles ?? [];
        const dependencies = new Map(resolvedVehicles.map((entry) => [entry.actorId, entry]));
        const plants = options.plants;
        const compiled = plants instanceof Map ? await compilePlantModules(plants) : null;
        this.vehicles = [...entries]
            .sort((left, right) => compareUtf8(left.id, right.id))
            .map((entry) => {
                const dependency = dependencies.get(entry.id);
                const mount = resolveVehiclePlantMount(dependency?.manifest, plants, compiled);
                return new KinematicVehiclePlant(
                    createVehiclePlantDefinition(entry, dependency, {
                        plantPluginId: mount.plantPluginId,
                        plantRuntimeHash: mount.plantRuntimeHash,
                    }),
                    { stepper: mount.plantStepper ?? null, unresolved: mount.unresolvedPluginPlant === true },
                );
            });
        bindRoadGroundSampler(this.vehicles, options);
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
