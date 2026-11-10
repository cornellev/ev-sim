import { PLANT_CONTACT_BICYCLE_MODEL, PLANT_DYNAMIC_BICYCLE_MODEL, readPlantParameterSource } from "../../plugin/PlantModule.js";
import { CONTACT_BICYCLE_MODEL, DEFAULT_DYNAMIC_BICYCLE, DYNAMIC_BICYCLE_FIELDS, normalizeVehicleDynamics } from "../../vehicles/VehicleManifest.js";
import { deriveAxleDistances } from "./dynamicBicycle.js";

export function resolveVehiclePhysicsConfig(manifest, plantDefinition = null) {
    const dynamics = normalizeVehicleDynamics(manifest.dynamics);
    const plugin = Boolean(dynamics?.plant);
    const model = plugin ? plantDefinition?.model : dynamics?.model;
    const physical = [CONTACT_BICYCLE_MODEL, PLANT_CONTACT_BICYCLE_MODEL, PLANT_DYNAMIC_BICYCLE_MODEL].includes(model);
    const parameters = new Map((plantDefinition?.parameters ?? []).map((parameter) => [parameter.key, parameter]));
    for (const [key] of DYNAMIC_BICYCLE_FIELDS) {
        if (plugin && dynamics[key] !== undefined && (!physical || !parameters.has(key))) {
            throw new Error(`Plant "${dynamics.plant}" does not support vehicle physics override "${key}".`);
        }
    }
    if (!physical) return null;
    const values = Object.fromEntries(DYNAMIC_BICYCLE_FIELDS.map(([key]) => {
        if (dynamics?.[key] !== undefined) return [key, dynamics[key]];
        const parameter = parameters.get(key);
        const declared = parameter
            ? (parameter.source === "default" ? parameter.default : readPlantParameterSource(manifest, parameter.source))
            : DEFAULT_DYNAMIC_BICYCLE[key];
        return [key, declared];
    }));
    normalizeVehicleDynamics({ model: CONTACT_BICYCLE_MODEL, ...values });
    const wheelbase = manifest.kinematics?.wheelbase ?? 1.5;
    if (!Number.isFinite(wheelbase) || wheelbase <= 0) throw new Error("Vehicle physics wheelbase must be positive and finite.");
    const axle = plugin ? { lf: wheelbase / 2, lr: wheelbase / 2 } : deriveAxleDistances(manifest.wheels, wheelbase);
    return Object.freeze({ ...values, wheelbase, ...axle });
}
