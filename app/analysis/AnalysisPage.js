'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaBroadcastTower, FaChartLine, FaChevronDown, FaChevronRight, FaCircle, FaDownload, FaFileImport, FaFilm, FaGripVertical, FaList, FaLock, FaPlus, FaSearch, FaSlidersH, FaTable, FaTimes, FaUnlock } from "react-icons/fa";
import UPlotGraph from "./UPlotGraph";
import { getTelemetryStore, getTelemetryTabBridge } from "../telemetry/TelemetryRuntime.js";
import { flattenNumericFields, LogDataset } from "../logging/LogDataset.js";
import { getTimelineStore } from "../logging/TimelineStore.js";
import { importLog, listLogs } from "../logging/LogClient.js";
import { storageGet, storagePut } from "../client/storageClient.js";
import { subscribeStorageEvents } from "../client/storageEvents.js";
import { downsampleMinMax } from "./downsample.js";
import { simulationTimeUsFromSnapshot } from "../telemetry/SimulationClock.js";

const LAYOUT_KEY = "analysis:layout:v1";
const PALETTE = ["#38bdf8", "#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#60a5fa", "#f472b6", "#a3e635"];
const ANALYSIS_TABS = [
    { key: "graph", name: "Graph", viewType: "graph", icon: FaChartLine },
    { key: "table", name: "Table", viewType: "table", icon: FaTable },
    { key: "events", name: "Events", viewType: "events", icon: FaCircle },
];

function serializeLayout({ activeView, selected, liveWindow, leftWidth, rightWidth }) {
    return {
        kind: "fusion-analysis-layout",
        version: 1,
        tabs: ANALYSIS_TABS.map(({ key, name, viewType }) => ({ id: key, name, viewType })),
        activeView,
        selected,
        liveWindow,
        leftWidth,
        rightWidth,
    };
}

function useTimeline(store) {
    const [state, setState] = useState(() => store.getSnapshot());
    useEffect(() => store.subscribe(setState), [store]);
    return state;
}

function valueAtSamples(samples, timeUs) {
    let previous;
    for (const sample of samples || []) {
        if ((sample.timeUs || 0) > timeUs) break;
        previous = sample;
    }
    return previous;
}

function formatValue(value) {
    if (value === undefined) return "—";
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toPrecision(7).replace(/0+$/, "").replace(/\.$/, "");
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
}

function formatCursor(timeUs) {
    return `${((Number(timeUs) || 0) / 1e6).toFixed(3)} s`;
}

function localSimulationTimeUs(store) {
    return store.getSimulationTimeUs?.() ?? 0;
}

function remoteSimulationTimeUs(source) {
    return simulationTimeUsFromSnapshot(source?.snapshot) ?? 0;
}

function selectionKey(selection) { return `${selection.path}\u0000${selection.field || ""}`; }

