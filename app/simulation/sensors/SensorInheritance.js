import { threePoseToRep103 } from "../../autonomy/CoordinateFrames.js";
import {
    createRunSensor,
    normalizeRunSensor,
    normalizeVehicleSensor,
    sensorTypeRegistry,
} from "./SensorTypeRegistry.js";

/**
 * Opt-in link from a run's owning vehicle to that vehicle's sensor mounts.
 * Locked mount fields are reapplied from the vehicle. Run overrides stay.
 * Mode "off" is the absence of `sensorRig.inheritance`.
 */

export function resolveInheritedVehicleSelection(manifest) {
    const actorId = text(manifest?.sensorRig?.vehicleId, "ego");
    const vehicles = Array.isArray(manifest?.initialState?.vehicles) ? manifest.initialState.vehicles : [];
    const actor = vehicles.find((entry) => entry?.id === actorId);
    if (manifest?.scenario?.id && actorId === "ego") {
        return { actorId, vehicleId: text(manifest.scenario.egoVehicleId, actor?.type || "") || null };
    }
    return { actorId, vehicleId: text(actor?.type) || null };
}

export function applySensorInheritance(manifest, {
    vehicleManifest = null,
    registry = sensorTypeRegistry,
} = {}) {
    if (manifest?.sensorRig?.inheritance?.mode !== "vehicle") {
        return { manifest, issues: [] };
    }
    const { actorId, vehicleId } = resolveInheritedVehicleSelection(manifest);
    if (!vehicleManifest) {
        return {
            manifest,
            issues: [{
                path: "sensorRig.inheritance",
                message: vehicleId
                    ? `Sensor inheritance requires vehicle "${vehicleId}".`
                    : `Sensor inheritance requires a vehicle for actor "${actorId}".`,
            }],
        };
    }
    const vehicleSensors = (Array.isArray(vehicleManifest.sensors) ? vehicleManifest.sensors : [])
        .map((sensor, index) => normalizeVehicleSensor(sensor, index, registry));
    const current = Array.isArray(manifest.sensorRig?.sensors) ? manifest.sensorRig.sensors : [];
    const used = new Set();
    const inherited = vehicleSensors.map((vehicleSensor) => {
        const index = matchingSensorIndex(current, vehicleSensor.id, used);
        if (index >= 0) used.add(index);
        return projectInheritedSensor(vehicleSensor, index >= 0 ? current[index] : null, actorId, registry);
    });
    const extras = [];
    const orphans = [];
    current.forEach((sensor, index) => {
        if (used.has(index)) return;
        if (sensor?.inheritedFrom) orphans.push(sensor);
        else extras.push(sensor);
    });
    const sensors = [...inherited, ...extras, ...orphans];
    const issues = orphans.map((sensor) => {
        const index = sensors.indexOf(sensor);
        return {
            path: `sensorRig.sensors.${index}.inheritedFrom`,
            message: `Inherited sensor "${sensor.inheritedFrom}" is no longer on the selected vehicle.`,
        };
    });
    const seen = new Set();
    sensors.forEach((sensor, index) => {
        if (seen.has(sensor.id)) {
            issues.push({
                path: `sensorRig.sensors.${index}.id`,
                message: `Duplicate id "${sensor.id}".`,
            });
        }
        seen.add(sensor.id);
    });
    return {
        manifest: {
            ...manifest,
            sensorRig: {
                ...manifest.sensorRig,
                inheritance: { mode: "vehicle" },
                sensors,
            },
        },
        issues,
    };
}

export function enableSensorInheritance(manifest, vehicleManifest, options = {}) {
    const linked = {
        ...manifest,
        sensorRig: {
            ...(manifest?.sensorRig ?? {}),
            inheritance: { mode: "vehicle" },
        },
    };
    return applySensorInheritance(linked, { ...options, vehicleManifest });
}

export function detachSensorInheritance(manifest, options = {}) {
    if (manifest?.sensorRig?.inheritance?.mode !== "vehicle") {
        return { manifest, issues: [] };
    }
    const source = options.vehicleManifest
        ? applySensorInheritance(manifest, options).manifest
        : manifest;
    return { manifest: clearSensorInheritanceMarkers(source), issues: [] };
}

export function clearSensorInheritanceMarkers(manifest) {
    if (!manifest?.sensorRig) return manifest;
    const sensorRig = { ...manifest.sensorRig };
    delete sensorRig.inheritance;
    sensorRig.sensors = (sensorRig.sensors ?? []).map((sensor) => {
        if (!sensor?.inheritedFrom) return sensor;
        const next = { ...sensor };
        delete next.inheritedFrom;
        return next;
    });
    return { ...manifest, sensorRig };
}

