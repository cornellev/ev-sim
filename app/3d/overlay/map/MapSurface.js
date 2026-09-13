'use client';

import { useEffect, useRef, useState } from "react";
import { fitMapViewportToContent } from "../../editor/document/documentRuntimeHydration.js";
import { isMapDetailZoom } from "../../editor/map/mapCoords.js";
import { MapSurfaceHud } from "./MapSurfaceHud.js";
import { MapSurfaceLayers } from "./MapSurfaceLayers.js";
import { useMapPointerController } from "./useMapPointerController.js";
import { useMapSize } from "./useMapSize.js";

export function MapSurface({ data, editorSnapshot, documentSnapshot, mapSelection = null }) {
    const containerRef = useRef(null);
    const size = useMapSize(containerRef);
    const [assetEpoch, setAssetEpoch] = useState(0);
    useEffect(() => data?.environment?.()?.objects?.()?.subscribe?.(() => setAssetEpoch((value) => value + 1)), [data]);
    const runtimeAssetBounds = new Map(
        [...(data?.environment?.()?.projector?.()?.assetInstanceEntries?.() ?? new Map())]
            .filter(([, entry]) => entry.bounds)
            .map(([id, entry]) => [String(id), entry.bounds]),
    );
    void assetEpoch;

    const viewport = editorSnapshot?.map ?? {
        centerX: 0,
        centerZ: 0,
        zoom: 1,
        gridVisible: true,
    };

    const layers = editorSnapshot?.layers ?? {
        buildings: true,
        roads: true,
        props: true,
    };

    const showDetail = isMapDetailZoom(viewport);

    const {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel,
    } = useMapPointerController({
        containerRef,
        data,
        size,
        viewport,
        layers,
        showDetail,
        documentSnapshot,
        runtimeAssetBounds,
    });

    const handleRecenter = () => {
        const editor = data?.editor?.();
        const document = data?.environment?.()?.getDocument?.();
        if (!editor || !document) return;
        fitMapViewportToContent(editor, document);
    };

    return (
        <div
            ref={containerRef}
            className="absolute inset-0 bg-zinc-950/95 pointer-events-auto touch-none"
            data-map-surface
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onPointerCancel={onPointerCancel}
        >
            <svg
                width={size.width}
                height={size.height}
                className="h-full w-full touch-none select-none"
            >
                <MapSurfaceLayers
                    viewport={viewport}
                    size={size}
                    layers={layers}
                    documentSnapshot={documentSnapshot}
                    mapSelection={mapSelection}
                    showDetail={showDetail}
                    draft={editorSnapshot?.roadDraft ?? viewport.draft}
                    runtimeAssetBounds={runtimeAssetBounds}
                />
            </svg>

            {/* <MapSurfaceHud
                viewport={viewport}
                layers={layers}
                showDetail={showDetail}
                onRecenter={handleRecenter}
            /> */}
        </div>
    );
}
