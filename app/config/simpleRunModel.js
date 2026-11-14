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
import { proposeSensorWiring } from "../simulation/sensors/SensorWiring.js";

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

export function overrideEditTarget(path, { scenarioOwned = false, actorId = "ego" } = {}) {
    if (!scenarioOwned) {
        const pose = `initialState.vehicles[${actorId}].pose`;
        if (path === `${pose}.position.x`) return { surface: "simple", field: "position-x" };
        if (path === `${pose}.position.y`) return { surface: "simple", field: "position-y" };
        if (path === `${pose}.position.z`) return { surface: "simple", field: "position-z" };
        if (path === `${pose}.rotation.y`) return { surface: "simple", field: "heading" };
    }
    if (path === "clock.pacing") return { surface: "simple", field: "pacing" };
    if (path === "clock.speed") return { surface: "simple", field: "speed" };
    if (path === "logging.policy") return { surface: "simple", field: "recording" };
    return { surface: "advanced", tab: advancedTabForOverride(path) };
}

function advancedTabForOverride(path) {
    if (path.startsWith("protobuf")) return "Protobuf";
    if (path.startsWith("sensorRig") || path.startsWith("sensorTransports") || path.startsWith("renderRecipe") || path === "cameraObjectMotion") return "Sensors";
    if (path.startsWith("plugins") || path.startsWith("scripts")) return "Scripts";
    if (path.startsWith("topics") || path.startsWith("schemas")) return "Topics";
    if (path.startsWith("initialState")) return "Initial State";
    if (path.startsWith("clock")) return "Clock";
    if (path.startsWith("controls")) return "Controls";
    if (path.startsWith("observationProfile")) return "Observation";
    if (path.startsWith("assertions")) return "Assertions";
    if (path.startsWith("logging")) return "Logging";
    if (path.startsWith("provenance")) return "Provenance";
    if (path.startsWith("scenario") || path.startsWith("parameters")) return "Scenario";
    if (path === "seed" || path === "name" || path === "id" || path === "description" || path.startsWith("environment")) return "Overview";
    return "JSON";
}

function recoveredIssuePath(issue) {
    const path = String(issue?.path || "").trim();
    if (path) return path;
    const message = String(issue?.message || "");
    const match = message.match(/^(sensorTransports(?:\.[A-Za-z0-9_]+)*|renderRecipe(?:\.[A-Za-z0-9_]+)*)\b/);
    return match ? match[1] : "";
}

function issueExplanation(path, tab) {
    if (path === "plugins" || path.startsWith("plugins.")) return "Plugin selection";
    if (path.startsWith("sensorTransports")) return "Sensor transport";
    if (path.startsWith("parameters") || path.startsWith("scenario.parameterValues")) return "Run parameter";
    if (path.startsWith("schemas") || path.includes(".schema")) return "Schema";
    if (path.startsWith("renderRecipe")) return "Render recipe";
    return tab;
}

function targetVehicleIndex(draft) {
    const vehicles = Array.isArray(draft?.initialState?.vehicles) ? draft.initialState.vehicles : [];
    const targetId = draft?.controls?.targetVehicleId || "ego";
    const target = vehicles.findIndex((vehicle) => vehicle?.id === targetId);
    if (target >= 0) return target;
    const ego = vehicles.findIndex((vehicle) => vehicle?.id === "ego");
    return ego >= 0 ? ego : 0;
}

function simpleFocusForIssue(path, draft) {
    if (path === "name") return "simple-field-name";
    if (path === "scenario.id") return "simple-field-scenario";
    if (path === "scenario.egoVehicleId") return "simple-field-vehicle";
    if (path === "environment.id" && !draft?.scenario) return "simple-field-environment";
    if (path === "clock.pacing") return "simple-field-pacing";
    if (path === "clock.speed") return "simple-field-speed";
    if (path === "logging.policy") return "simple-field-recording";
    if (draft?.scenario) return null;
    const prefix = `initialState.vehicles.${targetVehicleIndex(draft)}`;
    if (path === `${prefix}.pose.position.x`) return "simple-field-position-x";
    if (path === `${prefix}.pose.position.y`) return "simple-field-position-y";
    if (path === `${prefix}.pose.position.z`) return "simple-field-position-z";
    if (path === `${prefix}.pose.rotation.y`) return "simple-field-heading";
    if (path === `${prefix}.linearVelocity.x`) return "simple-field-longitudinal-speed";
    return null;
}

