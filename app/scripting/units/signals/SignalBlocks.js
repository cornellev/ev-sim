import { useEffect, useState } from "react";
import { reregister, storeData } from "../../ScriptManager";
import { SIGNAL_NAMESPACES, SIGNAL_PATHS } from "../../runtime/SignalPaths";
import Unit from "../Unit";
import { normalizeType, SUPPORTED_TYPES } from "../program/ProgramTypes.js";
import {
    normalizeConfig,
    parseConfigValue,
    stringifyJson,
    pathOrFallback,
    typedOutput,
    ReadSignalBlock,
    WriteSignalBlock,
    SignalExistsBlock,
    SignalAgeBlock,
    SignalChangedBlock,
    SignalLatchBlock,
    SignalDefaultBlock,
    StoreNamespaceBlock,
    TopicSnapshotBlock,
    TopicFieldBlock,
    BuildTopicMessageBlock,
    StagePublishBlock,
    TopicStaleGateBlock,
    TopicMetadataBlock,
    VehicleSnapshotBlock,
    VehiclePoseBlock,
    VehicleVelocityBlock,
    VehicleDimensionsBlock,
    DeviceSnapshotBlock,
    SimulationSnapshotBlock,
    ScenarioSnapshotBlock,
    ObjectSnapshotBlock,
    WaypointListBlock,
    CurrentWaypointBlock,
    AdvanceWaypointBlock,
    ReachedWaypointBlock,
    MissionStateBlock,
    SetMissionStateBlock,
    RouteProgressBlock,
    ScenarioFlagReadBlock,
    ScenarioFlagWriteBlock,
    BindInputBlock,
    BindOutputBlock,
    BindTriggerBlock,
    OnSignalUpdateBlock,
    OnTickBlock,
    OnTimerBlock,
    ProbeSignalBlock,
    LogSignalBlock,
    AssertSignalBlock,
    RecordSignalBlock,
    ReplaySignalBlock,
    BindingStatusBlock
} from "./SignalBlocks.block.js";

export {
    ReadSignalBlock,
    WriteSignalBlock,
    SignalExistsBlock,
    SignalAgeBlock,
    SignalChangedBlock,
    SignalLatchBlock,
    SignalDefaultBlock,
    StoreNamespaceBlock,
    TopicSnapshotBlock,
    TopicFieldBlock,
    BuildTopicMessageBlock,
    StagePublishBlock,
    TopicStaleGateBlock,
    TopicMetadataBlock,
    VehicleSnapshotBlock,
    VehiclePoseBlock,
    VehicleVelocityBlock,
    VehicleDimensionsBlock,
    DeviceSnapshotBlock,
    SimulationSnapshotBlock,
    ScenarioSnapshotBlock,
    ObjectSnapshotBlock,
    WaypointListBlock,
    CurrentWaypointBlock,
    AdvanceWaypointBlock,
    ReachedWaypointBlock,
    MissionStateBlock,
    SetMissionStateBlock,
    RouteProgressBlock,
    ScenarioFlagReadBlock,
    ScenarioFlagWriteBlock,
    BindInputBlock,
    BindOutputBlock,
    BindTriggerBlock,
    OnSignalUpdateBlock,
    OnTickBlock,
    OnTimerBlock,
    ProbeSignalBlock,
    LogSignalBlock,
    AssertSignalBlock,
    RecordSignalBlock,
    ReplaySignalBlock,
    BindingStatusBlock
} from "./SignalBlocks.block.js";

const CONTROL_CLASS = "w-full rounded-sm border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-white outline-none transition-[border-color,box-shadow] duration-150 focus:border-white/30 focus:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]";

const LABEL_CLASS = "flex flex-col gap-1.5";

const LABEL_TEXT_CLASS = "text-zinc-400";

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

export function ReadSignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Read Signal"
            defaults={ReadSignalBlock.defaults}
            normalize={(data) => ({
                ...data,
                path: pathOrFallback(data.path, SIGNAL_PATHS.VEHICLE_EGO_POSE),
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
                    <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} placeholder={SIGNAL_PATHS.CONTROLS_COMMAND_TOPIC} />
                    <SelectField label="Value type" value={typedOutput(data.type)} onChange={(type) => commit({ type })} options={SUPPORTED_TYPES} />
                    <TextField label="Stale after seconds" value={data.staleAfter} onChange={(staleAfter) => commit({ staleAfter })} placeholder="0.5" />
                    <TextField label="Fallback" value={data.fallback} onChange={(fallback) => commit({ fallback })} />
                </>
            )}
        </ConfigUnit>
    );
}

