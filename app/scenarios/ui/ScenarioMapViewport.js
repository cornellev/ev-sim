'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconFocus2, IconMinus, IconPlus } from "@tabler/icons-react";

import { isMapDetailZoom, MAP_WORLD_SCALE, screenToWorld, worldToScreen } from "../../3d/editor/map/mapCoords.js";
import { MapSurfaceLayers } from "../../3d/overlay/map/MapSurfaceLayers.js";
import { useMapSize } from "../../3d/overlay/map/useMapSize.js";
import { environmentDocumentFrom } from "../route/index.js";
import styles from "./ScenarioWorkspace.module.css";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 8;
const FIT_PADDING = 48;
const PAN_THRESHOLD_PX = 4;

function finite(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function normalizeScenarioMapDocument(environment) {
    const document = environmentDocumentFrom(environment);
    return {
        ...document,
        roads: {
            nodes: Array.isArray(document.roads?.nodes) ? document.roads.nodes : [],
            edges: Array.isArray(document.roads?.edges) ? document.roads.edges : [],
        },
        buildings: Array.isArray(document.buildings) ? document.buildings : [],
        features: Array.isArray(document.features) ? document.features : [],
    };
}

function documentPoints(document) {
    return [
        ...document.roads.nodes.map((node) => ({ x: finite(node.x), z: finite(node.z) })),
        ...document.buildings.flatMap((building) => (
            Array.isArray(building.footprint)
                ? building.footprint.map((point) => ({ x: finite(point.x), z: finite(point.z) }))
                : []
        )),
        ...document.features.map((feature) => ({ x: finite(feature.x), z: finite(feature.z) })),
    ];
}

export function fitScenarioMapViewport(document, size) {
    const points = documentPoints(document);
    if (points.length === 0) return { centerX: 0, centerZ: 0, zoom: 1, gridVisible: true };
    const xs = points.map((point) => point.x);
    const zs = points.map((point) => point.z);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minZ = Math.min(...zs);
    const maxZ = Math.max(...zs);
    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const width = Math.max(1, finite(size?.width, 800) - FIT_PADDING * 2);
    const height = Math.max(1, finite(size?.height, 600) - FIT_PADDING * 2);
    const zoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, Math.min(width / (spanX * MAP_WORLD_SCALE), height / (spanZ * MAP_WORLD_SCALE))),
    );
    return {
        centerX: (minX + maxX) / 2,
        centerZ: (minZ + maxZ) / 2,
        zoom,
        gridVisible: true,
    };
}

export function panScenarioMapViewport(viewport, deltaX, deltaY) {
    const scale = Math.max(Number.EPSILON, viewport.zoom * MAP_WORLD_SCALE);
    return {
        ...viewport,
        centerX: viewport.centerX - deltaX / scale,
        centerZ: viewport.centerZ - deltaY / scale,
    };
}

export function zoomScenarioMapViewport(viewport, screen, size, factor) {
    const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, viewport.zoom * factor));
    if (nextZoom === viewport.zoom) return viewport;
    const anchor = screenToWorld(screen, viewport, size);
    const nextScale = nextZoom * MAP_WORLD_SCALE;
    return {
        ...viewport,
        zoom: nextZoom,
        centerX: anchor.x - (screen.x - size.width / 2) / nextScale,
        centerZ: anchor.z - (screen.y - size.height / 2) / nextScale,
    };
}

