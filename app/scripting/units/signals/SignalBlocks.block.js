import { BlockOutput, UnitBlock } from "../../ScriptManager.js";
import { SIGNAL_NAMESPACES, SIGNAL_PATHS } from "../../runtime/SignalPaths.js";
import { getByPath, setByPath } from "../../runtime/SignalStore.js";
import { normalizeType, parseValueByType, SUPPORTED_TYPES } from "../program/ProgramTypes.js";
import { routeProgress } from "../../../scenarios/route/Route.js";

const JSON_TYPES = new Set(["json", "message", "route", "waypoint", "pose2d", "pose3d", "vec2", "vec3", "sim_event"]);

export function pathOrFallback(path, fallback) {
    const normalized = String(path || "").trim();
    return normalized || fallback;
}

function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function toInt(value, fallback = 0) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJson(value, fallback) {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value !== "string") return value;

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

export function stringifyJson(value) {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value ?? null, null, 2);
    } catch {
        return "";
    }
}

export function parseConfigValue(value, type = "json") {
    if (JSON_TYPES.has(type)) return parseJson(value, value ?? null);
    return parseValueByType(value, type);
}

function distanceBetween(a, b) {
    const ax = toNumber(a?.x ?? a?.position?.x ?? a?.longitude ?? a?.lon, 0);
    const ay = toNumber(a?.y ?? a?.position?.y ?? a?.latitude ?? a?.lat, 0);
    const az = toNumber(a?.z ?? a?.position?.z ?? a?.altitude, 0);
    const bx = toNumber(b?.x ?? b?.position?.x ?? b?.longitude ?? b?.lon, 0);
    const by = toNumber(b?.y ?? b?.position?.y ?? b?.latitude ?? b?.lat, 0);
    const bz = toNumber(b?.z ?? b?.position?.z ?? b?.altitude, 0);
    return Math.hypot(ax - bx, ay - by, az - bz);
}

export function normalizeConfig(defaults, data = {}) {
    return {
        ...defaults,
        ...(data || {})
    };
}

function readSignal(manager, path, options = {}) {
    return manager.readSignal(path, options);
}

function readSignalValue(manager, path, fallback = null, options = {}) {
    const signal = readSignal(manager, path, options);
    return signal.exists && !signal.stale ? signal.value : fallback;
}

function readNestedSignalValue(manager, directPath, parentPath, fieldPath, fallback = null) {
    const direct = readSignal(manager, directPath);
    if (direct.exists && !direct.stale) return direct.value;

    const parent = readSignal(manager, parentPath);
    if (!parent.exists || parent.stale) return fallback;

    return getByPath(parent.value, fieldPath, fallback);
}

function signalStatusOutput(signal) {
    return new BlockOutput()
        .set("exists", signal.exists)
        .set("stale", signal.stale)
        .set("age", signal.age ?? -1);
}

export function typedOutput(type) {
    return normalizeType(type || "json");
}

export class ConfiguredBlock extends UnitBlock {
    defaults() {
        return this.constructor.defaults || {};
    }

    normalizeConfig(data = {}) {
        return normalizeConfig(this.defaults(), data);
    }

    config() {
        return this.normalizeConfig({
            ...this.state,
            ...(this.getStoredData() || {})
        });
    }

    serializeState() {
        return { ...this.state };
    }

    hydrateState(state = {}) {
        this.state = this.normalizeConfig(state);
        this.reregister();
    }
}

export class ReadSignalBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.VEHICLE_EGO_POSE, type: "json", staleAfter: "", fallback: "" };

    register() {
        this.state = this.config();
        this.registerOutput("value", typedOutput(this.state.type));
        this.registerOutput("exists", "boolean");
        this.registerOutput("stale", "boolean");
        this.registerOutput("age", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        const signal = readSignal(this.manager, this.state.path, {
            staleAfter: this.state.staleAfter
        });
        const fallback = parseConfigValue(this.state.fallback, this.state.type);
        const value = signal.exists && !signal.stale ? signal.value : fallback;
        return signalStatusOutput(signal).set("value", parseValueByType(value, this.state.type));
    }
}

