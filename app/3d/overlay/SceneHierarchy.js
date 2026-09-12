'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import {
    IconChevronDown,
    IconChevronRight,
    IconEye,
    IconEyeOff,
    IconLock,
    IconLockOpen,
    IconSearch,
} from "@tabler/icons-react";
import { cn } from "./ui/cn";
import { objectCommands } from "../editor/commands/index.js";
import { editorPresentationRegistry } from "../editor/presentation/EditorPresentationRegistry.js";
import {
    buildHierarchyTree,
    filterHierarchyTree,
    flattenHierarchyTree,
    hierarchyRangeIds,
    hierarchyRowIndex,
    planHierarchyDrop,
} from "../editor/presentation/hierarchyModel.js";
import {
    HIERARCHY_ROW_HEIGHT,
    computeWindow,
    nextTreeIndex,
    scrollTopToReveal,
    siblingPositions,
} from "../editor/presentation/virtualWindow.js";
import { focusCameraOnSelection } from "../editor/tools/cameraFocus.js";
import {
    ENVIRONMENT_EDITOR_PREFERENCE_KEYS,
    readEnvironmentEditorPreference,
    writeEnvironmentEditorPreference,
} from "../../ui/environmentEditorPreferences.js";
import { PresentationIcon, registerBuiltinPresentations } from "./presentation/builtinPresentations.js";

const DROP_EDGE_RATIO = 0.25;
const OVERSCAN = 6;

function dropPositionFromEvent(event, row) {
    const rect = event.currentTarget?.getBoundingClientRect?.();
    if (!rect || rect.height === 0) return row.isGroup ? "inside" : "after";
    const ratio = (event.clientY - rect.top) / rect.height;
    if (ratio < DROP_EDGE_RATIO) return "before";
    if (ratio > 1 - DROP_EDGE_RATIO) return "after";
    return row.isGroup ? "inside" : "after";
}

function draggedIdsFromEvent(event, fallback) {
    const raw = String(event.dataTransfer?.getData?.("text/plain") ?? "");
    const ids = raw.split(",").filter(Boolean);
    return ids.length > 0 ? ids : [...fallback];
}

function readCollapsedPreference() {
    const stored = readEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.HIERARCHY_EXPANDED, null);
    return new Set(Array.isArray(stored?.collapsed) ? stored.collapsed.map(String) : []);
}

function rowDomId(id) {
    return `hierarchy-row-${String(id).replace(/[^\w-]+/g, "_")}`;
}

/**
 * Hierarchy pane: a windowed tree over `flattenHierarchyTree` rows (only the
 * visible slice renders), with roving keyboard focus, range and toggle
 * selection, inline rename, hide/lock toggles, drag-and-drop reparenting, and
 * the presentation registry's context menu. Collapsed groups persist as an
 * editor preference.
 */
