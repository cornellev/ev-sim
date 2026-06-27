'use client';

import { useRef } from "react";
import { isMapDetailZoom } from "../../editor/map/mapCoords.js";
import { MapSurfaceHud } from "./MapSurfaceHud.js";
import { MapSurfaceLayers } from "./MapSurfaceLayers.js";
import { useMapPointerController } from "./useMapPointerController.js";
import { useMapSize } from "./useMapSize.js";

export function MapSurface({ data, editorSnapshot, documentSnapshot }) {
    const containerRef = useRef(null);
    const size = useMapSize(containerRef);

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
        onWheel,
        onPointerDown,
        onPointerMove,
        onPointerUp,
    } = useMapPointerController({
        containerRef,
        data,
        size,
        viewport,
        layers,
        showDetail,
        documentSnapshot,
    });

    return (
        <div
            ref={containerRef}
            className="fixed inset-0 z-[15] bg-zinc-950/95 pointer-events-auto touch-none"
            onWheel={onWheel}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onPointerCancel={onPointerUp}
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
                    mapSelection={viewport.selection ?? null}
                    showDetail={showDetail}
                    draft={viewport.draft}
                />
            </svg>

            <MapSurfaceHud viewport={viewport} layers={layers} showDetail={showDetail} />
        </div>
    );
}
