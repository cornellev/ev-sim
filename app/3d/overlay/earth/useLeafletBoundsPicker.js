'use client';

import { useEffect, useRef } from "react";
import {
    boundsToLeafletLatLngBounds,
    geoBoundsEqual,
    leafletLatLngBoundsToGeoBounds,
    normalizeCorners,
} from "../../earth/map/GeoBoundsSelection.js";

const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const BOUNDS_STYLE = {
    color: "#38bdf8",
    weight: 2,
    fillColor: "#38bdf8",
    fillOpacity: 0.12,
};

const PREVIEW_STYLE = {
    color: "#34d399",
    weight: 2,
    dashArray: "6 4",
    fillColor: "#34d399",
    fillOpacity: 0.08,
};

/**
 * Leaflet mis-tiles when the container size changes or when layout settles late.
 * @param {import("leaflet").Map} map
 */
function scheduleMapResize(map) {
    requestAnimationFrame(() => {
        map.invalidateSize({ animate: false });
        requestAnimationFrame(() => {
            map.invalidateSize({ animate: false });
        });
    });
}

/**
 * Imperative Leaflet map with drag-to-draw bounds selection.
 *
 * @param {{
 *   bounds: import("../../earth/map/GeoBoundsSelection.js").GeoBounds,
 *   drawMode: boolean,
 *   onBoundsChange: (bounds: import("../../earth/map/GeoBoundsSelection.js").GeoBounds) => void,
 *   onInteractionStart?: () => void,
 *   onInteractionEnd?: () => void,
 *   expanded?: boolean,
 * }} options
 */
export function useLeafletBoundsPicker({
    bounds,
    drawMode,
    onBoundsChange,
    onInteractionStart,
    onInteractionEnd,
    expanded = false,
}) {
    const containerRef = useRef(null);
    const mapRef = useRef(null);
    const boundsLayerRef = useRef(null);
    const previewLayerRef = useRef(null);
    const drawStartRef = useRef(null);
    const isDrawingRef = useRef(false);
    const suppressEmitRef = useRef(false);
    const onBoundsChangeRef = useRef(onBoundsChange);
    const onInteractionStartRef = useRef(onInteractionStart);
    const onInteractionEndRef = useRef(onInteractionEnd);
    const boundsRef = useRef(bounds);
    const drawModeRef = useRef(drawMode);
    const expandedRef = useRef(expanded);
    const resizeObserverRef = useRef(null);

    onBoundsChangeRef.current = onBoundsChange;
    onInteractionStartRef.current = onInteractionStart;
    onInteractionEndRef.current = onInteractionEnd;
    boundsRef.current = bounds;
    drawModeRef.current = drawMode;
    expandedRef.current = expanded;

    useEffect(() => {
        if (!containerRef.current || mapRef.current) return undefined;

        let disposed = false;

        (async () => {
            const leafletModule = await import("leaflet");
            if (disposed || !containerRef.current) return;

            const L = leafletModule.default;
            const currentBounds = boundsRef.current;
            const map = L.map(containerRef.current, {
                zoomControl: true,
                attributionControl: true,
                worldCopyJump: true,
            });

            L.tileLayer(OSM_TILE_URL, {
                attribution: OSM_ATTRIBUTION,
                minZoom: 2,
                maxZoom: 19,
            }).addTo(map);

            const boundsLayer = L.rectangle(boundsToLeafletLatLngBounds(currentBounds), BOUNDS_STYLE).addTo(map);
            boundsLayerRef.current = boundsLayer;
            mapRef.current = map;

            map.fitBounds(boundsToLeafletLatLngBounds(currentBounds), { padding: [16, 16] });
            scheduleMapResize(map);

            if (typeof ResizeObserver !== "undefined" && containerRef.current) {
                resizeObserverRef.current = new ResizeObserver(() => {
                    if (!mapRef.current) return;
                    mapRef.current.invalidateSize({ animate: false });
                });
                resizeObserverRef.current.observe(containerRef.current);
            }

            const commitDraw = (cornerA, cornerB) => {
                const next = normalizeCorners(
                    { lat: cornerA.lat, lng: cornerA.lng },
                    { lat: cornerB.lat, lng: cornerB.lng },
                );
                if (previewLayerRef.current) {
                    map.removeLayer(previewLayerRef.current);
                    previewLayerRef.current = null;
                }
                boundsLayer.setBounds(boundsToLeafletLatLngBounds(next));
                suppressEmitRef.current = true;
                onBoundsChangeRef.current(next);
                suppressEmitRef.current = false;
            };

            const finishInteraction = () => {
                isDrawingRef.current = false;
                drawStartRef.current = null;
                map.dragging.enable();
                map.getContainer().classList.remove("earth-import-map--drawing");
                onInteractionEndRef.current?.();
            };

            map.on("mousedown", (event) => {
                if (!drawModeRef.current) return;
                L.DomEvent.stopPropagation(event);
                onInteractionStartRef.current?.();
                isDrawingRef.current = true;
                drawStartRef.current = event.latlng;
                map.dragging.disable();
                map.getContainer().classList.add("earth-import-map--drawing");

                if (previewLayerRef.current) {
                    map.removeLayer(previewLayerRef.current);
                }
                previewLayerRef.current = L.rectangle(
                    boundsToLeafletLatLngBounds(normalizeCorners(
                        { lat: event.latlng.lat, lng: event.latlng.lng },
                        { lat: event.latlng.lat, lng: event.latlng.lng },
                    )),
                    PREVIEW_STYLE,
                ).addTo(map);
            });

            map.on("mousemove", (event) => {
                if (!isDrawingRef.current || !drawStartRef.current || !previewLayerRef.current) return;
                const next = normalizeCorners(
                    { lat: drawStartRef.current.lat, lng: drawStartRef.current.lng },
                    { lat: event.latlng.lat, lng: event.latlng.lng },
                );
                previewLayerRef.current.setBounds(boundsToLeafletLatLngBounds(next));
            });

            map.on("mouseup", (event) => {
                if (!isDrawingRef.current || !drawStartRef.current) return;
                commitDraw(drawStartRef.current, event.latlng);
                finishInteraction();
            });

            map.on("mouseleave", () => {
                if (!isDrawingRef.current) return;
                if (previewLayerRef.current) {
                    map.removeLayer(previewLayerRef.current);
                    previewLayerRef.current = null;
                }
                finishInteraction();
            });
        })();

        return () => {
            disposed = true;
            resizeObserverRef.current?.disconnect();
            resizeObserverRef.current = null;
            if (mapRef.current) {
                mapRef.current.remove();
                mapRef.current = null;
            }
            boundsLayerRef.current = null;
            previewLayerRef.current = null;
        };
    }, []);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || expandedRef.current === expanded) return;
        expandedRef.current = expanded;
        scheduleMapResize(map);
    }, [expanded]);

    useEffect(() => {
        const map = mapRef.current;
        const boundsLayer = boundsLayerRef.current;
        if (!map || !boundsLayer) return;

        const current = leafletLatLngBoundsToGeoBounds(boundsLayer.getBounds());
        if (geoBoundsEqual(current, bounds)) return;
        if (isDrawingRef.current) return;

        suppressEmitRef.current = true;
        boundsLayer.setBounds(boundsToLeafletLatLngBounds(bounds));
        suppressEmitRef.current = false;
    }, [bounds]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map) return;
        map.getContainer().style.cursor = drawMode ? "crosshair" : "";
    }, [drawMode]);

    return containerRef;
}
