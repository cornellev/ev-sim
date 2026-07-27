'use client';

import { useEffect, useMemo, useState } from "react";
import { IconCube as FaCube, IconStack2 as FaLayerGroup, IconRoad as FaRoad } from "@tabler/icons-react";
import { cn } from "./ui/cn";

const LAYER_LABELS = {
    buildings: "Buildings",
    roads: "Roads",
    props: "Props",
};

const LAYER_ICONS = {
    buildings: FaCube,
    roads: FaRoad,
    props: FaLayerGroup,
};
const HIERARCHY_CONTROL_LOCK = "environment-scene-hierarchy";

function groupEntitiesByChunk(entities) {
    return entities.reduce((groups, entity) => {
        const key = entity.primaryChunk ?? "unchunked";
        if (!groups[key]) groups[key] = [];
        groups[key].push(entity);
        return groups;
    }, {});
}

export function SceneHierarchy({ data, compactOpen = false }) {
    const [registrySnapshot, setRegistrySnapshot] = useState({ entities: [], chunks: [] });
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [expandedChunks, setExpandedChunks] = useState({});

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(HIERARCHY_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(HIERARCHY_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => {
        const registry = data?.environment?.()?.objects?.();
        return registry?.subscribe?.(setRegistrySnapshot);
    }, [data]);

    useEffect(() => {
        const editor = data?.editor?.();
        return editor?.subscribe?.(setEditorSnapshot);
    }, [data]);

    if (!data) return null;

    const grouped = groupEntitiesByChunk(registrySnapshot.entities);
    const chunkKeys = Object.keys(grouped).sort((a, b) => {
        if (a === "unchunked") return 1;
        if (b === "unchunked") return -1;
        return a.localeCompare(b);
    });
    const selectedId = editorSnapshot?.selection?.id ?? null;
    const layers = editorSnapshot?.layers ?? {};

    const selectEntity = (entitySummary, event) => {
        event?.stopPropagation?.();
        const entity = data.environment()?.objects?.()?.getEntity?.(entitySummary.id) ?? entitySummary;
        data.editor()?.selectEntity(entity);
        data.simulation()?.render?.();
    };

    return (
        <div
            className={cn("absolute left-3 top-[58px] z-30 w-[312px] max-w-[calc(100vw-24px)] rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/85 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] pointer-events-auto", !compactOpen && "max-[1023px]:hidden")}
            onMouseDown={controls.disable}
            onMouseUp={controls.enable}
            onMouseLeave={controls.enable}
        >
            <div className="mb-2 flex items-center justify-between rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/70 px-2 py-1.5">
                <div>
                    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Hierarchy</p>
                    <p className="text-[11px] text-zinc-500">{registrySnapshot.entities.length} editable objects</p>
                </div>
                <div className="rounded-[var(--radius)] border border-zinc-700/80 px-2 py-1 font-mono text-[11px] text-zinc-300">
                    {registrySnapshot.chunks.length} chunks
                </div>
            </div>

            <div className="max-h-[60vh] space-y-1 overflow-auto pr-1">
                {chunkKeys.map((chunkKey) => {
                    const entities = grouped[chunkKey] ?? [];
                    const expanded = expandedChunks[chunkKey] !== false;

                    return (
                        <div key={chunkKey} className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-900/45 p-1">
                            <button
                                type="button"
                                className="flex w-full items-center justify-between rounded-[var(--radius)] px-2 py-1 text-left text-[11px] font-medium text-zinc-200 hover:bg-zinc-800/80"
                                onClick={() => setExpandedChunks((previous) => ({
                                    ...previous,
                                    [chunkKey]: !expanded,
                                }))}
                            >
                                <span>{expanded ? "▾" : "▸"} Chunk {chunkKey}</span>
                                <span className="font-mono text-[11px] text-zinc-500">{entities.length}</span>
                            </button>

                            {expanded && (
                                <div className="mt-1 space-y-1">
                                    {entities.map((entity) => {
                                        const Icon = LAYER_ICONS[entity.layer] ?? FaLayerGroup;
                                        const selected = selectedId === entity.id;
                                        const layerVisible = layers[entity.layer] !== false;
                                        return (
                                            <button
                                                key={entity.id}
                                                type="button"
                                                className={cn(
                                                    "flex w-full items-center gap-2 rounded-[var(--radius)] border px-2 py-1.5 text-left transition-colors",
                                                    selected
                                                        ? "border-sky-400/80 bg-sky-500/20 text-zinc-100"
                                                        : "border-zinc-800/90 bg-zinc-950/45 text-zinc-300 hover:bg-zinc-800/80",
                                                    (!layerVisible || entity.hidden) && "opacity-45",
                                                )}
                                                onClick={(event) => selectEntity(entity, event)}
                                                title={entity.id}
                                            >
                                                <Icon className="h-3 w-3 shrink-0 text-zinc-400" />
                                                <span className="min-w-0 flex-1 truncate text-[11px]">{entity.label}</span>
                                                <span className="rounded-[var(--radius)] bg-zinc-800/80 px-1.5 py-0.5 text-[11px] uppercase tracking-wide text-zinc-500">
                                                    {LAYER_LABELS[entity.layer] ?? entity.layer}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
