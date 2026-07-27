'use client';

import { useMemo, useState } from "react";
import { IconArrowsMinimize as FaCompress, IconMap2 as FaMapMarkedAlt } from "@tabler/icons-react";
import {
    editorStateToGeoBounds,
    geoBoundsToEarthImportPatch,
    summarizeBounds,
} from "../../earth/map/GeoBoundsSelection.js";
import { MenuButton } from "../ui/MenuButton";
import { useLeafletBoundsPicker } from "./useLeafletBoundsPicker.js";

function BoundsSummary({ bounds }) {
    const summary = useMemo(() => summarizeBounds(bounds), [bounds]);

    return (
        <div
            className={[
                "rounded-[var(--radius)] border px-2.5 py-2 text-[11px]",
                summary.valid
                    ? "border-zinc-700/80 bg-zinc-900/70 text-zinc-300"
                    : "border-rose-500/50 bg-rose-500/10 text-rose-100",
            ].join(" ")}
        >
            <p className="font-semibold uppercase tracking-[0.12em] text-zinc-400">Selection</p>
            <p className="mt-1 font-mono leading-snug">
                {summary.edgeMeters.toLocaleString()} m max edge
            </p>
            {!summary.valid && summary.error && (
                <p className="mt-1 leading-snug">{summary.error}</p>
            )}
        </div>
    );
}

/**
 * @param {{
 *   earthImport: import("../../editor/EditorState").EarthImportEditorState,
 *   onPatch: (patch: Record<string, number>) => void,
 *   onInteractionStart?: () => void,
 *   onInteractionEnd?: () => void,
 *   expanded?: boolean,
 * }} props
 */
export function EarthImportMapPicker({
    earthImport,
    onPatch,
    onInteractionStart,
    onInteractionEnd,
    expanded = false,
}) {
    const [drawMode, setDrawMode] = useState(false);
    const bounds = useMemo(() => editorStateToGeoBounds(earthImport), [earthImport]);

    const handleBoundsChange = (nextBounds) => {
        onPatch(geoBoundsToEarthImportPatch(nextBounds));
    };

    const containerRef = useLeafletBoundsPicker({
        bounds,
        drawMode,
        onBoundsChange: handleBoundsChange,
        onInteractionStart,
        onInteractionEnd,
        expanded,
    });

    const rootClassName = expanded
        ? "flex h-full min-h-0 flex-col gap-2"
        : "space-y-2";
    const mapHeightClass = expanded
        ? "min-h-[280px] flex-1"
        : "h-[200px]";

    return (
        <div className={rootClassName}>
            <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] text-zinc-400">
                    Drag on the map to define import bounds.
                </p>
                <MenuButton
                    compact
                    active={drawMode}
                    onClick={() => setDrawMode((value) => !value)}
                    title={drawMode ? "Exit draw mode" : "Draw import bounds on map"}
                    ariaLabel={drawMode ? "Exit draw mode" : "Draw import bounds on map"}
                    iconOnly
                >
                    <FaMapMarkedAlt className="h-3 w-3" />
                </MenuButton>
            </div>

            <div
                className={[
                    "overflow-hidden rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900",
                    mapHeightClass,
                    drawMode ? "earth-import-map--draw-mode" : "",
                ].join(" ")}
                aria-label="OpenStreetMap bounds picker"
                role="application"
            >
                {/* Leaflet owns the inner node — never pass reactive className to it. */}
                <div ref={containerRef} className="earth-import-map h-full w-full" />
            </div>

            <BoundsSummary bounds={bounds} />

            <p className="text-[11px] leading-snug text-zinc-500">
                Map data &copy; OpenStreetMap contributors. Preview loads Google Photorealistic 3D Tiles.
            </p>
        </div>
    );
}

/**
 * Full-screen map overlay for expanded picking.
 */
export function EarthImportMapPickerOverlay({
    earthImport,
    onPatch,
    onClose,
    onInteractionStart,
    onInteractionEnd,
}) {
    return (
        <div className="fixed inset-0 z-[16] pointer-events-auto bg-zinc-950/95 p-3">
            <div
                className="mx-auto flex h-full min-h-0 max-w-5xl flex-col gap-3"
                onMouseDown={onInteractionStart}
                onMouseUp={onInteractionEnd}
                onMouseLeave={onInteractionEnd}
            >
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <p className="text-[11px] font-semibold tracking-wide text-zinc-100">
                            Select import area
                        </p>
                        <p className="mt-0.5 text-[11px] text-zinc-400">
                            Pan and zoom, then draw a rectangle for the import bounds.
                        </p>
                    </div>
                    <MenuButton
                        compact
                        onClick={onClose}
                        title="Close expanded map"
                        ariaLabel="Close expanded map"
                        iconOnly
                    >
                        <FaCompress className="h-3 w-3" />
                    </MenuButton>
                </div>
                <div className="min-h-0 flex-1">
                    <EarthImportMapPicker
                        earthImport={earthImport}
                        onPatch={onPatch}
                        onInteractionStart={onInteractionStart}
                        onInteractionEnd={onInteractionEnd}
                        expanded
                    />
                </div>
            </div>
        </div>
    );
}
