import { BlockOutput } from "../../ScriptManager.js";
import {
    SIGNAL_NAMESPACES,
    SIGNAL_PATHS,
    devicesLeafPath,
    entityIdSegment,
    vehiclesLeafPath,
} from "../../runtime/SignalPaths.js";
import { cloneValue } from "../../runtime/SignalStore.js";
import {
    POSE3D_TYPE,
    VEC3_TYPE,
    finiteFloat,
    finiteInt32,
    normalizePose3d,
    normalizeVec3,
} from "../../types/PortTypes.js";

import { freezePorts, defineBlock } from "../defineBlock.js";
const MISSING_SIGNAL = Object.freeze({
    exists: false,
    stale: true,
    value: null,
});

function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readLeaf(manager, path) {
    if (!path || typeof manager?.readSignal !== "function") return MISSING_SIGNAL;
    return manager.readSignal(path);
}

function readVehicleLeaf(manager, actorId, leaf) {
    const canonical = readLeaf(manager, vehiclesLeafPath(actorId, leaf));
    if (canonical.exists) return canonical;
    if (entityIdSegment(actorId, "ego") !== "ego") return canonical;
    return readLeaf(manager, `${SIGNAL_NAMESPACES.VEHICLE}.ego.${leaf}`);
}

function freshValue(signal) {
    return Boolean(signal?.exists) && !signal.stale;
}

function zeroPose() {
    return normalizePose3d(null);
}

function zeroVec3() {
    return normalizeVec3(null);
}

const VEHICLE_STATE_PORTS = freezePorts(
    [{ label: "actorId", type: "string" }],
    [
        { label: "pose", type: POSE3D_TYPE },
        { label: "velocity", type: VEC3_TYPE },
        { label: "steering", type: "float64" },
        { label: "exists", type: "boolean" },
        { label: "stale", type: "boolean" },
    ],
);

const DEVICE_STATE_PORTS = freezePorts(
    [{ label: "deviceId", type: "string" }],
    [
        { label: "pose", type: POSE3D_TYPE },
        { label: "enabled", type: "boolean" },
        { label: "exists", type: "boolean" },
        { label: "stale", type: "boolean" },
    ],
);

const SIMULATION_CLOCK_PORTS = freezePorts(
    [],
    [
        { label: "time", type: "float64" },
        { label: "dt", type: "float64" },
        { label: "step", type: "int32" },
        { label: "status", type: "string" },
    ],
);

const SCENARIO_STATUS_PORTS = freezePorts(
    [],
    [
        { label: "status", type: "string" },
        { label: "terminal", type: "json" },
        { label: "latestTrigger", type: "json" },
    ],
);

export const VehicleStateBlock = defineBlock({
    type: "VehicleStateBlock",
    ports: VEHICLE_STATE_PORTS,
    execute() {
        const actorId = this.getInput("actorId");
        const poseSignal = readVehicleLeaf(this.manager, actorId, "pose");
        const velocitySignal = readVehicleLeaf(this.manager, actorId, "velocity");
        const steeringSignal = readVehicleLeaf(this.manager, actorId, "steeringAngle");
        const exists = poseSignal.exists;
        const stale = !exists
            || poseSignal.stale
            || velocitySignal.stale
            || (steeringSignal.exists && steeringSignal.stale);

        return new BlockOutput()
            .set("pose", freshValue(poseSignal) ? normalizePose3d(poseSignal.value) : zeroPose())
            .set("velocity", freshValue(velocitySignal) ? normalizeVec3(velocitySignal.value) : zeroVec3())
            .set("steering", freshValue(steeringSignal) ? finiteFloat(steeringSignal.value) : 0)
            .set("exists", exists)
            .set("stale", stale);
    },
});

export const DeviceStateBlock = defineBlock({
    type: "DeviceStateBlock",
    ports: DEVICE_STATE_PORTS,
    execute() {
        const deviceId = this.getInput("deviceId");
        const poseSignal = readLeaf(this.manager, devicesLeafPath(deviceId, "pose"));
        const enabledSignal = readLeaf(this.manager, devicesLeafPath(deviceId, "enabled"));
        const exists = poseSignal.exists;
        const stale = !exists || poseSignal.stale || (enabledSignal.exists && enabledSignal.stale);

        return new BlockOutput()
            .set("pose", freshValue(poseSignal) ? normalizePose3d(poseSignal.value) : zeroPose())
            .set("enabled", freshValue(enabledSignal) ? Boolean(enabledSignal.value) : false)
            .set("exists", exists)
            .set("stale", stale);
    },
});

export const SimulationClockBlock = defineBlock({
    type: "SimulationClockBlock",
    ports: SIMULATION_CLOCK_PORTS,
    valid() {
        return true;
    },
    execute() {
        const blob = readLeaf(this.manager, SIGNAL_PATHS.SIMULATION);
        const blobValue = blob.exists && isPlainObject(blob.value) ? blob.value : {};
        const timeLeaf = readLeaf(this.manager, SIGNAL_PATHS.SIMULATION_TIME);
        const dtLeaf = readLeaf(this.manager, SIGNAL_PATHS.SIMULATION_FIXED_DT);
        const stepLeaf = readLeaf(this.manager, SIGNAL_PATHS.SIMULATION_STEP);
        const statusLeaf = readLeaf(this.manager, SIGNAL_PATHS.SIMULATION_STATUS);

        const time = timeLeaf.exists ? finiteFloat(timeLeaf.value) : finiteFloat(blobValue.time);
        const dt = blob.exists && blobValue.dt != null && blobValue.dt !== ""
            ? finiteFloat(blobValue.dt)
            : (dtLeaf.exists ? finiteFloat(dtLeaf.value) : 0);
        const step = stepLeaf.exists
            ? finiteInt32(stepLeaf.value)
            : finiteInt32(blobValue.step ?? blobValue.frame);
        const status = statusLeaf.exists ? String(statusLeaf.value ?? "") : "";

        return new BlockOutput()
            .set("time", time)
            .set("dt", dt)
            .set("step", step)
            .set("status", status);
    },
});

export const ScenarioStatusBlock = defineBlock({
    type: "ScenarioStatusBlock",
    ports: SCENARIO_STATUS_PORTS,
    valid() {
        return true;
    },
    execute() {
        const statusSignal = readLeaf(this.manager, SIGNAL_PATHS.SCENARIO_STATUS);
        const terminalSignal = readLeaf(this.manager, SIGNAL_PATHS.SCENARIO_TERMINAL);
        const triggerSignal = readLeaf(this.manager, SIGNAL_PATHS.SCENARIO_LATEST_TRIGGER);

        return new BlockOutput()
            .set("status", freshValue(statusSignal) ? String(statusSignal.value ?? "") : "")
            .set("terminal", freshValue(terminalSignal) ? cloneValue(terminalSignal.value) : null)
            .set("latestTrigger", freshValue(triggerSignal) ? cloneValue(triggerSignal.value) : null);
    },
});

export const SIMULATOR_ADAPTER_BLOCKS = Object.freeze({
    VehicleStateBlock,
    DeviceStateBlock,
    SimulationClockBlock,
    ScenarioStatusBlock,
});

export const SIMULATOR_ADAPTER_PORTS = Object.freeze({
    VehicleStateBlock: VEHICLE_STATE_PORTS,
    DeviceStateBlock: DEVICE_STATE_PORTS,
    SimulationClockBlock: SIMULATION_CLOCK_PORTS,
    ScenarioStatusBlock: SCENARIO_STATUS_PORTS,
});
