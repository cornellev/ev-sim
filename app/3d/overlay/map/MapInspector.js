'use client';

import { useMemo } from "react";
import {
    FaArrowsAlt,
    FaBuilding,
    FaRoad,
    FaTh,
    FaTimes,
    FaTrafficLight,
    FaTrash,
} from "react-icons/fa";
import { MAP_SELECTION_TYPES } from "../../editor/EditorState";
import {
    footprintDimensions,
    getMapSelectionRecord,
    getNodeDegree,
} from "../../editor/document/documentMutations.js";
import { handleMapDelete } from "../../editor/map/MapToolLogic.js";
import { getPlacementAsset } from "../../editor/placement/PlacementCatalog";
import { MenuButton } from "../ui/MenuButton";

const INSPECTOR_CONTROL_LOCK = "map-mode-inspector";

function formatNumber(value, digits = 1) {
    if (!Number.isFinite(value)) return "0";
    return value.toFixed(digits);
}

function shortId(value) {
    const text = String(value ?? "");
    if (text.length <= 18) return text;
    return `${text.slice(0, 10)}...${text.slice(-4)}`;
}

function Field({ label, value, mono = false }) {
    return (
        <div className="rounded-lg border border-zinc-800/90 bg-zinc-950/45 px-2 py-1.5">
            <p className="text-[9px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</p>
            <p className={`${mono ? "font-mono" : ""} mt-0.5 truncate text-[11px] text-zinc-200`} title={String(value ?? "")}>
                {value ?? "None"}
            </p>
        </div>
    );
}

function getSelectionMeta(selection, record) {
    if (!selection || !record) {
        return {
            title: "No selection",
            subtitle: "Select a building, feature, road, or intersection on the map.",
            icon: <FaTh className="h-3 w-3" />,
        };
    }

    if (selection.type === MAP_SELECTION_TYPES.BUILDING) {
        const { width, depth } = footprintDimensions(record.footprint);
        return {
            title: "Building",
            subtitle: `${formatNumber(width)}m × ${formatNumber(depth)}m footprint`,
            icon: <FaBuilding className="h-3 w-3" />,
            height: record.height,
            width,
            depth,
        };
    }

    if (selection.type === MAP_SELECTION_TYPES.FEATURE) {
        const asset = getPlacementAsset(record.type);
        return {
            title: asset?.label ?? "Feature",
            subtitle: record.type,
            icon: <FaTh className="h-3 w-3" />,
            movable: true,
        };
    }

    if (selection.type === MAP_SELECTION_TYPES.ROAD) {
        return {
            title: "Road Segment",
            subtitle: `${record.width ?? 7}m wide`,
            icon: <FaRoad className="h-3 w-3" />,
            width: record.width ?? 7,
            lanes: record.laneCount ?? 2,
        };
    }

    if (selection.type === MAP_SELECTION_TYPES.INTERSECTION) {
        return {
            title: "Intersection",
            subtitle: `${formatNumber(record.x)}, ${formatNumber(record.z)}`,
            icon: <FaTrafficLight className="h-3 w-3" />,
        };
    }

    return {
        title: "Selection",
        subtitle: selection.type,
        icon: <FaTh className="h-3 w-3" />,
    };
}

function getScene(data) {
    return data?.three?.()?.scene ?? data?.scene ?? null;
}

