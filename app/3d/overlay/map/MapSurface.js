'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { isMapDetailZoom } from "../../editor/map/mapCoords.js";
import { paintMapSatelliteCanvas } from "../../editor/map/mapSatelliteFrustum.js";
import { MapCanvas } from "./MapCanvas.js";
import { useMapPointerController } from "./useMapPointerController.js";
import { useMapSatelliteCapture } from "./useMapSatelliteCapture.js";
import { useMapSize } from "./useMapSize.js";

function assetBoundsEpoch(entries) {
    if (!entries?.size) return "";
    return [...entries]
        .filter(([, entry]) => entry?.bounds)
        .map(([id]) => String(id))
        .sort()
        .join(",");
}

function collectAssetBounds(data) {
    return new Map(
        [...(data?.environment?.()?.projector?.()?.assetInstanceEntries?.() ?? new Map())]
            .filter(([, entry]) => entry.bounds)
            .map(([id, entry]) => [String(id), entry.bounds]),
    );
}

export function MapSurface({ data, documentSnapshot, mapSelection = null, gesturePreview = false }) {
    const containerRef = useRef(null);
    const satelliteCanvasRef = useRef(null);
    const size = useMapSize(containerRef);
    const [editorSnapshot, setEditorSnapshot] = useState(() => data?.editor?.()?.snapshot?.() ?? null);
    const [assetEpoch, setAssetEpoch] = useState(0);
    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);
    useEffect(() => {
        const registry = data?.environment?.()?.objects?.();
        if (!registry?.subscribe) return undefined;
        let last = assetBoundsEpoch(data?.environment?.()?.projector?.()?.assetInstanceEntries?.());
        return registry.subscribe(() => {
            const next = assetBoundsEpoch(data?.environment?.()?.projector?.()?.assetInstanceEntries?.());
            if (next === last) return;
            last = next;
            setAssetEpoch((value) => value + 1);
        });
    }, [data]);
    const runtimeAssetBounds = useMemo(
        () => collectAssetBounds(data),
        [data, assetEpoch],
    );

    const viewport = editorSnapshot?.map ?? {
        centerX: 0,
        centerZ: 0,
        zoom: 1,
        gridVisible: true,
        satelliteVisible: false,
    };
    const satelliteVisible = viewport.satelliteVisible === true;
    const satelliteCapture = useMapSatelliteCapture({
        data,
        enabled: satelliteVisible,
        viewport,
        size,
        documentSnapshot,
        assetEpoch,
        gesturePreview,
    });
    const mapCenterX = Number(viewport.centerX) || 0;
    const mapCenterZ = Number(viewport.centerZ) || 0;
    const mapZoom = Number(viewport.zoom) || 1;
    const paneWidth = Number(size.width) || 0;
    const paneHeight = Number(size.height) || 0;
    useLayoutEffect(() => {
        if (!satelliteVisible) return;
        paintMapSatelliteCanvas(
            satelliteCanvasRef.current,
            satelliteCapture,
            { centerX: mapCenterX, centerZ: mapCenterZ, zoom: mapZoom },
            { width: paneWidth, height: paneHeight },
        );
    }, [satelliteVisible, satelliteCapture, mapCenterX, mapCenterZ, mapZoom, paneWidth, paneHeight]);

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

    return (
        <MapCanvas
            containerRef={containerRef}
            size={size}
            viewport={viewport}
            layers={layers}
            documentSnapshot={documentSnapshot}
            mapSelection={mapSelection}
            draft={editorSnapshot?.roadDraft ?? viewport.draft}
            runtimeAssetBounds={runtimeAssetBounds}
            satelliteVisible={satelliteVisible}
            gesturePreview={gesturePreview}
            connectPreviewId={editorSnapshot?.connectPreview?.intersectionId ?? null}
            satelliteCanvasRef={satelliteCanvasRef}
            className="absolute inset-0 overflow-hidden bg-zinc-950/95 pointer-events-auto touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            onPointerCancel={onPointerCancel}
        />
    );
}
