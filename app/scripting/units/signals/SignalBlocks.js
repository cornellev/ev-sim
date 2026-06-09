import { useEffect, useState } from "react";
import { BlockOutput, reregister, storeData, UnitBlock } from "../../ScriptManager";
import { getByPath, setByPath } from "../../runtime/SignalStore";
import Unit from "../Unit";
import { normalizeType, parseValueByType, SUPPORTED_TYPES } from "../program/ProgramIO";

const CONTROL_CLASS = "w-full rounded-sm border border-white/10 bg-[#2b2b2b] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]";
const LABEL_CLASS = "flex flex-col gap-1.5";
const LABEL_TEXT_CLASS = "text-zinc-400";
const JSON_TYPES = new Set(["json", "message", "route", "waypoint", "pose2d", "pose3d", "vec2", "vec3", "sim_event"]);

function pathOrFallback(path, fallback) {
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

function stringifyJson(value) {
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value ?? null, null, 2);
    } catch {
        return "";
    }
}

function parseConfigValue(value, type = "json") {
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

function normalizeConfig(defaults, data = {}) {
    return {
        ...defaults,
        ...(data || {})
    };
}

function TextField({ label, value, onChange, placeholder = "", type = "text" }) {
    return (
        <label className={LABEL_CLASS}>
            <span className={LABEL_TEXT_CLASS}>{label}</span>
            <input
                value={value ?? ""}
                type={type}
                placeholder={placeholder}
                className={CONTROL_CLASS}
                onChange={(event) => onChange(event.target.value)}
            />
        </label>
    );
}

function TextAreaField({ label, value, onChange, placeholder = "" }) {
    return (
        <label className={LABEL_CLASS}>
            <span className={LABEL_TEXT_CLASS}>{label}</span>
            <textarea
                value={value ?? ""}
                placeholder={placeholder}
                rows={4}
                className={`${CONTROL_CLASS} resize-y font-mono text-[11px] leading-relaxed`}
                onChange={(event) => onChange(event.target.value)}
            />
        </label>
    );
}

function SelectField({ label, value, onChange, options }) {
    return (
        <label className={LABEL_CLASS}>
            <span className={LABEL_TEXT_CLASS}>{label}</span>
            <select
                value={value}
                className={CONTROL_CLASS}
                onChange={(event) => onChange(event.target.value)}
            >
                {options.map((option) => {
                    const item = typeof option === "string" ? { value: option, label: option } : option;
                    return <option key={item.value} value={item.value}>{item.label}</option>;
                })}
            </select>
        </label>
    );
}

function ConfigUnit({
    _uuid,
    title,
    initialData = null,
    initialState = null,
    defaults,
    normalize = (value) => value,
    inputs = [],
    outputs = [],
    children,
    initialPosition = null
}) {
    const [data, setData] = useState(() => normalize(normalizeConfig(defaults, initialData || initialState || {})));

    useEffect(() => {
        storeData(_uuid, data);
        reregister(_uuid);
    }, [data, _uuid]);

    const commit = (patch) => {
        setData((previous) => normalize({
            ...previous,
            ...(typeof patch === "function" ? patch(previous) : patch)
        }));
    };

    const resolvedInputs = typeof inputs === "function" ? inputs(data) : inputs;
    const resolvedOutputs = typeof outputs === "function" ? outputs(data) : outputs;

    return (
        <Unit
            title={title}
            hasOptions={true}
            _uuid={_uuid}
            initialPosition={initialPosition}
            inputs={resolvedInputs}
            outputs={resolvedOutputs}
        >
            <div className="flex flex-col gap-3 text-xs text-zinc-300">
                {children(data, commit)}
            </div>
        </Unit>
    );
}

class ConfiguredBlock extends UnitBlock {
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

function typedOutput(type) {
    return normalizeType(type || "json");
}

export function ReadSignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Read Signal"
            defaults={ReadSignalBlock.defaults}
            normalize={(data) => ({
                ...data,
                path: pathOrFallback(data.path, "vehicle.ego.pose"),
                type: normalizeType(data.type || "json"),
                staleAfter: data.staleAfter ?? "",
                fallback: data.fallback ?? ""
            })}
            outputs={(data) => [
                { label: "value", type: typedOutput(data.type) },
                { label: "exists", type: "boolean" },
                { label: "stale", type: "boolean" },
                { label: "age", type: "float64" }
            ]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} placeholder="topics./ackdrive" />
                    <SelectField label="Value type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                    <TextField label="Stale after seconds" value={data.staleAfter} onChange={(staleAfter) => commit({ staleAfter })} placeholder="0.5" />
                    <TextField label="Fallback" value={data.fallback} onChange={(fallback) => commit({ fallback })} />
                </>
            )}
        </ConfigUnit>
    );
}