export class WriteSignalBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.DEBUG_VALUE, type: "json", source: "script", staleAfter: "" };

    register() {
        this.state = this.config();
        this.registerInput("value", typedOutput(this.state.type));
        this.registerOutput("written", "boolean");
    }

    valid() {
        return this.hasInput("value");
    }

    execute() {
        const value = this.getInput("value");
        this.manager.writeSignal(this.state.path, value, {
            type: typedOutput(this.state.type),
            source: this.state.source || "script",
            staleAfter: this.state.staleAfter
        });
        return new BlockOutput().set("written", true);
    }
}

export class SignalExistsBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.DEBUG_VALUE };

    register() {
        this.state = this.config();
        this.registerOutput("exists", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("exists", this.manager.signalExists(this.state.path));
    }
}

export class SignalAgeBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.DEBUG_VALUE, staleAfter: "" };

    register() {
        this.state = this.config();
        this.registerOutput("age", "float64");
        this.registerOutput("stale", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        const signal = readSignal(this.manager, this.state.path, {
            staleAfter: this.state.staleAfter
        });
        return new BlockOutput()
            .set("age", signal.age ?? -1)
            .set("stale", signal.stale);
    }
}

export class SignalChangedBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.DEBUG_VALUE };

    register() {
        this.state = this.config();
        this.registerOutput("changed", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        return new BlockOutput().set("changed", this.manager.signalChanged(this.state.path));
    }
}

export class SignalLatchBlock extends ConfiguredBlock {
    static defaults = { type: "json" };

    constructor(uuid) {
        super(uuid);
        this.lastValue = null;
        this.hasLastValue = false;
    }

    register() {
        this.state = this.config();
        this.registerInput("value", typedOutput(this.state.type));
        this.registerInput("valid", "boolean");
        this.registerOutput("value", typedOutput(this.state.type));
    }

    valid() {
        return this.hasInput("value") && this.hasInput("valid");
    }

    serializeRuntimeState() {
        return {
            lastValue: this.lastValue,
            hasLastValue: this.hasLastValue
        };
    }

    hydrateRuntimeState(state = {}) {
        this.lastValue = state.lastValue ?? null;
        this.hasLastValue = Boolean(state.hasLastValue);
    }

    execute() {
        const valid = Boolean(this.getInput("valid"));
        const incoming = this.getInput("value");
        if (valid || !this.hasLastValue) {
            this.lastValue = incoming;
            this.hasLastValue = true;
        }
        return new BlockOutput().set("value", this.lastValue);
    }
}

export class SignalDefaultBlock extends ConfiguredBlock {
    static defaults = { type: "json" };

    register() {
        this.state = this.config();
        this.registerInput("value", typedOutput(this.state.type));
        this.registerInput("fallback", typedOutput(this.state.type));
        this.registerInput("useDefault", "boolean");
        this.registerOutput("value", typedOutput(this.state.type));
    }

    valid() {
        return this.hasInput("value") && this.hasInput("fallback") && this.hasInput("useDefault");
    }

    execute() {
        const useDefault = Boolean(this.getInput("useDefault"));
        return new BlockOutput().set("value", useDefault ? this.getInput("fallback") : this.getInput("value"));
    }
}

export class StoreNamespaceBlock extends ConfiguredBlock {
    static defaults = { namespace: "topics" };

    register() {
        this.state = this.config();
        this.registerInput("path", "string");
        this.registerOutput("path", "string");
    }

    valid() {
        return this.hasInput("path");
    }

    execute() {
        const path = String(this.getInput("path") || "").replace(/^\.+/, "");
        return new BlockOutput().set("path", `${this.state.namespace}.${path}`);
    }
}

export class TopicSnapshotBlock extends ConfiguredBlock {
    static defaults = { topic: "/controls/command", staleAfter: "" };

    register() {
        this.state = this.config();
        this.registerOutput("message", "message");
        this.registerOutput("exists", "boolean");
        this.registerOutput("stale", "boolean");
        this.registerOutput("age", "float64");
    }

    valid() {
        return true;
    }

