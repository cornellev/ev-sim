'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import {
    IconArrowBackUp,
    IconArrowForwardUp,
    IconChevronDown,
    IconChevronRight,
    IconEye,
    IconEyeOff,
    IconLock,
    IconLockOpen,
    IconSearch,
} from "@tabler/icons-react";
import { cn } from "./ui/cn";
import { MenuButton } from "./ui/MenuButton";
import { objectCommands } from "../editor/commands/index.js";
import { editorPresentationRegistry } from "../editor/presentation/EditorPresentationRegistry.js";
import {
    buildHierarchyTree,
    filterHierarchyTree,
    flattenHierarchyTree,
    hierarchyRangeIds,
    planHierarchyDrop,
} from "../editor/presentation/hierarchyModel.js";
import { focusCameraOnSelection } from "../editor/tools/cameraFocus.js";
import { PresentationIcon, registerBuiltinPresentations } from "./presentation/builtinPresentations.js";

const HIERARCHY_CONTROL_LOCK = "environment-scene-hierarchy";
const DROP_EDGE_RATIO = 0.25;

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

export function SceneHierarchy({ data, compactOpen = false }) {
    const [documentSnapshot, setDocumentSnapshot] = useState(null);
    const [selectionSnapshot, setSelectionSnapshot] = useState(null);
    const [busSnapshot, setBusSnapshot] = useState(null);
    const [presentationVersion, setPresentationVersion] = useState(0);
    const [collapsed, setCollapsed] = useState(() => new Set());
    const [query, setQuery] = useState("");
    const [renaming, setRenaming] = useState(null);
    const [renameValue, setRenameValue] = useState("");
    const [dropTarget, setDropTarget] = useState(null);
    const [menu, setMenu] = useState(null);
    const [lastIssue, setLastIssue] = useState(null);
    const anchorRef = useRef(null);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(HIERARCHY_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(HIERARCHY_CONTROL_LOCK),
        };
    }, [data]);

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

    useEffect(() => data?.selection?.()?.subscribe?.(setSelectionSnapshot), [data]);
    useEffect(() => data?.commands?.()?.subscribe?.(setBusSnapshot), [data]);

    const tree = useMemo(() => {
        const objects = documentSnapshot?.objects ?? [];
        return filterHierarchyTree(buildHierarchyTree(objects, { presentation: editorPresentationRegistry }), query);
    }, [documentSnapshot, query, presentationVersion]); // eslint-disable-line react-hooks/exhaustive-deps

    const rows = useMemo(() => flattenHierarchyTree(tree, { isExpanded: (id) => !collapsed.has(id) }), [tree, collapsed]);

    if (!data) return null;

    const selection = data.selection?.();
    const bus = data.commands?.();
    const document = data.environment?.()?.getDocument?.();
    const selectedIds = new Set(selectionSnapshot?.ids ?? []);
    const objects = documentSnapshot?.objects ?? [];

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
        data.simulation?.()?.render?.();
    };

    const toggleCollapsed = (id) => {
        setCollapsed((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

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
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        const plan = planHierarchyDrop({ objects, draggedIds: draggedIdsFromEvent(event, selectedIds), targetId: null });
        setDropTarget(null);
        if (plan.ok) report(bus?.execute(objectCommands.reparentObjects({ objectIds: plan.objectIds, parentId: null })));
    };

    return (
        <div
            className={cn("absolute left-3 top-[58px] z-30 w-[292px] max-w-[calc(100vw-24px)] rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/85 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] pointer-events-auto", !compactOpen && "max-[1023px]:hidden")}
            onMouseDown={controls.disable}
            onMouseUp={controls.enable}
            onMouseLeave={controls.enable}
            onClick={() => setMenu(null)}
        >
            <div className="mb-2 flex items-center justify-between gap-2 rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/70 px-2 py-1.5">
                <div className="min-w-0">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Hierarchy</p>
                    <p className="text-[11px] text-zinc-500">{objects.length} objects · {selectedIds.size} selected</p>
                </div>
                <div className="flex items-center gap-1">
                    <MenuButton iconOnly variant="ghost" className="h-7 w-7 rounded-[var(--radius)]" disabled={!busSnapshot?.canUndo} onClick={() => { bus?.undo(); data.simulation?.()?.render?.(); }} title="Undo (Mod+Z)" ariaLabel="Undo">
                        <IconArrowBackUp className="h-3 w-3" />
                    </MenuButton>
                    <MenuButton iconOnly variant="ghost" className="h-7 w-7 rounded-[var(--radius)]" disabled={!busSnapshot?.canRedo} onClick={() => { bus?.redo(); data.simulation?.()?.render?.(); }} title="Redo (Shift+Mod+Z)" ariaLabel="Redo">
                        <IconArrowForwardUp className="h-3 w-3" />
                    </MenuButton>
                </div>
            </div>

            <label className="mb-2 flex items-center gap-2 rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-950/45 px-2 py-1">
                <IconSearch className="h-3 w-3 shrink-0 text-zinc-500" aria-hidden="true" />
                <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search objects"
                    aria-label="Search hierarchy"
                    className="min-w-0 flex-1 bg-transparent text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600"
                />
            </label>

            {lastIssue && (
                <p role="status" className="mb-2 rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                    {lastIssue}
                </p>
            )}

            <div
                role="tree"
                aria-label="Environment objects"
                className="max-h-[60vh] space-y-0.5 overflow-auto pr-1 hide-scrollbar"
                onDragOver={(event) => { if (event.target === event.currentTarget) event.preventDefault(); }}
                onDrop={onDropToRoot}
            >
                {rows.length === 0 && (
                    <p className="px-2 py-3 text-[11px] text-zinc-500">{query ? "No objects match." : "No objects yet."}</p>
                )}
                {rows.map((row) => {
                    const selected = selectedIds.has(row.id);
                    const isDropTarget = dropTarget?.rowId === row.id;
                    return (
                        <div
                            key={row.id}
                            role="treeitem"
                            aria-selected={selected}
                            aria-expanded={row.isGroup ? row.expanded : undefined}
                            aria-level={row.depth + 1}
                            draggable
                            onDragStart={(event) => onDragStart(row, event)}
                            onDragOver={(event) => onDragOver(row, event)}
                            onDragLeave={() => setDropTarget((current) => (current?.rowId === row.id ? null : current))}
                            onDrop={(event) => onDrop(row, event)}
                            onContextMenu={(event) => openMenu(row, event)}
                            className={cn(
                                "group flex w-full items-center gap-1 rounded-[var(--radius)] border px-1.5 py-1 text-left",
                                selected ? "border-sky-400/80 bg-sky-500/20 text-zinc-100" : "border-transparent text-zinc-300 hover:bg-zinc-800/80",
                                row.hidden && "opacity-45",
                                isDropTarget && dropTarget.ok && dropTarget.position === "inside" && "border-emerald-400/80",
                                isDropTarget && dropTarget.ok && dropTarget.position === "before" && "border-t-2 border-t-emerald-400",
                                isDropTarget && dropTarget.ok && dropTarget.position === "after" && "border-b-2 border-b-emerald-400",
                                isDropTarget && !dropTarget.ok && "border-red-400/80",
                            )}
                            style={{ paddingLeft: `${6 + row.depth * 14}px` }}
                            title={isDropTarget && !dropTarget.ok ? dropTarget.reason ?? undefined : `${row.typeLabel} · ${row.id}`}
                        >
                            {row.isGroup ? (
                                <button
                                    type="button"
                                    className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"
                                    onClick={(event) => { event.stopPropagation(); toggleCollapsed(row.id); }}
                                    aria-label={row.expanded ? "Collapse group" : "Expand group"}
                                >
                                    {row.expanded ? <IconChevronDown className="h-3 w-3" /> : <IconChevronRight className="h-3 w-3" />}
                                </button>
                            ) : <span className="h-4 w-4 shrink-0" aria-hidden="true" />}
                            <PresentationIcon
                                presentation={editorPresentationRegistry.forRecord(row.record)}
                                className={cn("h-3 w-3 shrink-0", row.supported ? "text-zinc-400" : "text-amber-400")}
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
                                    className="min-w-0 flex-1 rounded-[var(--radius)] border border-zinc-700 bg-zinc-950 px-1 text-[11px] text-zinc-100 outline-none"
                                />
                            ) : (
                                <button
                                    type="button"
                                    className="min-w-0 flex-1 truncate text-left text-[11px]"
                                    onClick={(event) => selectRow(row, event)}
                                    onDoubleClick={(event) => { event.stopPropagation(); beginRename(row.id); }}
                                >
                                    {row.label}
                                    {!row.supported && <span className="ml-1 text-amber-400">(unsupported)</span>}
                                </button>
                            )}
                            <button
                                type="button"
                                className={cn("h-4 w-4 shrink-0 text-zinc-500 hover:text-zinc-200", !row.locked && "opacity-0 group-hover:opacity-100")}
                                onClick={(event) => { event.stopPropagation(); setLocked(row, !row.locked); }}
                                aria-label={row.locked ? "Unlock" : "Lock"}
                                title={row.locked ? "Unlock" : "Lock"}
                            >
                                {row.locked ? <IconLock className="h-3 w-3" /> : <IconLockOpen className="h-3 w-3" />}
                            </button>
                            <button
                                type="button"
                                className={cn("h-4 w-4 shrink-0 text-zinc-500 hover:text-zinc-200", !row.ownHidden && "opacity-0 group-hover:opacity-100")}
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

            {menu && (
                <div
                    role="menu"
                    className="fixed z-50 min-w-[160px] rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/95 p-1 shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
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
                                "flex w-full items-center justify-between gap-3 rounded-[var(--radius)] px-2 py-1 text-left text-[11px] hover:bg-zinc-800/80 disabled:opacity-40",
                                option.danger ? "text-red-300" : "text-zinc-200",
                            )}
                        >
                            <span>{option.label}</span>
                            {option.shortcut && <span className="font-mono text-[11px] text-zinc-500">{option.shortcut}</span>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