export function isInheritedSensorFieldLocked(sensor, path, definition) {
    if (!sensor?.inheritedFrom) return false;
    const joined = (Array.isArray(path) ? path : String(path ?? "").split(".")).join(".");
    return inheritedFieldPaths(sensor, definition).some((locked) => (
        joined === locked || joined.startsWith(`${locked}.`)
    ));
}

function matchingSensorIndex(sensors, vehicleSensorId, used) {
    const marked = sensors.findIndex((sensor, index) => (
        !used.has(index) && sensor?.inheritedFrom === vehicleSensorId
    ));
    if (marked >= 0) return marked;
    return sensors.findIndex((sensor, index) => (
        !used.has(index) && !sensor?.inheritedFrom && sensor?.id === vehicleSensorId
    ));
}

function projectInheritedSensor(vehicleSensor, existing, actorId, registry) {
    const definition = registry.get(vehicleSensor.type);
    const base = existing
        ? withoutInheritanceMarker(existing)
        : createRunSensor(vehicleSensor.type, {
            id: vehicleSensor.id,
            parentId: actorId,
            frameId: `${vehicleSensor.id}_frame`,
        }, 0, registry);
    const source = {
        ...base,
        id: vehicleSensor.id,
        type: vehicleSensor.type,
        parentId: actorId,
        pose: threePoseToRep103(vehicleSensor.pose),
        calibration: lockedCalibration(base.calibration, vehicleSensor, definition),
    };
    delete source.poseReference;
    delete source.inheritedFrom;
    if (definition?.pluginSensor) source.rateHz = vehicleSensor.config?.rateHz;
    const normalized = normalizeRunSensor(source, 0, registry);
    return { ...normalized, inheritedFrom: vehicleSensor.id };
}

function withoutInheritanceMarker(sensor) {
    const next = { ...sensor };
    delete next.inheritedFrom;
    delete next.poseReference;
    return next;
}

function lockedCalibration(existing = {}, vehicleSensor, definition) {
    const calibration = { ...(existing ?? {}) };
    const config = vehicleSensor.config ?? {};
    if (definition?.pluginSensor) {
        return {
            ...calibration,
            scanLayout: config.scanLayout,
            parameters: config.parameters,
            products: config.products,
        };
    }
    if (vehicleSensor.type === "camera") {
        return {
            ...calibration,
            width: config.width,
            height: config.height,
            verticalFovDeg: config.fov,
        };
    }
    if (vehicleSensor.type === "lidar3d") {
        return {
            ...calibration,
            range: config.range,
            azimuth: {
                startDeg: config.thetaRange?.[0],
                endDeg: config.thetaRange?.[1],
                stepDeg: config.thetaStep,
            },
            elevation: {
                startDeg: config.phiRange?.[0],
                endDeg: config.phiRange?.[1],
                stepDeg: config.phiStep,
            },
        };
    }
    if (vehicleSensor.type === "imu") {
        return { ...calibration, gravity: config.gravity };
    }
    if (vehicleSensor.type === "gnss") {
        return {
            ...calibration,
            datum: {
                ...(calibration.datum ?? {}),
                latitude: config.datum?.latitude,
                longitude: config.datum?.longitude,
            },
        };
    }
    if (vehicleSensor.type === "wheel-odometry") {
        return {
            ...calibration,
            wheelRadius: config.wheelRadius,
            trackWidth: config.trackWidth,
        };
    }
    return calibration;
}

function inheritedFieldPaths(sensor, definition) {
    const paths = ["id", "type", "parentId", "pose", "pose.position", "pose.rotation"];
    if (definition?.pluginSensor) {
        paths.push("rateHz", "calibration.scanLayout", "calibration.parameters", "calibration.products");
    } else if (sensor.type === "camera") {
        paths.push("calibration.width", "calibration.height", "calibration.verticalFovDeg");
    } else if (sensor.type === "lidar3d") {
        paths.push("calibration.range", "calibration.azimuth", "calibration.elevation");
    } else if (sensor.type === "imu") {
        paths.push("calibration.gravity");
    } else if (sensor.type === "gnss") {
        paths.push("calibration.datum.latitude", "calibration.datum.longitude");
    } else if (sensor.type === "wheel-odometry") {
        paths.push("calibration.wheelRadius", "calibration.trackWidth");
    }
    return paths;
}

function text(value, fallback = "") {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed || fallback;
    }
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return fallback;
}
