'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    DownloadSimple,
    Gauge,
    MagnifyingGlass,
    Play,
    Queue,
    SpinnerGap,
    Stop,
    TerminalWindow,
} from "@phosphor-icons/react";

import { listExperimentSuites } from "../../experiments/ExperimentClient.js";
import { subscribeStorageEvents } from "../../client/storageEvents.js";
import {
    cancelHeadlessRun,
    enqueueHeadlessRun,
    getHeadlessCapabilities,
    getHeadlessRun,
    headlessArtifactUrl,
    listHeadlessRuns,
    preflightHeadlessRun,
} from "../HeadlessClient.js";
import {
    AsyncState,
    Button,
    DialogSurface,
    Field,
    NativeSelect,
    StatusMessage,
    TextInput,
    WorkspaceFrame,
    pickLastOpenCatalogId,
    readLastOpenWorkspaceId,
    writeLastOpenWorkspaceId,
} from "../../ui";
import styles from "./HeadlessWorkspace.module.css";

const ICON = { size: 14, weight: "regular" };

function displayStatus(result) {
    if (!result) return "unknown";
    if (result.status === "pending") return "Queued";
    if (result.status === "running") return "Running";
    if (result.status === "paused") return "Paused";
    if (result.status === "completed") return "Completed";
    if (result.status === "cancelled") return "Cancelled";
    if (result.status === "interrupted") return "Interrupted";
    if (result.status === "error") return "Error";
    return result.status;
}

function statusTone(result) {
    const label = displayStatus(result);
    if (label === "Running") return "running";
    if (label === "Queued" || label === "Paused") return "queued";
    if (label === "Completed") return "success";
    return "danger";
}

function progressFraction(result) {
    const cases = result?.cases ?? [];
    if (cases.length === 0) return 0;
    const terminal = cases.filter((entry) => !["pending", "running"].includes(entry.status)).length;
    return terminal / cases.length;
}

function createRunNickname(suiteId) {
    const token = globalThis.crypto?.randomUUID?.().slice(0, 8)
        ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return `${String(suiteId || "suite").trim()}-headless-${token}`;
}

function formatBytes(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    if (n < 1024) return `${Math.round(n)} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function CatalogGroup({ label, items, selectedId, onSelect }) {
    if (!items.length) return null;
    return (
        <div className={styles.catalogGroup}>
            <div className={styles.catalogGroupLabel}>{label}</div>
            {items.map((entry, index) => (
                <button
                    key={entry.id}
                    type="button"
                    className={styles.catalogItem}
                    data-active={entry.id === selectedId || undefined}
                    aria-current={entry.id === selectedId ? "true" : undefined}
                    onClick={() => onSelect(entry.id)}
                >
                    <span className={styles.catalogOrdinal}>
                        {entry.queuePosition ? `#${entry.queuePosition}` : String(index + 1).padStart(2, "0")}
                    </span>
                    <span className={styles.catalogCopy}>
                        <span className={styles.catalogTitle}>{entry.id}</span>
                        <small>{displayStatus(entry)} · {entry.suiteId}</small>
                    </span>
                </button>
            ))}
        </div>
    );
}

