'use client';

import { useMemo, useState } from "react";
import {
    IconArrowDown,
    IconArrowUp,
    IconFiles,
    IconFolder,
    IconFolderPlus,
    IconSearch,
    IconX,
} from "@tabler/icons-react";

import {
    ALL_FOLDER_ID,
    UNFILED_FOLDER_ID,
    resolveLogFolderId,
} from "../LogCatalogDocument.js";
import { Button, TextInput } from "../../ui";
import styles from "./LogsPage.module.css";

export default function LogCatalog({
    logs,
    folders,
    selectedFolderId,
    query,
    onQuery,
    onSelectFolder,
    onCreateFolder,
    onRenameFolder,
    onDeleteFolder,
    onMoveFolder,
    onReorderFolder,
    onMoveLog,
}) {
    const [addingFolder, setAddingFolder] = useState(false);
    const [editingFolderId, setEditingFolderId] = useState(null);
    const [folderName, setFolderName] = useState("");
    const [dropTarget, setDropTarget] = useState(null);

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return logs;
        return logs.filter((log) => {
            const haystack = `${log.name || ""} ${log.id || ""} ${(log.tags || []).join(" ")} ${log.status || ""}`.toLowerCase();
            return haystack.includes(needle);
        });
    }, [logs, query]);

    const counts = useMemo(() => {
        const byFolder = new Map(folders.map((folder) => [folder.id, 0]));
        let unfiled = 0;
        for (const log of filtered) {
            const folderId = resolveLogFolderId(log.folderId, folders);
            if (!folderId) unfiled += 1;
            else byFolder.set(folderId, (byFolder.get(folderId) || 0) + 1);
        }
        return { all: filtered.length, unfiled, byFolder };
    }, [filtered, folders]);

    const submitFolder = () => {
        const value = folderName.trim();
        if (!value) return;
        if (editingFolderId) onRenameFolder?.(editingFolderId, value);
        else onCreateFolder?.(value);
        setFolderName("");
        setAddingFolder(false);
        setEditingFolderId(null);
    };

    const receiveDrop = (event, folderId) => {
        event.preventDefault();
        setDropTarget(null);
        const logId = event.dataTransfer.getData("application/x-log-id");
        if (logId) {
            onMoveLog?.(logId, folderId === UNFILED_FOLDER_ID || folderId === ALL_FOLDER_ID ? null : folderId);
            return;
        }
        const sourceFolderId = event.dataTransfer.getData("application/x-folder-id");
        if (sourceFolderId && folderId !== UNFILED_FOLDER_ID && folderId !== ALL_FOLDER_ID && sourceFolderId !== folderId) {
            onReorderFolder?.(sourceFolderId, folderId);
        }
    };

    const markDrop = (event, folderId) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropTarget !== folderId) setDropTarget(folderId);
    };

    return (
        <div className={styles.catalog}>
            <div className={styles.catalogHeader}>
                <div>
                    <span className={styles.eyebrow}>Library</span>
                    <strong>{logs.length} recording{logs.length === 1 ? "" : "s"}</strong>
                </div>
            </div>

            <label className={styles.search}>
                <IconSearch size={14} stroke={1.75} aria-hidden="true" />
                <span className={styles.srOnly}>Search recordings</span>
                <input type="search" autoComplete="off" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search recordings" />
                {query && <kbd>{filtered.length}</kbd>}
            </label>

            <div className={styles.catalogTools}>
                <span>Folders</span>
                <button
                    type="button"
                    onClick={() => {
                        setAddingFolder((value) => !value);
                        setEditingFolderId(null);
                        setFolderName("");
                    }}
                    aria-label="Create log folder"
                >
                    <IconFolderPlus size={15} stroke={1.75} aria-hidden="true" />
                </button>
            </div>

            {addingFolder && (
                <form className={styles.folderForm} onSubmit={(event) => { event.preventDefault(); submitFolder(); }}>
                    <TextInput
                        autoFocus
                        value={folderName}
                        onChange={(event) => setFolderName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Escape") {
                                setFolderName("");
                                setAddingFolder(false);
                            }
                        }}
                        placeholder="Folder name"
                        aria-label="Folder name"
                    />
                    <Button size="compact" variant="primary" disabled={!folderName.trim()} type="submit">Add</Button>
                </form>
            )}

            <nav className={styles.catalogScroll} aria-label="Log folders">
                <button
                    type="button"
                    className={styles.allRow}
                    data-selected={selectedFolderId === ALL_FOLDER_ID || undefined}
                    data-drop-target={dropTarget === ALL_FOLDER_ID || undefined}
                    onClick={() => onSelectFolder(ALL_FOLDER_ID)}
                    onDragOver={(event) => markDrop(event, ALL_FOLDER_ID)}
                    onDrop={(event) => receiveDrop(event, ALL_FOLDER_ID)}
                    onDragLeave={() => setDropTarget(null)}
                >
                    <IconFiles size={14} stroke={1.7} aria-hidden="true" />
                    <span>All recordings</span>
                    <small>{counts.all}</small>
                </button>

                {folders.map((folder, index) => {
                    const editing = editingFolderId === folder.id;
                    return (
                        <section
                            className={styles.catalogGroup}
                            data-folder-id={folder.id}
                            data-selected={selectedFolderId === folder.id || undefined}
                            data-drop-target={dropTarget === folder.id || undefined}
                            key={folder.id}
                            onDragOver={(event) => markDrop(event, folder.id)}
                            onDrop={(event) => receiveDrop(event, folder.id)}
                            onDragLeave={() => setDropTarget(null)}
                        >
                            <div
                                className={styles.folderRow}
                                draggable={!editing}
                                data-selected={selectedFolderId === folder.id || undefined}
                                onClick={() => !editing && onSelectFolder(folder.id)}
                                onDragStart={(event) => {
                                    event.dataTransfer.effectAllowed = "move";
                                    event.dataTransfer.setData("application/x-folder-id", folder.id);
                                }}
                                onDragEnd={() => setDropTarget(null)}
                            >
                                <IconFolder size={14} stroke={1.7} aria-hidden="true" />
                                {editing ? (
                                    <input
                                        className={styles.folderRename}
                                        autoFocus
                                        value={folderName}
                                        aria-label={`Rename ${folder.name}`}
                                        onChange={(event) => setFolderName(event.target.value)}
                                        onBlur={submitFolder}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter") submitFolder();
                                            if (event.key === "Escape") {
                                                setFolderName("");
                                                setEditingFolderId(null);
                                            }
                                        }}
                                        onClick={(event) => event.stopPropagation()}
                                    />
                                ) : (
                                    <button type="button" className={styles.folderName} onClick={() => onSelectFolder(folder.id)} onDoubleClick={() => { setEditingFolderId(folder.id); setFolderName(folder.name); }}>
                                        {folder.name}
                                    </button>
                                )}
                                <div className={styles.folderTrailing}>
                                    <small>{counts.byFolder.get(folder.id) || 0}</small>
                                    {!editing && (
                                        <div className={styles.folderChrome} onClick={(event) => event.stopPropagation()}>
                                            <button type="button" onClick={() => onMoveFolder?.(folder.id, -1)} disabled={index === 0} aria-label={`Move ${folder.name} up`}>
                                                <IconArrowUp size={12} stroke={1.75} aria-hidden="true" />
                                            </button>
                                            <button type="button" onClick={() => onMoveFolder?.(folder.id, 1)} disabled={index === folders.length - 1} aria-label={`Move ${folder.name} down`}>
                                                <IconArrowDown size={12} stroke={1.75} aria-hidden="true" />
                                            </button>
                                            <button type="button" data-label onClick={() => { setEditingFolderId(folder.id); setFolderName(folder.name); setAddingFolder(false); }} aria-label={`Rename ${folder.name}`}>
                                                Edit
                                            </button>
                                            <button type="button" onClick={() => onDeleteFolder?.(folder.id)} aria-label={`Delete ${folder.name}`}>
                                                <IconX size={12} stroke={1.75} aria-hidden="true" />
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </section>
                    );
                })}

                <section
                    className={styles.catalogGroup}
                    data-selected={selectedFolderId === UNFILED_FOLDER_ID || undefined}
                    data-drop-target={dropTarget === UNFILED_FOLDER_ID || undefined}
                    onDragOver={(event) => markDrop(event, UNFILED_FOLDER_ID)}
                    onDrop={(event) => receiveDrop(event, UNFILED_FOLDER_ID)}
                    onDragLeave={() => setDropTarget(null)}
                >
                    <button
                        type="button"
                        className={styles.folderRow}
                        data-selected={selectedFolderId === UNFILED_FOLDER_ID || undefined}
                        onClick={() => onSelectFolder(UNFILED_FOLDER_ID)}
                    >
                        <IconFolder size={14} stroke={1.7} aria-hidden="true" />
                        <span>Unfiled</span>
                        <small>{counts.unfiled}</small>
                    </button>
                </section>

                {filtered.length === 0 && query && (
                    <div className={styles.catalogEmpty}>
                        <p>No recordings match this search.</p>
                    </div>
                )}
            </nav>
        </div>
    );
}