function advancedFocusForIssue(path, draft, tab) {
    if (path === "plugins" || path.startsWith("plugins.")) return "run-focus-plugins";
    const transport = path.match(/^sensorTransports\.bindings\.(\d+)/);
    if (transport) {
        const binding = draft?.sensorTransports?.bindings?.[Number(transport[1])];
        return binding?.sensorId ? `run-focus-transport-${binding.sensorId}` : "run-focus-sensors";
    }
    if (path.startsWith("sensorTransports")) return "run-focus-sensors";
    const parameter = path.match(/^parameters\.(\d+)/);
    if (parameter) return `run-focus-parameter-${parameter[1]}`;
    const sensor = path.match(/^sensorRig\.sensors\.(\d+)/);
    if (sensor) {
        const entry = draft?.sensorRig?.sensors?.[Number(sensor[1])];
        return entry?.id ? `run-focus-sensor-${entry.id}` : "run-focus-sensors";
    }
    if (path.startsWith("sensorRig")) return "run-focus-sensors";
    const topicSchema = path.match(/^topics\.(\d+)\.schema/);
    if (topicSchema) return `run-focus-topic-${topicSchema[1]}-schema`;
    if (path.startsWith("schemas.")) {
        const type = path.slice("schemas.".length);
        const index = (draft?.topics ?? []).findIndex((topic) => (topic?.schema?.type || topic?.type) === type);
        return index >= 0 ? `run-focus-topic-${index}-schema` : "run-focus-tab-Topics";
    }
    if (path.startsWith("renderRecipe")) return "run-focus-render-recipe";
    if (tab === "JSON") return "run-focus-json";
    return `run-focus-tab-${tab}`;
}

export function validationIssueTarget(issue, draft = null) {
    const path = recoveredIssuePath(issue);
    const tab = advancedTabForOverride(path);
    return {
        path,
        explanation: issueExplanation(path, tab),
        simpleFocusId: simpleFocusForIssue(path, draft),
        tab,
        advancedFocusId: advancedFocusForIssue(path, draft, tab),
    };
}

export function simpleCreatedManifest(id, name) {
    const manifest = createDefaultRunManifest({ id, name });
    const vehicleId = manifest.initialState?.vehicles?.[0]?.type;
    const vehicle = vehicleId ? getBuiltInVehicleManifest(vehicleId) : null;
    if (!vehicle) return manifest;
    const inherited = enableSensorInheritance(manifest, vehicle);
    if (inherited.issues.length > 0) return manifest;
    return normalizeRunManifest(proposeSensorWiring(inherited.manifest).manifest);
}

export function newContactRunDefaults(source, vehicle, plant = null) {
    const pluginContact = plant?.id === vehicle?.dynamics?.plant && plant?.model === "contact-bicycle-v1"
        && vehicle.pluginLocks?.some((lock) => lock.plants?.includes(plant.id)
            && lock.pluginId === plant.ownership?.pluginId && lock.version === plant.ownership?.version && lock.packageHash === plant.ownership?.packageHash
            && lock.runtimeHash === plant.ownership?.runtimeHash);
    const manifest = structuredClone(source);
    if (vehicle?.dynamics?.model === "contact-bicycle-v2" || pluginContact) manifest.controls.zeroSpeedResponse = "brake-v1";
    else delete manifest.controls.zeroSpeedResponse;
    return manifest;
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
        const newIds = inherited.manifest.sensorRig.sensors.filter((sensor) => !draft.sensorRig.sensors.some((existing) => existing.id === sensor.id)).map((sensor) => sensor.id);
        const wired = proposeSensorWiring(inherited.manifest, { sensorIds: newIds });
        return { manifest: wired.manifest, issues: [...inherited.issues, ...wired.issues] };
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