export default function ScenarioMapViewport({
    environment,
    ariaLabel,
    interaction = "place",
    onPlace,
    onDrawStart,
    onDrawMove,
    onDrawEnd,
    children,
    className = "",
}) {
    const containerRef = useRef(null);
    const gestureRef = useRef(null);
    const size = useMapSize(containerRef);
    const document = useMemo(() => normalizeScenarioMapDocument(environment), [environment]);
    const fittedViewport = useMemo(() => fitScenarioMapViewport(document, size), [document, size]);
    const [viewportOverride, setViewportOverride] = useState(null);
    const viewport = viewportOverride?.document === document ? viewportOverride.viewport : fittedViewport;
    const updateViewport = useCallback((updater) => setViewportOverride((current) => {
        const currentViewport = current?.document === document ? current.viewport : fittedViewport;
        return { document, viewport: updater(currentViewport) };
    }), [document, fittedViewport]);

    const screenFromEvent = (event) => {
        const bounds = containerRef.current?.getBoundingClientRect();
        if (!bounds) return null;
        return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
    };

    const eventContext = (event) => {
        const screen = screenFromEvent(event);
        if (!screen) return null;
        return {
            screen,
            world: screenToWorld(screen, viewport, size),
            viewport,
            size,
        };
    };

    const begin = (event) => {
        if (event.target.closest?.("[data-map-control], [data-map-interactive]")) return;
        if (event.button !== 0 && event.button !== 1) return;
        const context = eventContext(event);
        if (!context) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        const pan = event.button === 1 || event.altKey || interaction === "pan";
        if (pan) {
            gestureRef.current = {
                kind: "pan",
                startX: event.clientX,
                startY: event.clientY,
                lastX: event.clientX,
                lastY: event.clientY,
                moved: false,
            };
            return;
        }
        if (interaction === "draw") {
            gestureRef.current = {
                kind: "draw",
                startX: event.clientX,
                startY: event.clientY,
                start: context,
                current: context,
            };
            onDrawStart?.(context.world, context);
            return;
        }
        gestureRef.current = {
            kind: "pending-place",
            startX: event.clientX,
            startY: event.clientY,
            lastX: event.clientX,
            lastY: event.clientY,
            start: context,
            moved: false,
        };
    };

    const move = (event) => {
        const gesture = gestureRef.current;
        if (!gesture) return;
        if (gesture.kind === "draw") {
            const context = eventContext(event);
            if (!context) return;
            gesture.current = context;
            onDrawMove?.(context.world, context);
            return;
        }
        const totalDistance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
        if (gesture.kind === "pending-place" && totalDistance < PAN_THRESHOLD_PX) return;
        gesture.kind = "pan";
        gesture.moved = true;
        const deltaX = event.clientX - gesture.lastX;
        const deltaY = event.clientY - gesture.lastY;
        gesture.lastX = event.clientX;
        gesture.lastY = event.clientY;
        updateViewport((current) => panScenarioMapViewport(current, deltaX, deltaY));
    };

    const end = (event) => {
        const gesture = gestureRef.current;
        if (!gesture) return;
        gestureRef.current = null;
        const context = eventContext(event) || gesture.current || gesture.start;
        if (gesture.kind === "draw") {
            const distancePx = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
            onDrawEnd?.(context?.world, { ...context, distancePx, start: gesture.start });
            return;
        }
        if (gesture.kind === "pending-place" && !gesture.moved && context) onPlace?.(context.world, context);
    };

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return undefined;
        const onWheel = (event) => {
            if (event.target.closest?.("[data-map-control]")) return;
            const bounds = element.getBoundingClientRect();
            const screen = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
            event.preventDefault();
            const factor = Math.exp(-event.deltaY * 0.0015);
            updateViewport((current) => zoomScenarioMapViewport(current, screen, size, factor));
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
    }, [size, updateViewport]);

    const zoomAtCenter = (factor) => updateViewport((current) => zoomScenarioMapViewport(
        current,
        { x: size.width / 2, y: size.height / 2 },
        size,
        factor,
    ));
    const showDetail = isMapDetailZoom(viewport);
    const overlay = typeof children === "function"
        ? children({
            document,
            size,
            viewport,
            toScreen: (point) => worldToScreen(point, viewport, size),
        })
        : children;

    return (
        <div
            ref={containerRef}
            className={`${styles.scenarioMapViewport} ${className}`.trim()}
            data-interaction={interaction}
            data-map-center={`${viewport.centerX.toFixed(3)},${viewport.centerZ.toFixed(3)}`}
            data-map-zoom={viewport.zoom.toFixed(3)}
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
        >
            <svg width={size.width} height={size.height} role="img" aria-label={ariaLabel}>
                <MapSurfaceLayers
                    viewport={viewport}
                    size={size}
                    layers={{ roads: true, buildings: true, props: true }}
                    documentSnapshot={document}
                    mapSelection={null}
                    showDetail={showDetail}
                    draft={null}
                />
                {overlay}
            </svg>
            <div className={styles.scenarioMapHud} data-map-control onPointerDown={(event) => event.stopPropagation()}>
                <div>
                    <button type="button" aria-label="Zoom out" onClick={() => zoomAtCenter(0.8)}><IconMinus size={14} /></button>
                    <button type="button" aria-label="Zoom in" onClick={() => zoomAtCenter(1.25)}><IconPlus size={14} /></button>
                    <button type="button" aria-label="Fit map to environment" onClick={() => setViewportOverride({ document, viewport: fitScenarioMapViewport(document, size) })}><IconFocus2 size={14} /></button>
                </div>
                <span>{viewport.zoom.toFixed(2)}× · Drag to pan · Scroll to zoom</span>
            </div>
        </div>
    );
}