export class ReadSignalBlock extends ConfiguredBlock {
    static defaults = { path: "vehicle.ego.pose", type: "json", staleAfter: "", fallback: "" };

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

export function WriteSignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Write Signal"
            defaults={WriteSignalBlock.defaults}
            normalize={(data) => ({
                ...data,
                path: pathOrFallback(data.path, "debug.value"),
                type: normalizeType(data.type || "json"),
                source: data.source || "script",
                staleAfter: data.staleAfter ?? ""
            })}
            inputs={(data) => [{ label: "value", type: typedOutput(data.type) }]}
            outputs={[{ label: "written", type: "boolean" }]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
                    <SelectField label="Value type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                    <TextField label="Source" value={data.source} onChange={(source) => commit({ source })} />
                    <TextField label="Stale after seconds" value={data.staleAfter} onChange={(staleAfter) => commit({ staleAfter })} />
                </>
            )}
        </ConfigUnit>
    );
}

export class WriteSignalBlock extends ConfiguredBlock {
    static defaults = { path: "debug.value", type: "json", source: "script", staleAfter: "" };

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

export function SignalExistsUnit(props) {
    return (
        <ConfigUnit {...props} title="Signal Exists" defaults={SignalExistsBlock.defaults} outputs={[{ label: "exists", type: "boolean" }]}>
            {(data, commit) => (
                <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
}

export class SignalExistsBlock extends ConfiguredBlock {
    static defaults = { path: "debug.value" };

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

export function SignalAgeUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Signal Age"
            defaults={SignalAgeBlock.defaults}
            outputs={[
                { label: "age", type: "float64" },
                { label: "stale", type: "boolean" }
            ]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
                    <TextField label="Stale after seconds" value={data.staleAfter} onChange={(staleAfter) => commit({ staleAfter })} />
                </>
            )}
        </ConfigUnit>
    );
}

export class SignalAgeBlock extends ConfiguredBlock {
    static defaults = { path: "debug.value", staleAfter: "" };

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

export function SignalChangedUnit(props) {
    return (
        <ConfigUnit {...props} title="Signal Changed" defaults={SignalChangedBlock.defaults} outputs={[{ label: "changed", type: "boolean" }]}>
            {(data, commit) => (
                <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
}

export class SignalChangedBlock extends ConfiguredBlock {
    static defaults = { path: "debug.value" };

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

export function SignalLatchUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Signal Latch"
            defaults={SignalLatchBlock.defaults}
            normalize={(data) => ({ ...data, type: normalizeType(data.type || "json") })}
            inputs={(data) => [
                { label: "value", type: typedOutput(data.type) },
                { label: "valid", type: "boolean" }
            ]}
            outputs={(data) => [{ label: "value", type: typedOutput(data.type) }]}
        >
            {(data, commit) => (
                <SelectField label="Value type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
            )}
        </ConfigUnit>
    );
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

export function SignalDefaultUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Signal Default"
            defaults={SignalDefaultBlock.defaults}
            normalize={(data) => ({ ...data, type: normalizeType(data.type || "json") })}
            inputs={(data) => [
                { label: "value", type: typedOutput(data.type) },
                { label: "fallback", type: typedOutput(data.type) },
                { label: "useDefault", type: "boolean" }
            ]}
            outputs={(data) => [{ label: "value", type: typedOutput(data.type) }]}
        >
            {(data, commit) => (
                <SelectField label="Value type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
            )}
        </ConfigUnit>
    );
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

export function StoreNamespaceUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Store Namespace"
            defaults={StoreNamespaceBlock.defaults}
            inputs={[{ label: "path", type: "string" }]}
            outputs={[{ label: "path", type: "string" }]}
        >
            {(data, commit) => (
                <SelectField
                    label="Namespace"
                    value={data.namespace}
                    onChange={(namespace) => commit({ namespace })}
                    options={["topics", "vehicle", "mission", "scenario", "debug", "simulation", "devices", "objects", "publish"]}
                />
            )}
        </ConfigUnit>
    );
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

export function TopicSnapshotUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Topic Snapshot"
            defaults={TopicSnapshotBlock.defaults}
            outputs={[
                { label: "message", type: "message" },
                { label: "exists", type: "boolean" },
                { label: "stale", type: "boolean" },
                { label: "age", type: "float64" }
            ]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Topic" value={data.topic} onChange={(topic) => commit({ topic })} placeholder="/ackdrive" />
                    <TextField label="Stale after seconds" value={data.staleAfter} onChange={(staleAfter) => commit({ staleAfter })} />
                </>
            )}
        </ConfigUnit>
    );
}

export class TopicSnapshotBlock extends ConfiguredBlock {
    static defaults = { topic: "/ackdrive", staleAfter: "" };

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

export function TopicFieldUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Topic Field"
            defaults={TopicFieldBlock.defaults}
            normalize={(data) => ({ ...data, type: normalizeType(data.type || "json") })}
            inputs={[{ label: "message", type: "message" }]}
            outputs={(data) => [{ label: "value", type: typedOutput(data.type) }]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Field path" value={data.fieldPath} onChange={(fieldPath) => commit({ fieldPath })} placeholder="drive.speed" />
                    <SelectField label="Field type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                    <TextField label="Fallback" value={data.fallback} onChange={(fallback) => commit({ fallback })} />
                </>
            )}
        </ConfigUnit>
    );
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

