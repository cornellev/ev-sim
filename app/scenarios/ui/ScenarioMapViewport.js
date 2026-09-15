'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconFocus2, IconMinus, IconPlus } from "@tabler/icons-react";

import { mapDocumentFrom, collectMapFitPoints } from "../../3d/editor/map/mapDocument.js";
import { screenToWorld } from "../../3d/editor/map/mapCoords.js";
import { fitMapViewport, mapWheelZoomFactor, panMapViewport, zoomMapViewport } from "../../3d/editor/map/mapViewport.js";
import { MapCanvas } from "../../3d/overlay/map/MapCanvas.js";
import { useMapSize } from "../../3d/overlay/map/useMapSize.js";
import styles from "./ScenarioWorkspace.module.css";

const PAN_THRESHOLD_PX = 4;

export default function ScenarioMapViewport({
    environment,
    ariaLabel,
    interaction = "place",
    onPlace,
    onDrawStart,
    onDrawMove,
    onDrawEnd,
    onSelectEntity,
    onDragEntity,
    onDragEntityEnd,
    children,
    className = "",
    fitPoints = null,
}) {
    const containerRef = useRef(null);
    const gestureRef = useRef(null);
    const size = useMapSize(containerRef);
    const document = useMemo(() => mapDocumentFrom(environment), [environment]);
    const fittedViewport = useMemo(
        () => fitMapViewport(fitPoints?.length ? fitPoints : collectMapFitPoints(document), size),
        [document, fitPoints, size],
    );
    const [viewportOverride, setViewportOverride] = useState(null);
    const [draggingId, setDraggingId] = useState(null);
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
        if (event.target.closest?.("[data-map-control]")) return;
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
        const draggable = event.target.closest?.("[data-map-draggable]");
        if (draggable && interaction !== "draw" && interaction !== "pan") {
            const entityId = draggable.getAttribute("data-map-draggable");
            if (entityId) {
                onSelectEntity?.(entityId, context);
                gestureRef.current = {
                    kind: "pending-drag",
                    entityId,
                    startX: event.clientX,
                    startY: event.clientY,
                    start: context,
                    current: context,
                    moved: false,
                };
                return;
            }
        }
        if (event.target.closest?.("[data-map-interactive]")) return;
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
        if (gesture.kind === "pending-drag" || gesture.kind === "drag") {
            const totalDistance = Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY);
            if (gesture.kind === "pending-drag" && totalDistance < PAN_THRESHOLD_PX) return;
            const context = eventContext(event);
            if (!context) return;
            if (gesture.kind === "pending-drag") {
                gesture.kind = "drag";
                gesture.moved = true;
                setDraggingId(gesture.entityId);
            }
            gesture.current = context;
            onDragEntity?.(gesture.entityId, context.world, context);
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
        updateViewport((current) => panMapViewport(current, deltaX, deltaY));
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
        if (gesture.kind === "pending-drag" || gesture.kind === "drag") {
            setDraggingId(null);
            if (gesture.kind === "drag" && context) {
                onDragEntityEnd?.(gesture.entityId, context.world, context);
            }
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
            updateViewport((current) => zoomMapViewport(current, screen, size, mapWheelZoomFactor(event.deltaY)));
        };
        element.addEventListener("wheel", onWheel, { passive: false });
        return () => element.removeEventListener("wheel", onWheel);
    }, [size, updateViewport]);

    const zoomAtCenter = (factor) => updateViewport((current) => zoomMapViewport(
        current,
        { x: size.width / 2, y: size.height / 2 },
        size,
        factor,
    ));
    const fitted = () => fitMapViewport(fitPoints?.length ? fitPoints : collectMapFitPoints(document), size);

    return (
        <MapCanvas
            containerRef={containerRef}
            size={size}
            viewport={viewport}
            documentSnapshot={document}
            className={`${styles.scenarioMapViewport} ${className}`.trim()}
            ariaLabel={ariaLabel}
            data-interaction={interaction}
            data-map-center={`${viewport.centerX.toFixed(3)},${viewport.centerZ.toFixed(3)}`}
            data-map-zoom={viewport.zoom.toFixed(3)}
            data-dragging={draggingId || undefined}
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            hud={(
                <div className={styles.scenarioMapHud} data-map-control onPointerDown={(event) => event.stopPropagation()}>
                    <div>
                        <button type="button" aria-label="Zoom out" onClick={() => zoomAtCenter(0.8)}><IconMinus size={14} /></button>
                        <button type="button" aria-label="Zoom in" onClick={() => zoomAtCenter(1.25)}><IconPlus size={14} /></button>
                        <button type="button" aria-label="Fit map to environment" onClick={() => setViewportOverride({ document, viewport: fitted() })}><IconFocus2 size={14} /></button>
                    </div>
                    <span>{viewport.zoom.toFixed(2)}× · Drag to pan · Scroll to zoom</span>
                </div>
            )}
        >
            {({ toScreen, toWorld, viewport: mapViewport, size: mapSize }) => (
                typeof children === "function"
                    ? children({
                        document,
                        size: mapSize,
                        viewport: mapViewport,
                        toScreen,
                        toWorld,
                        draggingId,
                    })
                    : children
            )}
        </MapCanvas>
    );
}