    execute() {
        const signal = readSignal(this.manager, `topics.${this.state.topic}`, {
            staleAfter: this.state.staleAfter
        });
        return signalStatusOutput(signal).set("message", signal.exists && !signal.stale ? signal.value : null);
    }
}

export class TopicFieldBlock extends ConfiguredBlock {
    static defaults = { fieldPath: "data", type: "json", fallback: "" };

    register() {
        this.state = this.config();
        this.registerInput("message", "message");
        this.registerOutput("value", typedOutput(this.state.type));
    }

    valid() {
        return this.hasInput("message");
    }

    execute() {
        const message = this.getInput("message");
        const fallback = parseConfigValue(this.state.fallback, this.state.type);
        const value = getByPath(message, this.state.fieldPath, fallback);
        return new BlockOutput().set("value", parseValueByType(value, this.state.type));
    }
}

export class BuildTopicMessageBlock extends ConfiguredBlock {
    static defaults = { fieldPath: "data", type: "json" };

    register() {
        this.state = this.config();
        this.registerInput("base", "message");
        this.registerInput("value", typedOutput(this.state.type));
        this.registerOutput("message", "message");
    }

    valid() {
        return this.hasInput("value");
    }

    execute() {
        const base = this.hasInput("base") ? this.getInput("base") : {};
        const value = this.getInput("value");
        return new BlockOutput().set("message", setByPath(base || {}, this.state.fieldPath, value));
    }
}

export class StagePublishBlock extends ConfiguredBlock {
    static defaults = { topic: "/controls/command", messageType: "message", path: "" };

    register() {
        this.state = this.config();
        this.registerInput("message", "message");
        this.registerOutput("staged", "boolean");
        this.registerOutput("path", "string");
    }

    valid() {
        return this.hasInput("message");
    }

    execute() {
        const path = pathOrFallback(this.state.path, `publish.${this.state.topic}`);
        this.manager.writeSignal(path, this.getInput("message"), {
            type: "message",
            source: "stage-publish",
            metadata: {
                topic: this.state.topic,
                messageType: this.state.messageType
            }
        });
        return new BlockOutput()
            .set("staged", true)
            .set("path", path);
    }
}

export class TopicStaleGateBlock extends ConfiguredBlock {
    static defaults = {};

    register() {
        this.registerInput("message", "message");
        this.registerInput("stale", "boolean");
        this.registerOutput("message", "message");
        this.registerOutput("allowed", "boolean");
    }

    valid() {
        return this.hasInput("message") && this.hasInput("stale");
    }

    execute() {
        const stale = Boolean(this.getInput("stale"));
        return new BlockOutput()
            .set("message", stale ? null : this.getInput("message"))
            .set("allowed", !stale);
    }
}

export class TopicMetadataBlock extends ConfiguredBlock {
    static defaults = { topic: "/controls/command" };

    register() {
        this.state = this.config();
        this.registerOutput("topic", "string");
        this.registerOutput("type", "string");
        this.registerOutput("source", "string");
        this.registerOutput("age", "float64");
        this.registerOutput("stale", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        const signal = readSignal(this.manager, `topics.${this.state.topic}`);
        return new BlockOutput()
            .set("topic", this.state.topic)
            .set("type", signal.type || "")
            .set("source", signal.source || "")
            .set("age", signal.age ?? -1)
            .set("stale", signal.stale);
    }
}

export class PathSnapshotBlock extends ConfiguredBlock {
    register() {
        this.state = this.config();
        this.registerOutput(this.constructor.outputLabel || "value", this.constructor.outputType || "json");
        this.registerOutput("exists", "boolean");
        this.registerOutput("stale", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        const signal = readSignal(this.manager, this.state.path);
        return new BlockOutput()
            .set(this.constructor.outputLabel || "value", signal.exists && !signal.stale ? signal.value : null)
            .set("exists", signal.exists)
            .set("stale", signal.stale);
    }
}

export class VehicleSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.VEHICLE_EGO };
}