export function BuildTopicMessageUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Build Topic Message"
            defaults={BuildTopicMessageBlock.defaults}
            normalize={(data) => ({ ...data, type: normalizeType(data.type || "json") })}
            inputs={(data) => [
                { label: "base", type: "message" },
                { label: "value", type: typedOutput(data.type) }
            ]}
            outputs={[{ label: "message", type: "message" }]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Field path" value={data.fieldPath} onChange={(fieldPath) => commit({ fieldPath })} placeholder="drive.speed" />
                    <SelectField label="Value type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                </>
            )}
        </ConfigUnit>
    );
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

export function StagePublishUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Stage Publish"
            defaults={StagePublishBlock.defaults}
            inputs={[{ label: "message", type: "message" }]}
            outputs={[
                { label: "staged", type: "boolean" },
                { label: "path", type: "string" }
            ]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Topic" value={data.topic} onChange={(topic) => commit({ topic })} placeholder="/ackdrive_cmd" />
                    <TextField label="Message type" value={data.messageType} onChange={(messageType) => commit({ messageType })} />
                    <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} placeholder="publish./ackdrive_cmd" />
                </>
            )}
        </ConfigUnit>
    );
}

export class StagePublishBlock extends ConfiguredBlock {
    static defaults = { topic: "/ackdrive_cmd", messageType: "message", path: "" };

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

export function TopicStaleGateUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Topic Stale Gate"
            inputs={[
                { label: "message", type: "message" },
                { label: "stale", type: "boolean" }
            ]}
            outputs={[
                { label: "message", type: "message" },
                { label: "allowed", type: "boolean" }
            ]}
            defaults={TopicStaleGateBlock.defaults}
        >
            {() => <span className="text-zinc-500">Passes the message only while the snapshot is fresh.</span>}
        </ConfigUnit>
    );
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

export function TopicMetadataUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Topic Metadata"
            defaults={TopicMetadataBlock.defaults}
            outputs={[
                { label: "topic", type: "string" },
                { label: "type", type: "string" },
                { label: "source", type: "string" },
                { label: "age", type: "float64" },
                { label: "stale", type: "boolean" }
            ]}
        >
            {(data, commit) => (
                <TextField label="Topic" value={data.topic} onChange={(topic) => commit({ topic })} />
            )}
        </ConfigUnit>
    );
}

