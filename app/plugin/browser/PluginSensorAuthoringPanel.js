import { describePluginSensorObservation } from "../PluginSensorContract.js";
import PluginSensorEditor from "./PluginSensorEditor.js";

function Field({ label, children }) {
    return (
        <label className="block text-[11px] text-[var(--slate-muted)]">
            <span className="mb-1 block">{label}</span>
            {children}
        </label>
    );
}

export function PluginSensorObservationDiagnostics({ definition, sensor, context = "run" }) {
    const descriptor = definition?.pluginSensor?.descriptor;
    if (!descriptor) return null;
    const observation = describePluginSensorObservation(descriptor, sensor, { context });
    return (
        <div className="mt-3 space-y-1 rounded-[var(--radius)] border border-[var(--slate-border-60)] bg-[var(--slate-bg)] p-3 text-[11px] text-[var(--slate-muted)]">
            <p className="font-medium text-[var(--slate-fg-2)]">Measured observation</p>
            <p>dtype {observation.dtype}</p>
            <p>shape [{observation.shape.join(", ")}]</p>
            <p>bytes {observation.byteCount}</p>
            <p>max range {observation.maxRangeM ?? "—"} m</p>
            <p>CPU LiDAR backend v{observation.cpuBackendVersion} required</p>
            <p>output {observation.outputKey || observation.outputMapping || "none"}</p>
            <p>enabled {observation.enabled ? "yes" : "no"}</p>
        </div>
    );
}

export function PluginSensorIdentity({ ownership, unresolved = false, conflict = null }) {
    if (!ownership || ownership === "builtin") return null;
    return (
        <div className="mt-3 space-y-1 text-[11px] text-[var(--slate-muted)]">
            <p>plugin {ownership.pluginId}@{ownership.version}</p>
            <p>package {ownership.packageHash}</p>
            <p>runtime {ownership.runtimeHash}</p>
            {ownership.uiHash ? <p>ui {ownership.uiHash}</p> : null}
            {unresolved && (
                <p className="text-[var(--slate-warning)]" role="status">
                    Locked package is missing from CAS. Restore the exact package to edit or save.
                </p>
            )}
            {conflict && <p className="text-[var(--slate-danger)]" role="status">{conflict}</p>}
        </div>
    );
}

export function PluginSensorPointCloudOutputs({
    sensor,
    definition,
    topics = [],
    onChange,
}) {
    const outputs = definition?.run?.outputs ?? [];
    if (outputs.length === 0) return null;
    const compatible = (rosType) => topics.filter((topic) => (
        !rosType || topic.schema?.type === rosType || topic.type === rosType
    ));
    return (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
            {outputs.map((output) => {
                const options = compatible(output.rosType);
                const value = sensor.outputs?.[output.key] || "";
                return (
                    <Field key={output.key} label={`${output.key} (${output.rosType})`}>
                        <select
                            aria-label={output.key}
                            value={value}
                            onChange={(event) => onChange(output.key, event.target.value || null)}
                        >
                            <option value="">None</option>
                            {options.map((topic) => (
                                <option key={topic.id} value={topic.id}>{topic.id}</option>
                            ))}
                            {value && !options.some((topic) => topic.id === value) && (
                                <option value={value}>{value} (incompatible)</option>
                            )}
                        </select>
                    </Field>
                );
            })}
        </div>
    );
}

export default function PluginSensorAuthoringPanel({
    context,
    sensor,
    definition,
    diagnostic = null,
    Component = null,
    onCommit,
    disabled = false,
    unresolved = false,
    conflict = null,
    topics = [],
    onOutputChange = null,
    sensorRegistry,
}) {
    const ownership = definition?.pluginSensor?.ownership;
    const kind = context?.kind === "vehicle" ? "vehicle" : "run";
    return (
        <div className="mt-3 space-y-3">
            <PluginSensorIdentity ownership={ownership} unresolved={unresolved} conflict={conflict} />
            <PluginSensorEditor
                context={context}
                sensor={sensor}
                definition={definition}
                diagnostic={diagnostic}
                Component={unresolved ? null : Component}
                onCommit={onCommit}
                disabled={disabled || unresolved}
                sensorRegistry={sensorRegistry}
            />
            {kind === "run" && onOutputChange && (
                <PluginSensorPointCloudOutputs
                    sensor={sensor}
                    definition={definition}
                    topics={topics}
                    onChange={onOutputChange}
                />
            )}
            <PluginSensorObservationDiagnostics definition={definition} sensor={sensor} context={kind} />
        </div>
    );
}
