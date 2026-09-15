'use client';

import { isMapDetailZoom, screenToWorld, worldToScreen } from "../../editor/map/mapCoords.js";
import { MapSurfaceLayers } from "./MapSurfaceLayers.js";

const DEFAULT_LAYERS = Object.freeze({ roads: true, buildings: true, props: true });

/**
 * Shared SVG map host. Editor and scenario attach their own pointer handlers
 * and overlays; layers, viewBox, and worldToScreen stay in one place.
 */
export function MapCanvas({
    containerRef,
    size,
    viewport,
    layers = DEFAULT_LAYERS,
    documentSnapshot,
    mapSelection = null,
    draft = null,
    runtimeAssetBounds,
    satelliteVisible = false,
    satelliteCanvasRef = null,
    gesturePreview = false,
    connectPreviewId = null,
    className = "",
    children,
    hud = null,
    ariaLabel,
    ...containerProps
}) {
    const showDetail = isMapDetailZoom(viewport);
    const toScreen = (point) => worldToScreen(point, viewport, size);
    const toWorld = (screen) => screenToWorld(screen, viewport, size);
    const overlay = typeof children === "function"
        ? children({ toScreen, toWorld, viewport, size, showDetail })
        : children;

    return (
        <div
            ref={containerRef}
            className={className}
            data-map-surface
            data-map-satellite-enabled={satelliteVisible || undefined}
            {...containerProps}
        >
            {satelliteVisible && (
                <canvas
                    ref={satelliteCanvasRef}
                    data-map-satellite
                    className="pointer-events-none absolute inset-0 z-0 h-full w-full"
                />
            )}
            <svg
                width={size.width}
                height={size.height}
                viewBox={`0 0 ${size.width} ${size.height}`}
                preserveAspectRatio="none"
                className="relative z-[1] h-full w-full touch-none select-none"
                role={ariaLabel ? "img" : undefined}
                aria-label={ariaLabel}
            >
                <MapSurfaceLayers
                    viewport={viewport}
                    size={size}
                    layers={layers}
                    documentSnapshot={documentSnapshot}
                    mapSelection={mapSelection}
                    showDetail={showDetail}
                    draft={draft}
                    runtimeAssetBounds={runtimeAssetBounds}
                    satelliteVisible={satelliteVisible}
                    gesturePreview={gesturePreview}
                    connectPreviewId={connectPreviewId}
                />
                {overlay}
            </svg>
            {hud}
        </div>
    );
}
