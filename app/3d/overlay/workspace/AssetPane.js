'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { IconFolder, IconFolderPlus, IconList, IconPhoto, IconSearch, IconSquares, IconTrafficCone, IconUpload } from "@tabler/icons-react";
import { EDITOR_MODES, EDITOR_TOOLS, MAP_TOOLS } from "../../editor/EditorState";
import {
    CATALOG_GRID_GAP,
    CATALOG_GRID_ITEM_HEIGHT,
    CATALOG_ROW_HEIGHT,
    computeItemWindow,
} from "../../editor/presentation/virtualWindow.js";
import { PLACEMENT_CATALOG } from "../../editor/placement/PlacementCatalog";
import { cn } from "../ui/cn";
import { ContextMenuSurface } from "../ui/ContextMenuSurface.js";
import {
    CATALOG_DRAG_MIME,
    PLACEMENT_DRAG_MIME,
    canAcceptCatalogDrop,
    catalogDropDestination,
    folderSubtreeIds,
    parseCatalogDragPayload,
} from "./assetCatalogDrop.js";

export { CATALOG_DRAG_MIME, PLACEMENT_DRAG_MIME, canAcceptCatalogDrop, catalogDropDestination, parseCatalogDragPayload };

function portableId(prefix = "asset") {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function isVirtualFolder(id) {
    return id === "all" || id === "root" || id === "built-ins";
}

function untitledFolderName(folders, parentId) {
    const siblings = folders.filter((entry) => (entry.parentId ?? null) === (parentId ?? null));
    const taken = new Set(siblings.map((entry) => String(entry.name).trim().toLowerCase()));
    const base = "Untitled folder";
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; ; n += 1) {
        const name = `${base} ${n}`;
        if (!taken.has(name.toLowerCase())) return name;
    }
}

function pathOf(file) {
    return String(file.webkitRelativePath || file.name).replaceAll("\\", "/");
}

function thumbnailUrl(asset) {
    const useHash = asset.thumbnails?.[String(asset.latestRevision)]?.useHash;
    return useHash ? `/api/storage/visual-assets/uses/sha256/${encodeURIComponent(useHash)}/content` : null;
}

