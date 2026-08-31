'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import {
    IconAdjustmentsHorizontal,
    IconBroadcast,
    IconChartLine,
    IconChevronDown,
    IconChevronRight,
    IconCircle,
    IconDownload,
    IconEyeOff,
    IconFileImport,
    IconGripVertical,
    IconList,
    IconLock,
    IconLockOpen,
    IconMovie,
    IconPlus,
    IconSearch,
    IconTable,
    IconX,
} from "@tabler/icons-react";
import UPlotGraph from "./UPlotGraph";
import { getTelemetryStore, getTelemetryTabBridge } from "../telemetry/TelemetryRuntime.js";
import { flattenNumericFields, LogDataset } from "../logging/LogDataset.js";
import { getTimelineStore } from "../logging/TimelineStore.js";
import { importLog, listLogs } from "../logging/LogClient.js";
import { storageGet, storagePut } from "../client/storageClient.js";
import { subscribeStorageEvents } from "../client/storageEvents.js";
import { downsampleMinMax } from "./downsample.js";
import { eventTypeKey, eventTypeLabel, eventTypeLabelFromKey, filterEvents } from "./eventFilters.js";
import { simulationTimeUsFromSnapshot } from "../telemetry/SimulationClock.js";
import { Button, IconButton, NativeSelect, StatusMessage, TabsContent, TabsList, TabsRoot, TabsTrigger, TextInput, WorkspaceFrame } from "../ui";
import styles from "./AnalysisPage.module.css";

const LAYOUT_KEY = "analysis:layout:v1";
const PALETTE = ["#38bdf8", "#f59e0b", "#a78bfa", "#34d399", "#fb7185", "#60a5fa", "#f472b6", "#a3e635"];
const ANALYSIS_TABS = [
    { key: "graph", name: "Graph", viewType: "graph", icon: IconChartLine },
    { key: "table", name: "Table", viewType: "table", icon: IconTable },
    { key: "events", name: "Events", viewType: "events", icon: IconCircle },
    { key: "spatial", name: "Autonomy", viewType: "spatial", icon: IconMovie },
];