export class VehiclePoseBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.VEHICLE_EGO_POSE };
    static outputLabel = "pose";
    static outputType = "pose3d";

    execute() {
        const path = this.state.path;
        const parent = path.replace(/\.pose$/, "");
        const pose = readNestedSignalValue(this.manager, path, parent, "pose", null);
        const signal = readSignal(this.manager, path);
        return new BlockOutput()
            .set("pose", pose)
            .set("exists", pose !== null && pose !== undefined)
            .set("stale", signal.exists ? signal.stale : false);
    }
}

export class VehicleVelocityBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.VEHICLE_EGO_VELOCITY };
    static outputLabel = "velocity";
    static outputType = "vec3";
}

export class VehicleDimensionsBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.VEHICLE_EGO_DIMENSIONS };
    static outputLabel = "dimensions";
}

export class DeviceSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.FRONT_CAMERA };
}

export class SimulationSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.SIMULATION };

    register() {
        this.state = this.config();
        this.registerOutput("value", "json");
        this.registerOutput("dt", "float64");
        this.registerOutput("frame", "int32");
    }

    execute() {
        const value = readSignalValue(this.manager, this.state.path, {});
        return new BlockOutput()
            .set("value", value)
            .set("dt", toNumber(value?.dt, 0))
            .set("frame", toInt(value?.frame ?? value?.step, 0));
    }
}

export class ScenarioSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.SCENARIO };
}

export class ObjectSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.TARGET_OBJECT };
}

export class WaypointListBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.MISSION_ROUTE, waypoints: "[]" };

    register() {
        this.state = this.config();
        this.registerOutput("route", "route");
        this.registerOutput("count", "int32");
    }

    valid() {
        return true;
    }

    execute() {
        const route = readSignalValue(this.manager, this.state.path, parseJson(this.state.waypoints, []));
        const list = Array.isArray(route) ? route : route?.waypoints || [];
        return new BlockOutput()
            .set("route", route)
            .set("count", list.length);
    }
}

export class CurrentWaypointBlock extends ConfiguredBlock {
    static defaults = { indexPath: SIGNAL_PATHS.MISSION_CURRENT_WAYPOINT };

    register() {
        this.state = this.config();
        this.registerInput("route", "route");
        this.registerOutput("waypoint", "waypoint");
        this.registerOutput("index", "int32");
        this.registerOutput("complete", "boolean");
    }

    valid() {
        return this.hasInput("route");
    }

    execute() {
        const route = this.getInput("route");
        const list = Array.isArray(route) ? route : route?.waypoints || [];
        const index = toInt(readSignalValue(this.manager, this.state.indexPath, 0), 0);
        return new BlockOutput()
            .set("waypoint", list[index] || null)
            .set("index", index)
            .set("complete", index >= list.length);
    }
}

export class AdvanceWaypointBlock extends ConfiguredBlock {
    static defaults = { indexPath: SIGNAL_PATHS.MISSION_CURRENT_WAYPOINT };

    register() {
        this.state = this.config();
        this.registerInput("advance", "boolean");
        this.registerInput("route", "route");
        this.registerOutput("index", "int32");
    }

    valid() {
        return this.hasInput("advance");
    }

    execute() {
        const route = this.hasInput("route") ? this.getInput("route") : [];
        const list = Array.isArray(route) ? route : route?.waypoints || [];
        const current = toInt(readSignalValue(this.manager, this.state.indexPath, 0), 0);
        const next = Boolean(this.getInput("advance")) ? Math.min(current + 1, Math.max(0, list.length)) : current;
        this.manager.writeSignal(this.state.indexPath, next, { type: "int32", source: "advance-waypoint" });
        return new BlockOutput().set("index", next);
    }
}

export class ReachedWaypointBlock extends ConfiguredBlock {
    static defaults = {};

    register() {
        this.registerInput("pose", "pose3d");
        this.registerInput("waypoint", "waypoint");
        this.registerInput("threshold", "float64");
        this.registerOutput("reached", "boolean");
        this.registerOutput("distance", "float64");
    }

    valid() {
        return this.hasInput("pose") && this.hasInput("waypoint") && this.hasInput("threshold");
    }