export function AssetPane({ data }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [catalog, setCatalog] = useState({ catalogRevision: 0, folders: [], assets: [] });
    const [capabilities, setCapabilities] = useState({ sources: [] });
    const [query, setQuery] = useState("");
    const [folder, setFolder] = useState("all");
    const [kind, setKind] = useState("all");
    const [sort, setSort] = useState("name");
    const [view, setView] = useState("grid");
    const [showArchived, setShowArchived] = useState(false);
    const [sourceId, setSourceId] = useState("");
    const [pendingImport, setPendingImport] = useState(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState(null);
    const [selectedAssetId, setSelectedAssetId] = useState(null);
    const [folderRename, setFolderRename] = useState(null);
    const [contextMenu, setContextMenu] = useState(null);
    const [dropTargetId, setDropTargetId] = useState(null);
    const fileInputRef = useRef(null);
    const catalogDragRef = useRef(null);
    const listRef = useRef(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
    const importInputId = useId();
    const importHintId = useId();
    const repository = data?.environment?.()?.assets?.()?.repository;

    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);
    const refresh = useCallback(async () => {
        if (!repository) return;
        try {
            const [nextCatalog, nextCapabilities] = await Promise.all([
                repository.list({ search: query, sort, archived: true }),
                repository.capabilities(),
            ]);
            setCatalog(nextCatalog);
            setCapabilities(nextCapabilities);
            setSourceId((current) => {
                const ids = nextCapabilities.sources?.map((source) => source.id) ?? [];
                if (current && ids.includes(current)) return current;
                return ids[0] ?? "";
            });
        } catch (error) {
            setMessage(error.message);
        }
    }, [repository, query, sort]);
    useEffect(() => { void refresh(); }, [refresh]);
    useEffect(() => repository?.subscribe?.(() => { void refresh(); }), [repository, refresh]);

    const inMap = editorSnapshot?.editorMode === EDITOR_MODES.MAP;
    const activePlacement = editorSnapshot?.activePlacement;
    const activeId = inMap
        ? (editorSnapshot?.map?.activeMapTool === MAP_TOOLS.FEATURE_PLACE ? editorSnapshot.map.activeFeatureType : activePlacement?.assetId)
        : (editorSnapshot?.activeTool === EDITOR_TOOLS.PLACE ? activePlacement?.id ?? activePlacement?.assetId : null);
    const builtins = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return PLACEMENT_CATALOG.filter((asset) => !needle || `${asset.label} ${asset.id}`.toLowerCase().includes(needle));
    }, [query]);
    const models = catalog.assets.filter((asset) => (showArchived || !asset.archived) && (folder === "all" || asset.folderId === (folder === "root" ? null : folder)));
    const selectedFolder = catalog.folders.find((entry) => entry.id === folder) ?? null;
    const catalogRows = useMemo(() => {
        const visibleBuiltins = kind !== "models" && (folder === "all" || folder === "built-ins") ? builtins : [];
        const visibleModels = kind !== "builtins" && folder !== "built-ins" ? models : [];
        return [
            ...visibleBuiltins.map((asset) => ({ kind: "builtin", key: asset.id, asset })),
            ...visibleModels.map((asset) => ({ kind: "model", key: asset.id, asset })),
        ];
    }, [builtins, folder, kind, models]);
    const gridColumns = view === "grid"
        ? Math.max(1, Math.floor((viewportSize.width + CATALOG_GRID_GAP) / (130 + CATALOG_GRID_GAP)))
        : 1;
    const catalogWindow = computeItemWindow({
        itemCount: catalogRows.length,
        columns: gridColumns,
        itemHeight: view === "grid" ? CATALOG_GRID_ITEM_HEIGHT : CATALOG_ROW_HEIGHT,
        rowGap: view === "grid" ? CATALOG_GRID_GAP : 0,
        scrollTop,
        viewportHeight: viewportSize.height,
        overscan: 6,
    });
    const visibleCatalogRows = catalogRows.slice(catalogWindow.start, catalogWindow.end);

    useEffect(() => {
        if (selectedAssetId && !catalogRows.some((row) => row.kind === "model" && row.asset.id === selectedAssetId)) {
            setSelectedAssetId(null);
        }
        if (contextMenu?.kind === "asset" && !catalogRows.some((row) => row.kind === "model" && row.asset.id === contextMenu.id)) {
            setContextMenu(null);
        }
        if (contextMenu?.kind === "folder" && !catalog.folders.some((entry) => entry.id === contextMenu.id)) {
            setContextMenu(null);
        }
    }, [catalog.folders, catalogRows, contextMenu, selectedAssetId]);

    useEffect(() => {
        const element = listRef.current;
        if (!element || typeof ResizeObserver !== "function") return undefined;
        const observer = new ResizeObserver((entries) => {
            const { width, height } = entries[0]?.contentRect ?? {};
            if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
                setViewportSize({ width, height });
            }
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);
    useEffect(() => {
        setScrollTop(0);
        if (listRef.current) listRef.current.scrollTop = 0;
    }, [folder, kind, query, showArchived, sort, view]);
    const uploadSources = capabilities.sources ?? [];
    const importReason = !repository
        ? "Asset catalog is not ready."
        : uploadSources.length === 0
            ? "No upload source is configured. Add an owned grant to visual-source-registry.json."
            : !sourceId
                ? "Choose an upload source."
                : busy
                    ? "Import is already in progress."
                    : null;
    const canImport = !importReason;
    const importTitle = importReason ?? "Import a GLTF or GLB model.";
    const statusText = message ?? (uploadSources.length === 0 || !repository ? importReason : null);

    const openImportPicker = (reimportAssetId = "") => {
        const input = fileInputRef.current;
        if (!canImport || !input) {
            if (importReason) setMessage(importReason);
            return false;
        }
        input.dataset.reimport = reimportAssetId;
        input.click();
        return true;
    };

    const armBuiltin = (asset) => {
        const editor = data.editor?.();
        if (!editor) return;
        if (activeId === asset.id) {
            if (inMap) editor.setActiveMapTool(MAP_TOOLS.SELECT);
            else editor.setActiveTool(EDITOR_TOOLS.SELECT);
        } else editor.setPlacementAsset({ kind: "builtin", ...asset });
        data.simulation?.()?.render?.();
    };
    const armModel = (asset) => {
        data.editor?.()?.setPlacementAsset?.({ kind: "catalog", assetId: asset.id, revision: asset.latestRevision, label: asset.name });
        data.simulation?.()?.render?.();
    };
    const openModel = (asset, pinned = false) => data.editor?.()?.openAssetTab?.({ id: asset.id, revision: asset.latestRevision, name: asset.name }, { pinned });

    const mutate = async (action) => {
        setBusy(true);
        setMessage(null);
        try { await action(); await refresh(); } catch (error) {
            setMessage(error.code === "EDITOR_ASSET_REVISION_CONFLICT" ? "The catalog changed. It has been refreshed; retry your change." : error.message);
            await refresh();
        } finally { setBusy(false); }
    };

    const beginFiles = async (fileList, reimportAsset = null) => {
        const files = await Promise.all([...fileList].map(async (file) => ({ path: pathOf(file), bytes: new Uint8Array(await file.arrayBuffer()) })));
        const entries = files.map((file) => file.path).filter((filePath) => /\.(gltf|glb)$/i.test(filePath));
        if (entries.length === 0) { setMessage("Select a GLTF or GLB model."); return; }
        setPendingImport({ files, entries, entryPath: entries.length === 1 ? entries[0] : "", reimportAsset });
    };

    const publishImport = () => mutate(async () => {
        if (!pendingImport?.entryPath || !sourceId) throw new Error("Choose an entry model and source.");
        const imported = await repository.import(pendingImport.files, sourceId, undefined, { entryPath: pendingImport.entryPath });
        const existing = pendingImport.reimportAsset;
        const draft = {
            assetId: existing?.id ?? portableId(),
            name: existing?.name ?? imported.suggestedName,
            folderId: existing?.folderId ?? (folder !== "all" && folder !== "built-ins" && folder !== "root" ? folder : null),
            tags: existing?.tags ?? [],
            publicationId: imported.publicationId,
            modelUseHash: imported.modelUseHash,
        };
        const published = existing
            ? await repository.publishRevision(existing.id, draft, catalog.catalogRevision)
            : await repository.publish(draft, catalog.catalogRevision);
        setPendingImport(null);
        // Publication is the model-availability boundary. Reflect the new
        // immutable revision before the best-effort thumbnail job runs.
        await refresh();
        void repository.generateThumbnail(
            draft.assetId,
            published.revision.revision,
            published.catalogRevision,
            data.environment().assets().previews,
        ).then(refresh).catch((error) => {
            setMessage(`Model imported. Thumbnail needs retry: ${error.message}`);
        });
    });

    const createFolder = () => {
        const parentId = isVirtualFolder(folder) ? null : folder;
        const id = portableId("folder");
        const name = untitledFolderName(catalog.folders, parentId);
        void mutate(async () => {
            await repository.createFolder({ id, name, parentId }, catalog.catalogRevision);
            setFolder(id);
            setFolderRename(null);
        });
    };
    const commitFolderRename = async () => {
        if (!folderRename) return;
        const name = folderRename.draft.trim();
        if (!name || name === folderRename.original) {
            setFolderRename(null);
            return;
        }
        setBusy(true);
        setMessage(null);
        try {
            await repository.updateFolder(folderRename.id, { name }, catalog.catalogRevision);
            setFolderRename(null);
            await refresh();
        } catch (error) {
            setMessage(error.code === "EDITOR_ASSET_REVISION_CONFLICT" ? "The catalog changed. It has been refreshed; retry your change." : error.message);
            await refresh();
        } finally { setBusy(false); }
    };
    const deleteFolderById = (target) => {
        if (!target || !globalThis.confirm?.(`Delete empty folder “${target.name}”?`)) return;
        void mutate(async () => {
            await repository.deleteFolder(target.id, catalog.catalogRevision);
            if (folder === target.id) setFolder(target.parentId ?? "all");
            setFolderRename(null);
        });
    };
    const moveFolder = (target, parentId) => {
        if (!target) return;
        if ((target.parentId ?? null) === (parentId ?? null)) return;
        void mutate(() => repository.updateFolder(target.id, { parentId }, catalog.catalogRevision));
    };
    const moveAsset = (asset, folderId) => {
        if (!asset) return;
        const next = folderId ?? null;
        if ((asset.folderId ?? null) === next) return;
        void mutate(() => repository.update(asset.id, { folderId: next }, catalog.catalogRevision));
    };
    const clearCatalogDrag = () => {
        catalogDragRef.current = null;
        setDropTargetId(null);
    };
    const beginAssetDrag = (asset, event) => {
        if (asset.archived) {
            event.preventDefault();
            return;
        }
        const payload = { kind: "asset", id: asset.id, folderId: asset.folderId ?? null };
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData(CATALOG_DRAG_MIME, JSON.stringify(payload));
        event.dataTransfer.setData(PLACEMENT_DRAG_MIME, JSON.stringify({ kind: "catalog", assetId: asset.id, revision: asset.latestRevision, label: asset.name }));
        catalogDragRef.current = payload;
    };
    const beginFolderDrag = (entry, event) => {
        if (isVirtualFolder(entry.id) || folderRename) {
            event.preventDefault();
            return;
        }
        const payload = { kind: "folder", id: entry.id, parentId: entry.parentId ?? null };
        event.dataTransfer.effectAllowed = "copyMove";
        event.dataTransfer.setData(CATALOG_DRAG_MIME, JSON.stringify(payload));
        catalogDragRef.current = payload;
    };
    const acceptCatalogDrop = (entry, event) => {
        const payload = parseCatalogDragPayload(event.dataTransfer.getData(CATALOG_DRAG_MIME)) ?? catalogDragRef.current;
        if (!payload) return;
        event.preventDefault();
        event.stopPropagation();
        catalogDragRef.current = null;
        setDropTargetId(null);
        if (busy || !canAcceptCatalogDrop(payload, entry, catalog.folders)) return;
        const destination = catalogDropDestination(entry);
        if (!destination) return;
        if (payload.kind === "asset") {
            const asset = catalog.assets.find((item) => item.id === payload.id);
            if (asset) moveAsset(asset, destination.folderId);
            return;
        }
        const target = catalog.folders.find((item) => item.id === payload.id);
        if (target) moveFolder(target, destination.parentId);
    };
    const onFolderDragOver = (entry, event) => {
        const types = [...event.dataTransfer.types];
        if (!types.includes(CATALOG_DRAG_MIME) && !catalogDragRef.current) return;
        const payload = catalogDragRef.current ?? parseCatalogDragPayload(event.dataTransfer.getData(CATALOG_DRAG_MIME));
        if (busy || !canAcceptCatalogDrop(payload, entry, catalog.folders)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropTargetId !== entry.id) setDropTargetId(entry.id);
    };
    const onFolderDragLeave = (entry, event) => {
        const related = event.relatedTarget;
        if (related && event.currentTarget.contains(related)) return;
        if (dropTargetId === entry.id) setDropTargetId(null);
    };
    const onFolderClick = (entry) => {
        if (isVirtualFolder(entry.id)) {
            setFolder(entry.id);
            setFolderRename(null);
            return;
        }
        if (folder === entry.id) {
            setFolderRename({ id: entry.id, draft: entry.name, original: entry.name });
            return;
        }
        setFolder(entry.id);
        setFolderRename(null);
    };
    const openFolderMenu = (entry, event) => {
        event.preventDefault();
        event.stopPropagation();
        if (isVirtualFolder(entry.id)) return;
        setFolder(entry.id);
        setContextMenu({ kind: "folder", id: entry.id, x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
    };
    const openAssetMenu = (asset, event) => {
        event.preventDefault();
        event.stopPropagation();
        setSelectedAssetId(asset.id);
        setContextMenu({ kind: "asset", id: asset.id, x: event.clientX, y: event.clientY, returnFocus: event.currentTarget });
    };
    const editAsset = (asset) => {
        const name = globalThis.prompt?.("Asset name", asset.name)?.trim();
        if (!name) return;
        const tagsText = globalThis.prompt?.("Comma-separated tags", asset.tags.join(", "));
        if (tagsText === null || tagsText === undefined) return;
        void mutate(() => repository.update(asset.id, { name, tags: tagsText.split(",").map((tag) => tag.trim()).filter(Boolean) }, catalog.catalogRevision));
    };

    const contextFolder = contextMenu?.kind === "folder" ? catalog.folders.find((entry) => entry.id === contextMenu.id) ?? null : null;
    const contextAsset = contextMenu?.kind === "asset" ? catalog.assets.find((entry) => entry.id === contextMenu.id) ?? null : null;
    const blockedFolderIds = contextFolder ? folderSubtreeIds(catalog.folders, contextFolder.id) : new Set();
    const folderMenuOptions = contextFolder ? [
        { id: "rename", label: "Rename", run: () => setFolderRename({ id: contextFolder.id, draft: contextFolder.name, original: contextFolder.name }) },
        {
            id: "move-to",
            label: "Move to",
            children: [
                { id: "move-top", label: "Top level", run: () => moveFolder(contextFolder, null) },
                ...catalog.folders.filter((entry) => !blockedFolderIds.has(entry.id)).map((entry) => ({
                    id: `move-${entry.id}`,
                    label: entry.name,
                    run: () => moveFolder(contextFolder, entry.id),
                })),
            ],
        },
        { id: "delete", label: "Delete", danger: true, run: () => deleteFolderById(contextFolder) },
    ] : [];
    const assetMenuOptions = contextAsset ? [
        { id: "place", label: "Place", disabled: contextAsset.archived === true, run: () => armModel(contextAsset) },
        {
            id: "move-to",
            label: "Move to",
            children: [
                { id: "move-unfiled", label: "Unfiled", disabled: contextAsset.folderId == null, run: () => moveAsset(contextAsset, null) },
                ...catalog.folders.filter((entry) => entry.id !== contextAsset.folderId).map((entry) => ({
                    id: `move-asset-${entry.id}`,
                    label: entry.name,
                    run: () => moveAsset(contextAsset, entry.id),
                })),
            ],
        },
        { id: "reimport", label: "Reimport", disabled: !canImport, run: () => openImportPicker(contextAsset.id) },
        { id: "edit", label: "Edit metadata", run: () => editAsset(contextAsset) },
        { id: "archive", label: contextAsset.archived ? "Unarchive" : "Archive", run: () => void mutate(() => repository.setArchived(contextAsset.id, !contextAsset.archived, catalog.catalogRevision)) },
        ...(!thumbnailUrl(contextAsset) ? [{
            id: "retry-thumbnail",
            label: "Retry thumbnail",
            run: () => void mutate(() => repository.generateThumbnail(contextAsset.id, contextAsset.latestRevision, catalog.catalogRevision, data.environment().assets().previews)),
        }] : []),
    ] : [];

    return (
        <div className="flex h-full min-h-0" data-editor-asset-library onDragEnd={clearCatalogDrag}>
            <nav aria-label="Asset folders" className="flex w-44 shrink-0 flex-col overflow-auto border-r border-[var(--slate-border-60)] p-1.5">
                {[{ id: "all", name: "All assets" }, { id: "built-ins", name: "Built-ins" }, { id: "root", name: "Unfiled models" }, ...catalog.folders].map((entry) => (
                    folderRename?.id === entry.id ? (
                        <input
                            key={entry.id}
                            aria-label="Rename folder"
                            value={folderRename.draft}
                            autoFocus
                            onChange={(event) => setFolderRename((current) => current ? { ...current, draft: event.target.value } : current)}
                            onBlur={() => void commitFolderRename()}
                            onKeyDown={(event) => {
                                event.stopPropagation();
                                if (event.key === "Enter") {
                                    event.preventDefault();
                                    void commitFolderRename();
                                } else if (event.key === "Escape") {
                                    event.preventDefault();
                                    setFolderRename(null);
                                }
                            }}
                            className="h-8 rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-surface-2)] px-2 text-[12px] outline-none"
                        />
                    ) : (
                        <button
                            key={entry.id}
                            type="button"
                            data-folder-id={entry.id}
                            data-drop-target={dropTargetId === entry.id || undefined}
                            draggable={!isVirtualFolder(entry.id)}
                            aria-current={folder === entry.id ? "page" : undefined}
                            onClick={() => onFolderClick(entry)}
                            onContextMenu={(event) => openFolderMenu(entry, event)}
                            onDragStart={(event) => beginFolderDrag(entry, event)}
                            onDragOver={catalogDropDestination(entry) ? (event) => onFolderDragOver(entry, event) : undefined}
                            onDragLeave={catalogDropDestination(entry) ? (event) => onFolderDragLeave(entry, event) : undefined}
                            onDrop={catalogDropDestination(entry) ? (event) => acceptCatalogDrop(entry, event) : undefined}
                            className={cn(
                                "flex h-8 items-center gap-2 rounded-[var(--radius)] px-2 text-left text-[12px] text-[var(--slate-fg-2)] hover:bg-[var(--slate-surface-hover)]",
                                folder === entry.id && "bg-[var(--slate-surface-3)] text-[var(--slate-fg)]",
                                dropTargetId === entry.id && "bg-[var(--slate-surface-3)] text-[var(--slate-fg)] ring-1 ring-inset ring-[var(--slate-ring)]",
                            )}
                        >
                            <IconFolder size={14} aria-hidden="true" />{entry.name}
                        </button>
                    )
                ))}
                <button type="button" disabled={busy} onClick={createFolder} className="mt-1 flex h-8 items-center gap-2 px-2 text-left text-[12px] text-[var(--slate-muted)] hover:text-[var(--slate-fg)]"><IconFolderPlus size={14} />New folder</button>
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
                <div data-editor-chrome className="pointer-events-auto flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--slate-border-60)] px-3 py-1.5">
                    <span aria-label="Asset breadcrumb" className="max-w-28 truncate text-xs text-zinc-400">Assets / {selectedFolder?.name ?? (folder === "built-ins" ? "Built-ins" : folder === "root" ? "Unfiled" : "All")}</span>
                    <label className="flex h-7 min-w-40 flex-1 items-center gap-1.5 rounded border border-[var(--slate-border-70)] px-2"><IconSearch size={13} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names or tags" aria-label="Search assets" className="min-w-0 flex-1 bg-transparent text-[12px] outline-none" /></label>
                    <select aria-label="Asset kind" value={kind} onChange={(event) => setKind(event.target.value)} className="h-7 rounded bg-[var(--slate-surface-2)] px-1 text-xs"><option value="all">All kinds</option><option value="builtins">Built-ins</option><option value="models">Models</option></select>
                    <select aria-label="Sort assets" value={sort} onChange={(event) => setSort(event.target.value)} className="h-7 rounded bg-[var(--slate-surface-2)] px-1 text-xs"><option value="name">Name</option><option value="updated">Updated</option></select>
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Archived</label>
                    <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><IconSquares size={16} /></button>
                    <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><IconList size={16} /></button>
                    {uploadSources.length > 0
                        ? <select aria-label="Import source" value={sourceId} onChange={(event) => setSourceId(event.target.value)} className="h-7 max-w-32 rounded bg-[var(--slate-surface-2)] px-1 text-xs">{uploadSources.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</select>
                        : <span className="text-xs text-zinc-500">No upload source</span>}
                    <label
                        htmlFor={canImport ? importInputId : undefined}
                        data-editor-asset-import
                        aria-disabled={!canImport || undefined}
                        aria-describedby={statusText ? importHintId : undefined}
                        title={importTitle}
                        className={cn(
                            "flex h-7 items-center gap-1 rounded px-2 text-xs",
                            canImport ? "cursor-pointer hover:bg-[var(--slate-surface-hover)]" : "cursor-not-allowed opacity-45",
                        )}
                        onClick={() => {
                            if (!canImport) {
                                setMessage(importReason);
                                return;
                            }
                            if (fileInputRef.current) fileInputRef.current.dataset.reimport = "";
                        }}
                    >
                        <IconUpload size={14} aria-hidden="true" />
                        Import
                    </label>
                    <input
                        id={importInputId}
                        ref={fileInputRef}
                        type="file"
                        multiple
                        accept=".gltf,.glb,.bin,image/*,.ktx2"
                        aria-label="Import"
                        tabIndex={canImport ? undefined : -1}
                        className="sr-only"
                        onChange={(event) => {
                            if (!canImport) {
                                event.currentTarget.value = "";
                                return;
                            }
                            const targetId = event.currentTarget.dataset.reimport;
                            const target = catalog.assets.find((asset) => asset.id === targetId) ?? null;
                            void beginFiles(event.currentTarget.files, target);
                            event.currentTarget.value = "";
                        }}
                    />
                </div>
                {pendingImport && <div className="flex items-center gap-2 border-b border-amber-700/40 bg-amber-950/30 px-2 py-1 text-xs"><span>Entry model</span><select aria-label="Entry model" value={pendingImport.entryPath} onChange={(event) => setPendingImport((current) => ({ ...current, entryPath: event.target.value }))}><option value="">Choose…</option>{pendingImport.entries.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select><button type="button" disabled={busy || !pendingImport.entryPath} onClick={publishImport}>Publish</button><button type="button" onClick={() => setPendingImport(null)}>Cancel</button></div>}
                {statusText && <p id={importHintId} role="status" className="border-b border-[var(--slate-border-60)] px-2 py-1 text-xs text-amber-300">{statusText}</p>}
                <div
                    ref={listRef}
                    role="list"
                    aria-label="Assets"
                    data-row-count={catalogRows.length}
                    data-rendered-rows={visibleCatalogRows.length}
                    className="relative min-h-0 flex-1 overflow-auto p-2"
                    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                >
                    {catalogRows.length === 0 && <p className="p-2 text-xs text-zinc-400">No assets match.</p>}
                    <div data-catalog-spacer="true" style={{ height: `${catalogWindow.totalHeight}px` }} className="relative">
                        <div
                            style={{
                                transform: `translateY(${catalogWindow.offsetTop}px)`,
                                ...(view === "grid" ? {
                                    gridTemplateColumns: `repeat(${catalogWindow.columns}, minmax(0, 1fr))`,
                                    gridAutoRows: `${catalogWindow.itemHeight}px`,
                                } : {}),
                            }}
                            className={cn("absolute inset-x-0 top-0", view === "grid" ? "grid gap-1.5" : "flex flex-col")}
                        >
                            {visibleCatalogRows.map((row) => {
                                if (row.kind === "builtin") {
                                    const asset = row.asset;
                                    return <article role="listitem" key={row.key} style={{ height: `${catalogWindow.itemHeight}px` }}><button type="button" aria-pressed={activeId === asset.id} aria-label={`Place ${asset.label}`} onClick={() => armBuiltin(asset)} className="flex h-full w-full items-center gap-2 rounded border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] px-2 text-xs hover:bg-[var(--slate-surface-hover)]"><IconTrafficCone size={20} /><span className="truncate">{asset.label}</span></button></article>;
                                }
                                const asset = row.asset;
                                const image = thumbnailUrl(asset);
                                const selected = selectedAssetId === asset.id;
                                return <article
                                    role="listitem"
                                    key={row.key}
                                    tabIndex={0}
                                    data-asset-id={asset.id}
                                    data-selected={selected || undefined}
                                    aria-label={asset.name}
                                    draggable={!asset.archived}
                                    onDragStart={(event) => beginAssetDrag(asset, event)}
                                    onClick={() => setSelectedAssetId(asset.id)}
                                    onDoubleClick={() => openModel(asset)}
                                    onContextMenu={(event) => openAssetMenu(asset, event)}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                            event.preventDefault();
                                            openModel(asset);
                                        } else if (event.key === "F10" && event.shiftKey) {
                                            event.preventDefault();
                                            const rect = event.currentTarget.getBoundingClientRect();
                                            setSelectedAssetId(asset.id);
                                            setContextMenu({
                                                kind: "asset",
                                                id: asset.id,
                                                x: rect.left + 8,
                                                y: rect.top + 8,
                                                returnFocus: event.currentTarget,
                                            });
                                        }
                                    }}
                                    style={{ height: `${catalogWindow.itemHeight}px` }}
                                    className={cn(
                                        "flex cursor-pointer items-center gap-2 overflow-hidden rounded border p-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)]",
                                        selected
                                            ? "border-[var(--slate-border)] bg-[var(--slate-surface-3)]"
                                            : "border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] hover:bg-[var(--slate-surface-hover)]",
                                    )}
                                >
                                    {/* Use-scoped content URLs are authenticated API resources, not static Next images. */}
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    {image ? <img src={image} alt="" className="h-12 w-12 shrink-0 object-cover" /> : <IconPhoto size={24} className="mx-3 text-zinc-500" />}
                                    <span className="min-w-0 flex-1"><strong className="block truncate font-medium">{asset.name}</strong><span className="block truncate text-[11px] text-zinc-400">{asset.id} · r{asset.latestRevision}{asset.archived ? " · archived" : ""}</span></span>
                                </article>;
                            })}
                        </div>
                    </div>
                </div>
            </div>
            <ContextMenuSurface
                key={contextMenu ? `${contextMenu.kind}:${contextMenu.id}:${contextMenu.x}:${contextMenu.y}` : "closed"}
                open={Boolean(contextMenu)}
                x={contextMenu?.x ?? 0}
                y={contextMenu?.y ?? 0}
                options={contextMenu?.kind === "folder" ? folderMenuOptions : assetMenuOptions}
                returnFocus={contextMenu?.returnFocus ?? null}
                onClose={() => setContextMenu(null)}
            />
        </div>
    );
}
