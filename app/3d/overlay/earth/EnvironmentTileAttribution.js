'use client';

import Image from "next/image";
import { useEffect, useState } from "react";

function normalize(entry) {
    if (typeof entry === "string") return entry ? { type: "string", value: entry } : null;
    return entry?.value ? entry : null;
}

/** Credits for the environment-owned tile session, visible after import Apply. */
export function EnvironmentTileAttribution({ data }) {
    const [entries, setEntries] = useState([]);
    useEffect(() => {
        const refresh = () => {
            const host = data?.environment?.()?.tiles?.() ?? data?.earthTilesManager?.();
            setEntries((host?.getAttributions?.() ?? host?.attributions ?? []).map(normalize).filter(Boolean));
        };
        refresh();
        const interval = setInterval(refresh, 500);
        return () => clearInterval(interval);
    }, [data]);
    if (entries.length === 0) return null;
    const images = entries.filter((entry) => entry.type === "image");
    const text = entries.filter((entry) => entry.type !== "image").map((entry) => entry.value).join(" · ");
    return (
        <div data-earth-tile-attribution className="pointer-events-none absolute bottom-3 left-3 right-3 z-20">
            <div className="mx-auto flex w-fit max-w-full items-center gap-2 rounded-[var(--radius)] border border-zinc-700/70 bg-zinc-950/85 px-3 py-1.5 text-[11px] text-zinc-300">
                {images.map((entry) => <Image key={entry.value} unoptimized width={80} height={16} src={entry.value} alt={entry.alt ?? "Google"} className="h-4 w-auto rounded-sm bg-white px-1 py-0.5" />)}
                {text && <span>{text}</span>}
            </div>
        </div>
    );
}
