'use client';

import { useEffect } from "react";
import { normalizeViewportRect, viewportRectsEqual } from "../../viewportRect.js";

/**
 * Publish an element's viewport-relative rectangle whenever its size or
 * position changes. ResizeObserver covers pane resizes; window resize and
 * scroll cover layout shifts. Measurements coalesce to one per frame.
 */
export function useElementRect(ref, onChange, { enabled = true } = {}) {
    useEffect(() => {
        const element = ref.current;
        if (!enabled || !element || typeof onChange !== "function") return undefined;
        let frame = 0;
        let last = null;
        const measure = () => {
            frame = 0;
            const bounds = element.getBoundingClientRect();
            const rect = normalizeViewportRect({ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height });
            if (viewportRectsEqual(rect, last)) return;
            last = rect;
            onChange(rect);
        };
        const schedule = () => {
            if (frame) return;
            frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : setTimeout(measure, 16);
        };
        measure();
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
        observer?.observe(element);
        window.addEventListener("resize", schedule);
        window.addEventListener("scroll", schedule, true);
        return () => {
            observer?.disconnect();
            window.removeEventListener("resize", schedule);
            window.removeEventListener("scroll", schedule, true);
            if (frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
        };
    }, [ref, onChange, enabled]);
}
