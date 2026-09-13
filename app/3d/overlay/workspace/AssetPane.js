'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconArchive, IconFolder, IconFolderPlus, IconList, IconPhoto, IconSearch, IconSquares, IconTrafficCone, IconUpload } from "@tabler/icons-react";
import { EDITOR_MODES, EDITOR_TOOLS, MAP_TOOLS } from "../../editor/EditorState";
import { PLACEMENT_CATALOG } from "../../editor/placement/PlacementCatalog";
import { cn } from "../ui/cn";

function portableId(prefix = "asset") {
    return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
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
    const fileInputRef = useRef(null);
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
            setSourceId((current) => current || nextCapabilities.sources?.[0]?.id || "");
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
    const visibleBuiltins = kind !== "models" && (folder === "all" || folder === "built-ins") ? builtins : [];
    const visibleModels = kind !== "builtins" && folder !== "built-ins" ? models : [];
    const selectedFolder = catalog.folders.find((entry) => entry.id === folder) ?? null;

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
        const name = globalThis.prompt?.("Folder name")?.trim();
        if (name) void mutate(() => repository.createFolder({ name, parentId: folder === "all" || folder === "root" || folder === "built-ins" ? null : folder }, catalog.catalogRevision));
    };
    const renameFolder = () => {
        const name = globalThis.prompt?.("Folder name", selectedFolder?.name)?.trim();
        if (!selectedFolder || !name) return;
        const parentId = globalThis.prompt?.("Parent folder ID (leave blank for root)", selectedFolder.parentId ?? "");
        if (parentId !== null && parentId !== undefined) void mutate(() => repository.updateFolder(selectedFolder.id, { name, parentId: parentId.trim() || null }, catalog.catalogRevision));
    };
    const deleteFolder = () => {
        if (selectedFolder && globalThis.confirm?.(`Delete empty folder “${selectedFolder.name}”?`)) void mutate(async () => {
            await repository.deleteFolder(selectedFolder.id, catalog.catalogRevision);
            setFolder("all");
        });
    };
    const editAsset = (asset) => {
        const name = globalThis.prompt?.("Asset name", asset.name)?.trim();
        if (!name) return;
        const tagsText = globalThis.prompt?.("Comma-separated tags", asset.tags.join(", "));
        if (tagsText === null || tagsText === undefined) return;
        const folderId = globalThis.prompt?.("Folder ID (leave blank for unfiled)", asset.folderId ?? "");
        if (folderId === null || folderId === undefined) return;
        void mutate(() => repository.update(asset.id, { name, folderId: folderId.trim() || null, tags: tagsText.split(",").map((tag) => tag.trim()).filter(Boolean) }, catalog.catalogRevision));
    };

    return (
        <div className="flex h-full min-h-0" data-editor-asset-library>
            <nav aria-label="Asset folders" className="flex w-44 shrink-0 flex-col overflow-auto border-r border-[var(--slate-border-60)] p-1.5">
                {[{ id: "all", name: "All assets" }, { id: "built-ins", name: "Built-ins" }, { id: "root", name: "Unfiled models" }, ...catalog.folders].map((entry) => (
                    <button key={entry.id} type="button" aria-current={folder === entry.id ? "page" : undefined} onClick={() => setFolder(entry.id)} className={cn("flex h-8 items-center gap-2 rounded-[var(--radius)] px-2 text-left text-[12px] text-[var(--slate-fg-2)] hover:bg-[var(--slate-surface-hover)]", folder === entry.id && "bg-[var(--slate-surface-3)] text-[var(--slate-fg)]")}>
                        <IconFolder size={14} aria-hidden="true" />{entry.name}
                    </button>
                ))}
                <button type="button" disabled={busy} onClick={createFolder} className="mt-1 flex h-8 items-center gap-2 px-2 text-left text-[12px] text-[var(--slate-muted)] hover:text-[var(--slate-fg)]"><IconFolderPlus size={14} />New folder</button>
                {selectedFolder && <div className="flex gap-1 px-2"><button type="button" onClick={renameFolder} className="text-[11px] text-zinc-400">Rename</button><button type="button" onClick={deleteFolder} className="text-[11px] text-red-300">Delete</button></div>}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex min-h-10 shrink-0 flex-wrap items-center gap-1.5 border-b border-[var(--slate-border-60)] px-2 py-1">
                    <span aria-label="Asset breadcrumb" className="max-w-28 truncate text-xs text-zinc-400">Assets / {selectedFolder?.name ?? (folder === "built-ins" ? "Built-ins" : folder === "root" ? "Unfiled" : "All")}</span>
                    <label className="flex h-7 min-w-40 flex-1 items-center gap-1.5 rounded border border-[var(--slate-border-70)] px-2"><IconSearch size={13} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search names or tags" aria-label="Search assets" className="min-w-0 flex-1 bg-transparent text-[12px] outline-none" /></label>
                    <select aria-label="Asset kind" value={kind} onChange={(event) => setKind(event.target.value)} className="h-7 rounded bg-[var(--slate-surface-2)] px-1 text-xs"><option value="all">All kinds</option><option value="builtins">Built-ins</option><option value="models">Models</option></select>
                    <select aria-label="Sort assets" value={sort} onChange={(event) => setSort(event.target.value)} className="h-7 rounded bg-[var(--slate-surface-2)] px-1 text-xs"><option value="name">Name</option><option value="updated">Updated</option></select>
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} />Archived</label>
                    <button type="button" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><IconSquares size={16} /></button>
                    <button type="button" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}><IconList size={16} /></button>
                    <select aria-label="Import source" value={sourceId} onChange={(event) => setSourceId(event.target.value)} className="h-7 max-w-32 rounded bg-[var(--slate-surface-2)] px-1 text-xs">{capabilities.sources?.map((source) => <option key={source.id} value={source.id}>{source.label}</option>)}</select>
                    <button type="button" disabled={busy || !sourceId} onClick={() => { fileInputRef.current.dataset.reimport = ""; fileInputRef.current.click(); }} className="flex h-7 items-center gap-1 rounded px-2 text-xs hover:bg-[var(--slate-surface-hover)]"><IconUpload size={14} />Import</button>
                    <input ref={fileInputRef} hidden type="file" multiple accept=".gltf,.glb,.bin,image/*,.ktx2" onChange={(event) => { const targetId = event.currentTarget.dataset.reimport; const target = catalog.assets.find((asset) => asset.id === targetId) ?? null; void beginFiles(event.currentTarget.files, target); event.currentTarget.value = ""; }} />
                </div>
                {pendingImport && <div className="flex items-center gap-2 border-b border-amber-700/40 bg-amber-950/30 px-2 py-1 text-xs"><span>Entry model</span><select aria-label="Entry model" value={pendingImport.entryPath} onChange={(event) => setPendingImport((current) => ({ ...current, entryPath: event.target.value }))}><option value="">Choose…</option>{pendingImport.entries.map((entry) => <option key={entry} value={entry}>{entry}</option>)}</select><button type="button" disabled={busy || !pendingImport.entryPath} onClick={publishImport}>Publish</button><button type="button" onClick={() => setPendingImport(null)}>Cancel</button></div>}
                {message && <p role="status" className="border-b border-[var(--slate-border-60)] px-2 py-1 text-xs text-amber-300">{message}</p>}
                <div role="list" aria-label="Assets" className={cn("min-h-0 flex-1 gap-1.5 overflow-auto p-2", view === "grid" ? "grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(130px,1fr))]" : "flex flex-col")}>
                    {visibleBuiltins.map((asset) => <article role="listitem" key={asset.id}><button type="button" aria-pressed={activeId === asset.id} aria-label={`Place ${asset.label}`} onClick={() => armBuiltin(asset)} className="flex h-16 w-full items-center gap-2 rounded border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] px-2 text-xs hover:bg-[var(--slate-surface-hover)]"><IconTrafficCone size={20} /><span className="truncate">{asset.label}</span></button></article>)}
                    {visibleModels.map((asset) => {
                        const image = thumbnailUrl(asset);
                        return <article role="listitem" key={asset.id} data-asset-id={asset.id} draggable={!asset.archived} onDragStart={(event) => event.dataTransfer.setData("application/x-cev-editor-asset", JSON.stringify({ kind: "catalog", assetId: asset.id, revision: asset.latestRevision, label: asset.name }))} className="group flex min-h-16 items-center gap-2 rounded border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] p-1.5 text-xs focus-within:ring-2">
                            <button type="button" aria-label={`Open asset ${asset.name}`} onClick={() => openModel(asset)} onDoubleClick={() => openModel(asset, true)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                                {/* Use-scoped content URLs are authenticated API resources, not static Next images. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {image ? <img src={image} alt="" className="h-12 w-12 shrink-0 object-cover" /> : <IconPhoto size={24} className="mx-3 text-zinc-500" />}
                                <span className="min-w-0 flex-1"><strong className="block truncate font-medium">{asset.name}</strong><span className="text-[11px] text-zinc-400">r{asset.latestRevision}{asset.archived ? " · archived" : ""}</span></span>
                            </button>
                            <span className="flex flex-col gap-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                                <button type="button" disabled={asset.archived} onClick={(event) => { event.stopPropagation(); armModel(asset); }} aria-label={`Place ${asset.name}`} className="rounded px-1 hover:bg-zinc-700">Place</button>
                                <button type="button" onClick={(event) => { event.stopPropagation(); fileInputRef.current.dataset.reimport = asset.id; fileInputRef.current.click(); }} aria-label={`Reimport ${asset.name}`} className="rounded px-1 hover:bg-zinc-700">Reimport</button>
                                <button type="button" onClick={(event) => { event.stopPropagation(); editAsset(asset); }} aria-label={`Edit ${asset.name}`} className="rounded px-1 hover:bg-zinc-700">Edit</button>
                                <button type="button" onClick={(event) => { event.stopPropagation(); void mutate(() => repository.setArchived(asset.id, !asset.archived, catalog.catalogRevision)); }} aria-label={`${asset.archived ? "Unarchive" : "Archive"} ${asset.name}`}><IconArchive size={14} /></button>
                                {!image && <button type="button" onClick={(event) => { event.stopPropagation(); void mutate(() => repository.generateThumbnail(asset.id, asset.latestRevision, catalog.catalogRevision, data.environment().assets().previews)); }} aria-label={`Retry thumbnail for ${asset.name}`}>Retry</button>}
                            </span>
                        </article>;
                    })}
                    {visibleBuiltins.length + visibleModels.length === 0 && <p className="p-2 text-xs text-zinc-400">No assets match.</p>}
                </div>
            </div>
        </div>
    );
}