export function SceneHierarchy({ data }) {
    const [documentSnapshot, setDocumentSnapshot] = useState(null);
    const [selectionSnapshot, setSelectionSnapshot] = useState(null);
    const [presentationVersion, setPresentationVersion] = useState(0);
    const [collapsed, setCollapsed] = useState(readCollapsedPreference);
    const [query, setQuery] = useState("");
    const [renaming, setRenaming] = useState(null);
    const [renameValue, setRenameValue] = useState("");
    const [dropTarget, setDropTarget] = useState(null);
    const [menu, setMenu] = useState(null);
    const [lastIssue, setLastIssue] = useState(null);
    const [activeId, setActiveId] = useState(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(480);
    const anchorRef = useRef(null);
    const treeRef = useRef(null);
    const revealRef = useRef(null);

    useEffect(() => {
        registerBuiltinPresentations();
        return editorPresentationRegistry.subscribe(() => setPresentationVersion((version) => version + 1));
    }, []);
    useEffect(() => {
        const document = data?.environment?.()?.getDocument?.();
        return document?.subscribe?.((snapshot, event) => {
            if (event?.transient) return;
            setDocumentSnapshot(snapshot);
        });
    }, [data]);
    useEffect(() => data?.selection?.()?.subscribe?.((snapshot) => {
        setSelectionSnapshot(snapshot);
        if (snapshot?.primary) {
            setActiveId(String(snapshot.primary));
            revealRef.current = String(snapshot.primary);
        }
    }), [data]);
    useEffect(() => {
        writeEnvironmentEditorPreference(ENVIRONMENT_EDITOR_PREFERENCE_KEYS.HIERARCHY_EXPANDED, { collapsed: [...collapsed] });
    }, [collapsed]);
    useEffect(() => {
        const element = treeRef.current;
        if (!element || typeof ResizeObserver !== "function") return undefined;
        const observer = new ResizeObserver((entries) => {
            const height = entries[0]?.contentRect?.height;
            if (Number.isFinite(height) && height > 0) setViewportHeight(height);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const tree = useMemo(() => {
        const objects = documentSnapshot?.objects ?? [];
        return filterHierarchyTree(buildHierarchyTree(objects, { presentation: editorPresentationRegistry }), query);
    }, [documentSnapshot, query, presentationVersion]); // eslint-disable-line react-hooks/exhaustive-deps
    const rows = useMemo(() => flattenHierarchyTree(tree, { isExpanded: (id) => !collapsed.has(id) }), [tree, collapsed]);
    const positions = useMemo(() => siblingPositions(rows), [rows]);
    const window = computeWindow({ rowCount: rows.length, rowHeight: HIERARCHY_ROW_HEIGHT, scrollTop, viewportHeight, overscan: OVERSCAN });

    // Reveal the primary selection (or keyboard focus) when it changes.
    useEffect(() => {
        const target = revealRef.current;
        if (!target || !treeRef.current) return;
        const index = hierarchyRowIndex(rows, target);
        if (index < 0) return;
        revealRef.current = null;
        const element = treeRef.current;
        const next = scrollTopToReveal({ index, rowHeight: HIERARCHY_ROW_HEIGHT, scrollTop: element.scrollTop, viewportHeight: element.clientHeight || viewportHeight });
        if (Math.abs(next - element.scrollTop) > 0.5) element.scrollTop = next;
    }, [rows, activeId, viewportHeight]);

    if (!data) return null;

    const selection = data.selection?.();
    const bus = data.commands?.();
    const document = data.environment?.()?.getDocument?.();
    const selectedIds = new Set(selectionSnapshot?.ids ?? []);
    const objects = documentSnapshot?.objects ?? [];
    const activeIndex = activeId ? hierarchyRowIndex(rows, activeId) : -1;
    const activeMounted = activeIndex >= window.start && activeIndex < window.end;

    const report = (result) => {
        if (result?.ok) {
            setLastIssue(null);
            return true;
        }
        setLastIssue(result?.issues?.[0]?.message ?? result?.error ?? "Command rejected.");
        return false;
    };

    const selectRow = (row, event) => {
        event?.stopPropagation?.();
        if (!selection) return;
        if (event?.shiftKey && anchorRef.current) {
            selection.select(hierarchyRangeIds(rows, anchorRef.current, row.id));
        } else if (event?.metaKey || event?.ctrlKey) {
            selection.select(row.id, { mode: "toggle" });
            anchorRef.current = row.id;
        } else {
            selection.select(row.id);
            anchorRef.current = row.id;
        }
        setActiveId(row.id);
        data.simulation?.()?.render?.();
    };

    const setGroupCollapsed = (id, value) => {
        setCollapsed((previous) => {
            const next = new Set(previous);
            if (value) next.add(id);
            else next.delete(id);
            return next;
        });
    };
    const toggleCollapsed = (id) => setGroupCollapsed(id, !collapsed.has(id));

    const beginRename = (id) => {
        const record = objects.find((entry) => String(entry.id) === String(id));
        if (!record) return;
        setRenaming(String(id));
        setRenameValue(record.name ?? "");
    };
    const commitRename = () => {
        if (!renaming) return;
        const id = renaming;
        setRenaming(null);
        if (!renameValue.trim()) return;
        report(bus?.execute(objectCommands.renameObject({ objectId: id, name: renameValue })));
        treeRef.current?.focus?.();
    };

    const setHidden = (row, hidden) => report(bus?.execute(objectCommands.setObjectsHidden({ objectIds: [row.id], hidden })));
    const setLocked = (row, locked) => report(bus?.execute(objectCommands.setObjectsLocked({ objectIds: [row.id], locked })));

    const menuContext = (row) => {
        const ids = selectedIds.has(row.id) && selectedIds.size > 1 ? [...selectedIds] : [row.id];
        const records = ids.map((id) => objects.find((entry) => String(entry.id) === id)).filter(Boolean);
        return {
            data,
            record: row.record,
            records,
            document,
            bus,
            selection,
            commands: objectCommands,
            beginRename,
            focus: (objectIds) => focusCameraOnSelection({ data, objectIds }),
        };
    };
    const openMenu = (row, event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!selectedIds.has(row.id)) selection?.select(row.id);
        const presentation = editorPresentationRegistry.forRecord(row.record);
        setMenu({ rowId: row.id, x: event.clientX, y: event.clientY, options: presentation.getMenuOptions(menuContext(row)) });
    };
    const runMenuOption = (option) => {
        setMenu(null);
        const result = option.run?.();
        if (result && typeof result === "object" && "ok" in result) report(result);
        data.simulation?.()?.render?.();
    };

    const onDragStart = (row, event) => {
        const ids = selectedIds.has(row.id) ? [...selectedIds] : [row.id];
        event.dataTransfer?.setData?.("text/plain", ids.join(","));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        setDropTarget(null);
    };
    const onDragOver = (row, event) => {
        event.preventDefault();
        const position = dropPositionFromEvent(event, row);
        const plan = planHierarchyDrop({ objects, draggedIds: draggedIdsFromEvent(event, selectedIds), targetId: row.id, position });
        setDropTarget({ rowId: row.id, position, ok: plan.ok, reason: plan.reason ?? null });
    };
    const onDrop = (row, event) => {
        event.preventDefault();
        const position = dropPositionFromEvent(event, row);
        const plan = planHierarchyDrop({ objects, draggedIds: draggedIdsFromEvent(event, selectedIds), targetId: row.id, position });
        setDropTarget(null);
        if (!plan.ok) {
            setLastIssue(plan.reason);
            return;
        }
        report(bus?.execute(objectCommands.reparentObjects({ objectIds: plan.objectIds, parentId: plan.parentId, index: plan.index })));
    };
    const onDropToRoot = (event) => {
        if (event.target !== event.currentTarget && !event.target?.dataset?.hierarchySpacer) return;
        event.preventDefault();
        const plan = planHierarchyDrop({ objects, draggedIds: draggedIdsFromEvent(event, selectedIds), targetId: null });
        setDropTarget(null);
        if (plan.ok) report(bus?.execute(objectCommands.reparentObjects({ objectIds: plan.objectIds, parentId: null })));
    };

    const onTreeKeyDown = (event) => {
        if (renaming) return;
        if (rows.length === 0) return;
        const current = activeIndex >= 0 ? activeIndex : 0;
        if (["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft"].includes(event.key)) {
            event.preventDefault();
            const next = nextTreeIndex(rows, current, event.key);
            const row = rows[next.index];
            if (!row) return;
            if (next.toggle) setGroupCollapsed(row.id, next.toggle === "collapse");
            setActiveId(row.id);
            revealRef.current = row.id;
            if (next.index !== current || !next.toggle) {
                if (event.shiftKey && anchorRef.current) selection?.select(hierarchyRangeIds(rows, anchorRef.current, row.id));
                else {
                    selection?.select(row.id);
                    anchorRef.current = row.id;
                }
                data.simulation?.()?.render?.();
            }
            return;
        }
        const row = rows[current];
        if (!row) return;
        if (event.key === "Enter") {
            event.preventDefault();
            beginRename(row.id);
        } else if (event.key === " ") {
            event.preventDefault();
            selection?.select(row.id, { mode: "toggle" });
            anchorRef.current = row.id;
            data.simulation?.()?.render?.();
        }
    };

    const visibleRows = rows.slice(window.start, window.end);

    return (
        <div className="flex h-full min-h-0 flex-col p-2 text-[var(--slate-fg)]" data-scene-hierarchy onClick={() => setMenu(null)}>
            <p className="mb-2 px-1 text-[11px] text-[var(--slate-muted)]" data-hierarchy-summary>{objects.length} objects · {selectedIds.size} selected</p>

            <label className="mb-2 flex h-7 items-center gap-2 rounded-[var(--radius)] border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] px-2">
                <IconSearch className="h-3 w-3 shrink-0 text-[var(--slate-muted)]" aria-hidden="true" />
                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search objects"
                    aria-label="Search hierarchy"
                    className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--slate-fg)] outline-none placeholder:text-[var(--slate-muted)]"
                />
            </label>

            {lastIssue && (
                <p role="status" className="mb-2 rounded-[var(--radius)] border border-[var(--slate-danger-border)] px-2 py-1 text-[11px] text-[var(--slate-danger)]">
                    {lastIssue}
                </p>
            )}

            <div
                ref={treeRef}
                role="tree"
                aria-label="Environment objects"
                aria-multiselectable="true"
                aria-activedescendant={activeMounted ? rowDomId(activeId) : undefined}
                tabIndex={0}
                data-hierarchy-tree
                data-row-count={rows.length}
                data-rendered-rows={visibleRows.length}
                className="relative min-h-0 flex-1 overflow-auto pr-1 outline-none focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)] hide-scrollbar"
                onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                onKeyDown={onTreeKeyDown}
                onDragOver={(event) => { if (event.target === event.currentTarget || event.target?.dataset?.hierarchySpacer) event.preventDefault(); }}
                onDrop={onDropToRoot}
            >
                {rows.length === 0 && (
                    <p className="px-2 py-3 text-[11px] text-[var(--slate-muted)]">{query ? "No objects match." : "No objects yet."}</p>
                )}
                <div data-hierarchy-spacer="true" style={{ height: `${window.totalHeight}px` }} className="relative">
                    <div style={{ transform: `translateY(${window.offsetTop}px)` }} className="absolute inset-x-0 top-0">
                        {visibleRows.map((row) => {
                            const selected = selectedIds.has(row.id);
                            const isDropTarget = dropTarget?.rowId === row.id;
                            const position = positions.get(row.id);
                            const active = row.id === activeId;
                            return (
                                <div
                                    key={row.id}
                                    id={rowDomId(row.id)}
                                    role="treeitem"
                                    aria-selected={selected}
                                    aria-expanded={row.isGroup ? row.expanded : undefined}
                                    aria-level={row.depth + 1}
                                    aria-posinset={position?.posinset}
                                    aria-setsize={position?.setsize}
                                    aria-current={active || undefined}
                                    draggable
                                    onDragStart={(event) => onDragStart(row, event)}
                                    onDragOver={(event) => onDragOver(row, event)}
                                    onDragLeave={() => setDropTarget((current) => (current?.rowId === row.id ? null : current))}
                                    onDrop={(event) => onDrop(row, event)}
                                    onContextMenu={(event) => openMenu(row, event)}
                                    style={{ height: `${HIERARCHY_ROW_HEIGHT}px`, paddingLeft: `${6 + row.depth * 14}px` }}
                                    className={cn(
                                        "group flex w-full items-center gap-1 rounded-[var(--radius)] border px-1.5 text-left",
                                        selected ? "border-[var(--slate-border)] bg-[var(--slate-surface-3)] text-[var(--slate-fg)]" : "border-transparent text-[var(--slate-fg-2)] hover:bg-[var(--slate-surface-hover)]",
                                        active && "ring-1 ring-inset ring-[var(--slate-ring)]",
                                        row.hidden && "opacity-45",
                                        isDropTarget && dropTarget.ok && dropTarget.position === "inside" && "border-[var(--slate-success-border)]",
                                        isDropTarget && dropTarget.ok && dropTarget.position === "before" && "border-t-2 border-t-[var(--slate-success)]",
                                        isDropTarget && dropTarget.ok && dropTarget.position === "after" && "border-b-2 border-b-[var(--slate-success)]",
                                        isDropTarget && !dropTarget.ok && "border-[var(--slate-danger-border)]",
                                    )}
                                    title={isDropTarget && !dropTarget.ok ? dropTarget.reason ?? undefined : `${row.typeLabel} · ${row.id}`}
                                >
                                    {row.isGroup ? (
                                        <button
                                            type="button"
                                            tabIndex={-1}
                                            className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--slate-muted)] hover:text-[var(--slate-fg)]"
                                            onClick={(event) => { event.stopPropagation(); toggleCollapsed(row.id); }}
                                            aria-label={row.expanded ? "Collapse group" : "Expand group"}
                                        >
                                            {row.expanded ? <IconChevronDown className="h-3 w-3" /> : <IconChevronRight className="h-3 w-3" />}
                                        </button>
                                    ) : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
                                    <PresentationIcon
                                        presentation={editorPresentationRegistry.forRecord(row.record)}
                                        className={cn("h-3 w-3 shrink-0", row.supported ? "text-[var(--slate-muted)]" : "text-[var(--slate-warning)]")}
                                    />
                                    {renaming === row.id ? (
                                        <input
                                            autoFocus
                                            value={renameValue}
                                            onChange={(event) => setRenameValue(event.target.value)}
                                            onBlur={commitRename}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") commitRename();
                                                if (event.key === "Escape") setRenaming(null);
                                                event.stopPropagation();
                                            }}
                                            onClick={(event) => event.stopPropagation()}
                                            aria-label="Object name"
                                            className="min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] px-1 text-[12px] text-[var(--slate-fg)] outline-none"
                                        />
                                    ) : (
                                        <button
                                            type="button"
                                            tabIndex={-1}
                                            className="min-w-0 flex-1 truncate text-left text-[12px]"
                                            onClick={(event) => selectRow(row, event)}
                                            onDoubleClick={(event) => { event.stopPropagation(); beginRename(row.id); }}
                                        >
                                            {row.label}
                                            {!row.supported && <span className="ml-1 text-[var(--slate-warning)]">(unsupported)</span>}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        className={cn("h-4 w-4 shrink-0 text-[var(--slate-muted)] hover:text-[var(--slate-fg)]", !row.locked && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}
                                        onClick={(event) => { event.stopPropagation(); setLocked(row, !row.locked); }}
                                        aria-label={row.locked ? "Unlock" : "Lock"}
                                        title={row.locked ? "Unlock" : "Lock"}
                                    >
                                        {row.locked ? <IconLock className="h-3 w-3" /> : <IconLockOpen className="h-3 w-3" />}
                                    </button>
                                    <button
                                        type="button"
                                        tabIndex={-1}
                                        className={cn("h-4 w-4 shrink-0 text-[var(--slate-muted)] hover:text-[var(--slate-fg)]", !row.ownHidden && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")}
                                        onClick={(event) => { event.stopPropagation(); setHidden(row, !row.ownHidden); }}
                                        aria-label={row.ownHidden ? "Show" : "Hide"}
                                        title={row.ownHidden ? "Show" : "Hide"}
                                    >
                                        {row.ownHidden ? <IconEyeOff className="h-3 w-3" /> : <IconEye className="h-3 w-3" />}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {menu && (
                <div
                    role="menu"
                    className="fixed z-50 min-w-[160px] rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] p-1 shadow-[var(--slate-shadow-overlay)]"
                    style={{ left: menu.x, top: menu.y }}
                    onClick={(event) => event.stopPropagation()}
                >
                    {menu.options.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            role="menuitem"
                            disabled={option.disabled}
                            onClick={() => runMenuOption(option)}
                            className={cn(
                                "flex w-full items-center justify-between gap-3 rounded-[var(--radius)] px-2 py-1 text-left text-[12px] hover:bg-[var(--slate-surface-hover)] disabled:opacity-40",
                                option.danger ? "text-[var(--slate-danger)]" : "text-[var(--slate-fg)]",
                            )}
                        >
                            <span>{option.label}</span>
                            {option.shortcut && <span className="font-mono text-[11px] text-[var(--slate-muted)]">{option.shortcut}</span>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