export function WriteSignalUnit(props) {
    return (
        <ConfigUnit
            {...props}
            title="Write Signal"
            defaults={WriteSignalBlock.defaults}
            normalize={(data) => ({
                ...data,
                path: pathOrFallback(data.path, SIGNAL_PATHS.DEBUG_VALUE),
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

export function SignalExistsUnit(props) {
    return (
        <ConfigUnit {...props} title="Signal Exists" defaults={SignalExistsBlock.defaults} outputs={[{ label: "exists", type: "boolean" }]}>
            {(data, commit) => (
                <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
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

export function SignalChangedUnit(props) {
    return (
        <ConfigUnit {...props} title="Signal Changed" defaults={SignalChangedBlock.defaults} outputs={[{ label: "changed", type: "boolean" }]}>
            {(data, commit) => (
                <TextField label="Path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
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
                    options={Object.values(SIGNAL_NAMESPACES)}
                />
            )}
        </ConfigUnit>
    );
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
                    <TextField label="Topic" value={data.topic} onChange={(topic) => commit({ topic })} placeholder="/controls/command" />
                    <TextField label="Stale after seconds" value={data.staleAfter} onChange={(staleAfter) => commit({ staleAfter })} />
                </>
            )}
        </ConfigUnit>
    );
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
                    <TextField label="Topic" value={data.topic} onChange={(topic) => commit({ topic })} placeholder="/controls/command" />
                    <TextField label="Message type" value={data.messageType} onChange={(messageType) => commit({ messageType })} />
                    <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} placeholder={SIGNAL_PATHS.CONTROLS_COMMAND_PUBLISH} />
                </>
            )}
        </ConfigUnit>
    );
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

function SnapshotUnit({ title, defaults, outputs, ...props }) {
    return (
        <ConfigUnit {...props} title={title} defaults={defaults} outputs={outputs}>
            {(data, commit) => (
                <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} />
            )}
        </ConfigUnit>
    );
}

export function VehicleSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Vehicle Snapshot" defaults={VehicleSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export function VehiclePoseUnit(props) {
    return <SnapshotUnit {...props} title="Vehicle Pose" defaults={VehiclePoseBlock.defaults} outputs={[{ label: "pose", type: "pose3d" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export function VehicleVelocityUnit(props) {
    return <SnapshotUnit {...props} title="Vehicle Velocity" defaults={VehicleVelocityBlock.defaults} outputs={[{ label: "velocity", type: "vec3" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export function VehicleDimensionsUnit(props) {
    return <SnapshotUnit {...props} title="Vehicle Dimensions" defaults={VehicleDimensionsBlock.defaults} outputs={[{ label: "dimensions", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export function DeviceSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Device Snapshot" defaults={DeviceSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export function SimulationSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Simulation Snapshot" defaults={SimulationSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "dt", type: "float64" }, { label: "frame", type: "int32" }]} />;
}

export function ScenarioSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Scenario Snapshot" defaults={ScenarioSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
}

export function ObjectSnapshotUnit(props) {
    return <SnapshotUnit {...props} title="Object Snapshot" defaults={ObjectSnapshotBlock.defaults} outputs={[{ label: "value", type: "json" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
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

export function MissionStateUnit(props) {
    return <SnapshotUnit {...props} title="Mission State" defaults={MissionStateBlock.defaults} outputs={[{ label: "state", type: "string" }, { label: "exists", type: "boolean" }, { label: "stale", type: "boolean" }]} />;
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
            {() => <span className="text-zinc-500">Projects onto route geometry and returns arc-length progress.</span>}
        </ConfigUnit>
    );
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

function BindingUnit({ title, defaults, children, ...props }) {
    return (
        <ConfigUnit {...props} title={title} defaults={defaults} outputs={[{ label: "config", type: "json" }]}>
            {children}
        </ConfigUnit>
    );
}

export function BindInputUnit(props) {
    return (
        <BindingUnit {...props} title="Bind Input" defaults={BindInputBlock.defaults}>
            {(data, commit) => (
                <>
                    <TextField label="External source" value={data.source} onChange={(source) => commit({ source })} placeholder="/controls/command" />
                    <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} placeholder={SIGNAL_PATHS.CONTROLS_COMMAND_TOPIC} />
                    <TextField label="Type" value={data.type} onChange={(type) => commit({ type })} placeholder="ackermann_msgs/AckermannDrive" />
                </>
            )}
        </BindingUnit>
    );
}

export function BindOutputUnit(props) {
    return (
        <BindingUnit {...props} title="Bind Output" defaults={BindOutputBlock.defaults}>
            {(data, commit) => (
                <>
                    <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} placeholder={SIGNAL_PATHS.CONTROLS_COMMAND_PUBLISH} />
                    <TextField label="External sink" value={data.sink} onChange={(sink) => commit({ sink })} placeholder="/controls/command" />
                    <TextField label="Type" value={data.type} onChange={(type) => commit({ type })} />
                </>
            )}
        </BindingUnit>
    );
}

export function BindTriggerUnit(props) {
    return (
        <BindingUnit {...props} title="Bind Trigger" defaults={BindTriggerBlock.defaults}>
            {(data, commit) => (
                <>
                    <TextField label="Store path" value={data.path} onChange={(path) => commit({ path })} placeholder={SIGNAL_PATHS.CONTROLS_COMMAND_TOPIC} />
                    <SelectField label="Mode" value={data.mode} onChange={(mode) => commit({ mode })} options={["update", "change", "fresh"]} />
                </>
            )}
        </BindingUnit>
    );
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

export function OnTickUnit(props) {
    return (
        <BindingUnit {...props} title="On Tick" defaults={OnTickBlock.defaults}>
            {(data, commit) => (
                <TextField label="Clock path" value={data.clockPath} onChange={(clockPath) => commit({ clockPath })} />
            )}
        </BindingUnit>
    );
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