export class TopicMetadataBlock extends ConfiguredBlock {
    static defaults = { topic: "/ackdrive" };

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

function SnapshotUnit({ title, defaults, outputs, ...props }) {
    return (
        <ConfigUnit {...props} title={title} defaults={defaults} outputs={outputs}>
            {(data, commit) => (
                <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
}

class PathSnapshotBlock extends ConfiguredBlock {
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

export function VehicleSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Vehicle Snapshot" defaults={VehicleSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export class VehicleSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: "vehicle.ego" };
}

export function VehiclePoseUnit(props) {
    return <SnapshotUnit {...props} title="Vehicle Pose" defaults={VehiclePoseBlock.defaults} outputs={[{ label: "pose", type: "pose3d" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export class VehiclePoseBlock extends PathSnapshotBlock {
    static defaults = { path: "vehicle.ego.pose" };
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

export function VehicleVelocityUnit(props) {
    return <SnapshotUnit {...props} title="Vehicle Velocity" defaults={VehicleVelocityBlock.defaults} outputs={[{ label: "velocity", type: "vec3" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export class VehicleVelocityBlock extends PathSnapshotBlock {
    static defaults = { path: "vehicle.ego.velocity" };
    static outputLabel = "velocity";
    static outputType = "vec3";
}

export function VehicleDimensionsUnit(props) {
    return <SnapshotUnit {...props} title="Vehicle Dimensions" defaults={VehicleDimensionsBlock.defaults} outputs={[{ label: "dimensions", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export class VehicleDimensionsBlock extends PathSnapshotBlock {
    static defaults = { path: "vehicle.ego.dimensions" };
    static outputLabel = "dimensions";
}

export function DeviceSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Device Snapshot" defaults={DeviceSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export class DeviceSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: "devices.front_camera" };
}

export function SimulationSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Simulation Snapshot" defaults={SimulationSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "dt", type: "float64" }, { label: "frame", type: "int32" }]} />;
}

export class SimulationSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: "simulation" };

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

export function ScenarioSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Scenario Snapshot" defaults={ScenarioSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export class ScenarioSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: "scenario" };
}

export function ObjectSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Object Snapshot" defaults={ObjectSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export class ObjectSnapshotBlock extends PathSnapshotBlock {
    static defaults = { path: "objects.target" };
}

export function WaypointListUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Waypoint List"
            defaults={WaypointListBlock.defaults}
            outputs={[
                { label: "route", type: "route" },
                { label: "count", type: "int32" }
            ]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Route path" value={data.path} onChange={(path) => commit({ path })} />
                    <TextAreaField label="Local waypoints" value={data.waypoints} onChange={(waypoints) => commit({ waypoints })} />
                </>
            )}
        </ConfigUnit>
    );
}

export class WaypointListBlock extends ConfiguredBlock {
    static defaults = { path: "mission.route", waypoints: "[]" };

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

export function CurrentWaypointUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Current Waypoint"
            defaults={CurrentWaypointBlock.defaults}
            inputs={[{ label: "route", type: "route" }]}
            outputs={[
                { label: "waypoint", type: "waypoint" },
                { label: "index", type: "int32" },
                { label: "complete", type: "boolean" }
            ]}
        >
            {(data, commit) => (
                <TextField label="Index path" value={data.indexPath} onChange={(indexPath) => commit({ indexPath })} />
            )}
        </ConfigUnit>
    );
}

export class CurrentWaypointBlock extends ConfiguredBlock {
    static defaults = { indexPath: "mission.currentWaypoint" };

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

export function AdvanceWaypointUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Advance Waypoint"
            defaults={AdvanceWaypointBlock.defaults}
            inputs={[
                { label: "advance", type: "boolean" },
                { label: "route", type: "route" }
            ]}
            outputs={[{ label: "index", type: "int32" }]}
        >
            {(data, commit) => (
                <TextField label="Index path" value={data.indexPath} onChange={(indexPath) => commit({ indexPath })} />
            )}
        </ConfigUnit>
    );
}

export class AdvanceWaypointBlock extends ConfiguredBlock {
    static defaults = { indexPath: "mission.currentWaypoint" };

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

export function ReachedWaypointUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Reached Waypoint"
            defaults={ReachedWaypointBlock.defaults}
            inputs={[
                { label: "pose", type: "pose3d" },
                { label: "waypoint", type: "waypoint" },
                { label: "threshold", type: "float64" }
            ]}
            outputs={[
                { label: "reached", type: "boolean" },
                { label: "distance", type: "float64" }
            ]}
        >
            {() => <span className="text-zinc-500">Compares pose and waypoint distance.</span>}
        </ConfigUnit>
    );
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

export function MissionStateUnit(props) {
    return <SnapshotUnit {...props} title="Mission State" defaults={MissionStateBlock.defaults} outputs={[{ label: "state", type: "string" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export class MissionStateBlock extends PathSnapshotBlock {
    static defaults = { path: "mission.state" };
    static outputLabel = "state";
    static outputType = "string";
}

export function SetMissionStateUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Set Mission State"
            defaults={SetMissionStateBlock.defaults}
            inputs={[{ label: "state", type: "string" }]}
            outputs={[{ label: "written", type: "boolean" }]}
        >
            {(data, commit) => (
                <TextField label="State path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
}

export class SetMissionStateBlock extends ConfiguredBlock {
    static defaults = { path: "mission.state" };

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

export function RouteProgressUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Route Progress"
            defaults={RouteProgressBlock.defaults}
            inputs={[
                { label: "pose", type: "pose3d" },
                { label: "route", type: "route" }
            ]}
            outputs={[
                { label: "progress", type: "float64" },
                { label: "segment", type: "int32" }
            ]}
        >
            {() => <span className="text-zinc-500">Returns nearest waypoint progress as 0..1.</span>}
        </ConfigUnit>
    );
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
        const list = Array.isArray(route) ? route : route?.waypoints || [];
        if (list.length === 0) {
            return new BlockOutput().set("progress", 0).set("segment", 0);
        }

        let nearestIndex = 0;
        let nearestDistance = Number.POSITIVE_INFINITY;
        list.forEach((waypoint, index) => {
            const distance = distanceBetween(pose, waypoint);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestIndex = index;
            }
        });

        return new BlockOutput()
            .set("progress", list.length <= 1 ? 1 : nearestIndex / (list.length - 1))
            .set("segment", nearestIndex);
    }
}

export function ScenarioFlagReadUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Scenario Flag Read"
            defaults={ScenarioFlagReadBlock.defaults}
            normalize={(data) => ({ ...data, type: normalizeType(data.type || "boolean") })}
            outputs={(data) => [
                { label: "value", type: typedOutput(data.type) },
                { label: "exists", type: "boolean" }
            ]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Flag" value={data.flag} onChange={(flag) => commit({ flag })} />
                    <SelectField label="Type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                    <TextField label="Fallback" value={data.fallback} onChange={(fallback) => commit({ fallback })} />
                </>
            )}
        </ConfigUnit>
    );
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

export function ScenarioFlagWriteUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Scenario Flag Write"
            defaults={ScenarioFlagWriteBlock.defaults}
            normalize={(data) => ({ ...data, type: normalizeType(data.type || "boolean") })}
            inputs={(data) => [{ label: "value", type: typedOutput(data.type) }]}
            outputs={[{ label: "written", type: "boolean" }]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Flag" value={data.flag} onChange={(flag) => commit({ flag })} />
                    <SelectField label="Type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                </>
            )}
        </ConfigUnit>
    );
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

function BindingUnit({ title, defaults, children, ...props }) {
    return (
        <ConfigUnit {...props} title={title} defaults={defaults} outputs={[{ label: "config", type: "json" }]}>
            {children}
        </ConfigUnit>
    );
}

class BindingBlock extends ConfiguredBlock {
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

export function BindInputUnit(props) {
    return (
        <BindingUnit {...props} title="Bind Input" defaults={BindInputBlock.defaults}>
            {(data, commit) => (
                <>
                    <TextField label="External source" value={data.source} onChange={(source) => commit({ source })} placeholder="/ackdrive" />
                    <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} placeholder="topics./ackdrive" />
                    <TextField label="Type" value={data.type} onChange={(type) => commit({ type })} placeholder="ackermann_msgs/AckermannDrive" />
                </>
            )}
        </BindingUnit>
    );
}

export class BindInputBlock extends BindingBlock {
    static defaults = { sourceKind: "topic", source: "/ackdrive", path: "topics./ackdrive", type: "message" };
    bindingKind = "input";
}

export function BindOutputUnit(props) {
    return (
        <BindingUnit {...props} title="Bind Output" defaults={BindOutputBlock.defaults}>
            {(data, commit) => (
                <>
                    <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} placeholder="publish./ackdrive_cmd" />
                    <TextField label="External sink" value={data.sink} onChange={(sink) => commit({ sink })} placeholder="/ackdrive_cmd" />
                    <TextField label="Type" value={data.type} onChange={(type) => commit({ type })} />
                </>
            )}
        </BindingUnit>
    );
}

export class BindOutputBlock extends BindingBlock {
    static defaults = { sinkKind: "topic", sink: "/ackdrive_cmd", path: "publish./ackdrive_cmd", type: "message" };
    bindingKind = "output";
}

export function BindTriggerUnit(props) {
    return (
        <BindingUnit {...props} title="Bind Trigger" defaults={BindTriggerBlock.defaults}>
            {(data, commit) => (
                <>
                    <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} placeholder="topics./ackdrive" />
                    <SelectField label="Mode" value={data.mode} onChange={(mode) => commit({ mode })} options={["update", "change", "fresh"]} />
                </>
            )}
        </BindingUnit>
    );
}

export class BindTriggerBlock extends BindingBlock {
    static defaults = { path: "topics./ackdrive", mode: "update" };
    bindingKind = "trigger";
}

class EntrypointBlock extends ConfiguredBlock {
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

export function OnSignalUpdateUnit(props) {
    return (
        <BindingUnit {...props} title="On Signal Update" defaults={OnSignalUpdateBlock.defaults}>
            {(data, commit) => (
                <TextField label="Signal path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </BindingUnit>
    );
}

export class OnSignalUpdateBlock extends EntrypointBlock {
    static defaults = { path: "topics./ackdrive" };
    entrypointKind = "signal-update";
}

export function OnTickUnit(props) {
    return (
        <BindingUnit {...props} title="On Tick" defaults={OnTickBlock.defaults}>
            {(data, commit) => (
                <TextField label="Clock path" value={data.clockPath} onChange={(clockPath) => commit({ clockPath })} />
            )}
        </BindingUnit>
    );
}

export class OnTickBlock extends EntrypointBlock {
    static defaults = { clockPath: "simulation.frame" };
    entrypointKind = "tick";
}

export function OnTimerUnit(props) {
    return (
        <BindingUnit {...props} title="On Timer" defaults={OnTimerBlock.defaults}>
            {(data, commit) => (
                <TextField label="Interval ms" value={data.intervalMs} onChange={(intervalMs) => commit({ intervalMs })} type="number" />
            )}
        </BindingUnit>
    );
}

export class OnTimerBlock extends EntrypointBlock {
    static defaults = { intervalMs: 100 };
    entrypointKind = "timer";
}

export function ProbeSignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Probe Signal"
            defaults={ProbeSignalBlock.defaults}
            outputs={[
                { label: "value", type: "json" },
                { label: "age", type: "float64" },
                { label: "stale", type: "boolean" }
            ]}
        >
            {(data, commit) => (
                <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
}

export class ProbeSignalBlock extends ConfiguredBlock {
    static defaults = { path: "debug.value" };

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

export function LogSignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Log Signal"
            defaults={LogSignalBlock.defaults}
            normalize={(data) => ({ ...data, type: normalizeType(data.type || "json") })}
            inputs={(data) => [{ label: "value", type: typedOutput(data.type) }]}
            outputs={(data) => [{ label: "value", type: typedOutput(data.type) }]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Label" value={data.label} onChange={(label) => commit({ label })} />
                    <TextField label="Sample every N runs" value={data.sampleEvery} onChange={(sampleEvery) => commit({ sampleEvery })} type="number" />
                    <SelectField label="Value type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                </>
            )}
        </ConfigUnit>
    );
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

export function AssertSignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Assert Signal"
            defaults={AssertSignalBlock.defaults}
            inputs={[{ label: "condition", type: "boolean" }]}
            outputs={[{ label: "ok", type: "boolean" }]}
        >
            {(data, commit) => (
                <TextField label="Message" value={data.message} onChange={(message) => commit({ message })} />
            )}
        </ConfigUnit>
    );
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

export function RecordSignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Record Signal"
            defaults={RecordSignalBlock.defaults}
            normalize={(data) => ({ ...data, type: normalizeType(data.type || "json") })}
            inputs={(data) => [{ label: "value", type: typedOutput(data.type) }]}
            outputs={[{ label: "count", type: "int32" }]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
                    <SelectField label="Value type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                    <TextField label="Max samples" value={data.maxSamples} onChange={(maxSamples) => commit({ maxSamples })} type="number" />
                </>
            )}
        </ConfigUnit>
    );
}

export class RecordSignalBlock extends ConfiguredBlock {
    static defaults = { path: "debug.recorded", type: "json", maxSamples: 120 };

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

export function ReplaySignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Replay Signal"
            defaults={ReplaySignalBlock.defaults}
            outputs={[
                { label: "value", type: "json" },
                { label: "exists", type: "boolean" }
            ]}
        >
            {(data, commit) => (
                <>
                    <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
                    <TextField label="Sample index" value={data.index} onChange={(index) => commit({ index })} type="number" />
                </>
            )}
        </ConfigUnit>
    );
}

export class ReplaySignalBlock extends ConfiguredBlock {
    static defaults = { path: "debug.recorded", index: 0 };

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

export function BindingStatusUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Binding Status"
            defaults={BindingStatusBlock.defaults}
            outputs={[
                { label: "status", type: "string" },
                { label: "connected", type: "boolean" },
                { label: "stale", type: "boolean" }
            ]}
        >
            {(data, commit) => (
                <TextField label="Status path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
}

export class BindingStatusBlock extends ConfiguredBlock {
    static defaults = { path: "debug.bindings.default" };

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
