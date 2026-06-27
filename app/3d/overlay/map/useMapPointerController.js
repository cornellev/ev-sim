import { useCallback, useMemo, useRef } from "react";
import { MapPointerController } from "../../editor/map/MapPointerController.js";
import { screenToWorld } from "../../editor/map/mapCoords.js";

/**
 * React adapter for map pointer gestures. MapSurface owns rendering; this hook owns input.
 */
export function useMapPointerController({
    containerRef,
    data,
    size,
    viewport,
    layers,
    showDetail,
    documentSnapshot,
}) {
    const controllerRef = useRef(null);
    if (!controllerRef.current) {
        controllerRef.current = new MapPointerController();
    }

    const getWorldFromEvent = useCallback((event) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return null;
        return screenToWorld(
            { x: event.clientX - rect.left, y: event.clientY - rect.top },
            viewport,
            size,
        );
    }, [containerRef, viewport, size]);

    const pointerContext = useMemo(() => ({
        data,
        size,
        viewport,
        layers,
        showDetail,
        documentSnapshot,
        getWorldFromEvent,
    }), [data, size, viewport, layers, showDetail, documentSnapshot, getWorldFromEvent]);

    const onWheel = useCallback((event) => {
        const containerRect = containerRef.current?.getBoundingClientRect();
        controllerRef.current.handleWheel({ data, containerRect, size }, event);
    }, [containerRef, data, size]);

    const onPointerDown = useCallback((event) => {
        const handled = controllerRef.current.handlePointerDown(pointerContext, event);
        if (handled) {
            event.preventDefault();
            containerRef.current?.setPointerCapture?.(event.pointerId);
        }
    }, [containerRef, pointerContext]);

    const onPointerMove = useCallback((event) => {
        controllerRef.current.handlePointerMove(pointerContext, event);
    }, [pointerContext]);

    const onPointerUp = useCallback((event) => {
        containerRef.current?.releasePointerCapture?.(event.pointerId);
        controllerRef.current.handlePointerUp(pointerContext, event);
    }, [containerRef, pointerContext]);

    return {
        onWheel,
        onPointerDown,
        onPointerMove,
        onPointerUp,
    };
}
