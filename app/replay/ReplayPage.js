'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    IconAdjustmentsHorizontal,
    IconChartLine,
    IconCheck,
    IconChevronLeft,
    IconChevronRight,
    IconDownload,
    IconDots,
    IconFileImport,
    IconFolderOpen,
    IconMap2,
    IconPlayerPause,
    IconPlayerPlay,
    IconRepeat,
    IconTrash,
    IconView360,
    IconX,
} from "@tabler/icons-react";
import ReplayScene from "./ReplayScene";
import SpatialLogViewer from "../spatial/SpatialLogViewer.js";
import { deleteLog, getLogDownloadUrl, importLog, listLogs, updateLog } from "../logging/LogClient.js";
import { LogDataset } from "../logging/LogDataset.js";
import { getTimelineStore } from "../logging/TimelineStore.js";
import { subscribeStorageEvents } from "../client/storageEvents.js";
import { AsyncState, Button, IconButton, NativeSelect, PopoverSurface, StatusMessage, TextInput, WorkspaceFrame, useShortcut } from "../ui";
import styles from "./ReplayPage.module.css";

function useTimeline(store, options = null) {
    const [state, setState] = useState(() => store.getSnapshot());
    const uiIntervalMs = options?.uiIntervalMs ?? 0;
    useEffect(() => store.subscribe(setState, { uiIntervalMs }), [store, uiIntervalMs]);
    return state;
}

