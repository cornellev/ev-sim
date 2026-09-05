'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog } from "radix-ui";
import { IconFileImport } from "@tabler/icons-react";

import {
    ALL_FOLDER_ID,
    UNFILED_FOLDER_ID,
    createLogCatalog,
    createLogFolder,
    formatLogBytes,
    normalizeLogCatalog,
    resolveLogFolderId,
    slugifyLogFolder,
} from "../LogCatalogDocument.js";
import { evidenceSearchHaystack } from "../LogEvidenceDocument.js";
import {
    deleteLogs,
    getLogCatalog,
    importLog,
    listLogs,
    saveLogCatalog,
    updateLog,
} from "../LogClient.js";
import {
    getExperimentResult,
    listExperimentBaselines,
    listExperimentResults,
} from "../../experiments/ExperimentClient.js";
import { subscribeStorageEvents } from "../../client/storageEvents.js";
import {
    AsyncState,
    Button,
    StatusMessage,
    WorkspaceFrame,
    pickLastOpenCatalogId,
    readLastOpenWorkspaceId,
    writeLastOpenWorkspaceId,
} from "../../ui";
import LogCatalog from "./LogCatalog.js";
import LogInspector from "./LogInspector.js";
import LogTable from "./LogTable.js";
import styles from "./LogsPage.module.css";

function uniqueFolderId(name, folders) {
    const base = slugifyLogFolder(name);
    if (!folders.some((folder) => folder.id === base)) return base;
    let index = 2;
    while (folders.some((folder) => folder.id === `${base}-${index}`)) index += 1;
    return `${base}-${index}`;
}

function compareLogs(a, b, sort) {
    const direction = sort.direction === "asc" ? 1 : -1;
    const left = a[sort.key];
    const right = b[sort.key];
    if (sort.key === "bytes" || sort.key === "durationUs") {
        return (Number(left) - Number(right)) * direction;
    }
    return String(left || "").localeCompare(String(right || "")) * direction;
}

