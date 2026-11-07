import { stampInheritedPluginSelections } from "../plugin/PluginSensorAuthoring.js";
import {
    createDefaultRunManifest,
    normalizeRunManifest,
} from "../simulation/RunManifest.js";
import {
    applySensorInheritance,
    enableSensorInheritance,
    resolveInheritedVehicleSelection,
} from "../simulation/sensors/SensorInheritance.js";
import { getBuiltInVehicleManifest } from "../vehicles/BuiltInVehicleManifests.js";

export const SIMPLE_VEHICLE_OPTIONS = Object.freeze([
    { id: "big-car", name: "Big Car (built-in)" },
    { id: "igvc-car", name: "IGVC Car (built-in)" },
    { id: "scenario-car", name: "Scenario Car (built-in)" },
]);

export const PROFILE_SURFACE_TABS = Object.freeze({
    scenario: "Scenario",
    topics: "Topics",
    sensors: "Sensors",
});

export function simpleCreatedManifest(id, name) {
    const manifest = createDefaultRunManifest({ id, name });
    const vehicleId = manifest.initialState?.vehicles?.[0]?.type;
    const vehicle = vehicleId ? getBuiltInVehicleManifest(vehicleId) : null;
    if (!vehicle) return manifest;
    const inherited = enableSensorInheritance(manifest, vehicle);
    if (inherited.issues.length > 0) return manifest;
    return normalizeRunManifest(inherited.manifest);
}

export function simpleVehicleTarget(draft) {
    const vehicles = Array.isArray(draft?.initialState?.vehicles) ? draft.initialState.vehicles : [];
    const targetId = draft?.controls?.targetVehicleId || "ego";
    return vehicles.find((vehicle) => vehicle?.id === targetId)
        ?? vehicles.find((vehicle) => vehicle?.id === "ego")
        ?? vehicles[0]
        ?? null;
}

export function scenarioSelectionState(draft, scenarios = [], catalogState = "ready") {
    const selectedId = draft?.scenario?.id || "";
    const known = scenarios.some((entry) => entry?.id === selectedId);
    return {
        selectedId,
        missing: Boolean(selectedId) && catalogState === "ready" && !known,
        preserveSelected: Boolean(selectedId) && !known,
    };
}

export function vehicleSelectionState(draft, options = []) {
    const selectedId = draft?.scenario?.id
        ? (draft.scenario.egoVehicleId || "")
        : (simpleVehicleTarget(draft)?.type || "");
    const known = options.some((entry) => entry?.id === selectedId);
    return {
        selectedId,
        missing: Boolean(selectedId) && !known,
    };
}

export function applySimpleVehicleSelection(draft, vehicleId, vehicleManifest = null) {
    const next = structuredClone(draft);
    if (next.scenario?.id) {
        next.scenario = { ...next.scenario, egoVehicleId: vehicleId };
    } else {
        const target = simpleVehicleTarget(next);
        if (target) {
            next.initialState = {
                ...next.initialState,
                vehicles: next.initialState.vehicles.map((vehicle) => (
                    vehicle.id === target.id ? { ...vehicle, type: vehicleId } : vehicle
                )),
            };
        }
    }
    if (next.sensorRig?.inheritance?.mode === "vehicle" && vehicleManifest) {
        const inherited = applySensorInheritance(next, { vehicleManifest });
        return { manifest: inherited.manifest, issues: inherited.issues };
    }
    return { manifest: next, issues: [] };
}

export function pluginGrantPreview(manifest, catalog, registry) {
    const stamped = stampInheritedPluginSelections(manifest, catalog, registry);
    const before = JSON.stringify(manifest?.plugins ?? null);
    const after = JSON.stringify(stamped.manifest?.plugins ?? null);
    return {
        required: before !== after,
        manifest: stamped.manifest,
        issues: stamped.issues,
    };
}

