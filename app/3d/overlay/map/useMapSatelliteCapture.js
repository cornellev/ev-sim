import { useEffect, useRef, useState } from "react";
import { MapSatelliteCapture } from "../../editor/map/MapSatelliteCapture.js";

export const MAP_SATELLITE_CAPTURE_DEBOUNCE_MS = 120;

function createCaptureCanvas() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
    return document.createElement("canvas");
}

/**
 * Idle nadir capture into an offscreen canvas. Returns the last successful
 * capture so MapSurface can composite it in SVG user space while panning.
 */
export function useMapSatelliteCapture({
    data,
    enabled,
    viewport,
    size,
    documentSnapshot,
    assetEpoch,
    gesturePreview = false,
}) {
    const [capture, setCapture] = useState(null);
    const capturerRef = useRef(null);
    const sourceCanvasRef = useRef(null);
    const centerX = Number(viewport?.centerX) || 0;
    const centerZ = Number(viewport?.centerZ) || 0;
    const zoom = Number(viewport?.zoom) || 1;
    const width = Number(size?.width) || 0;
    const height = Number(size?.height) || 0;

    useEffect(() => {
        if (!enabled) {
            capturerRef.current?.dispose?.();
            capturerRef.current = null;
            setCapture(null);
            return undefined;
        }
        capturerRef.current ??= new MapSatelliteCapture();
        sourceCanvasRef.current ??= createCaptureCanvas();
        return () => {
            capturerRef.current?.dispose?.();
            capturerRef.current = null;
        };
    }, [enabled]);

    useEffect(() => {
        if (!enabled || gesturePreview) return undefined;
        if (!(width > 0) || !(height > 0)) return undefined;
        const handle = setTimeout(() => {
            const canvas = sourceCanvasRef.current ?? createCaptureCanvas();
            sourceCanvasRef.current = canvas;
            const simulation = data?.simulation?.();
            let result = null;
            try {
                result = capturerRef.current?.capture?.({
                    renderer: simulation?.renderer,
                    scene: simulation?.scene,
                    registry: data?.environment?.()?.objects?.(),
                    tilesHost: data?.environment?.()?.tiles?.(),
                    viewport: { centerX, centerZ, zoom },
                    size: { width, height },
                    canvas,
                }) ?? null;
            } catch (error) {
                console.warn("[map-satellite] capture failed", error);
            }
            if (result) setCapture(result);
        }, MAP_SATELLITE_CAPTURE_DEBOUNCE_MS);
        return () => clearTimeout(handle);
    }, [enabled, gesturePreview, centerX, centerZ, zoom, width, height, documentSnapshot, assetEpoch, data]);

    return capture;
}
