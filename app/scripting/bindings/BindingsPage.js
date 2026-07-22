'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listScriptDocuments } from "../ScriptStorage.js";
import { summarizeScriptDocument } from "../EditorDocument.js";
import { SIGNAL_PATHS } from "../runtime/SignalPaths.js";
import { getBindingRuntime } from "./BindingRuntime.js";
import { getBindingManifest, parseBindingManifest, serializeBindingManifest } from "./BindingStorage.js";
import {
    INPUT_SOURCES,
    OUTPUT_SINKS,
    SIM_VALUE_KEYS,
    TRIGGER_KINDS,
    TRIGGER_KIND_ORDER,
    createBinding,
    normalizeBindingManifest,
    normalizeTrigger,
    suggestTriggerFromArtifact,
    summarizeTrigger,
    validateBinding
} from "./BindingDocument.js";
import { subscribeStorageEvents } from "../../client/storageEvents.js";

const TRIGGER_LABELS = {
    [TRIGGER_KINDS.TOPIC]: "ROS topic",
    [TRIGGER_KINDS.FIXED_UPDATE]: "Fixed update",
    [TRIGGER_KINDS.SIGNAL_UPDATE]: "Signal change",
    [TRIGGER_KINDS.TIMER]: "Timer"
};

const TRIGGER_SHORT_LABELS = {
    [TRIGGER_KINDS.TOPIC]: "Topic",
    [TRIGGER_KINDS.FIXED_UPDATE]: "Tick",
    [TRIGGER_KINDS.SIGNAL_UPDATE]: "Signal",
    [TRIGGER_KINDS.TIMER]: "Timer"
};

const INPUT_SOURCE_LABELS = {
    [INPUT_SOURCES.SIGNAL]: "Signal path",
    [INPUT_SOURCES.MESSAGE]: "Trigger message",
    [INPUT_SOURCES.CONSTANT]: "Constant",
    [INPUT_SOURCES.SIM]: "Simulation"
};

const SIGNAL_PATH_OPTIONS_ID = "bnd-signal-path-options";

function formatTime(ms) {
    if (!ms) return null;
    return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function parseConstant(raw) {
    const trimmed = String(raw ?? "").trim();
    if (!trimmed) return null;
    try {
        return JSON.parse(trimmed);
    } catch {
        return trimmed;
    }
}

function constantToText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function previewValue(value) {
    try {
        const text = JSON.stringify(value);
        return text && text.length > 64 ? `${text.slice(0, 61)}...` : text;
    } catch {
        return String(value);
    }
}

// ----------------------------------------------------------------- primitives

function Field({ label, hint, error, children }) {
    return (
        <label className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</span>
            {children}
            {hint && !error && <span className="text-[11px] leading-relaxed text-zinc-500">{hint}</span>}
            {error && <span className="text-[11px] leading-relaxed text-rose-300">{error}</span>}
        </label>
    );
}

function TextInput({ mono = false, className = "", value, ...props }) {
    return (
        <input
            {...props}
            value={value ?? ""}
            className={`h-8 w-full rounded-md border border-white/10 bg-[#171717] px-2.5 text-[12px] text-zinc-100 placeholder:text-zinc-600 outline-none transition-[border-color,background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus:border-emerald-400/40 focus:bg-[#191919] ${mono ? "font-mono" : ""} ${className}`}
        />
    );
}

function SignalPathInput(props) {
    return <TextInput {...props} mono list={SIGNAL_PATH_OPTIONS_ID} />;
}

function SelectInput({ className = "", value, children, ...props }) {
    return (
        <select
            {...props}
            value={value ?? ""}
            className={`h-8 w-full appearance-none rounded-md border border-white/10 bg-[#171717] px-2.5 text-[12px] text-zinc-100 outline-none transition-[border-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus:border-emerald-400/40 ${className}`}
        >
            {children}
        </select>
    );
}

function Toggle({ checked, onChange, label }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            className={`bnd-press relative h-[18px] w-[32px] shrink-0 rounded-full border transition-[background-color,border-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] ${checked ? "border-emerald-400/50 bg-emerald-400/25" : "border-white/15 bg-[#171717]"}`}
        >
            <span
                className={`absolute top-[2px] left-[2px] h-[12px] w-[12px] rounded-full transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] ${checked ? "translate-x-[14px] bg-emerald-200" : "translate-x-0 bg-zinc-500"}`}
            />
        </button>
    );
}

function SegmentedControl({ value, options, onChange }) {
    return (
        <div className="grid grid-cols-4 gap-0 overflow-hidden rounded-md border border-white/10 bg-[#171717]">
            {options.map((option) => {
                const active = option.value === value;
                return (
                    <button
                        key={option.value}
                        type="button"
                        onClick={() => onChange(option.value)}
                        aria-pressed={active}
                        className={`bnd-press h-8 border-r border-white/10 px-1 text-[11px] font-medium transition-[background-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] last:border-r-0 ${active ? "bg-emerald-400/15 text-emerald-200" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"}`}
                    >
                        {option.label}
                    </button>
                );
            })}
        </div>
    );
}

