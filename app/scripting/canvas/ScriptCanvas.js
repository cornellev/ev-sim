import { useContext, useEffect, useRef, useState } from "react";
import Grid from "../Grid";
import {
    CANVAS_TOOLBAR_ZOOM_FACTOR,
    DEFAULT_CANVAS_VIEWPORT,
    canStartEmptyCanvasPan,
    canvasOriginFromElement,
    canvasWorldTransform,
    dispatchCanvasViewportChanged,
    isCanvasChromeTarget,
    isEditableTarget,
    panViewport,
    wheelZoomFactor,
    zoomViewportAt,
} from "./CanvasViewport.js";
import { CanvasViewportContext } from "./CanvasViewportContext.js";

function canvasCenterScreen(canvas) {
    const rect = canvas?.getBoundingClientRect?.();
    if (!rect) return { x: 0, y: 0 };
    return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
    };
}

export function ScriptCanvas({ world = null, children = null }) {
    const {
        viewport,
        viewportRef,
        isPanModeRef,
        canvasRef,
        setViewport,
    } = useContext(CanvasViewportContext);
    const [isPanning, setIsPanning] = useState(false);
    const panStateRef = useRef({ active: false, lastX: 0, lastY: 0 });

    useEffect(() => {
        dispatchCanvasViewportChanged(viewport);
    }, [viewport]);

    useEffect(() => {
        const canvas = canvasRef?.current;
        if (!canvas) return;

        const onWheel = (event) => {
            if (isCanvasChromeTarget(event.target)) return;
            event.preventDefault();

            const origin = canvasOriginFromElement(canvas);
            const cursor = { x: event.clientX, y: event.clientY };
            // Trackpad two-finger scroll and mouse wheel zoom; grab-drag is the only pan.
            setViewport(zoomViewportAt(
                viewportRef.current,
                cursor,
                wheelZoomFactor(event.deltaY),
                origin,
            ));
        };

        canvas.addEventListener("wheel", onWheel, { passive: false });
        return () => {
            canvas.removeEventListener("wheel", onWheel);
        };
    }, [canvasRef, setViewport, viewportRef]);

    useEffect(() => {
        const canvas = canvasRef?.current;
        if (!canvas) return;

        const stopPan = () => {
            if (!panStateRef.current.active) return;
            panStateRef.current.active = false;
            setIsPanning(false);
        };

        const onMouseDown = (event) => {
            if (isCanvasChromeTarget(event.target)) return;

            const middle = event.button === 1;
            const spacePan = event.button === 0 && isPanModeRef.current;
            const emptyPan = event.button === 0 && !isPanModeRef.current && canStartEmptyCanvasPan(event.target);
            if (!middle && !spacePan && !emptyPan) return;

            event.preventDefault();
            panStateRef.current = {
                active: true,
                lastX: event.clientX,
                lastY: event.clientY,
            };
            setIsPanning(true);
        };

        const onMouseMove = (event) => {
            if (!panStateRef.current.active) return;
            const dx = event.clientX - panStateRef.current.lastX;
            const dy = event.clientY - panStateRef.current.lastY;
            panStateRef.current.lastX = event.clientX;
            panStateRef.current.lastY = event.clientY;
            setViewport(panViewport(viewportRef.current, dx, dy));
        };

        const onMouseUp = () => stopPan();
        const onMouseLeave = () => stopPan();

        canvas.addEventListener("mousedown", onMouseDown);
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        canvas.addEventListener("mouseleave", onMouseLeave);
        return () => {
            canvas.removeEventListener("mousedown", onMouseDown);
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
            canvas.removeEventListener("mouseleave", onMouseLeave);
        };
    }, [canvasRef, isPanModeRef, setViewport, viewportRef]);

    useEffect(() => {
        const onKeyDown = (event) => {
            if (event.code === "Space" && !event.repeat && !isEditableTarget(event.target)) {
                if (event.target?.closest?.("button, a, [href], [role='button']")) return;
                event.preventDefault();
                isPanModeRef.current = true;
                return;
            }

            if (!(event.ctrlKey || event.metaKey) || isEditableTarget(event.target)) return;
            if (event.key?.toLowerCase() === "s") return;

            const canvas = canvasRef?.current;
            const origin = canvasOriginFromElement(canvas);
            const center = canvasCenterScreen(canvas);

            if (event.key === "=" || event.key === "+") {
                event.preventDefault();
                setViewport(zoomViewportAt(viewportRef.current, center, CANVAS_TOOLBAR_ZOOM_FACTOR, origin));
                return;
            }

            if (event.key === "-" || event.key === "_") {
                event.preventDefault();
                setViewport(zoomViewportAt(viewportRef.current, center, 1 / CANVAS_TOOLBAR_ZOOM_FACTOR, origin));
                return;
            }

            if (event.key === "0") {
                event.preventDefault();
                setViewport({ ...DEFAULT_CANVAS_VIEWPORT });
            }
        };

        const onKeyUp = (event) => {
            if (event.code !== "Space") return;
            isPanModeRef.current = false;
        };

        const onBlur = () => {
            isPanModeRef.current = false;
        };

        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("keyup", onKeyUp);
        window.addEventListener("blur", onBlur);
        return () => {
            window.removeEventListener("keydown", onKeyDown);
            window.removeEventListener("keyup", onKeyUp);
            window.removeEventListener("blur", onBlur);
        };
    }, [canvasRef, isPanModeRef, setViewport, viewportRef]);

    const cursorClass = isPanning ? "cursor-grabbing" : "cursor-grab";

    return (
        <div
            data-script-canvas
            ref={canvasRef}
            className={`fixed inset-0 z-[1] h-[100dvh] w-[100vw] overflow-hidden bg-[var(--slate-bg)] ${cursorClass}`}
            style={{ touchAction: "none", overscrollBehavior: "none", userSelect: "none" }}
        >
            <Grid viewport={viewport} />
            <div
                className="script-canvas-world absolute left-0 top-0"
                style={{
                    transform: canvasWorldTransform(viewport),
                    transformOrigin: "0 0",
                    pointerEvents: "none",
                }}
            >
                <div style={{ pointerEvents: "auto" }}>
                    {world}
                </div>
            </div>
            {children}
        </div>
    );
}
