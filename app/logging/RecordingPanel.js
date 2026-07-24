'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import { FaCheck, FaExclamationTriangle, FaFileImport, FaSave, FaStopCircle } from "react-icons/fa";
import { getRecordingController } from "./RecordingController.js";
import { DEFAULT_REPLAY_PROFILE, DEFAULT_TELEMETRY_PROFILE, normalizeProfile, resolveProfileRule } from "./LogProfiles.js";
import { getTelemetryStore } from "../telemetry/TelemetryRuntime.js";
import { importLog } from "./LogClient.js";
import { storageGet, storagePut } from "../client/storageClient.js";
import { buildRecordingOptions } from "./RecordingOptions.js";

const PROFILE_SETTING = "logging-profiles-v1";

function formatBytes(value) {
    const bytes = Math.max(0, Number(value) || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatDuration(startedAt, now) {
    if (!startedAt) return "00:00";
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function customProfile(base, mode) {
    return normalizeProfile({
        ...base,
        id: `custom-${mode}`,
        name: mode === "replay-safe" ? "Replay Safe" : "Telemetry",
        mode,
    });
}

function estimatedBytesPerSecond(descriptor, rate) {
    const valueBytes = {
        boolean: 1,
        int32: 5,
        uint32: 5,
        int64: 10,
        uint64: 10,
        float32: 4,
        float64: 8,
        vec3: 24,
        pose3: 48,
    }[descriptor.type] || 32;
    return Math.round(Math.max(0, rate) * (valueBytes + 4));
}

export function RecordingPanel({ data, onOpenReplay }) {
    const controller = useMemo(() => getRecordingController(), []);
    const store = useMemo(() => getTelemetryStore(), []);
    const fileRef = useRef(null);
    const [recording, setRecording] = useState(() => controller.getSnapshot());
    const [profile, setProfile] = useState(() => customProfile(DEFAULT_REPLAY_PROFILE, "replay-safe"));
    const [query, setQuery] = useState("");
    const [now, setNow] = useState(Date.now());
    const [importing, setImporting] = useState(false);
    const [localError, setLocalError] = useState(null);

    useEffect(() => controller.subscribe(setRecording), [controller]);
    useEffect(() => {
        controller.attachSimulation(data?.simulation?.());
    }, [controller, data]);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    useEffect(() => {
        let cancelled = false;
        storageGet(`settings/${PROFILE_SETTING}`)
            .then((result) => {
                const saved = result?.value?.active || result?.value;
                if (!cancelled && saved?.kind === "fusion-log-profile") setProfile(normalizeProfile(saved));
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);

    const descriptors = store.descriptors();
    const visible = descriptors.filter((descriptor) => descriptor.path.toLowerCase().includes(query.toLowerCase())).slice(0, 80);

    const updateMode = (mode) => {
        const base = mode === "replay-safe" ? DEFAULT_REPLAY_PROFILE : DEFAULT_TELEMETRY_PROFILE;
        setProfile(customProfile(base, mode));
    };

    const setDescriptorRule = (descriptor, patch) => {
        const resolved = resolveProfileRule(profile, descriptor);
        if (resolved.locked || recording.active) return;
        setProfile((current) => normalizeProfile({
            ...current,
            rules: [
                ...current.rules,
                {
                    pattern: descriptor.path,
                    enabled: patch.enabled ?? resolved.enabled,
                    sampling: patch.sampling ?? resolved.sampling,
                    rateHz: Object.prototype.hasOwnProperty.call(patch, "rateHz") ? patch.rateHz : resolved.rateHz,
                },
            ],
        }));
    };

    const toggleDescriptor = (descriptor) => {
        const resolved = resolveProfileRule(profile, descriptor);
        setDescriptorRule(descriptor, {
            enabled: !resolved.enabled,
            sampling: resolved.enabled ? "disabled" : "on-change",
            rateHz: null,
        });
    };

    const saveProfile = async () => {
        setLocalError(null);
        try {
            await storagePut(`settings/${PROFILE_SETTING}`, { value: { active: profile } });
        } catch (error) {
            setLocalError(error.message);
        }
    };

    const start = async () => {
        setLocalError(null);
        try {
            await saveProfile();
            await controller.start(buildRecordingOptions({ data, store, profile }));
        } catch (error) {
            setLocalError(error.message);
        }
    };

    const stop = async () => {
        setLocalError(null);
        try {
            const metadata = await controller.stop();
            if (metadata?.id) onOpenReplay?.(metadata.id);
        } catch (error) {
            setLocalError(error.message);
        }
    };

    const handleImport = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setImporting(true);
        setLocalError(null);
        try {
            const metadata = await importLog(file);
            onOpenReplay?.(metadata.id);
        } catch (error) {
            setLocalError(error.message);
        } finally {
            setImporting(false);
        }
    };

    const error = localError || recording.error;

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-3 divide-x divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/65">
                <Metric label="Duration" value={formatDuration(recording.startedAt, now)} />
                <Metric label="Written" value={formatBytes(recording.bytesWritten)} />
                <Metric label="Queue" value={formatBytes(recording.queuedBytes)} />
            </div>

            <div className="flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900/65 p-1">
                {["replay-safe", "telemetry"].map((mode) => (
                    <button
                        key={mode}
                        type="button"
                        disabled={recording.active}
                        onClick={() => updateMode(mode)}
                        className={`flex-1 rounded-lg px-2 py-2 text-[10px] font-semibold tracking-wide transition-colors active:scale-[0.97] ${profile.mode === mode ? "bg-sky-500/20 text-sky-200" : "text-zinc-400 hover:bg-zinc-800"}`}
                    >
                        {mode === "replay-safe" ? "Replay Safe" : "Telemetry"}
                    </button>
                ))}
            </div>

            {!recording.active && (
                <div>
                    <div className="mb-1.5 flex items-center justify-between">
                        <label htmlFor="log-signal-search" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Signal rules</label>
                        <button type="button" onClick={saveProfile} className="inline-flex items-center gap-1 text-[10px] text-zinc-400 hover:text-zinc-100"><FaSave /> Save</button>
                    </div>
                    <input id="log-signal-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter signals…" className="mb-1.5 h-8 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 text-[11px] text-zinc-100 outline-none focus:border-sky-500" />
                    <div className="max-h-44 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/60">
                        {visible.length === 0 && <p className="px-3 py-5 text-center text-[10px] text-zinc-500">Signals appear as the simulation initializes.</p>}
                        {visible.map((descriptor) => {
                            const rule = resolveProfileRule(profile, descriptor);
                            const history = store.history(descriptor.path);
                            const rate = history.length > 1 ? Math.round((history.length - 1) / Math.max(0.1, ((history.at(-1)?.timeUs || 0) - (history[0]?.timeUs || 0)) / 1e6)) : 0;
                            return (
                                <div key={descriptor.path} className="border-b border-zinc-800/80 px-2.5 py-2 last:border-0 hover:bg-zinc-900">
                                    <div className="flex items-center gap-2">
                                        <button type="button" aria-label={`${rule.enabled ? "Disable" : "Enable"} ${descriptor.path}`} onClick={() => toggleDescriptor(descriptor)} disabled={rule.locked} className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${rule.enabled ? "border-sky-400 bg-sky-500/20 text-sky-200" : "border-zinc-700 text-transparent"} disabled:cursor-not-allowed`}><FaCheck className="h-2.5 w-2.5" /></button>
                                        <span className="min-w-0 flex-1"><span className="block truncate text-[10px] text-zinc-200">{descriptor.path}</span><span className="block truncate text-[9px] text-zinc-500">{descriptor.type}{descriptor.unit ? ` · ${descriptor.unit}` : ""} · {rate} Hz · ~{formatBytes(estimatedBytesPerSecond(descriptor, rate))}/s</span></span>
                                        <span className={`text-[8px] uppercase tracking-wide ${rule.locked ? "text-amber-300" : "text-zinc-600"}`}>{rule.locked ? "required" : descriptor.logClass}</span>
                                    </div>
                                    {!rule.locked && (
                                        <div className="mt-1.5 flex gap-1 pl-6">
                                            <select aria-label={`${descriptor.path} sampling`} value={rule.enabled ? rule.sampling : "disabled"} onChange={(event) => setDescriptorRule(descriptor, { enabled: event.target.value !== "disabled", sampling: event.target.value, rateHz: event.target.value === "fixed-rate" ? (rule.rateHz || 10) : null })} className="h-6 min-w-0 flex-1 rounded-md border border-zinc-800 bg-zinc-950 px-1.5 text-[8px] text-zinc-400 outline-none focus:border-sky-500">
                                                <option value="every-update">Every update</option>
                                                <option value="on-change">On change</option>
                                                <option value="fixed-rate">Fixed rate</option>
                                                <option value="disabled">Disabled</option>
                                            </select>
                                            {rule.enabled && rule.sampling === "fixed-rate" && <select aria-label={`${descriptor.path} rate`} value={rule.rateHz || 10} onChange={(event) => setDescriptorRule(descriptor, { enabled: true, sampling: "fixed-rate", rateHz: Number(event.target.value) })} className="h-6 rounded-md border border-zinc-800 bg-zinc-950 px-1 text-[8px] text-zinc-400 outline-none focus:border-sky-500">{[1, 5, 10, 20, 30, 60].map((hz) => <option key={hz} value={hz}>{hz} Hz</option>)}</select>}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {error && (
                <button type="button" onClick={() => { setLocalError(null); controller.acknowledgeError(); }} className="flex w-full items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-left text-[10px] leading-relaxed text-amber-100">
                    <FaExclamationTriangle className="mt-0.5 shrink-0" />
                    <span className="flex-1">{error}</span>
                    <span className="text-amber-300">Dismiss</span>
                </button>
            )}

            <div className="grid grid-cols-2 gap-1.5">
                <button type="button" onClick={recording.active ? stop : start} disabled={recording.status === "starting" || recording.status === "stopping"} className={`inline-flex h-9 items-center justify-center gap-2 rounded-lg border text-[10px] font-semibold tracking-wide transition-colors active:scale-[0.97] disabled:opacity-50 ${recording.active ? "border-red-400/60 bg-red-500/20 text-red-100" : "border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20"}`}>
                    {recording.active ? <FaStopCircle /> : <span className="h-2.5 w-2.5 rounded-full bg-red-400" />}
                    {recording.active ? "Stop & open" : recording.status === "starting" ? "Starting…" : "Start logging"}
                </button>
                <button type="button" disabled={importing} onClick={() => fileRef.current?.click()} className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 text-[10px] font-semibold text-zinc-200 hover:bg-zinc-800 active:scale-[0.97] disabled:opacity-50"><FaFileImport />{importing ? "Importing…" : "Open log"}</button>
            </div>
            <input ref={fileRef} type="file" accept=".sflog,application/x-sflog" hidden onChange={handleImport} />
            {recording.session && <p className="truncate text-[9px] text-zinc-600">Session {recording.session.id}</p>}
        </div>
    );
}

function Metric({ label, value }) {
    return <div className="px-2 py-2"><p className="text-[8px] uppercase tracking-[0.14em] text-zinc-600">{label}</p><p className="mt-0.5 font-mono text-[10px] text-zinc-200">{value}</p></div>;
}