function StatusDot({ telemetry, enabled }) {
    const status = telemetry?.lastStatus;
    let color = "bg-zinc-600";
    let pulse = false;

    if (!enabled) {
        color = "bg-zinc-700";
    } else if (status === "success") {
        color = "bg-emerald-400";
        pulse = true;
    } else if (status === "failure" || status === "invalid") {
        color = "bg-rose-400";
    } else if (status === "loading") {
        color = "bg-amber-300";
        pulse = true;
    }

    return (
        <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
            {pulse && <span className={`bnd-dot-pulse absolute inline-flex h-full w-full rounded-full ${color} opacity-60`} />}
            <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${color}`} />
        </span>
    );
}

// ------------------------------------------------------------------ list rail

function BindingRow({ binding, telemetry, selected, onSelect, onToggle }) {
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => onSelect(binding.id)}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(binding.id);
                }
            }}
            className={`bnd-row flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left outline-none focus-visible:bg-white/5 ${selected ? "bg-emerald-400/[0.07]" : "hover:bg-white/[0.03]"}`}
        >
            <StatusDot telemetry={telemetry} enabled={binding.enabled} />
            <div className="min-w-0 flex-1">
                <p className={`truncate text-[12px] font-medium ${binding.enabled ? "text-zinc-100" : "text-zinc-500"}`}>
                    {binding.name}
                </p>
                <p className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">
                    {summarizeTrigger(binding.trigger)}
                </p>
            </div>
            {telemetry?.runCount > 0 && (
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-500">
                    {telemetry.runCount}
                </span>
            )}
            <span onClick={(event) => event.stopPropagation()}>
                <Toggle
                    checked={binding.enabled}
                    onChange={(next) => onToggle(binding.id, next)}
                    label={`Enable ${binding.name}`}
                />
            </span>
        </div>
    );
}

function BindingList({ manifest, telemetry, selectedId, query, onQuery, onSelect, onToggle, onCreate }) {
    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return manifest.bindings;
        return manifest.bindings.filter((binding) =>
            binding.name.toLowerCase().includes(needle)
            || summarizeTrigger(binding.trigger).toLowerCase().includes(needle)
        );
    }, [manifest.bindings, query]);

    const groups = useMemo(() => TRIGGER_KIND_ORDER
        .map((kind) => ({
            kind,
            bindings: filtered.filter((binding) => binding.trigger.kind === kind)
        }))
        .filter((group) => group.bindings.length > 0),
    [filtered]);

    return (
        <aside className="flex w-[340px] shrink-0 flex-col border-r border-white/10 bg-[#202020]/60">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
                <TextInput
                    value={query}
                    onChange={(event) => onQuery(event.target.value)}
                    placeholder="Filter bindings"
                    aria-label="Filter bindings"
                />
                <button type="button" onClick={onCreate} className="bnd-btn bnd-btn--primary shrink-0">
                    New
                </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto mod-scrollbar">
                {manifest.bindings.length === 0 && (
                    <div className="px-6 py-14 text-center">
                        <p className="text-[13px] font-medium text-zinc-300">No bindings yet</p>
                        <p className="mx-auto mt-2 max-w-[220px] text-[11px] leading-relaxed text-zinc-500">
                            A binding runs a script whenever a ROS topic updates, a simulation tick fires,
                            a signal changes, or a timer elapses.
                        </p>
                        <button type="button" onClick={onCreate} className="bnd-btn bnd-btn--primary mt-5">
                            Create first binding
                        </button>
                    </div>
                )}

                {manifest.bindings.length > 0 && filtered.length === 0 && (
                    <p className="px-4 py-10 text-center text-[11px] text-zinc-500">
                        Nothing matches &ldquo;{query}&rdquo;.
                    </p>
                )}

                {groups.map((group) => (
                    <section key={group.kind}>
                        <p className="sticky top-0 z-[1] border-b border-white/5 bg-[#232323] px-4 py-1.5 text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                            {TRIGGER_LABELS[group.kind]}
                        </p>
                        <div className="divide-y divide-white/[0.04]">
                            {group.bindings.map((binding) => (
                                <BindingRow
                                    key={binding.id}
                                    binding={binding}
                                    telemetry={telemetry[binding.id]}
                                    selected={binding.id === selectedId}
                                    onSelect={onSelect}
                                    onToggle={onToggle}
                                />
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </aside>
    );
}

// -------------------------------------------------------------- detail editor

function TriggerEditor({ binding, topics, onPatchTrigger }) {
    const trigger = binding.trigger;

    return (
        <section className="border-t border-white/10 pt-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Trigger</p>
            <div className="mt-3 flex flex-col gap-3">
                <SegmentedControl
                    value={trigger.kind}
                    onChange={(kind) => onPatchTrigger({ kind })}
                    options={TRIGGER_KIND_ORDER.map((kind) => ({ value: kind, label: TRIGGER_SHORT_LABELS[kind] }))}
                />

                {trigger.kind === TRIGGER_KINDS.TOPIC && (
                    <Field
                        label="Topic"
                        hint={topics.length > 0 ? "Runs each time this topic receives an update." : "No live topics seen yet. Type the topic name; it activates when the bridge connects."}
                        error={!trigger.topic ? "Topic trigger needs a topic name." : null}
                    >
                        <TextInput
                            mono
                            list="bnd-topic-options"
                            value={trigger.topic}
                            onChange={(event) => onPatchTrigger({ topic: event.target.value })}
                            placeholder="/ackdrive"
                        />
                        <datalist id="bnd-topic-options">
                            {topics.map((topic) => <option key={topic} value={topic} />)}
                        </datalist>
                    </Field>
                )}

                {trigger.kind === TRIGGER_KINDS.FIXED_UPDATE && (
                    <Field label="Run every N ticks" hint="1 runs on every fixed simulation step (60 Hz by default).">
                        <TextInput
                            mono
                            type="number"
                            min={1}
                            value={trigger.everyN}
                            onChange={(event) => onPatchTrigger({ everyN: event.target.value })}
                        />
                    </Field>
                )}

                {trigger.kind === TRIGGER_KINDS.SIGNAL_UPDATE && (
                    <Field
                        label="Signal path"
                        hint="Runs when the value at this signal store path changes."
                        error={!trigger.path ? "Signal trigger needs a signal path." : null}
                    >
                        <SignalPathInput
                            value={trigger.path}
                            onChange={(event) => onPatchTrigger({ path: event.target.value })}
                            placeholder={SIGNAL_PATHS.VEHICLE_EGO_POSE}
                        />
                    </Field>
                )}

                {trigger.kind === TRIGGER_KINDS.TIMER && (
                    <Field label="Interval (ms)" hint="Wall-clock timer. Runs even while the simulation is paused.">
                        <TextInput
                            mono
                            type="number"
                            min={1}
                            value={trigger.intervalMs}
                            onChange={(event) => onPatchTrigger({ intervalMs: event.target.value })}
                        />
                    </Field>
                )}
            </div>
        </section>
    );
}

function ScriptPicker({ binding, scripts, scriptsLoading, onSelectScript }) {
    const selected = scripts.find((script) => script.id === binding.scriptId) || null;

    return (
        <section className="border-t border-white/10 pt-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Script</p>
            <div className="mt-3 flex flex-col gap-2">
                {scriptsLoading ? (
                    <div className="h-8 w-full animate-pulse rounded-md bg-white/5" />
                ) : (
                    <SelectInput
                        value={binding.scriptId || ""}
                        onChange={(event) => onSelectScript(event.target.value || null)}
                    >
                        <option value="">Select a script...</option>
                        {scripts.map((script) => (
                            <option key={script.id} value={script.id}>
                                {script.name}{script.valid ? "" : " (not compiled)"}
                            </option>
                        ))}
                    </SelectInput>
                )}

                {!scriptsLoading && scripts.length === 0 && (
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                        No scripts in the library yet. Create one in the Scripting workspace first.
                    </p>
                )}

                {selected && !selected.valid && (
                    <p className="rounded-md border border-amber-300/15 bg-amber-400/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-200">
                        This script has no valid compiled artifact
                        {selected.error ? `: ${selected.error}` : "."} It will not run until it compiles.
                    </p>
                )}

                {selected?.valid && (
                    <p className="font-mono text-[10px] text-zinc-500">
                        {selected.inputs} input{selected.inputs === 1 ? "" : "s"} / {selected.outputs} output{selected.outputs === 1 ? "" : "s"}
                    </p>
                )}
            </div>
        </section>
    );
}

function InputMappingRows({ binding, artifact, onPatchInput }) {
    const interfaceInputs = artifact?.interface?.inputs || [];
    const isTopicTrigger = binding.trigger.kind === TRIGGER_KINDS.TOPIC;

    if (!artifact) return null;

    return (
        <section className="border-t border-white/10 pt-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Inputs</p>
            {interfaceInputs.length === 0 && (
                <p className="mt-2 text-[11px] text-zinc-500">This script takes no inputs.</p>
            )}
            <div className="mt-1 divide-y divide-white/[0.04]">
                {interfaceInputs.map((port) => {
                    const mapping = binding.inputs.find((item) => item.input === port.label)
                        || { input: port.label, source: INPUT_SOURCES.SIGNAL, path: "", field: "" };

                    return (
                        <div key={port.label} className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3 py-2.5">
                            <div className="min-w-0">
                                <p className="truncate font-mono text-[11px] text-zinc-200">{port.label}</p>
                                <p className="truncate font-mono text-[9px] text-zinc-600">{port.type}</p>
                            </div>
                            <SelectInput
                                value={mapping.source}
                                aria-label={`Source for ${port.label}`}
                                onChange={(event) => onPatchInput(port.label, { source: event.target.value })}
                            >
                                {Object.values(INPUT_SOURCES).map((source) => (
                                    <option
                                        key={source}
                                        value={source}
                                        disabled={source === INPUT_SOURCES.MESSAGE && !isTopicTrigger}
                                    >
                                        {INPUT_SOURCE_LABELS[source]}
                                    </option>
                                ))}
                            </SelectInput>
                            <div className="min-w-0">
                                {mapping.source === INPUT_SOURCES.SIGNAL && (
                                    <SignalPathInput
                                        value={mapping.path || ""}
                                        onChange={(event) => onPatchInput(port.label, { path: event.target.value })}
                                        placeholder={SIGNAL_PATHS.ACKDRIVE_TOPIC}
                                        aria-label={`Signal path for ${port.label}`}
                                    />
                                )}
                                {mapping.source === INPUT_SOURCES.MESSAGE && (
                                    <TextInput
                                        mono
                                        value={mapping.field || ""}
                                        onChange={(event) => onPatchInput(port.label, { field: event.target.value })}
                                        placeholder="field.path (blank = whole message)"
                                        aria-label={`Message field for ${port.label}`}
                                    />
                                )}
                                {mapping.source === INPUT_SOURCES.CONSTANT && (
                                    <TextInput
                                        mono
                                        value={constantToText(mapping.value)}
                                        onChange={(event) => onPatchInput(port.label, { value: parseConstant(event.target.value) })}
                                        placeholder='1.5 or "text" or {"a":1}'
                                        aria-label={`Constant value for ${port.label}`}
                                    />
                                )}
                                {mapping.source === INPUT_SOURCES.SIM && (
                                    <SelectInput
                                        value={mapping.key || "dt"}
                                        aria-label={`Simulation value for ${port.label}`}
                                        onChange={(event) => onPatchInput(port.label, { key: event.target.value })}
                                    >
                                        {SIM_VALUE_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}
                                    </SelectInput>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function OutputMappingRows({ binding, artifact, onPatchOutput }) {
    const interfaceOutputs = artifact?.interface?.outputs || [];

    if (!artifact) return null;

    return (
        <section className="border-t border-white/10 pt-5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Outputs</p>
            {interfaceOutputs.length === 0 && (
                <p className="mt-2 text-[11px] text-zinc-500">This script produces no outputs.</p>
            )}
            <div className="mt-1 divide-y divide-white/[0.04]">
                {interfaceOutputs.map((port) => {
                    const mapping = binding.outputs.find((item) => item.output === port.label)
                        || { output: port.label, sink: OUTPUT_SINKS.SIGNAL, path: "", topic: "", type: "" };

                    return (
                        <div key={port.label} className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.4fr)] items-center gap-3 py-2.5">
                            <div className="min-w-0">
                                <p className="truncate font-mono text-[11px] text-zinc-200">{port.label}</p>
                                <p className="truncate font-mono text-[9px] text-zinc-600">{port.type}</p>
                            </div>
                            <SelectInput
                                value={mapping.sink}
                                aria-label={`Sink for ${port.label}`}
                                onChange={(event) => onPatchOutput(port.label, { sink: event.target.value })}
                            >
                                <option value={OUTPUT_SINKS.SIGNAL}>Signal path</option>
                                <option value={OUTPUT_SINKS.PUBLISH}>Publish to ROS</option>
                            </SelectInput>
                            <div className="min-w-0">
                                {mapping.sink === OUTPUT_SINKS.SIGNAL && (
                                    <SignalPathInput
                                        value={mapping.path || ""}
                                        onChange={(event) => onPatchOutput(port.label, { path: event.target.value })}
                                        placeholder="scenario.flags.done"
                                        aria-label={`Signal path for ${port.label}`}
                                    />
                                )}
                                {mapping.sink === OUTPUT_SINKS.PUBLISH && (
                                    <div className="flex min-w-0 gap-2">
                                        <TextInput
                                            mono
                                            value={mapping.topic || ""}
                                            onChange={(event) => onPatchOutput(port.label, { topic: event.target.value })}
                                            placeholder="/cmd_out"
                                            aria-label={`Publish topic for ${port.label}`}
                                        />
                                        <TextInput
                                            mono
                                            value={mapping.type || ""}
                                            onChange={(event) => onPatchOutput(port.label, { type: event.target.value })}
                                            placeholder="pkg/Type"
                                            aria-label={`Message type for ${port.label}`}
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </section>
    );
}

function RunFooter({ binding, telemetry, issues, onRunNow, onDelete, running }) {
    const lastRanAt = formatTime(telemetry?.lastRanAt);

    return (
        <section className="border-t border-white/10 pt-5">
            <div className="flex items-center gap-2">
                <button
                    type="button"
                    onClick={onRunNow}
                    disabled={running || issues.length > 0}
                    className="bnd-btn bnd-btn--primary"
                >
                    {running ? "Running..." : "Run now"}
                </button>
                <div className="flex-1" />
                <button type="button" onClick={onDelete} className="bnd-btn bnd-btn--danger">
                    Delete binding
                </button>
            </div>

            {issues.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1 rounded-md border border-amber-300/15 bg-amber-400/10 px-3 py-2">
                    {issues.map((issue) => (
                        <li key={issue} className="text-[11px] leading-relaxed text-amber-200">{issue}</li>
                    ))}
                </ul>
            )}

            {telemetry?.lastStatus && (
                <div className="mt-3 rounded-md border border-white/10 bg-[#171717] px-3 py-2.5">
                    <div className="flex items-center gap-2">
                        <span className={`text-[11px] font-medium ${telemetry.lastStatus === "success" ? "text-emerald-200" : telemetry.lastStatus === "loading" ? "text-amber-200" : "text-rose-200"}`}>
                            {telemetry.lastStatus === "success" ? "Last run succeeded"
                                : telemetry.lastStatus === "loading" ? "Script still loading"
                                : telemetry.lastStatus === "invalid" ? "Binding invalid"
                                : "Last run failed"}
                        </span>
                        <div className="flex-1" />
                        {lastRanAt && (
                            <span className="font-mono text-[10px] tabular-nums text-zinc-500">
                                {telemetry.runCount || 0} runs · {lastRanAt}
                            </span>
                        )}
                    </div>

                    {telemetry.lastError && (
                        <p className="mt-1.5 text-[11px] leading-relaxed text-rose-300">{telemetry.lastError}</p>
                    )}

                    {telemetry.lastStatus === "success" && telemetry.lastOutputs && Object.keys(telemetry.lastOutputs).length > 0 && (
                        <div className="mt-2 flex flex-col gap-1 border-t border-white/5 pt-2">
                            {Object.entries(telemetry.lastOutputs).map(([key, value]) => (
                                <div key={key} className="flex items-baseline gap-2">
                                    <span className="shrink-0 font-mono text-[10px] text-zinc-500">{key}</span>
                                    <span className="truncate font-mono text-[10px] text-zinc-300">{previewValue(value)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}

function DetailPanel({
    binding,
    telemetry,
    scripts,
    scriptDocs,
    scriptsLoading,
    topics,
    signalPaths = [],
    onPatch,
    onPatchTrigger,
    onSelectScript,
    onPatchInput,
    onPatchOutput,
    onRunNow,
    onDelete,
    running
}) {
    if (!binding) {
        return (
            <div className="flex min-w-0 flex-1 items-center justify-center">
                <div className="max-w-[300px] text-center">
                    <p className="text-[13px] font-medium text-zinc-400">Select a binding</p>
                    <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
                        Pick a binding from the list, or create a new one to wire a script
                        to a topic, tick, signal, or timer.
                    </p>
                </div>
            </div>
        );
    }

    const doc = scriptDocs.find((item) => item.id === binding.scriptId) || null;
    const artifact = doc?.latestValidArtifact || null;
    const issues = validateBinding(binding);

    return (
        <div key={binding.id} className="bnd-detail min-w-0 flex-1 overflow-y-auto mod-scrollbar">
            <datalist id={SIGNAL_PATH_OPTIONS_ID}>
                {signalPaths.map((path) => <option key={path} value={path} />)}
            </datalist>
            <div className="mx-auto flex max-w-[640px] flex-col gap-5 px-8 py-8 pb-16">
                <div className="flex items-center gap-3">
                    <input
                        value={binding.name}
                        onChange={(event) => onPatch({ name: event.target.value })}
                        aria-label="Binding name"
                        className="h-9 w-full min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-[16px] font-semibold tracking-tight text-zinc-50 outline-none transition-[border-color,background-color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:border-white/10 focus:border-emerald-400/40 focus:bg-[#171717]"
                    />
                    <Toggle
                        checked={binding.enabled}
                        onChange={(enabled) => onPatch({ enabled })}
                        label="Enable binding"
                    />
                </div>

                <TriggerEditor binding={binding} topics={topics} onPatchTrigger={onPatchTrigger} />
                <ScriptPicker
                    binding={binding}
                    scripts={scripts}
                    scriptsLoading={scriptsLoading}
                    onSelectScript={onSelectScript}
                />
                <InputMappingRows binding={binding} artifact={artifact} onPatchInput={onPatchInput} />
                <OutputMappingRows binding={binding} artifact={artifact} onPatchOutput={onPatchOutput} />
                <RunFooter
                    binding={binding}
                    telemetry={telemetry}
                    issues={issues}
                    onRunNow={onRunNow}
                    onDelete={onDelete}
                    running={running}
                />
            </div>
        </div>
    );
}

// ----------------------------------------------------------------------- page

export default function BindingsPage() {
    const runtime = useMemo(() => getBindingRuntime(), []);

    const [snapshot, setSnapshot] = useState(null);
    const [manifest, setManifest] = useState(null);
    const [selectedId, setSelectedId] = useState(null);
    const [query, setQuery] = useState("");
    const [scriptDocs, setScriptDocs] = useState([]);
    const [scriptsLoading, setScriptsLoading] = useState(true);
    const [running, setRunning] = useState(false);
    const [feedback, setFeedback] = useState(null);

    const saveTimer = useRef(null);
    const feedbackTimer = useRef(null);
    const fileInputRef = useRef(null);
    const hydratedRef = useRef(false);

    useEffect(() => runtime.subscribe((next) => {
        setSnapshot(next);
        if (!hydratedRef.current && next.ready) {
            hydratedRef.current = true;
            setManifest(next.manifest);
            setSelectedId((current) => current || next.manifest.bindings[0]?.id || null);
        }
    }), [runtime]);

    useEffect(() => {
        let cancelled = false;
        runtime.invalidateScript();

        (async () => {
            try {
                const documents = await listScriptDocuments();
                if (!cancelled) setScriptDocs(documents || []);
            } finally {
                if (!cancelled) setScriptsLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [runtime]);

    useEffect(() => () => {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    }, []);

    const showFeedback = useCallback((message) => {
        setFeedback(message);
        if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
        feedbackTimer.current = setTimeout(() => setFeedback(null), 2000);
    }, []);

    // Live-sync: MCP binding writes rehydrate the runtime without re-persisting.
    useEffect(() => {
        return subscribeStorageEvents((event) => {
            if (event.domain === "script") {
                runtime.invalidateScript(event.id || undefined);
                listScriptDocuments()
                    .then((documents) => setScriptDocs(documents || []))
                    .catch(() => {});
                return;
            }
            if (event.domain !== "bindings") return;

            (async () => {
                try {
                    const next = await getBindingManifest();
                    setManifest(next);
                    await runtime.setManifest(next, { persist: false });
                    showFeedback("Bindings updated by agent");
                } catch (error) {
                    console.warn("[bindings] MCP live-sync failed:", error);
                }
            })();
        });
    }, [runtime, showFeedback]);

    const commitManifest = useCallback((next, { immediate = false } = {}) => {
        setManifest(next);

        if (saveTimer.current) clearTimeout(saveTimer.current);
        const save = () => {
            runtime.setManifest(next).catch(() => {});
        };

        if (immediate) {
            save();
        } else {
            saveTimer.current = setTimeout(save, 450);
        }
    }, [runtime]);

    const scripts = useMemo(
        () => scriptDocs.map(summarizeScriptDocument).sort((a, b) => a.name.localeCompare(b.name)),
        [scriptDocs]
    );

    const selectedBinding = manifest?.bindings.find((binding) => binding.id === selectedId) || null;
    const telemetry = snapshot?.telemetry || {};
    const topics = snapshot?.topics || [];
    const signalPaths = snapshot?.signalPaths || [];

    const patchBinding = useCallback((id, patch, options) => {
        if (!manifest) return;
        commitManifest({
            ...manifest,
            bindings: manifest.bindings.map((binding) =>
                binding.id === id ? { ...binding, ...patch } : binding
            )
        }, options);
    }, [commitManifest, manifest]);

    const patchTrigger = useCallback((patch) => {
        if (!selectedBinding) return;
        patchBinding(selectedBinding.id, {
            trigger: normalizeTrigger({ ...selectedBinding.trigger, ...patch })
        });
    }, [patchBinding, selectedBinding]);

    const selectScript = useCallback((scriptId) => {
        if (!selectedBinding) return;

        const patch = { scriptId, inputs: [], outputs: [] };

        const doc = scriptDocs.find((item) => item.id === scriptId);
        const artifact = doc?.latestValidArtifact;
        if (artifact) {
            const suggested = suggestTriggerFromArtifact(artifact);
            const triggerUntouched = selectedBinding.trigger.kind === TRIGGER_KINDS.TOPIC
                && !selectedBinding.trigger.topic;
            if (suggested && triggerUntouched) {
                patch.trigger = suggested;
            }
        }

        patchBinding(selectedBinding.id, patch);
    }, [patchBinding, scriptDocs, selectedBinding]);

    const patchInput = useCallback((inputLabel, patch) => {
        if (!selectedBinding) return;

        const existing = selectedBinding.inputs.find((item) => item.input === inputLabel);
        const nextMapping = { input: inputLabel, source: INPUT_SOURCES.SIGNAL, ...existing, ...patch };
        patchBinding(selectedBinding.id, {
            inputs: [
                ...selectedBinding.inputs.filter((item) => item.input !== inputLabel),
                nextMapping
            ]
        });
    }, [patchBinding, selectedBinding]);

    const patchOutput = useCallback((outputLabel, patch) => {
        if (!selectedBinding) return;

        const existing = selectedBinding.outputs.find((item) => item.output === outputLabel);
        const nextMapping = { output: outputLabel, sink: OUTPUT_SINKS.SIGNAL, ...existing, ...patch };
        patchBinding(selectedBinding.id, {
            outputs: [
                ...selectedBinding.outputs.filter((item) => item.output !== outputLabel),
                nextMapping
            ]
        });
    }, [patchBinding, selectedBinding]);

    const createNewBinding = useCallback(() => {
        if (!manifest) return;
        const binding = createBinding({ name: `Binding ${manifest.bindings.length + 1}` });
        commitManifest({ ...manifest, bindings: [...manifest.bindings, binding] }, { immediate: true });
        setSelectedId(binding.id);
    }, [commitManifest, manifest]);

    const deleteSelected = useCallback(() => {
        if (!manifest || !selectedBinding) return;
        const remaining = manifest.bindings.filter((binding) => binding.id !== selectedBinding.id);
        commitManifest({ ...manifest, bindings: remaining }, { immediate: true });
        setSelectedId(remaining[0]?.id || null);
    }, [commitManifest, manifest, selectedBinding]);

    const toggleBinding = useCallback((id, enabled) => {
        patchBinding(id, { enabled }, { immediate: true });
    }, [patchBinding]);

    const setMasterEnabled = useCallback((enabled) => {
        if (!manifest) return;
        commitManifest({ ...manifest, enabled }, { immediate: true });
    }, [commitManifest, manifest]);

    const runNow = useCallback(async () => {
        if (!selectedBinding) return;
        setRunning(true);

        try {
            if (saveTimer.current) {
                clearTimeout(saveTimer.current);
                await runtime.setManifest(manifest);
            }
            await runtime.runBindingNow(selectedBinding.id);
        } catch (error) {
            showFeedback(error?.message || "Run failed.");
        } finally {
            setRunning(false);
        }
    }, [manifest, runtime, selectedBinding, showFeedback]);

    const exportManifest = useCallback(() => {
        if (!manifest) return;
        const blob = new Blob([serializeBindingManifest(manifest)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "script-bindings.json";
        anchor.click();
        URL.revokeObjectURL(url);
        showFeedback("Manifest exported");
    }, [manifest, showFeedback]);

    const importManifest = useCallback(async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;

        try {
            const parsed = parseBindingManifest(await file.text());
            commitManifest(parsed, { immediate: true });
            setSelectedId(parsed.bindings[0]?.id || null);
            showFeedback(`Imported ${parsed.bindings.length} binding${parsed.bindings.length === 1 ? "" : "s"}`);
        } catch (error) {
            showFeedback(error?.message || "Could not import manifest.");
        }
    }, [commitManifest, showFeedback]);

    const loading = !manifest;

    return (
        <div className="bnd-page fixed inset-0 flex min-h-[100dvh] flex-col bg-[#292929] font-sans text-white">
            <header className="flex h-14 shrink-0 items-center gap-4 border-b border-white/10 bg-[#202020]/95 px-5 backdrop-blur">
                <div className="min-w-0">
                    <h1 className="text-[14px] font-semibold tracking-tight text-zinc-50">Bindings</h1>
                    <p className="text-[10px] text-zinc-500">Wire scripts to topics, ticks, signals, and timers</p>
                </div>

                <div className="flex-1" />

                <div className="flex items-center gap-1.5" title={snapshot?.connected ? "ROS bridge connected" : "ROS bridge not connected"}>
                    <span className={`h-1.5 w-1.5 rounded-full ${snapshot?.connected ? "bg-emerald-400" : "bg-zinc-600"}`} />
                    <span className="font-mono text-[10px] text-zinc-500">
                        {snapshot?.connected ? "bridge up" : "bridge down"}
                    </span>
                </div>

                <div className="mx-1 h-5 w-px bg-white/10" />

                <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Runtime</span>
                    <Toggle
                        checked={manifest?.enabled !== false}
                        onChange={setMasterEnabled}
                        label="Enable binding runtime"
                    />
                </div>

                <div className="mx-1 h-5 w-px bg-white/10" />

                <button type="button" onClick={exportManifest} className="bnd-btn">Export</button>
                <button type="button" onClick={() => fileInputRef.current?.click()} className="bnd-btn">Import</button>
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={importManifest}
                />
            </header>

            {loading ? (
                <div className="flex flex-1">
                    <div className="w-[340px] shrink-0 border-r border-white/10 bg-[#202020]/60 p-4">
                        <div className="flex flex-col gap-2">
                            <div className="h-8 animate-pulse rounded-md bg-white/5" />
                            <div className="mt-3 h-10 animate-pulse rounded-md bg-white/5" />
                            <div className="h-10 animate-pulse rounded-md bg-white/[0.04]" />
                            <div className="h-10 animate-pulse rounded-md bg-white/[0.03]" />
                        </div>
                    </div>
                    <div className="flex-1" />
                </div>
            ) : (
                <div className="flex min-h-0 flex-1">
                    <BindingList
                        manifest={manifest}
                        telemetry={telemetry}
                        selectedId={selectedId}
                        query={query}
                        onQuery={setQuery}
                        onSelect={setSelectedId}
                        onToggle={toggleBinding}
                        onCreate={createNewBinding}
                    />
                    <DetailPanel
                        binding={selectedBinding}
                        telemetry={selectedBinding ? telemetry[selectedBinding.id] : null}
                        scripts={scripts}
                        scriptDocs={scriptDocs}
                        scriptsLoading={scriptsLoading}
                        topics={topics}
                        signalPaths={signalPaths}
                        onPatch={(patch) => patchBinding(selectedBinding.id, patch)}
                        onPatchTrigger={patchTrigger}
                        onSelectScript={selectScript}
                        onPatchInput={patchInput}
                        onPatchOutput={patchOutput}
                        onRunNow={runNow}
                        onDelete={deleteSelected}
                        running={running}
                    />
                </div>
            )}

            {feedback && (
                <div className="bnd-toast fixed left-1/2 top-4 z-[60] -translate-x-1/2 rounded-md border border-white/10 bg-[#171717]/95 px-3 py-1.5 text-xs font-medium text-zinc-100 shadow-[0_12px_36px_rgba(0,0,0,0.28)] backdrop-blur">
                    {feedback}
                </div>
            )}

            <style jsx global>{`
                .bnd-page .bnd-btn {
                    height: 30px;
                    padding: 0 12px;
                    border-radius: 6px;
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    background: #171717;
                    color: #d4d4d8;
                    font-size: 12px;
                    font-weight: 500;
                    transition:
                        background-color 150ms var(--ease-out-ui),
                        border-color 150ms var(--ease-out-ui),
                        color 150ms var(--ease-out-ui),
                        transform 120ms var(--ease-out-ui);
                }

                .bnd-page .bnd-btn:hover:not(:disabled) {
                    background: #1f1f1f;
                    color: #fafafa;
                }

                .bnd-page .bnd-btn:active:not(:disabled),
                .bnd-page .bnd-press:active:not(:disabled) {
                    transform: scale(0.97);
                }

                .bnd-page .bnd-btn:disabled {
                    opacity: 0.45;
                    cursor: not-allowed;
                }

                .bnd-page .bnd-btn--primary {
                    border-color: rgba(52, 211, 153, 0.25);
                    background: rgba(52, 211, 153, 0.12);
                    color: #a7f3d0;
                }

                .bnd-page .bnd-btn--primary:hover:not(:disabled) {
                    background: rgba(52, 211, 153, 0.18);
                    color: #d1fae5;
                }

                .bnd-page .bnd-btn--danger {
                    border-color: rgba(251, 113, 133, 0.2);
                    background: rgba(251, 113, 133, 0.08);
                    color: #fda4af;
                }

                .bnd-page .bnd-btn--danger:hover:not(:disabled) {
                    background: rgba(251, 113, 133, 0.14);
                    color: #fecdd3;
                }

                .bnd-page .bnd-press {
                    transition: transform 120ms var(--ease-out-ui);
                }

                .bnd-page .bnd-row {
                    transition: background-color 150ms var(--ease-out-ui);
                }

                .bnd-page .bnd-detail {
                    opacity: 1;
                    transform: translateY(0);
                    transition:
                        opacity 160ms var(--ease-out-ui),
                        transform 160ms var(--ease-out-ui);
                }

                .bnd-toast {
                    opacity: 1;
                    transform: translate(-50%, 0);
                    transition:
                        opacity 150ms var(--ease-out-ui),
                        transform 150ms var(--ease-out-ui);
                }

                @keyframes bnd-dot-pulse {
                    0%, 100% {
                        transform: scale(1);
                        opacity: 0.55;
                    }
                    50% {
                        transform: scale(2);
                        opacity: 0;
                    }
                }

                .bnd-dot-pulse {
                    animation: bnd-dot-pulse 2.2s var(--ease-in-out-ui) infinite;
                    will-change: transform, opacity;
                }

                @starting-style {
                    .bnd-page .bnd-detail {
                        opacity: 0;
                        transform: translateY(6px);
                    }

                    .bnd-toast {
                        opacity: 0;
                        transform: translate(-50%, -6px);
                    }
                }

                @media (prefers-reduced-motion: reduce) {
                    .bnd-page .bnd-detail,
                    .bnd-toast,
                    .bnd-page .bnd-btn,
                    .bnd-page .bnd-press,
                    .bnd-page .bnd-row {
                        transition-duration: 0ms;
                    }

                    .bnd-page .bnd-detail,
                    .bnd-toast {
                        transform: none !important;
                    }

                    .bnd-dot-pulse {
                        animation: none;
                    }
                }
            `}</style>
        </div>
    );
}
