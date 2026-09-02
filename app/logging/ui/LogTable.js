'use client';

import { formatLogBytes, formatLogDuration, formatLogTimestamp, resolveLogFolderId } from "../LogCatalogDocument.js";
import { AsyncState, Button } from "../../ui";
import styles from "./LogsPage.module.css";

const STATUS_LABEL = {
    recording: "Recording",
    complete: "Complete",
    incomplete: "Incomplete",
    corrupt: "Corrupt",
};

const COLUMNS = [
    { id: "name", label: "Name" },
    { id: "status", label: "Status" },
    { id: "bytes", label: "Size" },
    { id: "durationUs", label: "Duration" },
    { id: "createdAt", label: "Created" },
];

export default function LogTable({
    logs,
    folders,
    selectedId,
    checkedIds,
    sort,
    onSort,
    onSelect,
    onToggleChecked,
    onToggleAll,
    onDeleteChecked,
    onClearChecked,
}) {
    const checked = new Set(checkedIds);
    const visibleIds = logs.map((log) => log.id);
    const allChecked = visibleIds.length > 0 && visibleIds.every((id) => checked.has(id));
    const checkedLogs = logs.filter((log) => checked.has(log.id));
    const checkedBytes = checkedLogs.reduce((sum, log) => sum + (Number(log.bytes) || 0), 0);
    const folderNames = new Map(folders.map((folder) => [folder.id, folder.name]));

    return (
        <div className={styles.library}>
            <div className={styles.tableWrap}>
                {logs.length === 0 ? (
                    <AsyncState
                        className={styles.centerState}
                        status="empty"
                        title="No recordings in this folder"
                        detail="Import an SFLog or file a recording here from Unfiled."
                    />
                ) : (
                    <table className={styles.table}>
                        <thead>
                            <tr>
                                <th className={styles.checkCell}>
                                    <input
                                        className={styles.check}
                                        type="checkbox"
                                        checked={allChecked}
                                        aria-label="Select all visible recordings"
                                        onChange={() => onToggleAll(!allChecked)}
                                    />
                                </th>
                                {COLUMNS.map((column) => (
                                    <th key={column.id} aria-sort={sort.key === column.id ? (sort.direction === "asc" ? "ascending" : "descending") : "none"}>
                                        <button type="button" onClick={() => onSort(column.id)}>
                                            {column.label}
                                            {sort.key === column.id ? (sort.direction === "asc" ? " ↑" : " ↓") : ""}
                                        </button>
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map((log) => {
                                const folderName = folderNames.get(resolveLogFolderId(log.folderId, folders)) || "Unfiled";
                                return (
                                    <tr
                                        key={log.id}
                                        className={styles.tableRow}
                                        data-selected={log.id === selectedId || undefined}
                                        data-checked={checked.has(log.id) || undefined}
                                        data-log-id={log.id}
                                        draggable
                                        onDragStart={(event) => {
                                            event.dataTransfer.effectAllowed = "move";
                                            event.dataTransfer.setData("application/x-log-id", log.id);
                                        }}
                                        onClick={() => onSelect(log.id)}
                                    >
                                        <td className={styles.checkCell} onClick={(event) => event.stopPropagation()}>
                                            <input
                                                className={styles.check}
                                                type="checkbox"
                                                checked={checked.has(log.id)}
                                                aria-label={`Select ${log.name}`}
                                                onChange={() => onToggleChecked(log.id)}
                                            />
                                        </td>
                                        <td className={styles.nameCell}>
                                            <div className={styles.nameBlock}>
                                                <strong>{log.name || log.id}</strong>
                                                <small>{folderName} · {log.id}</small>
                                            </div>
                                        </td>
                                        <td>
                                            <span className={styles.statusBadge} data-status={log.status || "complete"}>
                                                {STATUS_LABEL[log.status] || log.status || "Complete"}
                                            </span>
                                        </td>
                                        <td className={styles.sizeCell}>{formatLogBytes(log.bytes)}</td>
                                        <td className={styles.durationCell}>{formatLogDuration(log.durationUs)}</td>
                                        <td className={styles.createdCell}>{formatLogTimestamp(log.createdAt)}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
            {checkedLogs.length > 0 && (
                <div className={styles.selectionBar}>
                    <p>
                        {checkedLogs.length} selected
                        {" "}
                        <span>{formatLogBytes(checkedBytes)}</span>
                    </p>
                    <div className={styles.selectionActions}>
                        <Button size="compact" onClick={onClearChecked}>Clear</Button>
                        <Button size="compact" variant="danger" onClick={onDeleteChecked}>Delete selected</Button>
                    </div>
                </div>
            )}
        </div>
    );
}