export function simpleEnvironment(draft, environments, scenario = null) {
    const suppliedByScenario = Boolean(draft?.scenario?.id);
    const id = suppliedByScenario
        ? String(scenario?.environment?.id || draft?.environment?.id || "")
        : String(draft?.environment?.id || "");
    const list = Array.isArray(environments) ? environments : null;
    const known = list?.find((entry) => entry?.id === id) ?? null;
    const expectedHash = draft?.environment?.expectedHash || "";
    const currentHash = known?.definitionHash || known?.hash || "";
    return {
        id,
        name: known?.name || id,
        suppliedByScenario,
        editable: !suppliedByScenario,
        missing: Boolean(list && id && !known),
        stale: Boolean(expectedHash && currentHash && expectedHash !== currentHash),
    };
}

export function withPositionAxis(vehicle, axis, value) {
    return {
        ...vehicle,
        pose: {
            ...vehicle.pose,
            position: { ...vehicle.pose.position, [axis]: value },
        },
    };
}

export function withHeading(vehicle, yaw) {
    return {
        ...vehicle,
        pose: {
            ...vehicle.pose,
            rotation: { ...vehicle.pose.rotation, y: yaw },
        },
    };
}

export function longitudinalSpeed(vehicle) {
    const yaw = Number(vehicle?.pose?.rotation?.y) || 0;
    const velocity = vehicle?.linearVelocity ?? {};
    return (Number(velocity.x) || 0) * Math.cos(yaw) + (Number(velocity.z) || 0) * -Math.sin(yaw);
}

export function withLongitudinalSpeed(vehicle, speed) {
    const yaw = Number(vehicle?.pose?.rotation?.y) || 0;
    const forwardX = Math.cos(yaw);
    const forwardZ = -Math.sin(yaw);
    const velocity = vehicle.linearVelocity ?? { x: 0, y: 0, z: 0 };
    const current = (Number(velocity.x) || 0) * forwardX + (Number(velocity.z) || 0) * forwardZ;
    return {
        ...vehicle,
        linearVelocity: {
            x: (Number(velocity.x) || 0) - current * forwardX + speed * forwardX,
            y: velocity.y,
            z: (Number(velocity.z) || 0) - current * forwardZ + speed * forwardZ,
        },
    };
}

export function sensorInheritanceStatus(draft, vehicleManifest) {
    const selection = resolveInheritedVehicleSelection(draft);
    const inheriting = draft?.sensorRig?.inheritance?.mode === "vehicle";
    const stored = Array.isArray(draft?.sensorRig?.sensors) ? draft.sensorRig.sensors : [];
    if (!inheriting) {
        return {
            inheriting: false,
            inherited: 0,
            extras: stored.length,
            counts: countSensorTypes(stored),
            issues: [],
        };
    }
    if (!vehicleManifest) {
        return {
            inheriting: true,
            inherited: stored.filter((sensor) => sensor?.inheritedFrom).length,
            extras: stored.filter((sensor) => !sensor?.inheritedFrom).length,
            counts: countSensorTypes(stored),
            issues: [{
                path: "sensorRig.inheritance",
                message: selection.vehicleId
                    ? `Vehicle "${selection.vehicleId}" is not loaded.`
                    : "Choose a vehicle before inheriting sensors.",
            }],
        };
    }
    const applied = applySensorInheritance(draft, { vehicleManifest });
    const sensors = applied.manifest?.sensorRig?.sensors ?? [];
    return {
        inheriting: true,
        inherited: sensors.filter((sensor) => sensor?.inheritedFrom).length,
        extras: sensors.filter((sensor) => !sensor?.inheritedFrom).length,
        counts: countSensorTypes(sensors),
        issues: applied.issues,
    };
}

function countSensorTypes(sensors) {
    const counts = new Map();
    for (const sensor of sensors) {
        const type = sensor?.type || "unknown";
        counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([type, count]) => ({ type, count }));
}
