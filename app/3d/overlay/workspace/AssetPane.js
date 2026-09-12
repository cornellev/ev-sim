'use client';

import { useEffect, useMemo, useState } from "react";
import { IconFolder, IconSearch, IconTrafficCone } from "@tabler/icons-react";
import { EDITOR_MODES, EDITOR_TOOLS, MAP_TOOLS } from "../../editor/EditorState";
import { PLACEMENT_CATALOG } from "../../editor/placement/PlacementCatalog";
import { cn } from "../ui/cn";

const FOLDERS = Object.freeze([{ id: "built-ins", label: "Built-ins" }]);

/**
 * Asset pane shell (ED-03): the built-in prop catalog in a folder/grid
 * arrangement. Clicking a tile arms placement in the active view. ED-06
 * replaces the contents with the server-backed catalog.
 */
export function AssetPane({ data }) {
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [query, setQuery] = useState("");
    const [folder, setFolder] = useState(FOLDERS[0].id);
    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);

    const items = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return PLACEMENT_CATALOG.filter((asset) => !needle || asset.label.toLowerCase().includes(needle) || asset.id.includes(needle));
    }, [query]);

    if (!data) return null;
    const inMap = editorSnapshot?.editorMode === EDITOR_MODES.MAP;
    const activeId = inMap
        ? (editorSnapshot?.map?.activeMapTool === MAP_TOOLS.FEATURE_PLACE ? editorSnapshot.map.activeFeatureType : null)
        : (editorSnapshot?.activeTool === EDITOR_TOOLS.PLACE ? editorSnapshot?.activePlacement?.id ?? null : null);

    const arm = (asset) => {
        const editor = data.editor?.();
        if (!editor) return;
        if (activeId === asset.id) {
            if (inMap) editor.setActiveMapTool(MAP_TOOLS.SELECT);
            else editor.setActiveTool(EDITOR_TOOLS.SELECT);
        } else if (inMap) {
            editor.setMapFeatureType(asset.id);
        } else {
            editor.setPlacementAsset(asset);
        }
        data.simulation?.()?.render?.();
    };

    return (
        <div className="flex h-full min-h-0">
            <nav aria-label="Asset folders" className="flex w-40 shrink-0 flex-col border-r border-[var(--slate-border-60)] p-1.5">
                {FOLDERS.map((entry) => (
                    <button
                        key={entry.id}
                        type="button"
                        aria-current={folder === entry.id ? "true" : undefined}
                        onClick={() => setFolder(entry.id)}
                        className={cn(
                            "flex h-8 items-center gap-2 rounded-[var(--radius)] px-2 text-left text-[12px] text-[var(--slate-fg-2)] hover:bg-[var(--slate-surface-hover)]",
                            folder === entry.id && "bg-[var(--slate-surface-3)] text-[var(--slate-fg)]",
                        )}
                    >
                        <IconFolder size={14} stroke={1.75} aria-hidden="true" />
                        {entry.label}
                    </button>
                ))}
            </nav>
            <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--slate-border-60)] px-2">
                    <nav aria-label="Breadcrumbs" className="text-[12px] text-[var(--slate-muted)]">
                        <span className="text-[var(--slate-fg-2)]">Built-ins</span>
                    </nav>
                    <label className="ml-auto flex h-7 w-52 items-center gap-1.5 rounded-[var(--radius)] border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] px-2">
                        <IconSearch size={13} stroke={1.75} className="shrink-0 text-[var(--slate-muted)]" aria-hidden="true" />
                        <input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder="Search assets"
                            aria-label="Search assets"
                            className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--slate-fg)] outline-none placeholder:text-[var(--slate-muted)]"
                        />
                    </label>
                </div>
                <div role="group" aria-label="Built-in assets" className="grid min-h-0 flex-1 auto-rows-max grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-1.5 overflow-auto p-2">
                    {items.length === 0 && <p className="col-span-full px-1 py-2 text-[12px] text-[var(--slate-muted)]">No assets match.</p>}
                    {items.map((asset) => {
                        const active = activeId === asset.id;
                        return (
                            <button
                                key={asset.id}
                                type="button"
                                aria-pressed={active}
                                aria-label={`Place ${asset.label}`}
                                data-asset-id={asset.id}
                                onClick={() => arm(asset)}
                                className={cn(
                                    "flex h-[72px] flex-col items-center justify-center gap-1.5 rounded-[var(--radius)] border border-[var(--slate-border-70)] bg-[var(--slate-surface-2)] px-2 text-[12px] text-[var(--slate-fg-2)] hover:bg-[var(--slate-surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)]",
                                    active && "border-[var(--slate-fg-2)] bg-[var(--slate-surface-3)] text-[var(--slate-fg)]",
                                )}
                            >
                                <span className="relative inline-flex">
                                    <IconTrafficCone size={20} stroke={1.5} aria-hidden="true" />
                                    <span aria-hidden="true" className="absolute -right-1 -top-1 h-2 w-2 rounded-full" style={{ backgroundColor: asset.mapColor }} />
                                </span>
                                <span className="truncate">{asset.label}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
