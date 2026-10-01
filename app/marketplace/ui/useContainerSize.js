"use client";

import { useEffect, useState } from "react";

export function useMedia(query) {
    const [matches, setMatches] = useState(false);
    useEffect(() => {
        const media = window.matchMedia(query);
        const update = () => setMatches(media.matches);
        update();
        media.addEventListener("change", update);
        return () => media.removeEventListener("change", update);
    }, [query]);
    return matches;
}

/** Content-box size of a panel container. Zero until the element is measured. */
export function useContainerSize(ref, enabled = true) {
    const [size, setSize] = useState({ width: 0, height: 0 });
    useEffect(() => {
        const element = ref.current;
        if (!enabled || !element) return undefined;
        let frame = 0;
        const measure = () => {
            frame = 0;
            const bounds = element.getBoundingClientRect();
            const next = { width: Math.round(bounds.width), height: Math.round(bounds.height) };
            setSize((current) => (current.width === next.width && current.height === next.height ? current : next));
        };
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(measure);
        };
        measure();
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
        observer?.observe(element);
        return () => {
            observer?.disconnect();
            if (frame) cancelAnimationFrame(frame);
        };
    }, [enabled, ref]);
    return size;
}
