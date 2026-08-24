'use client';

import { useMemo, useState } from "react";
import {
    IconChevronDown,
    IconFileDescription,
    IconFolder,
    IconFolderPlus,
    IconPlus,
    IconSearch,
} from "@tabler/icons-react";

import { Button, TextInput } from "../../ui";
import styles from "./ScenarioWorkspace.module.css";

const UNFILED = "__unfiled__";

export default function ScenarioCatalog({
    scenarios,
    folders,
    selectedId,
    onSelect,
    onCreate,
    onCreateFolder,
    onMove,
}) {
    const [query, setQuery] = useState("");
    const [newFolder, setNewFolder] = useState("");
    const [addingFolder, setAddingFolder] = useState(false);
    const [collapsed, setCollapsed] = useState(() => new Set());
    const [dropTarget, setDropTarget] = useState(null);

    const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle) return scenarios;
        return scenarios.filter((entry) => `${entry.name} ${entry.description || ""}`.toLowerCase().includes(needle));
    }, [query, scenarios]);

    const groups = useMemo(() => [
        ...folders.map((folder) => ({ ...folder, scenarios: filtered.filter((entry) => entry.folderId === folder.id) })),
        { id: UNFILED, name: "Unfiled", scenarios: filtered.filter((entry) => !entry.folderId || !folders.some((folder) => folder.id === entry.folderId)) },
    ], [filtered, folders]);

    const toggleFolder = (folderId) => setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(folderId)) next.delete(folderId);
        else next.add(folderId);
        return next;
    });

    const submitFolder = () => {
        const value = newFolder.trim();
        if (!value) return;
        onCreateFolder?.(value);
        setNewFolder("");
        setAddingFolder(false);
    };

    const receiveDrop = (event, folderId) => {
        event.preventDefault();
        setDropTarget(null);
        const scenarioId = event.dataTransfer.getData("application/x-scenario-id");
        if (scenarioId) onMove?.(scenarioId, folderId === UNFILED ? null : folderId);
    };

    return (
        <div className={styles.catalog}>
            <div className={styles.catalogHeader}>
                <div>
                    <span className={styles.eyebrow}>Library</span>
                    <strong>{scenarios.length} scenario{scenarios.length === 1 ? "" : "s"}</strong>
                </div>
                <Button size="compact" variant="primary" onClick={onCreate}>
                    <IconPlus size={14} stroke={1.75} aria-hidden="true" /> New
                </Button>
            </div>

            <label className={styles.search}>
                <IconSearch size={14} stroke={1.75} aria-hidden="true" />
                <span className={styles.srOnly}>Search scenarios</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search scenarios" />
                {query && <kbd>{filtered.length}</kbd>}
            </label>

            <div className={styles.catalogTools}>
                <span>Folders</span>
                <button type="button" onClick={() => setAddingFolder((value) => !value)} aria-label="Create scenario folder">
                    <IconFolderPlus size={15} stroke={1.75} aria-hidden="true" />
                </button>
            </div>

            {addingFolder && (
                <form className={styles.folderForm} onSubmit={(event) => { event.preventDefault(); submitFolder(); }}>
                    <TextInput autoFocus value={newFolder} onChange={(event) => setNewFolder(event.target.value)} placeholder="Folder name" aria-label="Folder name" />
                    <Button size="compact" variant="primary" disabled={!newFolder.trim()} type="submit">Add</Button>
                </form>
            )}

            <nav className={styles.catalogScroll} aria-label="Scenario catalog">
                {groups.map((group) => {
                    if (group.id === UNFILED && group.scenarios.length === 0 && filtered.length === 0) return null;
                    const isCollapsed = collapsed.has(group.id);
                    return (
                        <section
                            className={styles.catalogGroup}
                            data-folder-id={group.id}
                            data-drop-target={dropTarget === group.id || undefined}
                            key={group.id}
                            onDragOver={(event) => {
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                if (dropTarget !== group.id) setDropTarget(group.id);
                            }}
                            onDrop={(event) => receiveDrop(event, group.id)}
                        >
                            <button
                                type="button"
                                className={styles.folderRow}
                                onClick={() => toggleFolder(group.id)}
                                aria-expanded={!isCollapsed}
                            >
                                <IconChevronDown className={styles.folderChevron} data-collapsed={isCollapsed || undefined} size={13} stroke={1.75} aria-hidden="true" />
                                <IconFolder size={14} stroke={1.7} aria-hidden="true" />
                                <span>{group.name}</span>
                                <small>{group.scenarios.length}</small>
                            </button>
                            {!isCollapsed && (
                                <div className={styles.scenarioRows}>
                                    {group.scenarios.map((entry) => (
                                        <div
                                            draggable
                                            data-scenario-id={entry.id}
                                            key={entry.id}
                                            onDragStart={(event) => {
                                                event.dataTransfer.effectAllowed = "move";
                                                event.dataTransfer.setData("application/x-scenario-id", entry.id);
                                            }}
                                            onDragEnd={() => setDropTarget(null)}
                                        >
                                            <button
                                                type="button"
                                                className={styles.scenarioRow}
                                                data-selected={entry.id === selectedId || undefined}
                                                aria-current={entry.id === selectedId ? "page" : undefined}
                                                onClick={() => onSelect(entry.id)}
                                            >
                                                <IconFileDescription size={15} stroke={1.6} aria-hidden="true" />
                                                <span>
                                                    <strong>{entry.name}</strong>
                                                    <small>{entry.description || "No description"}</small>
                                                </span>
                                            </button>
                                        </div>
                                    ))}
                                    {group.scenarios.length === 0 && <p className={styles.emptyGroup}>Drop scenarios here when organizing the catalog.</p>}
                                </div>
                            )}
                        </section>
                    );
                })}
                {filtered.length === 0 && (
                    <div className={styles.catalogEmpty}>
                        <IconFileDescription size={19} stroke={1.5} aria-hidden="true" />
                        <p>{query ? "No scenarios match this search." : "Create the first scenario to define a repeatable drive."}</p>
                    </div>
                )}
            </nav>
        </div>
    );
}
