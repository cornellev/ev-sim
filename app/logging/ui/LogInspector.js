'use client';

import { useState } from "react";
import {
    IconChartLine,
    IconDownload,
    IconHistory,
    IconTrash,
} from "@tabler/icons-react";

import {
    formatLogBytes,
    formatLogDuration,
    formatLogTimestamp,
    resolveLogFolderId,
} from "../LogCatalogDocument.js";
import { getLogDownloadUrl } from "../LogClient.js";
import { AsyncState, Button, NativeSelect, TextInput } from "../../ui";
import styles from "./LogsPage.module.css";

export default function LogInspector({
    log,
    folders,
    busy,
    onRename,
    onTags,
    onMove,
    onOpenReplay,
    onOpenAnalysis,
    onDelete,
}) {
    const [drafts, setDrafts] = useState({
        id: log?.id || "",
        name: log?.name || "",
        tags: (log?.tags || []).join(", "),
    });
    if ((log?.id || "") !== drafts.id) {
        setDrafts({
            id: log?.id || "",
            name: log?.name || "",
            tags: (log?.tags || []).join(", "),
        });
    }
    const nameDraft = drafts.name;
    const tagsDraft = drafts.tags;
    const setNameDraft = (name) => setDrafts((current) => ({ ...current, name }));
    const setTagsDraft = (tags) => setDrafts((current) => ({ ...current, tags }));

    if (!log) {
        return (
            <div className={styles.inspector}>
                <AsyncState
                    className={styles.centerState}
                    status="empty"
                    title="Select a recording"
                    detail="Choose a log to rename it, move it, download it, or open Replay."
                />
            </div>
        );
    }

    const folderId = resolveLogFolderId(log.folderId, folders) || "";
    const recording = log.status === "recording";
    const persistName = () => {
        const next = nameDraft.trim();
        if (next && next !== log.name) onRename(next);
        else setNameDraft(log.name || "");
    };

    return (
        <div className={styles.inspector} role="region" aria-label="Recording details">
            <header className={styles.inspectorHeader}>
                <p>Selected</p>
                <strong>{log.name || log.id}</strong>
            </header>
            <div className={styles.inspectorBody}>
                <label className={styles.inspectorField}>
                    <span>Name</span>
                    <TextInput
                        aria-label="Log name"
                        value={nameDraft}
                        onChange={(event) => setNameDraft(event.target.value)}
                        onBlur={persistName}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") {
                                event.currentTarget.blur();
                            }
                        }}
                    />
                </label>
                <label className={styles.inspectorField}>
                    <span>Tags</span>
                    <TextInput
                        aria-label="Log tags"
                        placeholder="Tags, comma separated"
                        value={tagsDraft}
                        onChange={(event) => setTagsDraft(event.target.value)}
                        onBlur={() => {
                            const tags = tagsDraft.split(",").map((tag) => tag.trim()).filter(Boolean);
                            const current = log.tags || [];
                            if (tags.join("\0") === current.join("\0")) return;
                            onTags(tags);
                        }}
                    />
                </label>
                <label className={styles.inspectorField}>
                    <span>Folder</span>
                    <NativeSelect
                        aria-label="Log folder"
                        value={folderId}
                        onChange={(event) => onMove(event.target.value || null)}
                    >
                        <option value="">Unfiled</option>
                        {folders.map((folder) => (
                            <option key={folder.id} value={folder.id}>{folder.name}</option>
                        ))}
                    </NativeSelect>
                </label>
                {(log.tags || []).length > 0 && (
                    <div className={styles.tagList}>
                        {log.tags.map((tag) => <span className={styles.tag} key={tag}>{tag}</span>)}
                    </div>
                )}
                <div className={styles.metaGrid}>
                    <div className={styles.metaRow}><span>Status</span><span>{log.status || "complete"}</span></div>
                    <div className={styles.metaRow}><span>Size</span><span>{formatLogBytes(log.bytes)}</span></div>
                    <div className={styles.metaRow}><span>Duration</span><span>{formatLogDuration(log.durationUs)}</span></div>
                    <div className={styles.metaRow}><span>Created</span><span>{formatLogTimestamp(log.createdAt)}</span></div>
                    {log.completedAt && <div className={styles.metaRow}><span>Completed</span><span>{formatLogTimestamp(log.completedAt)}</span></div>}
                    <div className={styles.metaRow}><span>Id</span><span>{log.id}</span></div>
                    {log.profile?.name && <div className={styles.metaRow}><span>Profile</span><span>{log.profile.name}</span></div>}
                    {log.manifestId && <div className={styles.metaRow}><span>Manifest</span><span>{log.manifestId}</span></div>}
                    {log.resolvedHash && <div className={styles.metaRow}><span>Resolved hash</span><span>{log.resolvedHash}</span></div>}
                </div>
            </div>
            <div className={styles.inspectorActions}>
                <Button size="compact" disabled={busy || recording} onClick={() => onOpenReplay?.(log.id)}>
                    <IconHistory size={14} stroke={1.75} /> Replay
                </Button>
                <Button size="compact" disabled={busy || recording} onClick={() => onOpenAnalysis?.(log.id)}>
                    <IconChartLine size={14} stroke={1.75} /> Analyze
                </Button>
                <Button asChild size="compact">
                    <a href={getLogDownloadUrl(log.id)} download>
                        <IconDownload size={14} stroke={1.75} /> Download
                    </a>
                </Button>
                <Button size="compact" variant="danger" disabled={busy || recording} onClick={onDelete}>
                    <IconTrash size={14} stroke={1.75} /> {recording ? "Stop recording to delete" : "Delete"}
                </Button>
            </div>
        </div>
    );
}