function serializeLayout({ activeView, selected, liveWindow, leftWidth, rightWidth, excludedEventTypes }) {
    return {
        kind: "fusion-analysis-layout",
        version: 1,
        tabs: ANALYSIS_TABS.map(({ key, name, viewType }) => ({ id: key, name, viewType })),
        activeView,
        selected,
        liveWindow,
        leftWidth,
        rightWidth,
        excludedEventTypes,
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

export default function AnalysisPage({ initialLogId, onOpenReplay, onOpenWorkspace }) {
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
    const [excludedEventTypes, setExcludedEventTypes] = useState([]);
    const [error, setError] = useState(null);
    const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
    const [rightDrawerOpen, setRightDrawerOpen] = useState(false);
    const leftDrawerTriggerRef = useRef(null);
    const rightDrawerTriggerRef = useRef(null);
    const [graphPixelWidth, setGraphPixelWidth] = useState(1000);
    const [expandedGroups, setExpandedGroups] = useState(() => new Set([
        "devices",
        "simulation",
        "topics",
        "vehicles",
        "candidate",
        "oracle",
        "visualization",
        "diagnostics",
    ]));
    const [exactSync, setExactSync] = useState(false);

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
            dataset.loadSnapshot(timelineState.timeUs, { includeHeavy: false })
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
                if (["graph", "table", "events", "spatial"].includes(layout.activeView)) setActiveView(layout.activeView);
                if (Number.isFinite(layout.liveWindow)) setLiveWindow(layout.liveWindow);
                if (Number.isFinite(layout.leftWidth)) setLeftWidth(layout.leftWidth);
                if (Number.isFinite(layout.rightWidth)) setRightWidth(layout.rightWidth);
                if (Array.isArray(layout.excludedEventTypes)) setExcludedEventTypes(layout.excludedEventTypes);
            })
            .catch(() => {});
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        const timer = setTimeout(() => {
            storagePut(`settings/${encodeURIComponent(LAYOUT_KEY)}`, { value: serializeLayout({ activeView, selected, liveWindow, leftWidth, rightWidth, excludedEventTypes }) }).catch(() => {});
        }, 350);
        return () => clearTimeout(timer);
    }, [activeView, excludedEventTypes, leftWidth, liveWindow, rightWidth, selected]);

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
            if (descriptor.type === "bytes" || descriptor.logClass === "heavy") {
                rows.push({ descriptor, path: descriptor.path, field: "", value: undefined, numeric: false });
                continue;
            }
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
        const layout = serializeLayout({ activeView, selected, liveWindow, leftWidth, rightWidth, excludedEventTypes });
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
            setActiveView(["graph", "table", "events", "spatial"].includes(layout.activeView) ? layout.activeView : "graph");
            setLiveWindow(Number(layout.liveWindow) || 30);
            setExcludedEventTypes(Array.isArray(layout.excludedEventTypes) ? layout.excludedEventTypes : []);
        } catch (caught) { setError(caught.message); }
    };

    const signalSearch = (
        <div className={styles.searchField}>
            <IconSearch size={15} stroke={1.75} aria-hidden="true" />
            <TextInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search fields, types, units" aria-label="Search signals" />
        </div>
    );

    return (
        <WorkspaceFrame
            title="Analysis"
            subtitle=""
            onOpenWorkspace={onOpenWorkspace}
            contentClassName={styles.workspaceContent}
            actions={(
                <>
                    <div className={styles.sourceSelector}>
                        <IconBroadcast size={15} stroke={1.75} aria-hidden="true" />
                        <div className="w-[2px]"></div>
                        <NativeSelect value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} aria-label="Telemetry source">
                            <option value="live">Live · this simulator tab</option>
                            {remoteSources.map((remote) => <option key={remote.sourceId} value={`remote:${remote.sourceId}`}>Live · {remote.metadata?.environmentId || "unmanaged"} · {remote.metadata?.simulationStatus || "idle"} · {remote.sourceId.slice(-6)}</option>)}
                            {logs.map((log) => <option key={log.id} value={`log:${log.id}`}>Log · {log.name}</option>)}
                        </NativeSelect>
                    </div>
                    <Button size="compact" onClick={() => fileRef.current?.click()}><IconFileImport size={15} stroke={1.75} /> Import log</Button>
                    <input ref={fileRef} hidden type="file" accept=".sflog,application/x-sflog" onChange={handleImport} />
                    <div className="w-[2px]"></div>
                    <span className={styles.headerClock}>{formatCursor(timelineState.timeUs)}</span>
                    {sourceKey.startsWith("log:") && <Button size="compact" onClick={() => onOpenReplay?.(sourceKey.slice(4))}><IconMovie size={15} stroke={1.75} /> Replay</Button>}
                </>
            )}
        >
            <div className={styles.analysisShell}>
                {error && <StatusMessage className={styles.error} tone="danger" title="Analysis unavailable">{error}<button type="button" onClick={() => setError(null)}>Dismiss</button></StatusMessage>}
                <div className={styles.workArea}>
                    <aside className={styles.leftRail} style={{ width: leftWidth }}>
                        <div className={styles.railSearch}>{signalSearch}</div>
                        <div className={styles.railHeading}><span>Signal tree</span><span>{fieldRows.length}</span></div>
                        <SignalTree groups={groupedFields} query={query} expanded={expandedGroups} onToggle={toggleGroup} onAdd={addSignal} />
                        <ResizeHandle side="right" onDelta={(delta) => setLeftWidth((width) => Math.min(440, Math.max(210, width + delta)))} />
                    </aside>

                    <section className={styles.centerPane}>
                        <div className={styles.viewToolbar}>
                            <TabsRoot value={activeView} onValueChange={setActiveView}>
                                <TabsList aria-label="Analysis view">
                                    {ANALYSIS_TABS.map((view) => <TabsTrigger key={view.key} value={view.key}><view.icon size={14} stroke={1.75} />{view.name}</TabsTrigger>)}
                                </TabsList>
                                {ANALYSIS_TABS.map((view) => (
                                    <TabsContent key={view.key} value={view.key} forceMount className="sr-only">
                                        {view.name} view
                                    </TabsContent>
                                ))}
                            </TabsRoot>
                            <div className={styles.drawerButtons}>
                                <Button ref={leftDrawerTriggerRef} size="compact" onClick={() => setLeftDrawerOpen(true)}><IconList size={15} stroke={1.75} /> Signals</Button>
                                <Button ref={rightDrawerTriggerRef} size="compact" onClick={() => setRightDrawerOpen(true)}><IconAdjustmentsHorizontal size={15} stroke={1.75} /> Configure</Button>
                            </div>
                        </div>
                        <div className={styles.visualization} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); try { addSignal(JSON.parse(event.dataTransfer.getData("application/x-fusion-signal"))); } catch {} }}>
                            {activeView === "graph" && <UPlotGraph data={graphData} series={selected} onWidth={setGraphPixelWidth} onCursor={(timeUs) => timeline.seek(timeUs)} onUnlockLive={() => { if (isLiveSource && timeline.getSnapshot().liveLocked) timeline.set({ liveLocked: false }); }} />}
                            {activeView === "table" && <SignalTable selected={selected} samplesFor={samplesFor} timeUs={timelineState.timeUs} />}
                            {activeView === "events" && <EventView events={source.events || []} timeline={timeline} excludedTypes={excludedEventTypes} onExcludedTypesChange={setExcludedEventTypes} />}
                            {activeView === "spatial" && (
                                <AutonomySpatialView
                                    source={source}
                                    dataset={dataset}
                                    sourceKey={sourceKey}
                                    timeUs={timelineState.timeUs}
                                    exactSync={exactSync}
                                    onExactSyncChange={setExactSync}
                                    store={store}
                                />
                            )}
                        </div>
                        <div className={styles.timelinePanel}>
                            <div className={styles.timelineToolbar}>
                                <Button size="compact" aria-pressed={timelineState.liveLocked && isLiveSource} className={timelineState.liveLocked && isLiveSource ? styles.activeControl : undefined} onClick={() => { const timeUs = sourceKey === "live" ? localSimulationTimeUs(store) : isLiveSource ? source.timeUs : timelineState.durationUs; timeline.set({ timeUs, liveLocked: isLiveSource }); }}>{timelineState.liveLocked && isLiveSource ? <IconLock size={15} stroke={1.75} /> : <IconLockOpen size={15} stroke={1.75} />}{isLiveSource ? "Live" : "Cursor"}</Button>
                                {!sourceKey.startsWith("log:") && <NativeSelect value={liveWindow} onChange={(event) => setLiveWindow(Number(event.target.value))} aria-label="Live data window" className={styles.windowSelect}>{[10, 30, 60, 120].map((seconds) => <option key={seconds} value={seconds}>{seconds}s window</option>)}</NativeSelect>}
                                <span>{formatCursor(timelineState.timeUs)} / {formatCursor(timelineState.durationUs)}</span>
                            </div>
                            <input aria-label="Analysis timeline" type="range" min="0" max={Math.max(1, timelineState.durationUs)} step="1000" value={Math.min(timelineState.timeUs, Math.max(1, timelineState.durationUs))} onChange={(event) => timeline.seek(Number(event.target.value))} className="timeline-range" />
                        </div>
                    </section>

                    <aside className={styles.rightRail} style={{ width: rightWidth }}>
                        <ResizeHandle side="left" onDelta={(delta) => setRightWidth((width) => Math.min(380, Math.max(200, width - delta)))} />
                        <SignalConfiguration selected={selected} onRemove={removeSignal} onUpdate={updateSignal} onExport={exportLayout} onImport={() => layoutFileRef.current?.click()} />
                    </aside>
                </div>

                {leftDrawerOpen && <Drawer side="left" title="Signals" onClose={() => setLeftDrawerOpen(false)} restoreFocusRef={leftDrawerTriggerRef}><div className={styles.railSearch}>{signalSearch}</div><SignalTree groups={groupedFields} query={query} expanded={expandedGroups} onToggle={toggleGroup} onAdd={(row) => { addSignal(row); setLeftDrawerOpen(false); }} /></Drawer>}
                {rightDrawerOpen && <Drawer side="right" title="View configuration" onClose={() => setRightDrawerOpen(false)} restoreFocusRef={rightDrawerTriggerRef}><SignalConfiguration selected={selected} onRemove={removeSignal} onUpdate={updateSignal} onExport={exportLayout} onImport={() => layoutFileRef.current?.click()} /></Drawer>}
                <input ref={layoutFileRef} hidden type="file" accept="application/json,.json" onChange={importLayout} />
            </div>
        </WorkspaceFrame>
    );
}