function formatTime(timeUs) {
    const totalMs = Math.max(0, Math.round((Number(timeUs) || 0) / 1000));
    const minutes = Math.floor(totalMs / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

export default function ReplayPage({ initialLogId, mcpCommand, onOpenAnalysis, onOpenWorkspace }) {
    const timeline = useMemo(() => getTimelineStore(), []);
    const timelineState = useTimeline(timeline, { uiIntervalMs: 66 });
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
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [exactSync, setExactSync] = useState(false);
    const [viewMode, setViewMode] = useState("3d");
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

    useShortcut({
        id: "replay-playback",
        keys: ["Space", "ArrowLeft", "ArrowRight"],
        priority: 20,
        handler: (event) => {
            if (event.target instanceof Element && event.target.closest("button, a, input, select, textarea, [contenteditable], [role='button'], [role='slider'], [role='combobox']")) return false;
            if (event.key === " ") timeline.togglePlaying();
            if (event.key === "ArrowLeft") timeline.seek(timeline.getSnapshot().timeUs - 16667);
            if (event.key === "ArrowRight") timeline.seek(timeline.getSnapshot().timeUs + 16667);
        },
    });
    useShortcut({
        id: "replay-inspector-dismiss",
        keys: "Escape",
        enabled: inspectorOpen,
        priority: 30,
        handler: () => setInspectorOpen(false),
    });

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

    const simulationStep = dataset?.valueAt("simulation.step", timelineState.timeUs, { clone: false });
    const simulationStatus = dataset?.valueAt("simulation.status", timelineState.timeUs, { clone: false });
    const selectedLog = logs.find((log) => log.id === selectedId) || null;
    const entityPrefix = selectedEntity ? `vehicles.${selectedEntity}.` : null;
    const entityDescriptorPaths = useMemo(() => {
        if (!dataset || !entityPrefix) return [];
        return dataset.descriptors
            .filter((descriptor) => descriptor.path.startsWith(entityPrefix))
            .slice(0, 7)
            .map((descriptor) => descriptor.path);
    }, [dataset, entityPrefix]);
    const entityRows = useMemo(() => {
        if (!dataset || !entityDescriptorPaths.length) return [];
        return entityDescriptorPaths.map((path) => ({
            path,
            value: dataset.valueAt(path, timelineState.timeUs, { clone: false }),
        }));
    }, [dataset, entityDescriptorPaths, timelineState.timeUs]);
    const nearbyEvents = useMemo(() => {
        if (!dataset) return [];
        return dataset.eventsNear(timelineState.timeUs, 750000).slice(-5);
    }, [dataset, timelineState.timeUs]);
    const autonomySnap = useMemo(() => {
        if (!dataset || !inspectorOpen) return null;
        return dataset.autonomySnapshotAt(timelineState.timeUs, { exactSync, clone: false });
    }, [dataset, exactSync, inspectorOpen, timelineState.timeUs]);
    const eventMarkers = useMemo(() => {
        if (!dataset?.events?.length) return null;
        const durationUs = dataset.durationUs;
        return dataset.events.map((event, index) => (
            <button
                key={`${event.timeUs}-${index}`}
                type="button"
                aria-label={`${event.category}: ${event.name}`}
                onClick={() => timeline.seek(event.timeUs)}
                className={styles.eventMarker}
                style={{ left: `${durationUs ? (event.timeUs / durationUs) * 100 : 0}%` }}
            />
        ));
    }, [dataset, timeline]);

    const manageTrigger = (
        <IconButton
            label="Manage log"
            tooltip={null}
            disabled={!selectedLog}
            onClick={() => {
                setNameDraft(selectedLog?.name || "");
                setTagsDraft((selectedLog?.tags || []).join(", "));
                setDeleteArmed(false);
            }}
        >
            <IconDots size={16} stroke={1.75} />
        </IconButton>
    );

    return (
        <WorkspaceFrame
            title="Replay"
            subtitle=""
            onOpenWorkspace={onOpenWorkspace}
            contentClassName={styles.workspaceContent}
            actions={(
                <>
                    <div className={styles.logSelector}>
                        <IconFolderOpen size={15} stroke={1.75} aria-hidden="true" />
                        <div className="w-[2px]"></div>
                        <NativeSelect aria-label="Replay log" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
                            <option value="">Choose a log</option>
                            {logs.map((log) => <option key={log.id} value={log.id}>{log.name} · {formatTime(log.durationUs)}</option>)}
                        </NativeSelect>
                    </div>
                    <Button size="compact" onClick={() => fileRef.current?.click()}><IconFileImport size={15} stroke={1.75} /> Import</Button>
                    <input ref={fileRef} hidden type="file" accept=".sflog,application/x-sflog" onChange={handleImport} />
                    <Button size="compact" disabled={!dataset} onClick={() => onOpenAnalysis?.(selectedId)}><IconChartLine size={15} stroke={1.75} /> Analyze</Button>
                    <PopoverSurface trigger={manageTrigger} open={manageOpen} onOpenChange={setManageOpen} align="end" className={styles.managePopover}>
                        {selectedLog && <>
                            <h2>Manage log</h2>
                            <TextInput aria-label="Log name" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} />
                            <div className={styles.manageRow}>
                                <TextInput aria-label="Log tags" placeholder="Tags, comma separated" value={tagsDraft} onChange={(event) => setTagsDraft(event.target.value)} />
                                <IconButton label="Save log details" onClick={async () => { try { await updateLog(selectedId, { name: nameDraft, tags: tagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean) }); await refreshLogs(); setManageOpen(false); } catch (caught) { setError(caught.message); } }}><IconCheck size={16} stroke={1.75} /></IconButton>
                            </div>
                            <div className={styles.manageActions}>
                                <Button asChild size="compact"><a href={getLogDownloadUrl(selectedId)} download><IconDownload size={15} stroke={1.75} /> Download</a></Button>
                                <Button variant="danger" size="compact" onClick={async () => { if (!deleteArmed) { setDeleteArmed(true); return; } try { await deleteLog(selectedId); const catalog = await refreshLogs(); setManageOpen(false); setDataset(null); setSelectedId(catalog[0]?.id || ""); } catch (caught) { setError(caught.message); } }}><IconTrash size={15} stroke={1.75} /> {deleteArmed ? "Confirm delete" : "Delete"}</Button>
                            </div>
                        </>}
                    </PopoverSurface>
                </>
            )}
        >
            <div className={styles.replayShell}>
                <section className={styles.sceneRegion}>
                    {dataset && viewMode === "3d" && (
                        <ReplayScene
                            dataset={dataset}
                            timeline={timeline}
                            selectedEntity={selectedEntity}
                            onSelectEntity={setSelectedEntity}
                            exactSync={exactSync}
                        />
                    )}
                    {dataset && viewMode === "map" && (
                        <SpatialLogViewer
                            dataset={dataset}
                            timeUs={timelineState.timeUs}
                            timeline={timeline}
                            exactSync={exactSync}
                            primaryEntityId={selectedEntity}
                            className={styles.spatialViewer}
                        />
                    )}
                    {status === "loading" && <div className={styles.stateOverlay}><AsyncState status="loading" title="Indexing log" detail="Preparing checkpoints and event data." /></div>}
                    {!dataset && status !== "loading" && <div className={styles.stateOverlay}><AsyncState status="empty" title="Select or import an SFLog" detail="Replay seeks from indexed checkpoints, so moving backward does not rescan the session." /></div>}
                    {error && <StatusMessage className={styles.errorMessage} tone="danger" title="Could not open this log">{error}</StatusMessage>}

                    {dataset && (
                        <aside className={styles.inspector} data-open={inspectorOpen || undefined}>
                            <div className={styles.inspectorHeader}><div><p>At cursor</p><strong>{formatTime(timelineState.timeUs)}</strong></div><IconButton className={styles.compactClose} label="Close inspector" onClick={() => setInspectorOpen(false)}><IconX size={16} stroke={1.75} /></IconButton></div>
                            <div className={styles.metricGrid}><InspectorMetric label="Step" value={simulationStep ?? "N/A"} /><InspectorMetric label="Status" value={simulationStatus ?? "N/A"} /></div>
                            {dataset.runManifest && <div className={styles.inspectorSection}><p className={styles.sectionLabel}>Recorded run</p><p className={styles.emphasis}>{dataset.runManifest.name}</p><p className={styles.hash}>{dataset.metadata.resolvedHash || dataset.resolvedRun?.resolvedHash}</p>{dataset.runResults && <p className={dataset.runResults.passed ? styles.resultPassed : styles.resultFailed}>{dataset.runResults.passed ? "Assertions passed" : "Assertions failed"} · {dataset.runResults.assertions?.length || 0} checked</p>}</div>}
                            <div className={styles.inspectorSection}>
                                <p className={styles.sectionLabel}>Selected entity</p>
                                <p className={styles.emphasis}>{selectedEntity || "No vehicle state"}</p>
                                {entityRows.map(({ path, value }) => <div key={path} className={styles.dataRow}><span>{path.slice(entityPrefix.length)}</span><code>{typeof value === "object" ? JSON.stringify(value) : String(value)}</code></div>)}
                            </div>
                            <div className={styles.inspectorSection}>
                                <p className={styles.sectionLabel}>Autonomy at cursor</p>
                                <p className={styles.muted}>
                                    {exactSync ? "Exact capture sync" : "Lookback"}
                                    {autonomySnap?.ages?.perceptionNs != null
                                        ? ` · perception age ${(autonomySnap.ages.perceptionNs / 1e6).toFixed(0)} ms`
                                        : ""}
                                </p>
                                <p className={styles.emphasis}>
                                    boxes {autonomySnap?.perception?.detections3d?.length || 0}
                                    {" · "}lanes {autonomySnap?.perception?.lanes?.length || 0}
                                    {" · "}EKF {autonomySnap?.localization?.estimate ? "yes" : "no"}
                                </p>
                                {autonomySnap?.localization?.error && (
                                    <p className={styles.muted}>
                                        |err| {Number(autonomySnap.localization.error.positionM || 0).toFixed(3)} m
                                    </p>
                                )}
                            </div>
                            <div className={styles.inspectorSection}><p className={styles.sectionLabel}>Nearby events</p>{nearbyEvents.length === 0 ? <p className={styles.muted}>No events within ±0.75 s</p> : nearbyEvents.map((event, index) => <button key={`${event.id || "event"}-${event.timeUs}-${index}`} onClick={() => timeline.seek(event.timeUs)} className={styles.eventRow}><code>{formatTime(event.timeUs)}</code><span>{event.category} / {event.name}</span></button>)}</div>
                        </aside>
                    )}
                </section>

                <footer className={styles.transport}>
                    <div className={styles.transportControls}>
                        <IconButton disabled={!dataset} onClick={() => timeline.togglePlaying()} label={timelineState.playing ? "Pause replay" : "Play replay"}>{timelineState.playing ? <IconPlayerPause size={16} stroke={1.75} /> : <IconPlayerPlay size={16} stroke={1.75} />}</IconButton>
                        <IconButton disabled={!dataset} onClick={() => stepEvent(-1)} label="Previous event"><IconChevronLeft size={16} stroke={1.75} /></IconButton>
                        <IconButton disabled={!dataset} onClick={() => stepEvent(1)} label="Next event"><IconChevronRight size={16} stroke={1.75} /></IconButton>
                        <NativeSelect aria-label="Playback speed" value={timelineState.speed} onChange={(event) => timeline.set({ speed: Number(event.target.value) })} className={styles.speedSelect}>{[0.25, 0.5, 1, 2, 4].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}</NativeSelect>
                        <Button size="compact" aria-pressed={timelineState.loopEnabled} className={timelineState.loopEnabled ? styles.activeControl : undefined} onClick={() => timeline.set({ loopEnabled: !timelineState.loopEnabled })}><IconRepeat size={15} stroke={1.75} /> Loop</Button>
                        <Button size="compact" disabled={!dataset} onClick={() => timeline.set({ selection: { ...(timelineState.selection || {}), startUs: timelineState.timeUs } })}>Mark in</Button>
                        <Button size="compact" disabled={!dataset} onClick={() => timeline.set({ selection: { ...(timelineState.selection || {}), endUs: timelineState.timeUs } })}>Mark out</Button>
                        <Button size="compact" aria-pressed={exactSync} className={exactSync ? styles.activeControl : undefined} onClick={() => setExactSync((value) => !value)}>Exact sync</Button>
                        <Button size="compact" aria-pressed={viewMode === "map"} className={viewMode === "map" ? styles.activeControl : undefined} disabled={!dataset} onClick={() => setViewMode((mode) => (mode === "3d" ? "map" : "3d"))}>
                            {viewMode === "map" ? <IconMap2 size={15} stroke={1.75} /> : <IconView360 size={15} stroke={1.75} />}
                            {viewMode === "map" ? "Map" : "3D"}
                        </Button>
                        <Button size="compact" className={styles.compactInspectorButton} disabled={!dataset} onClick={() => setInspectorOpen(true)}><IconAdjustmentsHorizontal size={15} stroke={1.75} /> Inspector</Button>
                        <span className={styles.clock}>{formatTime(timelineState.timeUs)} <span>/ {formatTime(timelineState.durationUs)}</span></span>
                    </div>
                    <div className={styles.timeline}>
                        <input aria-label="Replay timeline" type="range" min="0" max={Math.max(1, timelineState.durationUs)} step="1000" value={Math.min(timelineState.timeUs, Math.max(1, timelineState.durationUs))} disabled={!dataset} onChange={(event) => timeline.seek(Number(event.target.value))} className="timeline-range" />
                        {eventMarkers}
                    </div>
                </footer>
            </div>
        </WorkspaceFrame>
    );
}

function InspectorMetric({ label, value }) {
    return <div className={styles.metric}><p>{label}</p><code>{String(value)}</code></div>;
}