export default function LogsPage({
    onOpenWorkspace,
    onOpenReplay,
    onOpenAnalysis,
    onOpenManifest,
    onOpenExperiment,
}) {
    const fileRef = useRef(null);
    const [logs, setLogs] = useState([]);
    const [catalog, setCatalog] = useState(() => createLogCatalog());
    const [selectedId, setSelectedId] = useState("");
    const [selectedFolderId, setSelectedFolderId] = useState(ALL_FOLDER_ID);
    const [query, setQuery] = useState("");
    const [checkedIds, setCheckedIds] = useState([]);
    const [sort, setSort] = useState({ key: "createdAt", direction: "desc" });
    const [status, setStatus] = useState("loading");
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [pendingDelete, setPendingDelete] = useState(null);
    const [resultSummaries, setResultSummaries] = useState([]);
    const [baselines, setBaselines] = useState([]);
    const [linkedResult, setLinkedResult] = useState(null);

    const folders = useMemo(() => catalog.folders || [], [catalog.folders]);

    const refresh = useCallback(async () => {
        const [nextLogs, nextCatalog, nextResults, nextBaselines] = await Promise.all([
            listLogs(),
            getLogCatalog().catch(() => createLogCatalog()),
            listExperimentResults().catch(() => ({ results: [] })),
            listExperimentBaselines().catch(() => ({ baselines: [] })),
        ]);
        setLogs(nextLogs);
        setCatalog(normalizeLogCatalog(nextCatalog || {}));
        setResultSummaries(Array.isArray(nextResults?.results) ? nextResults.results : (Array.isArray(nextResults) ? nextResults : []));
        setBaselines(Array.isArray(nextBaselines?.baselines) ? nextBaselines.baselines : (Array.isArray(nextBaselines) ? nextBaselines : []));
        return nextLogs;
    }, []);

    const load = useCallback(async () => {
        setStatus("loading");
        setError(null);
        try {
            const nextLogs = await refresh();
            const preferred = readLastOpenWorkspaceId("logs");
            setSelectedId((current) => pickLastOpenCatalogId(nextLogs, current || preferred) || "");
            setStatus("ready");
        } catch (caught) {
            setError(caught.message);
            setStatus("error");
        }
    }, [refresh]);

    useEffect(() => {
        load();
    }, [load]);

    useEffect(() => {
        if (selectedId) writeLastOpenWorkspaceId("logs", selectedId);
    }, [selectedId]);

    useEffect(() => subscribeStorageEvents(async (event) => {
        if (event.domain !== "logging") return;
        const nextLogs = await refresh().catch(() => null);
        if (!nextLogs) return;
        if (event.action === "deleted") {
            setCheckedIds((current) => current.filter((id) => id !== event.id));
            setSelectedId((current) => {
                if (current !== event.id) return current;
                return pickLastOpenCatalogId(nextLogs, null) || "";
            });
        }
    }), [refresh]);

    useEffect(() => {
        if (!logs.some((log) => log.status === "recording")) return undefined;
        const timer = window.setInterval(() => {
            refresh().catch(() => {});
        }, 1500);
        return () => window.clearInterval(timer);
    }, [logs, refresh]);

    const visibleLogs = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return logs
            .filter((log) => {
                const folderId = resolveLogFolderId(log.folderId, folders);
                if (selectedFolderId === UNFILED_FOLDER_ID && folderId) return false;
                if (selectedFolderId !== ALL_FOLDER_ID && selectedFolderId !== UNFILED_FOLDER_ID && folderId !== selectedFolderId) return false;
                if (!needle) return true;
                return evidenceSearchHaystack(log.evidence, log).includes(needle);
            })
            .slice()
            .sort((a, b) => compareLogs(a, b, sort));
    }, [folders, logs, query, selectedFolderId, sort]);

    const selectedLog = logs.find((log) => log.id === selectedId) || null;
    const selectedResultId = selectedLog?.evidence?.resultId || null;

    useEffect(() => {
        let cancelled = false;
        if (!selectedResultId) {
            setLinkedResult(null);
            return undefined;
        }
        const summary = resultSummaries.find((entry) => entry.id === selectedResultId) || null;
        getExperimentResult(selectedResultId)
            .then((value) => {
                if (cancelled) return;
                setLinkedResult(value?.result || value || summary);
            })
            .catch(() => {
                if (!cancelled) setLinkedResult(null);
            });
        return () => { cancelled = true; };
    }, [resultSummaries, selectedResultId]);

    const linkedBaseline = useMemo(() => {
        if (!selectedResultId) return null;
        return baselines.find((entry) => entry.sourceResultId === selectedResultId) || null;
    }, [baselines, selectedResultId]);

    const totalBytes = logs.reduce((sum, log) => sum + (Number(log.bytes) || 0), 0);

    const persistCatalog = async (nextFolders) => {
        const previous = catalog;
        const next = normalizeLogCatalog({ ...catalog, folders: nextFolders });
        setCatalog(next);
        try {
            const saved = await saveLogCatalog({ catalog: next, expectedRevision: catalog.revision ?? 0 });
            setCatalog(normalizeLogCatalog(saved));
            await refresh();
        } catch (caught) {
            setCatalog(previous);
            setError(caught.message);
        }
    };

    const createFolder = (name) => persistCatalog([...folders, createLogFolder({ id: uniqueFolderId(name, folders), name })]);

    const renameFolder = (folderId, name) => persistCatalog(folders.map((folder) => (
        folder.id === folderId ? { ...folder, name } : folder
    )));

    const deleteFolder = (folderId) => persistCatalog(folders.filter((folder) => folder.id !== folderId));

    const moveFolder = (folderId, delta) => {
        const index = folders.findIndex((folder) => folder.id === folderId);
        const nextIndex = index + delta;
        if (index < 0 || nextIndex < 0 || nextIndex >= folders.length) return;
        const next = folders.slice();
        const [folder] = next.splice(index, 1);
        next.splice(nextIndex, 0, folder);
        persistCatalog(next);
    };

    const reorderFolder = (sourceId, targetId) => {
        const from = folders.findIndex((folder) => folder.id === sourceId);
        const to = folders.findIndex((folder) => folder.id === targetId);
        if (from < 0 || to < 0 || from === to) return;
        const next = folders.slice();
        const [folder] = next.splice(from, 1);
        next.splice(to, 0, folder);
        persistCatalog(next);
    };

    const patchLog = async (id, patch) => {
        setBusy(true);
        setError(null);
        try {
            const updated = await updateLog(id, patch);
            setLogs((current) => current.map((log) => (log.id === id ? { ...log, ...updated } : log)));
        } catch (caught) {
            setError(caught.message);
        } finally {
            setBusy(false);
        }
    };

    const confirmDelete = async () => {
        const ids = pendingDelete?.ids || [];
        setPendingDelete(null);
        if (!ids.length) return;
        setBusy(true);
        setError(null);
        try {
            const result = await deleteLogs(ids);
            const failed = (result.results || []).filter((entry) => !entry.deleted);
            const nextLogs = await refresh();
            setCheckedIds((current) => current.filter((id) => !ids.includes(id)));
            if (ids.includes(selectedId)) setSelectedId(pickLastOpenCatalogId(nextLogs, null) || "");
            if (failed.length) setError(failed.map((entry) => entry.error || `Could not delete ${entry.id}.`).join(" "));
        } catch (caught) {
            setError(caught.message);
        } finally {
            setBusy(false);
        }
    };

    const handleImport = async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        setBusy(true);
        setError(null);
        try {
            const imported = await importLog(file);
            const folderId = selectedFolderId === ALL_FOLDER_ID || selectedFolderId === UNFILED_FOLDER_ID ? null : selectedFolderId;
            if (folderId) await updateLog(imported.id, { folderId });
            const nextLogs = await refresh();
            setSelectedId(imported.id || pickLastOpenCatalogId(nextLogs, imported.id) || "");
        } catch (caught) {
            setError(caught.message);
        } finally {
            setBusy(false);
        }
    };

    const deleteCount = pendingDelete?.ids?.length || 0;
    const deleteBytes = (pendingDelete?.ids || [])
        .map((id) => logs.find((log) => log.id === id))
        .reduce((sum, log) => sum + (Number(log?.bytes) || 0), 0);

    return (
        <>
            <WorkspaceFrame
                title="Logs"
                subtitle={selectedLog?.name}
                onOpenWorkspace={onOpenWorkspace}
                className={styles.workspace}
                contentClassName={styles.workspaceContent}
                actions={(
                    <>
                        <span className={styles.headerMeta}>{formatLogBytes(totalBytes)}</span>
                        <Button size="compact" onClick={() => fileRef.current?.click()} disabled={busy}>
                            <IconFileImport size={15} stroke={1.75} /> Import
                        </Button>
                        <input ref={fileRef} hidden type="file" accept=".sflog,application/x-sflog" onChange={handleImport} />
                    </>
                )}
                sidebar={(
                    <LogCatalog
                        logs={logs}
                        folders={folders}
                        selectedFolderId={selectedFolderId}
                        query={query}
                        onQuery={setQuery}
                        onSelectFolder={setSelectedFolderId}
                        onCreateFolder={createFolder}
                        onRenameFolder={renameFolder}
                        onDeleteFolder={deleteFolder}
                        onMoveFolder={moveFolder}
                        onReorderFolder={reorderFolder}
                        onMoveLog={(id, folderId) => patchLog(id, { folderId })}
                    />
                )}
                inspector={(
                    <LogInspector
                        log={selectedLog}
                        folders={folders}
                        busy={busy}
                        linkedResult={linkedResult}
                        linkedBaseline={linkedBaseline}
                        onRename={(name) => selectedLog && patchLog(selectedLog.id, { name })}
                        onTags={(tags) => selectedLog && patchLog(selectedLog.id, { tags })}
                        onMove={(folderId) => selectedLog && patchLog(selectedLog.id, { folderId })}
                        onOpenReplay={onOpenReplay}
                        onOpenAnalysis={onOpenAnalysis}
                        onOpenManifest={(manifestId) => onOpenManifest?.(manifestId)}
                        onOpenExperimentResult={(target) => onOpenExperiment?.({
                            suiteId: target.suiteId,
                            resultId: target.resultId,
                            tab: "review",
                        })}
                        onOpenExperimentCase={(target) => onOpenExperiment?.({
                            suiteId: target.suiteId,
                            resultId: target.resultId,
                            caseId: target.caseId,
                            tab: "review",
                        })}
                        onOpenBaselineCompare={(target) => onOpenExperiment?.({
                            suiteId: target.suiteId,
                            resultId: target.resultId,
                            baselineId: target.baselineId,
                            tab: "compare",
                        })}
                        onDelete={() => selectedLog && setPendingDelete({ ids: [selectedLog.id] })}
                    />
                )}
            >
                {status === "loading" && (
                    <AsyncState className={styles.centerState} status="loading" title="Loading recordings" detail="Reading the SFLog catalog and folder list." />
                )}
                {status === "error" && (
                    <AsyncState className={styles.centerState} status="error" title="Could not load recordings" detail={error} onRetry={load} />
                )}
                {status === "ready" && (
                    <div className={styles.libraryHost}>
                        {error && <StatusMessage tone="danger" title="Log library action failed">{error}</StatusMessage>}
                        <LogTable
                            logs={visibleLogs}
                            folders={folders}
                            selectedId={selectedId}
                            checkedIds={checkedIds}
                            sort={sort}
                            onSort={(key) => setSort((current) => ({
                                key,
                                direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
                            }))}
                            onSelect={setSelectedId}
                            onToggleChecked={(id) => setCheckedIds((current) => (
                                current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
                            ))}
                            onToggleAll={(checked) => setCheckedIds(checked ? visibleLogs.map((log) => log.id) : [])}
                            onClearChecked={() => setCheckedIds([])}
                            onDeleteChecked={() => setPendingDelete({ ids: checkedIds.slice() })}
                        />
                    </div>
                )}
            </WorkspaceFrame>

            <AlertDialog.Root open={Boolean(pendingDelete)} onOpenChange={(open) => !open && setPendingDelete(null)}>
                <AlertDialog.Portal>
                    <AlertDialog.Overlay className="sf-dialog-overlay" />
                    <AlertDialog.Content className="sf-dialog sf-guard-dialog">
                        <header className="sf-dialog__header">
                            <div>
                                <AlertDialog.Title className="sf-dialog__title">
                                    Delete {deleteCount === 1 ? "this recording" : `${deleteCount} recordings`}?
                                </AlertDialog.Title>
                                <AlertDialog.Description className="sf-dialog__description">
                                    This permanently removes the SFLog file{deleteCount === 1 ? "" : "s"} and sidecar{deleteCount === 1 ? "" : "s"} ({formatLogBytes(deleteBytes)}). Active recordings are skipped.
                                </AlertDialog.Description>
                            </div>
                        </header>
                        <div className="sf-dialog__footer">
                            <AlertDialog.Cancel asChild><Button>Cancel</Button></AlertDialog.Cancel>
                            <Button variant="danger" onClick={confirmDelete}>Delete</Button>
                        </div>
                    </AlertDialog.Content>
                </AlertDialog.Portal>
            </AlertDialog.Root>
        </>
    );
}