export default function AnalysisPage({ initialLogId, onOpenReplay }) {
    const store = useMemo(() => getTelemetryStore(), []);
    const bridge = useMemo(() => getTelemetryTabBridge(), []);
    const timeline = useMemo(() => getTimelineStore(), []);
    const timelineState = useTimeline(timeline);
    const fileRef = useRef(null);
    const layoutFileRef = useRef(null);
    const sourceSelectionRef = useRef(initialLogId ? `log:${initialLogId}` : "live");
    const [revision, setRevision] = useState(0);
    const [logs, setLogs] = useState([]);
    const [remoteSources, setRemoteSources] = useState(() => bridge.getSources());
    const [sourceKey, setSourceKey] = useState(initialLogId ? `log:${initialLogId}` : "live");
    const [dataset, setDataset] = useState(null);
    const [datasetSnapshot, setDatasetSnapshot] = useState({});
    const [logSeries, setLogSeries] = useState(new Map());
    const [query, setQuery] = useState("");
    const [activeView, setActiveView] = useState("graph");
    const [selected, setSelected] = useState([]);
    const [liveWindow, setLiveWindow] = useState(30);
    const [leftWidth, setLeftWidth] = useState(280);
    const [rightWidth, setRightWidth] = useState(240);
    const [error, setError] = useState(null);
    const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
    const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
    const [graphPixelWidth, setGraphPixelWidth] = useState(1000);
    const [expandedGroups, setExpandedGroups] = useState(() => new Set(["devices", "simulation", "topics", "vehicles"]));

    const loadCatalog = useCallback(() => listLogs().then(setLogs).catch((caught) => setError(caught.message)), []);
    useEffect(() => { loadCatalog(); }, [loadCatalog]);
    useEffect(() => subscribeStorageEvents((event) => {
        if (event.domain !== "logging" || !["updated", "deleted"].includes(event.action)) return;
        loadCatalog();
        if (event.action === "deleted" && sourceKey === `log:${event.id}`) setSourceKey("live");
    }), [loadCatalog, sourceKey]);
    useEffect(() => bridge.subscribe(setRemoteSources), [bridge]);
    useEffect(() => {
        if (initialLogId) setSourceKey(`log:${initialLogId}`);
    }, [initialLogId]);
    useEffect(() => {
        let timer = null;
        const schedule = () => {
            if (timer) return;
            timer = setTimeout(() => {
                timer = null;
                setRevision((value) => value + 1);
                if (sourceKey === "live" && timeline.getSnapshot().liveLocked) {
                    const timeUs = localSimulationTimeUs(store);
                    timeline.set({ durationUs: timeUs, timeUs, liveLocked: true });
                }
            }, 100);
        };
        const paths = [...new Set(selected.map((item) => item.path))];
        const unsubscribe = store.subscribeSignals({ paths, includeEvents: true, includeCatalog: true }, schedule);
        return () => {
            unsubscribe();
            clearTimeout(timer);
        };
    }, [selected, sourceKey, store, timeline]);
    useEffect(() => {
        const changed = sourceSelectionRef.current !== sourceKey;
        sourceSelectionRef.current = sourceKey;
        const current = timeline.getSnapshot();
        if (sourceKey === "live") {
            const timeUs = localSimulationTimeUs(store);
            timeline.set({ durationUs: timeUs, timeUs: changed || current.liveLocked ? timeUs : current.timeUs, liveLocked: changed ? true : current.liveLocked, playing: false });
            return;
        }
        if (sourceKey.startsWith("remote:")) {
            const timeUs = remoteSimulationTimeUs(remoteSources.find((item) => item.sourceId === sourceKey.slice(7)));
            timeline.set({ durationUs: timeUs, timeUs: changed || current.liveLocked ? timeUs : current.timeUs, liveLocked: changed ? true : current.liveLocked, playing: false });
        }
    }, [remoteSources, sourceKey, store, timeline]);
    useEffect(() => {
        if (!sourceKey.startsWith("remote:")) return undefined;
        const sourceId = sourceKey.slice(7);
        bridge.requestSource(sourceId, selected.map((item) => item.path));
        return () => bridge.requestSource(sourceId, []);
    }, [bridge, selected, sourceKey]);
    useEffect(() => {
        if (!sourceKey.startsWith("log:")) { setDataset(null); return; }
        let cancelled = false;
        setError(null);
        LogDataset.open(sourceKey.slice(4), { eager: false })
            .then((opened) => {
                if (cancelled) return;
                setDataset(opened);
                setDatasetSnapshot({});
                setLogSeries(new Map());
                timeline.set({ durationUs: opened.durationUs, timeUs: 0, liveLocked: false, playing: false });
                opened.loadEvents({ limit: 5000 }).then(() => { if (!cancelled) setRevision((value) => value + 1); }).catch(() => {});
            })
            .catch((caught) => { if (!cancelled) setError(caught.message); });
        return () => { cancelled = true; };
    }, [sourceKey, timeline]);
    useEffect(() => {
        if (!dataset || !sourceKey.startsWith("log:")) return undefined;
        let cancelled = false;
        const timer = setTimeout(() => {
            dataset.loadSnapshot(timelineState.timeUs)
                .then((snapshot) => { if (!cancelled) setDatasetSnapshot(snapshot); })
                .catch((caught) => { if (!cancelled) setError(caught.message); });
        }, 50);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [dataset, sourceKey, timelineState.timeUs]);
    useEffect(() => {
        if (!dataset || !sourceKey.startsWith("log:")) return undefined;
        let cancelled = false;
        const maxPoints = Math.min(2000, Math.max(2, Math.floor(graphPixelWidth * 2)));
        Promise.all(selected.map(async (item) => [selectionKey(item), await dataset.loadSeries(item.path, item.field, {
            fromUs: 0,
            toUs: dataset.durationUs,
            maxPoints,
        })])).then((entries) => {
            if (!cancelled) setLogSeries(new Map(entries));
        }).catch((caught) => { if (!cancelled) setError(caught.message); });
        return () => { cancelled = true; };
    }, [dataset, graphPixelWidth, selected, sourceKey]);
    useEffect(() => {
        let cancelled = false;
        storageGet(`settings/${encodeURIComponent(LAYOUT_KEY)}`)
            .then((result) => {
                const layout = result?.value;
                if (cancelled || layout?.version !== 1) return;
                if (Array.isArray(layout.selected)) setSelected(layout.selected);
                if (["graph", "table", "events"].includes(layout.activeView)) setActiveView(layout.activeView);
                if (Number.isFinite(layout.liveWindow)) setLiveWindow(layout.liveWindow);
                if (Number.isFinite(layout.leftWidth)) setLeftWidth(layout.leftWidth);
                if (Number.isFinite(layout.rightWidth)) setRightWidth(layout.rightWidth);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        const timer = setTimeout(() => {
            storagePut(`settings/${encodeURIComponent(LAYOUT_KEY)}`, { value: serializeLayout({ activeView, selected, liveWindow, leftWidth, rightWidth }) }).catch(() => {});
        }, 350);
        return () => clearTimeout(timer);
    }, [activeView, leftWidth, liveWindow, rightWidth, selected]);

    const source = useMemo(() => {
        if (sourceKey === "live") return { descriptors: store.descriptors(), snapshot: store.snapshot({ includeHeavy: false }), events: store.events(), timeUs: localSimulationTimeUs(store), revision };
        if (sourceKey.startsWith("remote:")) {
            const remote = remoteSources.find((item) => item.sourceId === sourceKey.slice(7));
            return remote ? { ...remote, timeUs: remoteSimulationTimeUs(remote) } : { descriptors: [], snapshot: {}, events: [], timeUs: 0 };
        }
        if (dataset) return { descriptors: dataset.descriptors, snapshot: datasetSnapshot, events: dataset.events, timeUs: timelineState.timeUs };
        return { descriptors: [], snapshot: {}, events: [], timeUs: 0 };
    }, [dataset, datasetSnapshot, remoteSources, revision, sourceKey, store, timelineState.timeUs]);

    const fieldRows = useMemo(() => {
        const rows = [];
        for (const descriptor of source.descriptors || []) {
            const raw = source.snapshot?.[descriptor.path];
            const latest = raw?.value !== undefined && raw?.type ? raw.value : raw;
            const numeric = flattenNumericFields(latest);
            if (typeof latest === "number" || numeric.length === 0) rows.push({ descriptor, path: descriptor.path, field: "", value: latest, numeric: typeof latest === "number" });
            for (const child of numeric) {
                if (!child.field && typeof latest === "number") continue;
                rows.push({ descriptor, path: descriptor.path, field: child.field, value: child.value, numeric: true });
            }
        }
        const lower = query.toLowerCase();
        return rows.filter((row) => `${row.path}.${row.field} ${row.descriptor.type} ${row.descriptor.unit || ""}`.toLowerCase().includes(lower));
    }, [query, source]);

    const groupedFields = useMemo(() => {
        const groups = new Map();
        for (const row of fieldRows) {
            const group = row.path.split(".")[0] || "signals";
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(row);
        }
        return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    }, [fieldRows]);

    const toggleGroup = (group) => setExpandedGroups((current) => {
        const next = new Set(current);
        if (next.has(group)) next.delete(group);
        else next.add(group);
        return next;
    });

    const addSignal = useCallback((row) => {
        if (!row?.numeric) return;
        const next = { path: row.path, field: row.field || "", label: row.field ? `${row.path}.${row.field}` : row.path, unit: row.descriptor?.unit || null, axis: "left", color: PALETTE[selected.length % PALETTE.length], width: 1.5 };
        setSelected((current) => current.some((item) => selectionKey(item) === selectionKey(next)) ? current : [...current, next]);
    }, [selected.length]);

    const samplesFor = useCallback((item) => {
        if (dataset && sourceKey.startsWith("log:")) return logSeries.get(selectionKey(item)) || [];
        if (sourceKey === "live") return store.series(item.path).map((sample) => ({ ...sample, value: item.field ? item.field.split(".").reduce((value, key) => value?.[key], sample.value) : sample.value }));
        if (sourceKey.startsWith("remote:")) {
            return bridge.getSeries(sourceKey.slice(7), item.path).map((sample) => ({
                ...sample,
                value: item.field ? item.field.split(".").reduce((current, key) => current?.[key], sample.value) : sample.value,
            }));
        }
        const raw = source.snapshot?.[item.path];
        const value = raw?.value !== undefined ? raw.value : raw;
        return [{ timeUs: source.timeUs || 0, value: item.field ? item.field.split(".").reduce((current, key) => current?.[key], value) : value }];
    }, [bridge, dataset, logSeries, source, sourceKey, store]);

    const graphData = useMemo(() => {
        const rawSeries = selected.map(samplesFor);
        const newestTime = rawSeries.reduce((latest, samples) => Math.max(latest, samples.at(-1)?.timeUs || 0), 0);
        const windowStart = !sourceKey.startsWith("log:") && timelineState.liveLocked ? Math.max(0, newestTime - liveWindow * 1e6) : 0;
        const maxPoints = Math.min(2000, Math.max(2, Math.floor(graphPixelWidth * 2)));
        const series = rawSeries.map((samples) => downsampleMinMax(samples.filter((sample) => (sample.timeUs || 0) >= windowStart), maxPoints));
        const times = [...new Set(series.flatMap((samples) => samples.map((sample) => sample.timeUs || 0)))].sort((a, b) => a - b);
        const visibleTimes = times.filter((time) => time >= windowStart);
        return [visibleTimes.map((time) => time / 1e6), ...series.map((samples) => {
            const values = new Map(samples.map((sample) => [sample.timeUs || 0, typeof sample.value === "number" ? sample.value : null]));
            return visibleTimes.map((time) => values.get(time) ?? null);
        })];
    }, [graphPixelWidth, liveWindow, samplesFor, selected, sourceKey, timelineState.liveLocked]);

    const removeSignal = (index) => setSelected((current) => current.filter((_item, itemIndex) => itemIndex !== index));
    const updateSignal = (index, patch) => setSelected((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
    const isLiveSource = !sourceKey.startsWith("log:");

    const handleImport = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
            const imported = await importLog(file);
            await loadCatalog();
            setSourceKey(`log:${imported.id}`);
        } catch (caught) { setError(caught.message); }
    };

    const exportLayout = () => {
        const layout = serializeLayout({ activeView, selected, liveWindow, leftWidth, rightWidth });
        const url = URL.createObjectURL(new Blob([JSON.stringify(layout, null, 2)], { type: "application/json" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "analysis-layout.json";
        link.click();
        URL.revokeObjectURL(url);
    };

    const importLayout = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
            const layout = JSON.parse(await file.text());
            if (layout.kind !== "fusion-analysis-layout" || layout.version !== 1) throw new Error("Unsupported analysis layout.");
            setSelected(Array.isArray(layout.selected) ? layout.selected : []);
            setActiveView(["graph", "table", "events"].includes(layout.activeView) ? layout.activeView : "graph");
            setLiveWindow(Number(layout.liveWindow) || 30);
        } catch (caught) { setError(caught.message); }
    };

    return (
        <main className="fixed inset-0 z-10 flex min-h-0 flex-col overflow-hidden bg-zinc-950 text-zinc-100">
            <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-800 px-3">
                <div className="mr-2 min-w-0"><h1 className="text-[13px] font-semibold tracking-wide">Analysis</h1><p className="text-[10px] text-zinc-500">Live and recorded telemetry</p></div>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                    <FaBroadcastTower className={isLiveSource ? "text-emerald-400" : "text-zinc-600"} />
                    <select value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} className="h-8 min-w-0 max-w-md flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[11px] outline-none focus:border-sky-500">
                        <option value="live">Live · this simulator tab</option>
                        {remoteSources.map((remote) => <option key={remote.sourceId} value={`remote:${remote.sourceId}`}>Live · {remote.metadata?.environmentId || "unmanaged"} · {remote.metadata?.simulationStatus || "idle"} · {remote.sourceId.slice(-6)}</option>)}
                        {logs.map((log) => <option key={log.id} value={`log:${log.id}`}>Log · {log.name}</option>)}
                    </select>
                    <button type="button" className="workspace-button" onClick={() => fileRef.current?.click()}><FaFileImport /> Import log</button>
                    <input ref={fileRef} hidden type="file" accept=".sflog,application/x-sflog" onChange={handleImport} />
                </div>
                <span className="font-mono text-[11px] tabular-nums text-zinc-300">{formatCursor(timelineState.timeUs)}</span>
                {sourceKey.startsWith("log:") && <button type="button" className="workspace-button" onClick={() => onOpenReplay?.(sourceKey.slice(4))}><FaFilm /> Replay</button>}
            </header>

            {error && <button onClick={() => setError(null)} className="border-b border-red-500/30 bg-red-950/50 px-4 py-2 text-left text-[10px] text-red-200">{error} <span className="float-right text-red-300">Dismiss</span></button>}

            <div className="flex min-h-0 flex-1">
                <aside className="relative hidden shrink-0 flex-col border-r border-zinc-800 bg-zinc-950 lg:flex" style={{ width: leftWidth }}>
                    <div className="border-b border-zinc-800 p-2">
                        <div className="flex h-8 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5"><FaSearch className="text-[10px] text-zinc-500" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fields, types, units…" className="min-w-0 flex-1 bg-transparent text-[10px] outline-none" /></div>
                    </div>
                    <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2"><span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Signal tree</span><span className="text-[9px] text-zinc-600">{fieldRows.length}</span></div>
                    <SignalTree groups={groupedFields} query={query} expanded={expandedGroups} onToggle={toggleGroup} onAdd={addSignal} />
                    <ResizeHandle side="right" onDelta={(delta) => setLeftWidth((width) => Math.min(440, Math.max(210, width + delta)))} />
                </aside>

                <section className="flex min-w-0 flex-1 flex-col">
                    <div className="flex h-10 shrink-0 items-end border-b border-zinc-800 bg-zinc-950 px-2">
                        {ANALYSIS_TABS.map((view) => <button key={view.key} onClick={() => setActiveView(view.key)} className={`flex h-9 items-center gap-2 border-b-2 px-3 text-[10px] font-semibold ${activeView === view.key ? "border-sky-400 text-zinc-100" : "border-transparent text-zinc-500 hover:text-zinc-300"}`}><view.icon className="text-[9px]" />{view.name}</button>)}
                        <div className="ml-auto flex h-9 items-center gap-1">
                            <span className="lg:hidden"><button type="button" onClick={() => setLeftDrawerOpen(true)} className="workspace-button"><FaList /> Signals</button></span>
                            <span className="xl:hidden"><button type="button" onClick={() => setRightDrawerOpen(true)} className="workspace-button"><FaSlidersH /> Configure</button></span>
                        </div>
                    </div>
                    <div className="min-h-0 flex-1" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); try { addSignal(JSON.parse(event.dataTransfer.getData("application/x-fusion-signal"))); } catch {} }}>
                        {activeView === "graph" && <UPlotGraph data={graphData} series={selected} onWidth={setGraphPixelWidth} onCursor={(timeUs) => timeline.seek(timeUs)} onUnlockLive={() => { if (isLiveSource && timeline.getSnapshot().liveLocked) timeline.set({ liveLocked: false }); }} />}
                        {activeView === "table" && <SignalTable selected={selected} samplesFor={samplesFor} timeUs={timelineState.timeUs} />}
                        {activeView === "events" && <EventView events={source.events || []} timeline={timeline} />}
                    </div>
                    <div className="shrink-0 border-t border-zinc-800 px-3 py-2">
                        <div className="mb-1.5 flex items-center gap-2">
                            <button type="button" onClick={() => { const timeUs = sourceKey === "live" ? localSimulationTimeUs(store) : isLiveSource ? source.timeUs : timelineState.durationUs; timeline.set({ timeUs, liveLocked: isLiveSource }); }} className={`workspace-button ${timelineState.liveLocked && isLiveSource ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200" : ""}`}>{timelineState.liveLocked && isLiveSource ? <FaLock /> : <FaUnlock />}{isLiveSource ? "Live" : "Cursor"}</button>
                            {!sourceKey.startsWith("log:") && <select value={liveWindow} onChange={(event) => setLiveWindow(Number(event.target.value))} className="h-8 rounded-lg border border-zinc-700 bg-zinc-900 px-2 text-[10px] outline-none">{[10, 30, 60, 120].map((seconds) => <option key={seconds} value={seconds}>{seconds}s window</option>)}</select>}
                            <span className="ml-auto font-mono text-[10px] text-zinc-500">{formatCursor(timelineState.timeUs)} / {formatCursor(timelineState.durationUs)}</span>
                        </div>
                        <input aria-label="Analysis timeline" type="range" min="0" max={Math.max(1, timelineState.durationUs)} step="1000" value={Math.min(timelineState.timeUs, Math.max(1, timelineState.durationUs))} onChange={(event) => timeline.seek(Number(event.target.value))} className="timeline-range w-full" />
                    </div>
                </section>

                <aside className="relative hidden shrink-0 flex-col border-l border-zinc-800 bg-zinc-950 xl:flex" style={{ width: rightWidth }}>
                    <ResizeHandle side="left" onDelta={(delta) => setRightWidth((width) => Math.min(380, Math.max(200, width - delta)))} />
                    <SignalConfiguration selected={selected} onRemove={removeSignal} onUpdate={updateSignal} onExport={exportLayout} onImport={() => layoutFileRef.current?.click()} />
                </aside>
            </div>

            {leftDrawerOpen && <Drawer side="left" title="Signals" onClose={() => setLeftDrawerOpen(false)}><div className="border-b border-zinc-800 p-2"><div className="flex h-8 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5"><FaSearch className="text-[10px] text-zinc-500" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fields, types, units…" className="min-w-0 flex-1 bg-transparent text-[10px] outline-none" /></div></div><SignalTree groups={groupedFields} query={query} expanded={expandedGroups} onToggle={toggleGroup} onAdd={(row) => { addSignal(row); setLeftDrawerOpen(false); }} /></Drawer>}
            {rightDrawerOpen && <Drawer side="right" title="View configuration" onClose={() => setRightDrawerOpen(false)}><SignalConfiguration selected={selected} onRemove={removeSignal} onUpdate={updateSignal} onExport={exportLayout} onImport={() => layoutFileRef.current?.click()} /></Drawer>}
            <input ref={layoutFileRef} hidden type="file" accept="application/json,.json" onChange={importLayout} />
        </main>
    );
}

function SignalTree({ groups, query, expanded, onToggle, onAdd }) {
    return (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
            {groups.map(([group, rows]) => {
                const open = Boolean(query) || expanded.has(group);
                return (
                    <div key={group}>
                        <button type="button" onClick={() => onToggle(group)} className="flex w-full items-center gap-2 border-b border-zinc-900 px-2.5 py-2 text-left text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300">
                            {open ? <FaChevronDown className="text-[8px]" /> : <FaChevronRight className="text-[8px]" />}
                            <span className="flex-1">{group}</span>
                            <span className="font-mono text-[8px] text-zinc-700">{rows.length}</span>
                        </button>
                        {open && rows.map((row) => {
                            const key = `${row.path}.${row.field}`;
                            const label = row.field ? `${row.path}.${row.field}` : row.path;
                            return (
                                <div key={key} className="group flex w-full items-center gap-1 px-2 py-1 pl-4 hover:bg-zinc-900 focus-within:bg-zinc-900">
                                    <button
                                        type="button"
                                        disabled={!row.numeric}
                                        draggable={row.numeric}
                                        onDragStart={(event) => event.dataTransfer.setData("application/x-fusion-signal", JSON.stringify(row))}
                                        onDoubleClick={() => onAdd(row)}
                                        onKeyDown={(event) => { if (event.key === "Enter") onAdd(row); }}
                                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus:outline-none disabled:cursor-default"
                                    >
                                        <FaGripVertical className="text-[8px] text-zinc-800 group-hover:text-zinc-600" />
                                        <span className={`h-1.5 w-1.5 rounded-full ${row.numeric ? "bg-sky-400" : "bg-zinc-700"}`} />
                                        <span className="min-w-0 flex-1">
                                            <span className="block truncate font-mono text-[9px] text-zinc-300">{row.field ? <><span className="text-zinc-600">{row.path}.</span>{row.field}</> : row.path}</span>
                                            <span className="block truncate text-[8px] text-zinc-600">{row.descriptor.type}{row.descriptor.unit ? ` · ${row.descriptor.unit}` : ""} · {formatValue(row.value)}</span>
                                        </span>
                                    </button>
                                    {row.numeric && (
                                        <button type="button" onClick={() => onAdd(row)} aria-label={`Add ${label} to graph`} title={`Add ${label} to graph`} className="grid h-6 w-6 shrink-0 place-items-center rounded text-zinc-700 hover:bg-sky-500/10 hover:text-sky-300 focus:outline-none focus:ring-1 focus:ring-sky-500/60">
                                            <FaPlus className="text-[8px]" />
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                );
            })}
        </div>
    );
}

function SignalConfiguration({ selected, onRemove, onUpdate, onExport, onImport }) {
    return <><div className="border-b border-zinc-800 px-3 py-3"><p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-zinc-500">View configuration</p><p className="mt-1 text-[9px] text-zinc-600">{selected.length} plotted series</p></div><div className="min-h-0 flex-1 overflow-y-auto">{selected.map((item, index) => <div key={selectionKey(item)} className="border-b border-zinc-800 p-3"><div className="flex items-start gap-2"><input aria-label={`${item.label} color`} type="color" value={item.color} onChange={(event) => onUpdate(index, { color: event.target.value })} className="mt-0.5 h-4 w-4 cursor-pointer rounded border-0 bg-transparent p-0" /><span className="min-w-0 flex-1 break-all font-mono text-[9px] leading-relaxed text-zinc-300">{item.label}</span><button onClick={() => onRemove(index)} className="text-[9px] text-zinc-600 hover:text-red-300">Remove</button></div><div className="mt-2 flex gap-1"><button onClick={() => onUpdate(index, { axis: "left" })} className={`flex-1 rounded-md border px-2 py-1 text-[8px] ${item.axis !== "right" ? "border-sky-500/40 text-sky-200" : "border-zinc-800 text-zinc-600"}`}>Left axis</button><button onClick={() => onUpdate(index, { axis: "right" })} className={`flex-1 rounded-md border px-2 py-1 text-[8px] ${item.axis === "right" ? "border-sky-500/40 text-sky-200" : "border-zinc-800 text-zinc-600"}`}>Right axis</button></div></div>)}{selected.length === 0 && <p className="px-4 py-8 text-center text-[10px] leading-relaxed text-zinc-600">Add a numeric field to configure its axis and color.</p>}</div><div className="grid grid-cols-2 gap-1 border-t border-zinc-800 p-2"><button className="workspace-button" onClick={onExport}><FaDownload /> Export</button><button className="workspace-button" onClick={onImport}><FaFileImport /> Layout</button></div></>;
}

function Drawer({ side, title, onClose, children }) {
    return <div className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className={`absolute bottom-0 top-14 flex w-[min(340px,88vw)] flex-col border-zinc-700 bg-zinc-950 shadow-2xl ${side === "left" ? "left-0 border-r" : "right-0 border-l"}`}><div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 px-3"><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-400">{title}</p><button type="button" onClick={onClose} className="timeline-icon-button" aria-label={`Close ${title}`}><FaTimes /></button></div>{children}</aside></div>;
}

function SignalTable({ selected, samplesFor, timeUs }) {
    return <div className="h-full overflow-auto"><table className="w-full border-collapse text-left text-[10px]"><thead className="sticky top-0 bg-zinc-950 text-[8px] uppercase tracking-[0.13em] text-zinc-600"><tr>{["Signal", "Value", "Previous", "Delta", "Unit", "Age"].map((name) => <th key={name} className="border-b border-zinc-800 px-3 py-2 font-semibold">{name}</th>)}</tr></thead><tbody>{selected.map((item) => { const samples = samplesFor(item); const current = valueAtSamples(samples, timeUs); const index = current ? samples.indexOf(current) : -1; const previous = index > 0 ? samples[index - 1] : null; const delta = typeof current?.value === "number" && typeof previous?.value === "number" ? current.value - previous.value : undefined; return <tr key={selectionKey(item)} className="border-b border-zinc-900 hover:bg-zinc-900/60"><td className="max-w-sm px-3 py-2 font-mono text-zinc-300">{item.label}</td><td className="px-3 py-2 font-mono text-zinc-100">{formatValue(current?.value)}</td><td className="px-3 py-2 font-mono text-zinc-500">{formatValue(previous?.value)}</td><td className="px-3 py-2 font-mono text-zinc-400">{formatValue(delta)}</td><td className="px-3 py-2 text-zinc-500">{item.unit || "—"}</td><td className="px-3 py-2 font-mono text-zinc-500">{current ? `${Math.max(0, (timeUs - current.timeUs) / 1e6).toFixed(3)}s` : "—"}</td></tr>; })}</tbody></table>{selected.length === 0 && <div className="grid h-48 place-items-center text-[10px] text-zinc-600">Add signals from the field tree.</div>}</div>;
}

function EventView({ events, timeline }) {
    const [filter, setFilter] = useState("");
    const visible = events.filter((event) => `${event.category} ${event.name} ${event.severity}`.toLowerCase().includes(filter.toLowerCase()));
    return <div className="flex h-full min-h-0 flex-col"><div className="border-b border-zinc-800 p-2"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter event category, name, severity…" className="h-8 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-[10px] outline-none focus:border-sky-500" /></div><div className="min-h-0 flex-1 overflow-auto">{visible.map((event, index) => <button key={event.id || index} onClick={() => timeline.seek(event.timeUs)} className="grid w-full grid-cols-[90px_100px_1fr_80px] gap-3 border-b border-zinc-900 px-3 py-2 text-left text-[10px] hover:bg-zinc-900"><span className="font-mono text-zinc-600">{formatCursor(event.timeUs)}</span><span className="truncate text-sky-300">{event.category}</span><span className="truncate text-zinc-300">{event.name}</span><span className="text-zinc-600">{event.severity}</span></button>)}{visible.length === 0 && <div className="grid h-48 place-items-center text-[10px] text-zinc-600">No matching events.</div>}</div></div>;
}

function ResizeHandle({ side, onDelta }) {
    const start = (event) => {
        event.preventDefault();
        let last = event.clientX;
        const move = (moveEvent) => { const delta = moveEvent.clientX - last; last = moveEvent.clientX; onDelta(delta); };
        const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", stop);
    };
    return <div onPointerDown={start} className={`absolute bottom-0 top-0 z-20 w-1 cursor-col-resize hover:bg-sky-500/50 ${side === "right" ? "right-0" : "left-0"}`} />;
}