export default function HeadlessWorkspace({
    onOpenWorkspace,
    onOpenReplay,
    onOpenAnalysis,
    preselectedSuiteId = null,
}) {
    const [loadState, setLoadState] = useState("loading");
    const [error, setError] = useState(null);
    const [capabilities, setCapabilities] = useState(null);
    const [catalog, setCatalog] = useState({ runs: [], recent: [], queue: null, liveHealth: null });
    const [suites, setSuites] = useState([]);
    const [selectedId, setSelectedId] = useState(null);
    const [detail, setDetail] = useState(null);
    const [filter, setFilter] = useState("");
    const [launchOpen, setLaunchOpen] = useState(Boolean(preselectedSuiteId));
    const [launchSuiteId, setLaunchSuiteId] = useState(preselectedSuiteId || "");
    const [launchNickname, setLaunchNickname] = useState("");
    const [launchFailFast, setLaunchFailFast] = useState("inherit");
    const [launchArtifactProfile, setLaunchArtifactProfile] = useState("evaluation");
    const [preflight, setPreflight] = useState(null);
    const [preflightError, setPreflightError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [cancelOpen, setCancelOpen] = useState(false);
    const [inspectorOpen, setInspectorOpen] = useState(false);
    const [announcement, setAnnouncement] = useState("");
    const refreshTimer = useRef(null);
    const selectedIdRef = useRef(null);

    const openLaunch = useCallback((suiteId = launchSuiteId || preselectedSuiteId || "") => {
        setLaunchSuiteId(suiteId || "");
        setLaunchOpen(true);
        setInspectorOpen(false);
    }, [launchSuiteId, preselectedSuiteId]);

    const refreshCatalog = useCallback(async (options = {}) => {
        try {
            const [caps, payload, suiteList] = await Promise.all([
                getHeadlessCapabilities(),
                listHeadlessRuns(),
                listExperimentSuites(),
            ]);
            setCapabilities(caps);
            setCatalog({
                runs: payload?.runs || [],
                recent: payload?.recent || [],
                queue: payload?.queue ?? null,
                liveHealth: payload?.liveHealth ?? null,
            });
            setSuites(Array.isArray(suiteList) ? suiteList : suiteList?.suites || []);
            setLoadState("ready");
            setError(null);
            if (!selectedIdRef.current && !options.preserveSelection) {
                const ids = [...(payload.runs || []), ...(payload.recent || [])];
                const first = pickLastOpenCatalogId(ids, readLastOpenWorkspaceId("headless-runs"));
                if (first) setSelectedId(first);
            }
            return payload;
        } catch (refreshError) {
            setLoadState("error");
            setError(refreshError.message);
            throw refreshError;
        }
    }, []);

    const refreshDetail = useCallback(async (resultId) => {
        if (!resultId) {
            setDetail(null);
            return;
        }
        const payload = await getHeadlessRun(resultId);
        setDetail(payload.result);
    }, []);

    useEffect(() => {
        selectedIdRef.current = selectedId;
        if (selectedId) writeLastOpenWorkspaceId("headless-runs", selectedId);
    }, [selectedId]);

    useEffect(() => {
        refreshCatalog().catch(() => {});
    }, [refreshCatalog]);

    useEffect(() => {
        if (!selectedId) {
            setDetail(null);
            return;
        }
        refreshDetail(selectedId).catch((detailError) => setError(detailError.message));
    }, [selectedId, refreshDetail]);

    useEffect(() => {
        if (!launchSuiteId) {
            setPreflight(null);
            setPreflightError(null);
            return;
        }
        setLaunchNickname((current) => {
            const prefix = `${launchSuiteId}-headless-`;
            if (!current || current.startsWith(prefix) === false) return createRunNickname(launchSuiteId);
            return current;
        });
        setPreflight(null);
        setPreflightError(null);
        let cancelled = false;
        preflightHeadlessRun({
            suiteId: launchSuiteId,
            artifactProfile: launchArtifactProfile,
        }).then((summary) => {
            if (!cancelled) setPreflight(summary);
        }).catch((preflightFailure) => {
            if (cancelled) return;
            setPreflight(null);
            setPreflightError(preflightFailure.message);
        });
        return () => {
            cancelled = true;
        };
    }, [launchSuiteId, launchArtifactProfile]);

    useEffect(() => {
        return subscribeStorageEvents((event) => {
            if (!["experiment-result", "headless-queue", "headless-runtime"].includes(event.domain)) return;
            refreshCatalog({ preserveSelection: true })
                .then(() => {
                    if (selectedIdRef.current) refreshDetail(selectedIdRef.current);
                })
                .catch(() => {});
            if (event.domain === "experiment-result" && event.data?.status) {
                setAnnouncement(`Run ${event.id} is now ${event.data.status}.`);
            }
        });
    }, [refreshCatalog, refreshDetail]);

    useEffect(() => {
        const active = catalog.runs.find((entry) => entry.status === "running");
        if (!active) return undefined;
        refreshTimer.current = window.setInterval(() => {
            refreshCatalog({ preserveSelection: true })
                .then(() => refreshDetail(active.id))
                .catch(() => {});
        }, 3000);
        return () => window.clearInterval(refreshTimer.current);
    }, [catalog.runs, refreshCatalog, refreshDetail]);

    const filteredRuns = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        const match = (entry) => !needle
            || entry.id.toLowerCase().includes(needle)
            || entry.suiteId?.toLowerCase().includes(needle);
        const active = catalog.runs.filter((entry) => ["running", "paused"].includes(entry.status)).filter(match);
        const queued = catalog.runs.filter((entry) => entry.status === "pending").filter(match);
        const recent = catalog.recent.filter(match);
        return { active, queued, recent };
    }, [catalog.recent, catalog.runs, filter]);

    const selected = detail || catalog.runs.find((entry) => entry.id === selectedId)
        || catalog.recent.find((entry) => entry.id === selectedId)
        || null;

    const liveHealth = selected?.liveHealth || catalog.liveHealth;
    const canCancel = selected && ["pending", "running", "paused"].includes(selected.status);
    const runCount = (catalog.runs?.length || 0) + (catalog.recent?.length || 0);
    const hasCatalogItems = filteredRuns.active.length || filteredRuns.queued.length || filteredRuns.recent.length;
    const rssCap = capabilities?.safetyLimits?.maxRssBytesPerEnvironment;

    async function submitLaunch() {
        if (!launchSuiteId || !launchNickname.trim()) return;
        setSubmitting(true);
        try {
            const payload = await enqueueHeadlessRun({
                suiteId: launchSuiteId,
                resultId: launchNickname.trim(),
                expectedRevision: preflight?.revision,
                failFast: launchFailFast === "inherit" ? undefined : launchFailFast === "true",
                artifactProfile: launchArtifactProfile,
            });
            setLaunchOpen(false);
            setSelectedId(payload.resultId);
            setAnnouncement(`Queued headless run ${payload.resultId}.`);
            await refreshCatalog({ preserveSelection: true });
            await refreshDetail(payload.resultId);
        } catch (submitError) {
            setPreflightError(submitError.message);
        } finally {
            setSubmitting(false);
        }
    }

    async function confirmCancel() {
        if (!selected?.id) return;
        setSubmitting(true);
        try {
            await cancelHeadlessRun(selected.id);
            setCancelOpen(false);
            setAnnouncement(`Cancelled headless run ${selected.id}.`);
            await refreshCatalog({ preserveSelection: true });
            await refreshDetail(selected.id);
        } catch (cancelError) {
            setError(cancelError.message);
        } finally {
            setSubmitting(false);
        }
    }

    const sidebar = (
        <div className={styles.catalog}>
            <header>
                <div>
                    <span>Queue</span>
                    <strong>{runCount} run{runCount === 1 ? "" : "s"}</strong>
                </div>
                <Button size="compact" variant="primary" onClick={() => openLaunch()}>
                    <Play {...ICON} aria-hidden="true" />
                    Launch
                </Button>
            </header>
            <label className={styles.search}>
                <MagnifyingGlass size={14} weight="regular" aria-hidden="true" />
                <span className={styles.srOnly}>Filter runs</span>
                <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Search by id or suite" />
            </label>
            <nav className={styles.runList} aria-label="Headless runs">
                <CatalogGroup label="Active" items={filteredRuns.active} selectedId={selectedId} onSelect={setSelectedId} />
                <CatalogGroup label="Queued" items={filteredRuns.queued} selectedId={selectedId} onSelect={setSelectedId} />
                <CatalogGroup label="Recent" items={filteredRuns.recent} selectedId={selectedId} onSelect={setSelectedId} />
                {!hasCatalogItems && loadState === "ready" && (
                    <div className={styles.catalogEmpty}>
                        <strong>{filter.trim() ? "No matching runs" : "No headless runs yet"}</strong>
                        <p>{filter.trim() ? "Try another search." : "Launch a saved experiment suite to enqueue the first run."}</p>
                    </div>
                )}
            </nav>
        </div>
    );

    const inspector = selected ? (
        <aside className={styles.inspector} data-open={inspectorOpen || undefined} aria-label="Host inspector">
            <h3>Host</h3>
            <div className={styles.inspectorGrid}>
                <div className={styles.inspectorRow}>
                    <span className={styles.inspectorLabel}>Readiness</span>
                    <span>{capabilities?.ready ? "Ready" : "Unavailable"} · {capabilities?.platform || "—"}/{capabilities?.architecture || "—"}</span>
                </div>
                <div className={styles.inspectorRow}>
                    <span className={styles.inspectorLabel}>Worker</span>
                    <span>{liveHealth?.workerPid ? `PID ${liveHealth.workerPid}` : "Idle"} · {liveHealth?.supervisor?.state ?? liveHealth?.pumpState ?? "—"}</span>
                </div>
                <div className={styles.inspectorRow}>
                    <span className={styles.inspectorLabel}>Memory</span>
                    <span>RSS {formatBytes(liveHealth?.supervisor?.rssBytes)} · Heap {formatBytes(liveHealth?.supervisor?.heapBytes)}</span>
                </div>
                <div className={styles.inspectorRow}>
                    <span className={styles.inspectorLabel}>Step / queue</span>
                    <span>Step {liveHealth?.supervisor?.lastCompletedStep ?? "—"} · {formatBytes(liveHealth?.supervisor?.queueBytes)}</span>
                </div>
                <div className={styles.inspectorRow}>
                    <span className={styles.inspectorLabel}>Limits</span>
                    <span>RSS cap {formatBytes(rssCap)} · 1 active case</span>
                </div>
                <div className={styles.inspectorRow}>
                    <span className={styles.inspectorLabel}>Job</span>
                    <span>{selected.execution?.jobId ?? "—"}</span>
                </div>
                <div className={styles.inspectorRow}>
                    <span className={styles.inspectorLabel}>Revision</span>
                    <span>{selected.revision ?? "—"}</span>
                </div>
            </div>
        </aside>
    ) : null;

    let main = null;
    if (loadState === "loading") {
        main = (
            <div className={styles.overview}>
                <div className={styles.skeleton} style={{ height: 22, width: "42%" }} />
                <div className={styles.skeleton} style={{ height: 3, width: "100%" }} />
                <div className={styles.skeleton} style={{ height: 160, width: "100%" }} />
            </div>
        );
    } else if (loadState === "error") {
        main = (
            <div className={styles.centerState}>
                <AsyncState status="error" title="Could not load headless runs" detail={error} onRetry={() => refreshCatalog()} />
            </div>
        );
    } else if (capabilities && capabilities.ready === false) {
        main = (
            <div className={styles.centerState}>
                <AsyncState status="error" title="Headless queue unavailable" detail="The server is not ready to accept managed experiment runs." />
            </div>
        );
    } else if (!selected) {
        main = (
            <div className={styles.emptyHero}>
                <h2>Select or launch a headless run</h2>
                <p>Queue a saved experiment suite. The server runs one isolated case at a time.</p>
                <Button size="compact" variant="primary" onClick={() => openLaunch()}>
                    <Play {...ICON} aria-hidden="true" />
                    Queue a suite
                </Button>
            </div>
        );
    } else {
        const artifacts = (selected.cases ?? []).flatMap((entry, index) => (
            (entry.artifacts ?? [])
                .filter((artifact) => artifact.name !== "run.sflog")
                .map((artifact) => ({ entry, index, artifact }))
        ));
        main = (
            <div className={styles.overview}>
                <header className={styles.overviewHeader}>
                    <div>
                        <span className={styles.sectionKicker}>Headless run</span>
                        <h2>{selected.id}</h2>
                        <p>
                            {selected.suiteId} · {selected.summary?.passed ?? 0} passed · {selected.summary?.failed ?? 0} failed · {selected.cases?.length ?? 0} cases
                        </p>
                    </div>
                    <div className={styles.overviewActions}>
                        {canCancel && (
                            <Button size="compact" variant="danger" onClick={() => setCancelOpen(true)}>
                                <Stop {...ICON} aria-hidden="true" />
                                Cancel run
                            </Button>
                        )}
                        {(selected.cases ?? []).map((entry) => entry.logId ? (
                            <Button key={entry.logId} size="compact" onClick={() => onOpenReplay?.(entry.logId)}>
                                <TerminalWindow {...ICON} aria-hidden="true" />
                                Replay {entry.id}
                            </Button>
                        ) : null)}
                        {(selected.cases ?? []).map((entry) => entry.logId ? (
                            <Button key={`${entry.logId}-analysis`} size="compact" onClick={() => onOpenAnalysis?.(entry.logId)}>
                                <Gauge {...ICON} aria-hidden="true" />
                                Analyze {entry.id}
                            </Button>
                        ) : null)}
                        {artifacts.map(({ entry, index, artifact }) => (
                            <Button key={`${entry.id}-${artifact.name}`} asChild size="compact">
                                <a href={headlessArtifactUrl(selected.id, index, artifact.name)} download={artifact.name}>
                                    <DownloadSimple {...ICON} aria-hidden="true" />
                                    {artifact.name}
                                </a>
                            </Button>
                        ))}
                    </div>
                </header>
                <div className={styles.metaRow}>
                    <span className={styles.statusBadge} data-tone={statusTone(selected)}>{displayStatus(selected)}</span>
                    {selected.queuePosition ? <span>Queue #{selected.queuePosition}</span> : null}
                    <span>{Math.round(progressFraction(selected) * 100)}% cases finished</span>
                </div>
                <div className={styles.progressBlock}>
                    <div className={styles.progressLine} aria-hidden="true">
                        <span
                            className={styles.progressFill}
                            data-active={selected.status === "running" || undefined}
                            style={{ "--progress": progressFraction(selected) }}
                        />
                    </div>
                </div>
                <div className={styles.caseList}>
                    {(selected.cases ?? []).map((entry, index) => (
                        <div key={entry.id || index} className={styles.caseRow}>
                            <div>
                                <strong>{entry.id}</strong>
                                <p>{entry.scenarioId} · {entry.manifestId} · seed {String(entry.seed)}</p>
                                {entry.failureReason && <p data-tone="danger">{entry.failureReason}</p>}
                            </div>
                            <span className={styles.statusBadge} data-tone={statusTone({ status: entry.status })}>{entry.status}</span>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <WorkspaceFrame
            className={styles.workspace}
            contentClassName={styles.workspaceContent}
            title="Headless Runs"
            subtitle="Server queue"
            onOpenWorkspace={onOpenWorkspace}
            actions={(
                <>
                    {selected && (
                        <Button
                            size="compact"
                            className={styles.inspectorToggle}
                            aria-pressed={inspectorOpen}
                            onClick={() => setInspectorOpen((open) => !open)}
                        >
                            Host
                        </Button>
                    )}
                    <Button size="compact" variant="primary" onClick={() => openLaunch()}>
                        <Play {...ICON} aria-hidden="true" />
                        Launch suite
                    </Button>
                </>
            )}
            sidebar={sidebar}
        >
            <div aria-live="polite" className={styles.liveRegion}>{announcement}</div>
            <div className={styles.shell} data-inspector={selected ? true : undefined}>
                <div className={styles.detail}>{main}</div>
                {inspectorOpen && selected && (
                    <button type="button" className={styles.inspectorScrim} aria-label="Close host inspector" onClick={() => setInspectorOpen(false)} />
                )}
                {inspector}
            </div>
            <DialogSurface
                open={launchOpen}
                onOpenChange={setLaunchOpen}
                title="Queue headless run"
                description="Admit a saved experiment suite into the server FIFO. One isolated case runs at a time."
                footer={(
                    <>
                        <Button size="compact" onClick={() => setLaunchOpen(false)}>Cancel</Button>
                        <Button
                            size="compact"
                            variant="primary"
                            disabled={submitting || !launchSuiteId || !launchNickname.trim() || !preflight || Boolean(preflightError)}
                            onClick={submitLaunch}
                        >
                            {submitting ? <SpinnerGap {...ICON} aria-hidden="true" /> : <Queue {...ICON} aria-hidden="true" />}
                            Queue run
                        </Button>
                    </>
                )}
            >
                <div className={styles.launchForm}>
                    <Field label="Experiment suite" required>
                        <NativeSelect value={launchSuiteId} onChange={(event) => setLaunchSuiteId(event.target.value)}>
                            <option value="">Select a suite</option>
                            {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name || suite.id}</option>)}
                        </NativeSelect>
                    </Field>
                    <Field label="Run nickname" required>
                        <TextInput value={launchNickname} onChange={(event) => setLaunchNickname(event.target.value)} />
                    </Field>
                    <Field label="Fail-fast policy">
                        <NativeSelect value={launchFailFast} onChange={(event) => setLaunchFailFast(event.target.value)}>
                            <option value="inherit">Inherit suite policy</option>
                            <option value="true">Fail fast</option>
                            <option value="false">Continue on failure</option>
                        </NativeSelect>
                    </Field>
                    <Field label="Artifact profile">
                        <NativeSelect value={launchArtifactProfile} onChange={(event) => setLaunchArtifactProfile(event.target.value)}>
                            <option value="evaluation">Evaluation</option>
                            <option value="training">Training</option>
                            <option value="disabled">Disabled</option>
                        </NativeSelect>
                    </Field>
                    {preflight && (
                        <StatusMessage tone="neutral" title="Preflight">
                            Revision {preflight.revision} · {preflight.caseCount} cases · policy {preflight.failurePolicy}
                        </StatusMessage>
                    )}
                    {rssCap != null && (
                        <p className={styles.launchLimits}>Effective RSS cap {formatBytes(rssCap)} · FIFO · one worker</p>
                    )}
                    {preflightError && <StatusMessage tone="danger" title="Preflight failed">{preflightError}</StatusMessage>}
                </div>
            </DialogSurface>
            <DialogSurface
                open={cancelOpen}
                onOpenChange={setCancelOpen}
                title="Cancel active headless run?"
                description="This stops worker execution and finalizes nonterminal cases as cancelled."
                footer={(
                    <>
                        <Button size="compact" onClick={() => setCancelOpen(false)}>Keep running</Button>
                        <Button size="compact" variant="danger" disabled={submitting} onClick={confirmCancel}>
                            {submitting ? <SpinnerGap {...ICON} aria-hidden="true" /> : <Stop {...ICON} aria-hidden="true" />}
                            Cancel run
                        </Button>
                    </>
                )}
            >
                <p style={{ margin: 0, padding: "8px", color: "var(--slate-muted)", fontSize: 12 }}>
                    Pending jobs are removed without launching a worker. The current in-flight case is not replayed.
                </p>
            </DialogSurface>
        </WorkspaceFrame>
    );
}
