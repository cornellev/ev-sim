'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaBackward, FaChartLine, FaCheck, FaChevronLeft, FaChevronRight, FaDownload, FaEllipsisH, FaFileImport, FaFolderOpen, FaPause, FaPlay, FaRedo, FaSpinner, FaTrash } from "react-icons/fa";
import ReplayScene from "./ReplayScene";
import { deleteLog, getLogDownloadUrl, importLog, listLogs, updateLog } from "../logging/LogClient.js";
import { LogDataset } from "../logging/LogDataset.js";
import { getTimelineStore } from "../logging/TimelineStore.js";
import { subscribeStorageEvents } from "../client/storageEvents.js";

function useTimeline(store) {
    const [state, setState] = useState(() => store.getSnapshot());
    useEffect(() => store.subscribe(setState), [store]);
    return state;
}

function formatTime(timeUs) {
    const totalMs = Math.max(0, Math.round((Number(timeUs) || 0) / 1000));
    const minutes = Math.floor(totalMs / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export default function ReplayPage({ initialLogId, mcpCommand, onOpenAnalysis }) {
    const timeline = useMemo(() => getTimelineStore(), []);
    const timelineState = useTimeline(timeline);
    const [logs, setLogs] = useState([]);
    const [selectedId, setSelectedId] = useState(initialLogId || "");
    const [dataset, setDataset] = useState(null);
    const [status, setStatus] = useState("catalog");
    const [error, setError] = useState(null);
    const [selectedEntity, setSelectedEntity] = useState(null);
    const [manageOpen, setManageOpen] = useState(false);
    const [nameDraft, setNameDraft] = useState("");
    const [tagsDraft, setTagsDraft] = useState("");
    const [deleteArmed, setDeleteArmed] = useState(false);
    const fileRef = useRef(null);
    const playRef = useRef({ timeUs: 0, stamp: 0 });
    const appliedMcpCommandRef = useRef(null);

    const refreshLogs = useCallback(async () => {
        try {
            const catalog = await listLogs();
            setLogs(catalog);
            return catalog;
        } catch (caught) {
            setError(caught.message);
            return [];
        }
    }, []);

    useEffect(() => subscribeStorageEvents(async (event) => {
        if (event.domain !== "logging" || !["updated", "deleted"].includes(event.action)) return;
        const catalog = await refreshLogs();
        if (event.action === "deleted" && event.id === selectedId) {
            setDataset(null);
            setSelectedId(catalog[0]?.id || "");
        }
    }), [refreshLogs, selectedId]);
    useEffect(() => {
        let cancelled = false;
        listLogs()
            .then((catalog) => {
                if (cancelled) return;
                setLogs(catalog);
                setSelectedId((current) => current || catalog[0]?.id || "");
            })
            .catch((caught) => { if (!cancelled) setError(caught.message); });
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        if (!selectedId) return undefined;
        let cancelled = false;
        Promise.resolve()
            .then(() => {
                if (cancelled) return null;
                setStatus("loading");
                setError(null);
                return LogDataset.open(selectedId);
            })
            .then((opened) => {
                if (cancelled || !opened) return;
                setDataset(opened);
                timeline.set({ durationUs: opened.durationUs, timeUs: 0, playing: false, speed: 1, loopEnabled: false, selection: { startUs: 0, endUs: opened.durationUs } });
                const firstEntity = opened.descriptors.find((item) => item.type === "pose3" && item.path.startsWith("vehicles."))?.path.split(".")[1];
                setSelectedEntity(firstEntity || null);
                setStatus("ready");
            })
            .catch((caught) => { if (!cancelled) { setError(caught.message); setStatus("error"); } });
        return () => { cancelled = true; };
    }, [selectedId, timeline]);

    useEffect(() => {
        if (!mcpCommand?.requestId || appliedMcpCommandRef.current === mcpCommand.requestId) return;
        if (mcpCommand.logId !== selectedId) return;
        if (!dataset || dataset.id !== mcpCommand.logId) return;
        const patch = {};
        if (mcpCommand.timeUs !== undefined) patch.timeUs = Number(mcpCommand.timeUs);
        if (mcpCommand.playing !== undefined) patch.playing = Boolean(mcpCommand.playing);
        if (mcpCommand.speed !== undefined) patch.speed = Number(mcpCommand.speed);
        if (mcpCommand.loop !== undefined) patch.loopEnabled = Boolean(mcpCommand.loop);
        if (Object.keys(patch).length) timeline.set(patch);
        appliedMcpCommandRef.current = mcpCommand.requestId;
    }, [dataset, mcpCommand, selectedId, timeline]);

    useEffect(() => {
        if (!timelineState.playing || !dataset) return undefined;
        let frame;
        playRef.current = { timeUs: timeline.getSnapshot().timeUs, stamp: performance.now() };
        const tick = (stamp) => {
            const elapsedUs = (stamp - playRef.current.stamp) * 1000 * timelineState.speed;
            let next = playRef.current.timeUs + elapsedUs;
            const end = timelineState.loopEnabled ? (timelineState.selection?.endUs ?? dataset.durationUs) : dataset.durationUs;
            const start = timelineState.loopEnabled ? (timelineState.selection?.startUs ?? 0) : 0;
            if (next >= end) {
                if (timelineState.loopEnabled && end > start) {
                    next = start + ((next - start) % (end - start));
                    playRef.current = { timeUs: next, stamp };
                } else {
                    timeline.set({ timeUs: dataset.durationUs, playing: false });
                    return;
                }
            }
            timeline.set({ timeUs: next });
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [dataset, timeline, timelineState.loopEnabled, timelineState.playing, timelineState.selection?.endUs, timelineState.selection?.startUs, timelineState.speed]);

    const stepEvent = useCallback((direction) => {
        if (!dataset) return;
        const ordered = direction > 0 ? dataset.events : [...dataset.events].reverse();
        const event = ordered.find((item) => direction > 0 ? item.timeUs > timelineState.timeUs : item.timeUs < timelineState.timeUs);
        if (event) timeline.seek(event.timeUs);
    }, [dataset, timeline, timelineState.timeUs]);

    useEffect(() => {
        const keydown = (event) => {
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
            if (event.key === " ") { event.preventDefault(); timeline.togglePlaying(); }
            if (event.key === "ArrowLeft") { event.preventDefault(); timeline.seek(timeline.getSnapshot().timeUs - 16667); }
            if (event.key === "ArrowRight") { event.preventDefault(); timeline.seek(timeline.getSnapshot().timeUs + 16667); }
        };
        window.addEventListener("keydown", keydown);
        return () => window.removeEventListener("keydown", keydown);
    }, [timeline]);

    const handleImport = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setStatus("loading");
        try {
            const imported = await importLog(file);
            await refreshLogs();
            setSelectedId(imported.id);
        } catch (caught) {
            setError(caught.message);
            setStatus("error");
        }
    };

    const exactSnapshot = dataset?.snapshotAt(timelineState.timeUs) || {};
    const selectedLog = logs.find((log) => log.id === selectedId) || null;
    const entityPrefix = selectedEntity ? `vehicles.${selectedEntity}.` : null;
    const entityRows = entityPrefix ? Object.entries(exactSnapshot).filter(([path]) => path.startsWith(entityPrefix)).slice(0, 7) : [];
    const nearbyEvents = dataset?.eventsNear(timelineState.timeUs, 750000).slice(-5) || [];

    return (
        <main className="fixed inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
            <header className="relative flex h-14 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
                <div className="min-w-0">
                    <h1 className="text-[13px] font-semibold tracking-wide">Replay</h1>
                    <p className="text-[10px] text-zinc-500">Read-only state and event playback</p>
                </div>
                <div className="ml-4 flex min-w-0 flex-1 items-center gap-2">
                    <FaFolderOpen className="shrink-0 text-zinc-500" />
                    <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="h-8 min-w-0 max-w-sm flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] outline-none focus:border-sky-500">
                        <option value="">Choose a log…</option>
                        {logs.map((log) => <option key={log.id} value={log.id}>{log.name} · {formatTime(log.durationUs)}</option>)}
                    </select>
                    <button type="button" onClick={() => fileRef.current?.click()} className="workspace-button"><FaFileImport /> Import</button>
                    <input ref={fileRef} hidden type="file" accept=".sflog,application/x-sflog" onChange={handleImport} />
                </div>
                <button type="button" disabled={!dataset} onClick={() => onOpenAnalysis?.(selectedId)} className="workspace-button"><FaChartLine /> Analyze</button>
                <button type="button" disabled={!selectedLog} onClick={() => { setNameDraft(selectedLog?.name || ""); setTagsDraft((selectedLog?.tags || []).join(", ")); setDeleteArmed(false); setManageOpen((open) => !open); }} className="timeline-icon-button" aria-label="Manage log"><FaEllipsisH /></button>
                <span className="hidden text-[9px] text-zinc-600 lg:block">Esc · workspaces</span>
                {manageOpen && selectedLog && (
                    <div className="absolute right-4 top-12 z-30 w-72 rounded-xl border border-zinc-700 bg-zinc-950 p-3 shadow-2xl">
                        <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Manage log</p>
                        <div className="mt-2 space-y-1.5">
                            <input aria-label="Log name" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[10px] outline-none focus:border-sky-500" />
                            <div className="flex gap-1">
                                <input aria-label="Log tags" placeholder="Tags, comma separated" value={tagsDraft} onChange={(event) => setTagsDraft(event.target.value)} className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[10px] outline-none focus:border-sky-500" />
                                <button type="button" aria-label="Save log details" className="timeline-icon-button" onClick={async () => { try { await updateLog(selectedId, { name: nameDraft, tags: tagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean) }); await refreshLogs(); setManageOpen(false); } catch (caught) { setError(caught.message); } }}><FaCheck /></button>
                            </div>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-1.5">
                            <a href={getLogDownloadUrl(selectedId)} download className="workspace-button"><FaDownload /> Download</a>
                            <button type="button" className={`workspace-button ${deleteArmed ? "border-red-500/60 bg-red-500/15 text-red-200" : ""}`} onClick={async () => { if (!deleteArmed) { setDeleteArmed(true); return; } try { await deleteLog(selectedId); const catalog = await refreshLogs(); setManageOpen(false); setDataset(null); setSelectedId(catalog[0]?.id || ""); } catch (caught) { setError(caught.message); } }}><FaTrash /> {deleteArmed ? "Confirm delete" : "Delete"}</button>
                        </div>
                    </div>
                )}
            </header>

            <section className="relative min-h-0 flex-1">
                {dataset && <ReplayScene dataset={dataset} timeUs={timelineState.timeUs} selectedEntity={selectedEntity} onSelectEntity={setSelectedEntity} />}
                {status === "loading" && <div className="absolute inset-0 grid place-items-center bg-zinc-950"><div className="flex items-center gap-2 text-xs text-zinc-400"><FaSpinner className="animate-spin" /> Indexing log…</div></div>}
                {!dataset && status !== "loading" && <div className="absolute inset-0 grid place-items-center"><div className="max-w-sm text-center"><FaBackward className="mx-auto mb-3 text-2xl text-zinc-700" /><p className="text-sm font-medium">Select or import an SFLog</p><p className="mt-1 text-xs leading-relaxed text-zinc-500">Replay seeks from indexed checkpoints, so moving backward does not rescan the entire session.</p></div></div>}
                {error && <div className="absolute left-4 top-4 max-w-md rounded-xl border border-red-500/30 bg-red-950/80 p-3 text-[11px] text-red-100 backdrop-blur"><p className="font-semibold">Could not open this log</p><p className="mt-1 text-red-200/70">{error}</p></div>}

                {dataset && (
                    <aside className="absolute right-3 top-3 w-[290px] overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-950/82 shadow-2xl backdrop-blur-xl">
                        <div className="border-b border-zinc-800 px-3 py-2.5"><p className="text-[9px] uppercase tracking-[0.16em] text-zinc-500">At cursor</p><p className="mt-1 font-mono text-lg tabular-nums text-zinc-100">{formatTime(timelineState.timeUs)}</p></div>
                        <div className="grid grid-cols-2 divide-x divide-zinc-800 border-b border-zinc-800"><InspectorMetric label="Step" value={exactSnapshot["simulation.step"] ?? "N/A"} /><InspectorMetric label="Status" value={exactSnapshot["simulation.status"] ?? "N/A"} /></div>
                        {dataset.runManifest && <div className="border-b border-zinc-800 px-3 py-2.5"><p className="text-[9px] uppercase tracking-[0.14em] text-zinc-500">Recorded run</p><p className="mt-1 truncate text-[10px] font-semibold text-sky-200">{dataset.runManifest.name}</p><p className="mt-0.5 truncate font-mono text-[8px] text-zinc-600">{dataset.metadata.resolvedHash || dataset.resolvedRun?.resolvedHash}</p>{dataset.runResults && <p className={`mt-1 text-[9px] ${dataset.runResults.passed ? "text-emerald-300" : "text-red-300"}`}>{dataset.runResults.passed ? "Assertions passed" : "Assertions failed"} · {dataset.runResults.assertions?.length || 0} checked</p>}</div>}
                        <div className="px-3 py-2.5">
                            <p className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-zinc-500">Selected entity</p>
                            <p className="mb-2 text-xs font-semibold text-sky-200">{selectedEntity || "No vehicle state"}</p>
                            {entityRows.map(([path, value]) => <div key={path} className="flex gap-2 border-t border-zinc-800/70 py-1.5 text-[9px]"><span className="min-w-0 flex-1 truncate text-zinc-500">{path.slice(entityPrefix.length)}</span><span className="max-w-[150px] truncate font-mono text-zinc-300">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span></div>)}
                        </div>
                        <div className="border-t border-zinc-800 px-3 py-2.5"><p className="mb-1.5 text-[9px] uppercase tracking-[0.14em] text-zinc-500">Nearby events</p>{nearbyEvents.length === 0 ? <p className="text-[9px] text-zinc-600">No events within ±0.75 s</p> : nearbyEvents.map((event) => <button key={event.id || `${event.timeUs}-${event.name}`} onClick={() => timeline.seek(event.timeUs)} className="flex w-full gap-2 py-1 text-left text-[9px]"><span className="font-mono text-zinc-600">{formatTime(event.timeUs)}</span><span className="truncate text-zinc-300">{event.category} / {event.name}</span></button>)}</div>
                    </aside>
                )}
            </section>

            <footer className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-4 pb-3 pt-2.5">
                <div className="mb-2 flex items-center gap-2">
                    <button type="button" disabled={!dataset} onClick={() => timeline.togglePlaying()} className="timeline-icon-button" aria-label={timelineState.playing ? "Pause replay" : "Play replay"}>{timelineState.playing ? <FaPause /> : <FaPlay />}</button>
                    <button type="button" disabled={!dataset} onClick={() => stepEvent(-1)} className="timeline-icon-button" title="Previous event"><FaChevronLeft /></button>
                    <button type="button" disabled={!dataset} onClick={() => stepEvent(1)} className="timeline-icon-button" title="Next event"><FaChevronRight /></button>
                    <select value={timelineState.speed} onChange={(event) => timeline.set({ speed: Number(event.target.value) })} className="h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[10px] outline-none">
                        {[0.25, 0.5, 1, 2, 4].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
                    </select>
                    <button type="button" onClick={() => timeline.set({ loopEnabled: !timelineState.loopEnabled })} className={`workspace-button ${timelineState.loopEnabled ? "border-sky-500/50 bg-sky-500/15 text-sky-200" : ""}`}><FaRedo /> Loop</button>
                    <button type="button" disabled={!dataset} onClick={() => timeline.set({ selection: { ...(timelineState.selection || {}), startUs: timelineState.timeUs } })} className="workspace-button">Mark in</button>
                    <button type="button" disabled={!dataset} onClick={() => timeline.set({ selection: { ...(timelineState.selection || {}), endUs: timelineState.timeUs } })} className="workspace-button">Mark out</button>
                    <span className="ml-auto font-mono text-[11px] tabular-nums text-zinc-300">{formatTime(timelineState.timeUs)} <span className="text-zinc-600">/ {formatTime(timelineState.durationUs)}</span></span>
                </div>
                <div className="relative h-8">
                    <input aria-label="Replay timeline" type="range" min="0" max={Math.max(1, timelineState.durationUs)} step="1000" value={Math.min(timelineState.timeUs, Math.max(1, timelineState.durationUs))} disabled={!dataset} onChange={(event) => timeline.seek(Number(event.target.value))} className="timeline-range absolute inset-x-0 top-2 w-full" />
                    {dataset?.events.map((event, index) => <button key={`${event.timeUs}-${index}`} type="button" title={`${event.category}: ${event.name}`} onClick={() => timeline.seek(event.timeUs)} className="absolute top-0 h-2 w-px bg-amber-400/80" style={{ left: `${dataset.durationUs ? (event.timeUs / dataset.durationUs) * 100 : 0}%` }} />)}
                </div>
            </footer>
        </main>
    );
}

function InspectorMetric({ label, value }) {
    return <div className="px-3 py-2"><p className="text-[8px] uppercase tracking-[0.14em] text-zinc-600">{label}</p><p className="mt-0.5 truncate font-mono text-[10px] text-zinc-300">{String(value)}</p></div>;
}
