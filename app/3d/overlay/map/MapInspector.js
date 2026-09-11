'use client';

import { useMemo, useState } from "react";
import {
    IconArrowsMove as FaArrowsAlt,
    IconBuilding as FaBuilding,
    IconRoad as FaRoad,
    IconGridDots as FaTh,
    IconX as FaTimes,
    IconTrafficLights as FaTrafficLight,
    IconTrash as FaTrash,
} from "@tabler/icons-react";
import { MAP_SELECTION_TYPES } from "../../editor/EditorState";
import {
    footprintDimensions,
    getIntersectionMovements,
    getMapSelectionRecord,
    getNodeDegree,
    setRoadNodeElevation,
    setTurnMovementAllowed,
    updateRoadEdge,
} from "../../editor/document/documentMutations.js";
import { syncRoadsFromDocument } from "../../editor/document/DocumentSync.js";
import { handleMapDelete } from "../../editor/map/MapToolLogic.js";
import { getPlacementAsset } from "../../editor/placement/PlacementCatalog";
import { MenuButton } from "../ui/MenuButton";

const INSPECTOR_CONTROL_LOCK = "map-mode-inspector";

function formatNumber(value, digits = 1) {
    if (!Number.isFinite(value)) return "0";
    return value.toFixed(digits);
}

function nodeElevation(node) {
    const y = Number(node?.y);
    return Number.isFinite(y) ? y : 0;
}

function shortId(value) {
    const text = String(value ?? "");
    if (text.length <= 18) return text;
    return `${text.slice(0, 10)}...${text.slice(-4)}`;
}

function Field({ label, value, mono = false }) {
    return (
        <div className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-950/45 px-2 py-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</p>
            <p className={`${mono ? "font-mono" : ""} mt-0.5 truncate text-[11px] text-zinc-200`} title={String(value ?? "")}>
                {value ?? "None"}
            </p>
        </div>
    );
}

function ElevationField({ label, value, onCommit, onFocus, onBlur }) {
    const [draft, setDraft] = useState(null);
    const display = draft ?? String(formatNumber(value, 2));

    return (
        <label className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-950/45 px-2 py-1.5 block">
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</span>
            <input
                type="number"
                step="0.1"
                className="mt-0.5 w-full bg-transparent font-mono text-[11px] text-zinc-200 outline-none"
                value={display}
                onFocus={(event) => {
                    setDraft(String(formatNumber(value, 2)));
                    onFocus?.(event);
                }}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={(event) => {
                    const parsed = Number(event.target.value);
                    setDraft(null);
                    if (Number.isFinite(parsed) && parsed !== value) {
                        onCommit(parsed);
                    }
                    onBlur?.(event);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Enter") {
                        event.currentTarget.blur();
                    }
                }}
            />
        </label>
    );
}