export function MapInspector({ data, editorSnapshot, documentSnapshot }) {
    const selection = editorSnapshot?.map?.selection ?? null;
    const record = selection
        ? getMapSelectionRecord(documentSnapshot, selection)
        : null;
    const meta = getSelectionMeta(selection, record);
    const connectedRoads = selection?.type === MAP_SELECTION_TYPES.INTERSECTION && record
        ? getNodeDegree(documentSnapshot, record.id)
        : 0;

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(INSPECTOR_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(INSPECTOR_CONTROL_LOCK),
        };
    }, [data]);

    const clearSelection = () => {
        data?.editor?.()?.clearMapSelection?.();
    };

    const deleteSelection = () => {
        const editor = data?.editor?.();
        const environment = data?.environment?.();
        const scene = getScene(data);
        if (!editor || !environment || !scene || !selection) return;

        handleMapDelete({
            document: environment.getDocument(),
            editor,
            data,
            scene,
            selection,
        });
    };

    if (!selection || !record) {
        return null;
    }

    return (
        <div
            className="fixed right-3 top-3 z-[25] w-[320px] rounded-2xl border border-zinc-700/80 bg-zinc-950/88 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl pointer-events-auto"
            onMouseDown={controls.disable}
            onMouseUp={controls.enable}
            onMouseLeave={controls.enable}
        >
            <div className="mb-2 flex items-start justify-between rounded-xl border border-zinc-700/80 bg-zinc-900/70 p-2">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl border border-sky-400/50 bg-sky-500/15 text-sky-100">
                            {meta.icon}
                        </span>
                        <div className="min-w-0">
                            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Map Inspector</p>
                            <p className="truncate text-[13px] font-semibold text-zinc-100">{meta.title}</p>
                            <p className="truncate text-[10px] text-zinc-500">{meta.subtitle}</p>
                        </div>
                    </div>
                    <p className="mt-2 truncate font-mono text-[10px] text-zinc-500" title={selection.id}>
                        {shortId(selection.id)}
                    </p>
                </div>
                <MenuButton
                    iconOnly
                    variant="ghost"
                    className="h-7 w-7 rounded-lg"
                    onClick={clearSelection}
                    title="Clear selection"
                    ariaLabel="Clear selection"
                >
                    <FaTimes className="h-3 w-3" />
                </MenuButton>
            </div>

            <div className="space-y-2">
                {selection.type === MAP_SELECTION_TYPES.BUILDING && (
                    <div className="grid grid-cols-3 gap-1.5">
                        <Field label="Width" value={`${formatNumber(meta.width)}m`} mono />
                        <Field label="Depth" value={`${formatNumber(meta.depth)}m`} mono />
                        <Field label="Height" value={`${formatNumber(meta.height)}m`} mono />
                    </div>
                )}

                {selection.type === MAP_SELECTION_TYPES.FEATURE && (
                    <div className="grid grid-cols-2 gap-1.5">
                        <Field label="Type" value={record.type} />
                        <Field label="Position" value={`${formatNumber(record.x)}, ${formatNumber(record.z)}`} mono />
                    </div>
                )}

                {selection.type === MAP_SELECTION_TYPES.ROAD && (
                    <div className="grid grid-cols-2 gap-1.5">
                        <Field label="Width" value={`${formatNumber(meta.width)}m`} mono />
                        <Field label="Lanes" value={meta.lanes} mono />
                    </div>
                )}

                {selection.type === MAP_SELECTION_TYPES.INTERSECTION && (
                    <div className="grid grid-cols-2 gap-1.5">
                        <Field label="Position" value={`${formatNumber(record.x)}, ${formatNumber(record.z)}`} mono />
                        <Field label="Connected Roads" value={connectedRoads} mono />
                    </div>
                )}

                {selection.type === MAP_SELECTION_TYPES.INTERSECTION && connectedRoads > 0 && (
                    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[10px] text-amber-100/80">
                        Deleting removes this intersection and all {connectedRoads} connected road segment{connectedRoads === 1 ? "" : "s"}.
                    </div>
                )}

                {meta.movable && (
                    <div className="rounded-xl border border-zinc-800/90 bg-zinc-900/45 px-2.5 py-2 text-[10px] text-zinc-400">
                        <span className="inline-flex items-center gap-1.5 text-zinc-300">
                            <FaArrowsAlt className="h-3 w-3 text-sky-300" />
                            Drag the marker to reposition this prop.
                        </span>
                    </div>
                )}

                <div className="flex items-center justify-end gap-2 rounded-xl border border-zinc-800/90 bg-zinc-900/45 p-2">
                    <MenuButton compact variant="danger" onClick={deleteSelection} title="Delete selection">
                        <FaTrash className="h-3 w-3" />
                        Delete
                    </MenuButton>
                </div>
            </div>
        </div>
    );
}