function AutonomySpatialView({ source, dataset, sourceKey, timeUs, exactSync, onExactSyncChange, store }) {
    const snap = useMemo(() => {
        if (dataset && sourceKey.startsWith("log:")) {
            return dataset.autonomySnapshotAt(timeUs, { exactSync });
        }
        const candidate = store.read("visualization.perception.candidate")?.value;
        const oracle = store.read("visualization.perception.oracle")?.value;
        const localization = store.read("visualization.localization.candidate")?.value;
        const error = store.read("visualization.localization.error")?.value;
        const status = store.read("visualization.perception.status")?.value;
        const controls = store.read("visualization.controls.snapshot")?.value;
        return {
            perception: {
                ...(candidate || {}),
                oracle: oracle || { detections2d: [], detections3d: [], lanes: [] },
                status: status?.status || candidate?.status || "ok",
                ageNs: status?.ageNs ?? candidate?.ageNs ?? null,
            },
            localization: {
                ...(localization || {}),
                error,
            },
            controls: controls || null,
            ages: {
                perceptionNs: status?.ageNs ?? candidate?.ageNs ?? null,
                localizationNs: localization?.ageNs ?? null,
                controlsNs: controls?.ageNs ?? controls?.heartbeatAgeNs ?? null,
            },
        };
    }, [dataset, exactSync, sourceKey, store, timeUs, source]);

    return (
        <div className={styles.eventView}>
            <div className={styles.eventFilter}>
                <div className={styles.eventFilterControls}>
                    <Button size="compact" aria-pressed={exactSync} onClick={() => onExactSyncChange(!exactSync)}>
                        {exactSync ? "Exact sync on" : "Lookback"}
                    </Button>
                    <span className={styles.eventCount}>
                        capture-aligned · age {Number.isFinite(snap?.ages?.perceptionNs) ? `${(snap.ages.perceptionNs / 1e6).toFixed(0)} ms` : "—"}
                    </span>
                </div>
            </div>
            <div className={styles.eventList}>
                <div className={styles.eventRow}>
                    <div className={styles.eventJump}>
                        <span>Candidate 3D boxes</span>
                        <code>{snap?.perception?.detections3d?.length || 0}</code>
                        <span>2D</span>
                        <code>{snap?.perception?.detections2d?.length || 0}</code>
                    </div>
                </div>
                <div className={styles.eventRow}>
                    <div className={styles.eventJump}>
                        <span>Oracle 3D boxes</span>
                        <code>{snap?.perception?.oracle?.detections3d?.length || 0}</code>
                        <span>lanes</span>
                        <code>{(snap?.perception?.lanes?.length || 0) + (snap?.perception?.oracle?.lanes?.length || 0)}</code>
                    </div>
                </div>
                <div className={styles.eventRow}>
                    <div className={styles.eventJump}>
                        <span>EKF estimate</span>
                        <code>{snap?.localization?.estimate ? "present" : "missing"}</code>
                        <span>|err|</span>
                        <code>{snap?.localization?.error ? `${Number(snap.localization.error.positionM || 0).toFixed(3)} m` : "—"}</code>
                    </div>
                </div>
                <div className={styles.eventRow} data-testid="controls-analysis-summary">
                    <div className={styles.eventJump}>
                        <span>Controls</span>
                        <code>{snap?.controls?.mode || "—"}</code>
                        <span>req/app/ach v</span>
                        <code>
                            {Number(snap?.controls?.requested?.speedMps ?? NaN).toFixed?.(2) || "—"}/
                            {Number(snap?.controls?.applied?.speedMps ?? NaN).toFixed?.(2) || "—"}/
                            {Number(snap?.controls?.achieved?.speedMps ?? NaN).toFixed?.(2) || "—"}
                        </code>
                        <span>{snap?.controls?.flags?.timedOut ? "timeout" : snap?.controls?.flags?.saturated ? "sat" : ""}</span>
                    </div>
                </div>
                <div className={styles.eventRow}>
                    <div className={styles.eventJump}>
                        <span>Status</span>
                        <code>{snap?.perception?.status || "ok"}</code>
                        <span>{snap?.perception?.statusCode || ""}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}

function SignalTree({ groups, query, expanded, onToggle, onAdd }) {
    return (
        <div className={styles.signalTree}>
            {groups.map(([group, rows]) => {
                const open = Boolean(query) || expanded.has(group);
                return (
                    <div key={group}>
                        <button type="button" onClick={() => onToggle(group)} className={styles.groupButton} aria-expanded={open}>
                            {open ? <IconChevronDown size={14} stroke={1.75} /> : <IconChevronRight size={14} stroke={1.75} />}
                            <span>{group}</span>
                            <code>{rows.length}</code>
                        </button>
                        {open && rows.map((row) => {
                            const key = `${row.path}.${row.field}`;
                            const label = row.field ? `${row.path}.${row.field}` : row.path;
                            return (
                                <div key={key} className={styles.signalRow}>
                                    <button
                                        type="button"
                                        disabled={!row.numeric}
                                        draggable={row.numeric}
                                        onDragStart={(event) => event.dataTransfer.setData("application/x-fusion-signal", JSON.stringify(row))}
                                        onDoubleClick={() => onAdd(row)}
                                        onKeyDown={(event) => { if (event.key === "Enter") onAdd(row); }}
                                        className={styles.signalMain}
                                    >
                                        <IconGripVertical size={13} stroke={1.5} className={styles.grip} />
                                        <span className={row.numeric ? styles.numericMark : styles.valueMark} />
                                        <span className={styles.signalCopy}>
                                            <span className={styles.signalName}>{row.field ? <><span>{row.path}.</span>{row.field}</> : row.path}</span>
                                            <span className={styles.signalMeta}>{row.descriptor.type}{row.descriptor.unit ? ` · ${row.descriptor.unit}` : ""} · {formatValue(row.value)}</span>
                                        </span>
                                    </button>
                                    {row.numeric && (
                                        <IconButton type="button" onClick={() => onAdd(row)} label={`Add ${label} to graph`}><IconPlus size={14} stroke={1.75} /></IconButton>
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
    return <div className={styles.configuration}><div className={styles.configurationHeader}><p>View configuration</p><span>{selected.length} plotted series</span></div><div className={styles.configurationList}>{selected.map((item, index) => <div key={selectionKey(item)} className={styles.seriesCard}><div className={styles.seriesHeader}><input aria-label={`${item.label} color`} type="color" value={item.color} onChange={(event) => onUpdate(index, { color: event.target.value })} /><code>{item.label}</code><button type="button" onClick={() => onRemove(index)}>Remove</button></div><div className={styles.axisControl}><button type="button" aria-pressed={item.axis !== "right"} onClick={() => onUpdate(index, { axis: "left" })}>Left axis</button><button type="button" aria-pressed={item.axis === "right"} onClick={() => onUpdate(index, { axis: "right" })}>Right axis</button></div></div>)}{selected.length === 0 && <p className={styles.emptyCopy}>Add a numeric field to configure its axis and color.</p>}</div><div className={styles.configurationActions}><Button size="compact" onClick={onExport}><IconDownload size={15} stroke={1.75} /> Export</Button><Button size="compact" onClick={onImport}><IconFileImport size={15} stroke={1.75} /> Layout</Button></div></div>;
}

function Drawer({ side, title, onClose, restoreFocusRef, children }) {
    return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}><Dialog.Portal><Dialog.Overlay className={styles.drawerOverlay} /><Dialog.Content onCloseAutoFocus={(event) => { event.preventDefault(); restoreFocusRef?.current?.focus(); }} className={`${styles.drawer} ${side === "left" ? styles.drawerLeft : styles.drawerRight}`}><div className={styles.drawerHeader}><Dialog.Title>{title}</Dialog.Title><Dialog.Close asChild><IconButton label={`Close ${title}`}><IconX size={16} stroke={1.75} /></IconButton></Dialog.Close></div>{children}</Dialog.Content></Dialog.Portal></Dialog.Root>;
}

function SignalTable({ selected, samplesFor, timeUs }) {
    return <div className={styles.tableWrap}><table><thead><tr>{["Signal", "Value", "Previous", "Delta", "Unit", "Age"].map((name) => <th key={name}>{name}</th>)}</tr></thead><tbody>{selected.map((item) => { const samples = samplesFor(item); const current = valueAtSamples(samples, timeUs); const index = current ? samples.indexOf(current) : -1; const previous = index > 0 ? samples[index - 1] : null; const delta = typeof current?.value === "number" && typeof previous?.value === "number" ? current.value - previous.value : undefined; return <tr key={selectionKey(item)}><td>{item.label}</td><td>{formatValue(current?.value)}</td><td>{formatValue(previous?.value)}</td><td>{formatValue(delta)}</td><td>{item.unit || "—"}</td><td>{current ? `${Math.max(0, (timeUs - current.timeUs) / 1e6).toFixed(3)}s` : "—"}</td></tr>; })}</tbody></table>{selected.length === 0 && <div className={styles.emptyCopy}>Add signals from the field tree.</div>}</div>;
}

function EventView({ events, timeline, excludedTypes, onExcludedTypesChange }) {
    const [filter, setFilter] = useState("");
    const eventTypes = useMemo(() => [...new Map(events.map((event) => {
        const key = eventTypeKey(event);
        return [key, { key, label: eventTypeLabel(event) }];
    })).values()].sort((a, b) => a.label.localeCompare(b.label)), [events]);
    const excluded = useMemo(() => new Set(excludedTypes), [excludedTypes]);
    const availableTypes = eventTypes.filter((type) => !excluded.has(type.key));
    const visible = useMemo(() => filterEvents(events, filter, excludedTypes), [events, excludedTypes, filter]);
    const excludeType = (key) => {
        if (!key || excluded.has(key)) return;
        onExcludedTypesChange([...excludedTypes, key]);
    };
    const includeType = (key) => onExcludedTypesChange(excludedTypes.filter((type) => type !== key));
    return (
        <div className={styles.eventView}>
            <div className={styles.eventFilter}>
                <div className={styles.eventFilterControls}>
                    <TextInput value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter event category, name, severity" aria-label="Filter events" />
                    <NativeSelect value="" onChange={(event) => excludeType(event.target.value)} aria-label="Exclude an event type" disabled={availableTypes.length === 0}>
                        <option value="">{availableTypes.length > 0 ? "Exclude event type…" : "All event types excluded"}</option>
                        {availableTypes.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
                    </NativeSelect>
                    <span className={styles.eventCount}>{visible.length} / {events.length}</span>
                </div>
                {excludedTypes.length > 0 && (
                    <div className={styles.eventExclusions} aria-label="Excluded event types">
                        <span>Excluded</span>
                        {excludedTypes.map((key) => <button type="button" key={key} onClick={() => includeType(key)} aria-label={`Include ${eventTypeLabelFromKey(key)} events`}>{eventTypeLabelFromKey(key)}<IconX size={12} stroke={1.75} /></button>)}
                        <button type="button" className={styles.clearExclusions} onClick={() => onExcludedTypesChange([])}>Show all</button>
                    </div>
                )}
            </div>
            <div className={styles.eventList}>
                {visible.map((event, index) => (
                    <div key={event.id || index} className={styles.eventRow}>
                        <button type="button" className={styles.eventJump} onClick={() => timeline.seek(event.timeUs)} aria-label={`Seek to ${event.name} at ${formatCursor(event.timeUs)}`}>
                            <code>{formatCursor(event.timeUs)}</code>
                            <span>{event.category}</span>
                            <span>{event.name}</span>
                            <span>{event.severity}</span>
                        </button>
                        <IconButton type="button" className={styles.excludeEventButton} onClick={() => excludeType(eventTypeKey(event))} label={`Exclude ${eventTypeLabel(event)} events`}>
                            <IconEyeOff size={14} stroke={1.75} />
                        </IconButton>
                    </div>
                ))}
                {visible.length === 0 && <div className={styles.emptyCopy}>{events.length > 0 && excludedTypes.length > 0 ? "No events match the current filters." : "No matching events."}</div>}
            </div>
        </div>
    );
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
    return <div onPointerDown={start} className={`${styles.resizeHandle} ${side === "right" ? styles.resizeRight : styles.resizeLeft}`} role="separator" aria-orientation="vertical" />;
}