    execute() {
        const distance = distanceBetween(this.getInput("pose"), this.getInput("waypoint"));
        const threshold = toNumber(this.getInput("threshold"), 1);
        return new BlockOutput()
            .set("reached", distance <= threshold)
            .set("distance", distance);
    }
}

export class MissionStateBlock extends PathSnapshotBlock {
    static defaults = { path: SIGNAL_PATHS.MISSION_STATE };
    static outputLabel = "state";
    static outputType = "string";
}

export class SetMissionStateBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.MISSION_STATE };

    register() {
        this.state = this.config();
        this.registerInput("state", "string");
        this.registerOutput("written", "boolean");
    }

    valid() {
        return this.hasInput("state");
    }

    execute() {
        this.manager.writeSignal(this.state.path, this.getInput("state"), {
            type: "string",
            source: "set-mission-state"
        });
        return new BlockOutput().set("written", true);
    }
}

export class RouteProgressBlock extends ConfiguredBlock {
    static defaults = {};

    register() {
        this.registerInput("pose", "pose3d");
        this.registerInput("route", "route");
        this.registerOutput("progress", "float64");
        this.registerOutput("segment", "int32");
    }

    valid() {
        return this.hasInput("pose") && this.hasInput("route");
    }

    execute() {
        const pose = this.getInput("pose");
        const route = this.getInput("route");
        const result = routeProgress(route, pose);
        return new BlockOutput()
            .set("progress", result.progress)
            .set("segment", result.segment);
    }
}

export class ScenarioFlagReadBlock extends ConfiguredBlock {
    static defaults = { flag: "stopSeen", type: "boolean", fallback: "false" };

    register() {
        this.state = this.config();
        this.registerOutput("value", typedOutput(this.state.type));
        this.registerOutput("exists", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        const path = `scenario.flags.${this.state.flag}`;
        const signal = readSignal(this.manager, path);
        const fallback = parseConfigValue(this.state.fallback, this.state.type);
        return new BlockOutput()
            .set("value", parseValueByType(signal.exists ? signal.value : fallback, this.state.type))
            .set("exists", signal.exists);
    }
}

export class ScenarioFlagWriteBlock extends ConfiguredBlock {
    static defaults = { flag: "stopSeen", type: "boolean" };

    register() {
        this.state = this.config();
        this.registerInput("value", typedOutput(this.state.type));
        this.registerOutput("written", "boolean");
    }

    valid() {
        return this.hasInput("value");
    }

    execute() {
        this.manager.writeSignal(`scenario.flags.${this.state.flag}`, this.getInput("value"), {
            type: typedOutput(this.state.type),
            source: "scenario-flag-write"
        });
        return new BlockOutput().set("written", true);
    }
}

export class BindingBlock extends ConfiguredBlock {
    bindingKind = "input";

    register() {
        this.state = this.config();
        this.registerOutput("config", "json");
    }

    valid() {
        return true;
    }

    getBindingDefinition() {
        return {
            kind: this.bindingKind,
            ...this.state
        };
    }

    execute() {
        return new BlockOutput().set("config", this.getBindingDefinition());
    }
}

export class BindInputBlock extends BindingBlock {
    static defaults = { sourceKind: "topic", source: "/controls/command", path: SIGNAL_PATHS.CONTROLS_COMMAND_TOPIC, type: "message" };
    bindingKind = "input";
}

export class BindOutputBlock extends BindingBlock {
    static defaults = { sinkKind: "topic", sink: "/controls/command", path: SIGNAL_PATHS.CONTROLS_COMMAND_PUBLISH, type: "message" };
    bindingKind = "output";
}

export class BindTriggerBlock extends BindingBlock {
    static defaults = { path: SIGNAL_PATHS.CONTROLS_COMMAND_TOPIC, mode: "update" };
    bindingKind = "trigger";
}

export class EntrypointBlock extends ConfiguredBlock {
    entrypointKind = "tick";

    register() {
        this.state = this.config();
        this.registerOutput("config", "json");
    }

    valid() {
        return true;
    }

    getEntrypointDefinition() {
        return {
            kind: this.entrypointKind,
            ...this.state
        };
    }

