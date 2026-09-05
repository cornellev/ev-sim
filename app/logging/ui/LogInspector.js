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
import { normalizeLogEvidence } from "../LogEvidenceDocument.js";
import { getLogDownloadUrl } from "../LogClient.js";
import { AsyncState, Button, NativeSelect, TextInput } from "../../ui";
import styles from "./LogsPage.module.css";

function shortHash(value) {
    const text = String(value || "");
    if (!text) return "—";
    return text.length > 16 ? `${text.slice(0, 12)}…` : text;
}

function MetaRow({ label, value, mono = false }) {
    if (value == null || value === "") return null;
    return (
        <div className={styles.metaRow}>
            <span>{label}</span>
            <span className={mono ? styles.monoValue : undefined} title={String(value)}>{value}</span>
        </div>
    );
}

function Section({ title, children }) {
    return (
        <section className={styles.inspectorSection}>
            <h3 className={styles.inspectorSectionTitle}>{title}</h3>
            <div className={styles.metaGrid}>{children}</div>
        </section>
    );
}

export default function LogInspector({
    log,
    folders,
    busy,
    linkedResult = null,
    linkedBaseline = null,
    onRename,
    onTags,
    onMove,
    onOpenReplay,
    onOpenAnalysis,
    onOpenManifest,
    onOpenExperimentResult,
    onOpenExperimentCase,
    onOpenBaselineCompare,
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
    let evidence = null;
    try {
        evidence = log.evidence ? normalizeLogEvidence(log.evidence) : null;
    } catch {
        evidence = null;
    }
    const manifestId = evidence?.manifestId || log.manifestId || null;
    const resultId = evidence?.resultId || null;
    const caseId = evidence?.caseId || null;
    const suiteId = evidence?.suiteId || linkedResult?.suiteId || null;
    const persistName = () => {
        const next = nameDraft.trim();
        if (next && next !== log.name) onRename(next);
        else setNameDraft(log.name || "");
    };

    const resultMissing = Boolean(resultId && !linkedResult);
    const baselineMissing = Boolean(resultId && linkedResult && !linkedBaseline);
    const caseMissing = Boolean(caseId && linkedResult && !(linkedResult.cases || []).some((entry) => entry.id === caseId));
    const artifactWarnings = [
        ...(evidence?.source?.warnings || []),
        ...(linkedResult?.cases || [])
            .filter((entry) => !caseId || entry.id === caseId)
            .flatMap((entry) => entry.artifactWarnings || []),
    ];
    const sourceStatus = linkedResult
        ? (linkedResult.status || "unknown")
        : (resultId ? "missing" : null);
    const caseEntry = (linkedResult?.cases || []).find((entry) => entry.id === caseId) || null;

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

                <Section title="Recording">
                    <MetaRow label="Status" value={log.status || "complete"} />
                    <MetaRow label="Size" value={formatLogBytes(log.bytes)} />
                    <MetaRow label="Duration" value={formatLogDuration(log.durationUs)} />
                    <MetaRow label="Created" value={formatLogTimestamp(log.createdAt)} />
                    {log.completedAt && <MetaRow label="Completed" value={formatLogTimestamp(log.completedAt)} />}
                    <MetaRow label="Id" value={log.id} mono />
                    {log.profile?.name && <MetaRow label="Profile" value={log.profile.name} />}
                    {evidence?.source?.status && <MetaRow label="Evidence index" value={evidence.source.status} />}
                </Section>

                <Section title="Run identity">
                    <MetaRow label="Manifest" value={manifestId || "unknown"} mono />
                    <MetaRow label="Run id" value={evidence?.runId || log.runId || "unknown"} mono />
                    <MetaRow label="Definition" value={shortHash(evidence?.definitionHash || log.definitionHash)} mono />
                    <MetaRow label="Resolved" value={shortHash(evidence?.resolvedHash || log.resolvedHash)} mono />
                    <MetaRow label="Semantic" value={shortHash(evidence?.simulationSemanticHash)} mono />
                    <MetaRow label="Episode" value={shortHash(evidence?.episodeHash)} mono />
                    <MetaRow label="Trajectory" value={shortHash(evidence?.trajectoryHash)} mono />
                    <MetaRow label="World" value={shortHash(evidence?.worldHash)} mono />
                    <MetaRow label="Git" value={shortHash(evidence?.gitCommit || log.gitHash)} mono />
                </Section>

                <Section title="Experiment lineage">
                    <MetaRow label="Suite" value={suiteId || "unknown"} mono />
                    <MetaRow label="Result" value={resultId || "unknown"} mono />
                    <MetaRow label="Case" value={caseId || "unknown"} mono />
                    {sourceStatus && <MetaRow label="Result status" value={sourceStatus} />}
                    {caseEntry?.status && <MetaRow label="Case status" value={caseEntry.status} />}
                    {caseEntry?.failureReason && <MetaRow label="Failure" value={caseEntry.failureReason} />}
                    {resultMissing && <MetaRow label="Link" value="Linked result is missing" />}
                    {caseMissing && <MetaRow label="Case link" value="Linked case is missing" />}
                    {baselineMissing && <MetaRow label="Baseline" value="No baseline references this result" />}
                    {linkedBaseline && <MetaRow label="Baseline" value={linkedBaseline.name || linkedBaseline.id} />}
                    {artifactWarnings.length > 0 && (
                        <MetaRow label="Warnings" value={artifactWarnings.join(" · ")} />
                    )}
                </Section>

                <Section title="Models & calibration">
                    <MetaRow label="Calibration" value={shortHash(evidence?.calibrationHash) || "unknown"} mono />
                    {(evidence?.candidateModels || []).length === 0
                        ? <MetaRow label="Models" value="None declared" />
                        : evidence.candidateModels.map((model, index) => (
                            <MetaRow
                                key={`${model.role}-${model.modelId}-${index}`}
                                label={`${model.role}${model.version ? ` @ ${model.version}` : ""}`}
                                value={`${model.modelId} · ${shortHash(model.digest)}`}
                                mono
                            />
                        ))}
                </Section>
            </div>
            <div className={styles.inspectorActions}>
                <Button
                    size="compact"
                    disabled={busy || recording || !manifestId}
                    onClick={() => onOpenManifest?.(manifestId)}
                >
                    Manifest
                </Button>
                <Button
                    size="compact"
                    disabled={busy || recording || !resultId || resultMissing}
                    onClick={() => onOpenExperimentResult?.({ suiteId, resultId, caseId })}
                >
                    Result
                </Button>
                <Button
                    size="compact"
                    disabled={busy || recording || !resultId || !caseId || resultMissing || caseMissing}
                    onClick={() => onOpenExperimentCase?.({ suiteId, resultId, caseId })}
                >
                    Case
                </Button>
                <Button
                    size="compact"
                    disabled={busy || recording || !linkedBaseline}
                    onClick={() => onOpenBaselineCompare?.({
                        suiteId: linkedBaseline?.suiteId || suiteId,
                        resultId,
                        baselineId: linkedBaseline?.id,
                    })}
                >
                    Baseline
                </Button>
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
