"use client";

import { useEffect, useRef, useState } from "react";

const DRAG_THRESHOLD_PX = 3;
const PIXELS_PER_STEP = 6;

function formatValue(value, precision) {
    if (!Number.isFinite(value)) return "0";
    const fixed = Number(value.toFixed(precision));
    return String(fixed);
}

function clamp(value, min, max) {
    let next = value;
    if (Number.isFinite(min)) next = Math.max(min, next);
    if (Number.isFinite(max)) next = Math.min(max, next);
    return next;
}

function roundToStep(value, step, precision) {
    if (!(step > 0)) return Number(value.toFixed(precision));
    const rounded = Math.round(value / step) * step;
    return Number(rounded.toFixed(precision));
}

/**
 * Number field that scrubbing left/right adjusts, while still allowing typed entry.
 * Drag right to increase, left to decrease. Hold Shift for finer steps, Alt for coarser.
 */
export function DragNumber({
    value,
    onChange,
    step = 0.01,
    min,
    max,
    precision = 3,
    disabled = false,
    className = "",
    "aria-label": ariaLabel,
}) {
    const [text, setText] = useState(null);
    const [pressed, setPressed] = useState(false);
    const [dragging, setDragging] = useState(false);
    const inputRef = useRef(null);
    const dragRef = useRef(null);
    const suppressClickRef = useRef(false);

    useEffect(() => () => {
        const state = dragRef.current;
        if (!state) return;
        document.documentElement.style.cursor = state.previousCursor;
        document.documentElement.style.userSelect = state.previousUserSelect;
    }, []);

    const commitText = (raw) => {
        const candidate = String(raw).trim();
        if (!candidate || candidate === "-" || candidate === "." || candidate === "-.") return false;
        const next = Number(candidate);
        if (!Number.isFinite(next)) return false;
        const clamped = clamp(next, min, max);
        onChange?.(clamped);
        return true;
    };

    const endDrag = (event) => {
        const state = dragRef.current;
        if (!state) return;
        dragRef.current = null;
        document.documentElement.style.cursor = state.previousCursor;
        document.documentElement.style.userSelect = state.previousUserSelect;
        setPressed(false);
        setDragging(false);
        setText(null);
        try {
            event.currentTarget.releasePointerCapture?.(state.pointerId);
        } catch {
            // Capture may already be released.
        }
        if (state.moved) {
            suppressClickRef.current = true;
        } else {
            // Pointer down is prevented so it can become a scrub. Restore the
            // normal click-to-type behavior if the pointer did not move.
            setTimeout(() => {
                inputRef.current?.focus();
                inputRef.current?.select();
            }, 0);
        }
    };

    return (
        <input
            ref={inputRef}
            type="text"
            inputMode="decimal"
            aria-label={ariaLabel}
            disabled={disabled}
            value={text ?? formatValue(value, precision)}
            className={`drag-number ${pressed ? "is-pressed" : ""} ${dragging ? "is-dragging" : ""} ${className}`.trim()}
            onClick={(event) => {
                if (!suppressClickRef.current) return;
                suppressClickRef.current = false;
                event.preventDefault();
            }}
            onChange={(event) => {
                const raw = event.target.value;
                setText(raw);
                commitText(raw);
            }}
            onBlur={() => {
                if (text !== null) commitText(text);
                setText(null);
            }}
            onKeyDown={(event) => {
                if (event.key === "Enter") {
                    event.currentTarget.blur();
                    return;
                }
                if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault();
                    const direction = event.key === "ArrowUp" ? 1 : -1;
                    const multiplier = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
                    const next = clamp(
                        roundToStep(Number(value) + direction * step * multiplier, step, precision),
                        min,
                        max,
                    );
                    onChange?.(next);
                    setText(null);
                }
            }}
            onPointerDown={(event) => {
                if (disabled || event.button !== 0) return;
                event.preventDefault();
                dragRef.current = {
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    origin: Number(value) || 0,
                    moved: false,
                    previousCursor: document.documentElement.style.cursor,
                    previousUserSelect: document.documentElement.style.userSelect,
                };
                document.documentElement.style.cursor = "ew-resize";
                document.documentElement.style.userSelect = "none";
                setPressed(true);
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
                const state = dragRef.current;
                if (!state || state.pointerId !== event.pointerId) return;

                const deltaX = event.clientX - state.startX;
                if (!state.moved && Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;

                if (!state.moved) {
                    state.moved = true;
                    setDragging(true);
                }

                const multiplier = event.shiftKey ? 0.1 : event.altKey ? 10 : 1;
                const delta = (deltaX / PIXELS_PER_STEP) * step * multiplier;
                const next = clamp(roundToStep(state.origin + delta, step, precision), min, max);
                onChange?.(next);
                setText(formatValue(next, precision));
            }}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
        />
    );
}