    execute() {
        return new BlockOutput().set("config", this.getEntrypointDefinition());
    }
}

export class OnSignalUpdateBlock extends EntrypointBlock {
    static defaults = { path: SIGNAL_PATHS.CONTROLS_COMMAND_TOPIC };
    entrypointKind = "signal-update";
}

export class OnTickBlock extends EntrypointBlock {
    static defaults = { clockPath: SIGNAL_PATHS.SIMULATION_FRAME };
    entrypointKind = "tick";
}

export class OnTimerBlock extends EntrypointBlock {
    static defaults = { intervalMs: 100 };
    entrypointKind = "timer";
}

export class ProbeSignalBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.DEBUG_VALUE };

    register() {
        this.state = this.config();
        this.registerOutput("value", "json");
        this.registerOutput("age", "float64");
        this.registerOutput("stale", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        const signal = readSignal(this.manager, this.state.path);
        return new BlockOutput()
            .set("value", signal.value)
            .set("age", signal.age ?? -1)
            .set("stale", signal.stale);
    }
}

export class LogSignalBlock extends ConfiguredBlock {
    static defaults = { label: "signal", sampleEvery: 1, type: "json" };

    constructor(uuid) {
        super(uuid);
        this.count = 0;
    }

    register() {
        this.state = this.config();
        this.registerInput("value", typedOutput(this.state.type));
        this.registerOutput("value", typedOutput(this.state.type));
    }

    valid() {
        return this.hasInput("value");
    }

    serializeRuntimeState() {
        return { count: this.count };
    }

    hydrateRuntimeState(state = {}) {
        this.count = toInt(state.count, 0);
    }

    execute() {
        const value = this.getInput("value");
        this.count += 1;
        const sampleEvery = Math.max(1, toInt(this.state.sampleEvery, 1));
        if (this.count % sampleEvery === 0) {
            console.debug(`[visual-script:${this.state.label}]`, value);
        }
        return new BlockOutput().set("value", value);
    }
}

export class AssertSignalBlock extends ConfiguredBlock {
    static defaults = { message: "Signal assertion failed." };

    register() {
        this.state = this.config();
        this.registerInput("condition", "boolean");
        this.registerOutput("ok", "boolean");
    }

    valid() {
        return this.hasInput("condition");
    }

    execute() {
        if (!this.getInput("condition")) {
            throw new Error(this.state.message || "Signal assertion failed.");
        }
        return new BlockOutput().set("ok", true);
    }
}

export class RecordSignalBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.DEBUG_RECORDED, type: "json", maxSamples: 120 };

    register() {
        this.state = this.config();
        this.registerInput("value", typedOutput(this.state.type));
        this.registerOutput("count", "int32");
    }

    valid() {
        return this.hasInput("value");
    }

    execute() {
        const history = this.manager.recordSignal(this.state.path, this.getInput("value"), {
            type: typedOutput(this.state.type),
            maxSamples: toInt(this.state.maxSamples, 120)
        });
        return new BlockOutput().set("count", history.length);
    }
}

export class ReplaySignalBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.DEBUG_RECORDED, index: 0 };

    register() {
        this.state = this.config();
        this.registerOutput("value", "json");
        this.registerOutput("exists", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        const history = this.manager.getSignalHistory(this.state.path);
        const entry = history[toInt(this.state.index, 0)];
        return new BlockOutput()
            .set("value", entry?.value ?? null)
            .set("exists", Boolean(entry));
    }
}

export class BindingStatusBlock extends ConfiguredBlock {
    static defaults = { path: SIGNAL_PATHS.DEBUG_BINDING_STATUS };

    register() {
        this.state = this.config();
        this.registerOutput("status", "string");
        this.registerOutput("connected", "boolean");
        this.registerOutput("stale", "boolean");
    }

    valid() {
        return true;
    }

    execute() {
        const signal = readSignal(this.manager, this.state.path);
        const status = signal.value || {};
        return new BlockOutput()
            .set("status", status.status || (signal.exists ? "connected" : "missing"))
            .set("connected", Boolean(status.connected ?? signal.exists))
            .set("stale", signal.stale || status.status === "stale");
    }
}