function isRoadBidirectional(record) {
    return record?.bidirectional !== false && record?.oneWay !== true;
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
        const bidirectional = isRoadBidirectional(record);
        return {
            title: "Road Segment",
            subtitle: `${record.width ?? 7}m wide · ${bidirectional ? "two-way" : "one-way"}`,
            icon: <FaRoad className="h-3 w-3" />,
            width: record.width ?? 7,
            lanes: record.laneCount ?? 2,
            bidirectional,
        };
    }

    if (selection.type === MAP_SELECTION_TYPES.INTERSECTION) {
        return {
            title: "Intersection",
            subtitle: `${formatNumber(record.x)}, ${formatNumber(nodeElevation(record), 2)}, ${formatNumber(record.z)}`,
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
    const roadStartNode = selection?.type === MAP_SELECTION_TYPES.ROAD && record
        ? documentSnapshot?.roads?.nodes?.find((node) => node.id === record.startNodeId) ?? null
        : null;
    const roadEndNode = selection?.type === MAP_SELECTION_TYPES.ROAD && record
        ? documentSnapshot?.roads?.nodes?.find((node) => node.id === record.endNodeId) ?? null
        : null;
    const movementMatrix = (
        selection?.type === MAP_SELECTION_TYPES.INTERSECTION && record
            ? getIntersectionMovements(documentSnapshot, record.id)
            : null
    );

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

    const setRoadBidirectional = (bidirectional) => {
        const editor = data?.editor?.();
        const environment = data?.environment?.();
        const scene = getScene(data);
        if (!editor || !environment || !scene || !selection?.id) return;
        const document = environment.getDocument();
        const result = updateRoadEdge(document, selection.id, {
            bidirectional,
            direction: bidirectional ? null : 1,
        });
        if (!result.ok) return;
        editor.markDirty(true);
        syncRoadsFromDocument(data, scene, document);
        data.environment()?.objects?.()?.registerExistingContent?.(scene, data);
        data.simulation()?.render?.();
    };

    const commitNodeElevation = (nodeId, y) => {
        const editor = data?.editor?.();
        const environment = data?.environment?.();
        const scene = getScene(data);
        if (!editor || !environment || !scene || !nodeId) return;
        const document = environment.getDocument();
        const result = setRoadNodeElevation(document, nodeId, y);
        if (!result.ok) return;
        editor.markDirty(true);
        syncRoadsFromDocument(data, scene, document);
        data.environment()?.objects?.()?.registerExistingContent?.(scene, data);
        data.simulation()?.render?.();
    };

    const setMovementAllowed = (fromEdgeId, toEdgeId, allowed) => {
        const editor = data?.editor?.();
        const environment = data?.environment?.();
        if (!editor || !environment || !record?.id) return;
        const result = setTurnMovementAllowed(
            environment.getDocument(),
            record.id,
            fromEdgeId,
            toEdgeId,
            allowed,
        );
        if (!result.ok) return;
        editor.markDirty(true);
        data.simulation()?.render?.();
    };

    if (!selection || !record) {
        return null;
    }

    return (
        <div
            className="fixed right-3 top-3 z-[25] w-[320px] rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/88 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] pointer-events-auto"
            onMouseDown={controls.disable}
            onMouseUp={controls.enable}
            onMouseLeave={controls.enable}
        >
            <div className="mb-2 flex items-start justify-between rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/70 p-2">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius)] border border-sky-400/50 bg-sky-500/15 text-sky-100">
                            {meta.icon}
                        </span>
                        <div className="min-w-0">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Map Inspector</p>
                            <p className="truncate text-[13px] font-semibold text-zinc-100">{meta.title}</p>
                            <p className="truncate text-[11px] text-zinc-500">{meta.subtitle}</p>
                        </div>
                    </div>
                    <p className="mt-2 truncate font-mono text-[11px] text-zinc-500" title={selection.id}>
                        {shortId(selection.id)}
                    </p>
                </div>
                <MenuButton
                    iconOnly
                    variant="ghost"
                    className="h-7 w-7 rounded-[var(--radius)]"
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
                    <>
                        <div className="grid grid-cols-2 gap-1.5">
                            <Field label="Width" value={`${formatNumber(meta.width)}m`} mono />
                            <Field label="Lanes" value={meta.lanes} mono />
                        </div>
                        <div className="grid grid-cols-2 gap-1.5">
                            <ElevationField
                                label="Start Y (m)"
                                value={nodeElevation(roadStartNode)}
                                onCommit={(y) => commitNodeElevation(record.startNodeId, y)}
                                onFocus={controls.disable}
                                onBlur={controls.enable}
                            />
                            <ElevationField
                                label="End Y (m)"
                                value={nodeElevation(roadEndNode)}
                                onCommit={(y) => commitNodeElevation(record.endNodeId, y)}
                                onFocus={controls.disable}
                                onBlur={controls.enable}
                            />
                        </div>
                        <div className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-950/45 px-2 py-1.5">
                            <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Travel</p>
                            <div className="mt-1.5 flex gap-1.5">
                                <MenuButton
                                    compact
                                    variant={meta.bidirectional ? "primary" : "ghost"}
                                    onClick={() => setRoadBidirectional(true)}
                                    title="Two-way travel"
                                >
                                    Two-way
                                </MenuButton>
                                <MenuButton
                                    compact
                                    variant={!meta.bidirectional ? "primary" : "ghost"}
                                    onClick={() => setRoadBidirectional(false)}
                                    title="One-way travel (start to end)"
                                >
                                    One-way
                                </MenuButton>
                            </div>
                            {!meta.bidirectional && (
                                <p className="mt-1.5 text-[11px] text-zinc-500">
                                    Legal direction is start → end along the segment.
                                </p>
                            )}
                        </div>
                    </>
                )}

                {selection.type === MAP_SELECTION_TYPES.INTERSECTION && (
                    <>
                        <div className="grid grid-cols-2 gap-1.5">
                            <Field label="Position XZ" value={`${formatNumber(record.x)}, ${formatNumber(record.z)}`} mono />
                            <Field label="Connected Roads" value={connectedRoads} mono />
                            <ElevationField
                                label="Elevation Y (m)"
                                value={nodeElevation(record)}
                                onCommit={(y) => commitNodeElevation(record.id, y)}
                                onFocus={controls.disable}
                                onBlur={controls.enable}
                            />
                        </div>
                        {movementMatrix?.incident?.length > 0 && (
                            <div className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-950/45 px-2 py-2">
                                <div className="mb-1.5">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Allowed movements</p>
                                    <p className="text-[11px] text-zinc-600">Incoming roads are rows; outgoing roads are columns.</p>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="w-full border-collapse text-[11px]" data-intersection-movement-matrix>
                                        <thead>
                                            <tr>
                                                <th className="p-1 text-left font-medium text-zinc-500">From ↓ / To →</th>
                                                {movementMatrix.incident.map((edge) => (
                                                    <th key={`to-${edge.id}`} className="p-1 font-mono font-medium text-zinc-400" title={edge.id}>
                                                        {shortId(edge.id)}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {movementMatrix.incident.map((fromEdge) => (
                                                <tr key={`from-${fromEdge.id}`}>
                                                    <th className="p-1 text-left font-mono font-medium text-zinc-400" title={fromEdge.id}>
                                                        {shortId(fromEdge.id)}
                                                    </th>
                                                    {movementMatrix.incident.map((toEdge) => {
                                                        const cell = movementMatrix.cells.find((candidate) => (
                                                            candidate.fromEdgeId === fromEdge.id
                                                            && candidate.toEdgeId === toEdge.id
                                                        ));
                                                        return (
                                                            <td key={`${fromEdge.id}-${toEdge.id}`} className="p-1 text-center">
                                                                <input
                                                                    type="checkbox"
                                                                    aria-label={`Allow movement from ${fromEdge.id} to ${toEdge.id}`}
                                                                    checked={cell?.allowed === true}
                                                                    disabled={!cell}
                                                                    data-overridden={cell?.overridden || undefined}
                                                                    onChange={(event) => setMovementAllowed(fromEdge.id, toEdge.id, event.target.checked)}
                                                                    className="h-3.5 w-3.5 accent-sky-500 disabled:opacity-25"
                                                                />
                                                            </td>
                                                        );
                                                    })}
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </>
                )}

                {selection.type === MAP_SELECTION_TYPES.INTERSECTION && connectedRoads > 0 && (
                    <div className="rounded-[var(--radius)] border border-amber-500/20 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-100/80">
                        Deleting removes this intersection and all {connectedRoads} connected road segment{connectedRoads === 1 ? "" : "s"}.
                    </div>
                )}

                {meta.movable && (
                    <div className="rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-900/45 px-2.5 py-2 text-[11px] text-zinc-400">
                        <span className="inline-flex items-center gap-1.5 text-zinc-300">
                            <FaArrowsAlt className="h-3 w-3 text-sky-300" />
                            Drag the marker to reposition this prop.
                        </span>
                    </div>
                )}

                <div className="flex items-center justify-end gap-2 rounded-[var(--radius)] border border-zinc-800/90 bg-zinc-900/45 p-2">
                    <MenuButton compact variant="danger" onClick={deleteSelection} title="Delete selection">
                        <FaTrash className="h-3 w-3" />
                        Delete
                    </MenuButton>
                </div>
            </div>
        </div>
    );
}
