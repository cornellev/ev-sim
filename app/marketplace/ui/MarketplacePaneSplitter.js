"use client";

import { useRef } from "react";

import styles from "./MarketplaceWorkspace.module.css";

/**
 * Pointer- and keyboard-resizable separator. Arrow keys step by the amount
 * `onStep` applies, Home/End request the minimum/maximum, and double-click
 * resets. `growDirection` is 1 when dragging toward the positive client axis
 * grows the pane, and -1 when the pane grows the other way.
 */
export default function MarketplacePaneSplitter({
    splitterId,
    label,
    axis,
    growDirection,
    aria,
    controlsId,
    onResize,
    onStep,
    onReset,
    className,
}) {
    const dragRef = useRef(null);
    if (!aria) return null;
    const horizontal = axis === "y";

    const onPointerDown = (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = {
            pointerId: event.pointerId,
            start: horizontal ? event.clientY : event.clientX,
            size: aria.valuenow,
        };
    };
    const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const current = horizontal ? event.clientY : event.clientX;
        onResize?.(drag.size + growDirection * (current - drag.start));
    };
    const endDrag = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
    };
    const onKeyDown = (event) => {
        const positiveKey = horizontal ? "ArrowDown" : "ArrowRight";
        const negativeKey = horizontal ? "ArrowUp" : "ArrowLeft";
        if (event.key === positiveKey || event.key === negativeKey) {
            event.preventDefault();
            const towardPositive = event.key === positiveKey ? 1 : -1;
            onStep?.(towardPositive * growDirection, { large: event.shiftKey });
        } else if (event.key === "Home") {
            event.preventDefault();
            onResize?.(aria.valuemin);
        } else if (event.key === "End") {
            event.preventDefault();
            onResize?.(aria.valuemax);
        }
    };

    return (
        <div
            role="separator"
            tabIndex={0}
            aria-label={label}
            aria-orientation={aria.orientation}
            aria-valuenow={aria.valuenow}
            aria-valuemin={aria.valuemin}
            aria-valuemax={aria.valuemax}
            aria-controls={controlsId}
            data-market-splitter={splitterId}
            data-axis={axis}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => onReset?.()}
            onKeyDown={onKeyDown}
            className={[styles.marketSplitter, className].filter(Boolean).join(" ")}
        >
            <span aria-hidden="true" />
        </div>
    );
}
