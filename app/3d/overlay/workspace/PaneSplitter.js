'use client';

import { useRef } from "react";
import { cn } from "../ui/cn";
import { PANE_LIMITS, PANE_STEP } from "../../editor/workspace/paneLayout.js";

/**
 * Keyboard- and pointer-resizable separator between a pane and the scene.
 * Arrow keys step ±8 px (Shift ±32), Home/End go to the minimum/maximum,
 * Enter or Space toggles the pane, double-click resets it.
 */
export function PaneSplitter({ paneId, label, aria, onResize, onStep, onToggle, onReset, disabled = false, controls, className }) {
    const limits = PANE_LIMITS[paneId];
    const horizontal = limits.axis === "y";
    const dragRef = useRef(null);

    const onPointerDown = (event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        dragRef.current = { pointerId: event.pointerId, start: horizontal ? event.clientY : event.clientX, size: aria.valuenow || limits.default };
        controls?.disable?.();
    };
    const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const current = horizontal ? event.clientY : event.clientX;
        // Side panes grow toward the center; the bottom pane grows upward.
        const direction = paneId === "inspector" || paneId === "assets" ? -1 : 1;
        onResize?.(drag.size + direction * (current - drag.start));
    };
    const endDrag = (event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        controls?.enable?.();
    };
    const onKeyDown = (event) => {
        if (disabled) return;
        const grow = horizontal ? "ArrowUp" : "ArrowRight";
        const shrink = horizontal ? "ArrowDown" : "ArrowLeft";
        // Side panes: the inspector grows leftward, so its arrow direction flips.
        const flip = paneId === "inspector" ? -1 : 1;
        if (event.key === grow || event.key === shrink) {
            event.preventDefault();
            const direction = (event.key === grow ? 1 : -1) * flip;
            onStep?.(direction, { large: event.shiftKey });
        } else if (event.key === "Home") {
            event.preventDefault();
            onResize?.(limits.min);
        } else if (event.key === "End") {
            event.preventDefault();
            onResize?.(limits.max);
        } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle?.();
        }
    };

    return (
        <div
            role="separator"
            tabIndex={disabled ? -1 : 0}
            aria-label={label}
            aria-orientation={aria.orientation}
            aria-valuenow={aria.valuenow}
            aria-valuemin={aria.valuemin}
            aria-valuemax={aria.valuemax}
            aria-controls={`environment-pane-${paneId}`}
            aria-disabled={disabled || undefined}
            data-pane-splitter={paneId}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => onReset?.()}
            onKeyDown={onKeyDown}
            className={cn(
                "pointer-events-auto relative shrink-0 bg-[var(--slate-surface-1)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--slate-ring)]",
                horizontal ? "cursor-row-resize" : "cursor-col-resize",
                disabled && "cursor-default",
                className,
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    "absolute bg-[var(--slate-border-70)] transition-[background-color] duration-[140ms]",
                    horizontal ? "left-0 right-0 top-1/2 h-px -translate-y-1/2" : "bottom-0 top-0 left-1/2 w-px -translate-x-1/2",
                    !disabled && "group-hover:bg-[var(--slate-fg-2)]",
                )}
            />
        </div>
    );
}
