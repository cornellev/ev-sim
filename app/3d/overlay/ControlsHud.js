'use client';

import { useEffect, useState } from "react";

function formatAge(ageNs) {
    if (!Number.isFinite(ageNs)) return "—";
    if (ageNs < 1e6) return `${(ageNs / 1e3).toFixed(0)} µs`;
    if (ageNs < 1e9) return `${(ageNs / 1e6).toFixed(1)} ms`;
    return `${(ageNs / 1e9).toFixed(2)} s`;
}

function formatNum(value, digits = 2) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

/**
 * Compact requested / applied / achieved controls HUD for the live simulation chrome.
 */
export function ControlsHud({ data }) {
    const [snapshot, setSnapshot] = useState(null);

    useEffect(() => {
        if (!data) return undefined;
        const read = () => {
            const store = data.bindings?.()?.signalStore;
            setSnapshot(store?.read?.("visualization.controls.snapshot")?.value ?? null);
        };
        read();
        const store = data.bindings?.()?.signalStore;
        const unsubscribe = store?.subscribe?.(() => read());
        const timer = setInterval(read, 200);
        return () => {
            unsubscribe?.();
            clearInterval(timer);
        };
    }, [data]);

    const flags = snapshot?.flags || {};
    const flagLabels = [
        flags.timedOut && "timeout",
        flags.saturated && "sat",
        flags.rateLimited && "rate",
        flags.fallbackActive && "fallback",
        flags.delayed && "delay",
        flags.passthrough && "awaiting",
    ].filter(Boolean);
    const status = snapshot?.status || (snapshot ? "live" : "idle");

    return (
        <div
            className="pointer-events-none fixed bottom-[4.75rem] left-3 z-30 min-w-[248px] rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/90 px-3 py-2 font-mono text-[11px] text-zinc-100 shadow-[0_16px_45px_rgba(0,0,0,0.38)]"
            data-testid="controls-hud"
        >
            <div className="mb-1 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.08em] text-zinc-500">
                <span>Controls · {snapshot?.authority || "—"}</span>
                <span>{snapshot ? `${snapshot.mode || status} · seq ${snapshot.sequence ?? "—"}` : "no plant yet"}</span>
            </div>
            <div className="grid grid-cols-[auto_1fr_1fr_1fr] gap-x-2 gap-y-0.5">
                <span className="text-zinc-500" />
                <span className="text-zinc-500">req</span>
                <span className="text-zinc-500">app</span>
                <span className="text-zinc-500">ach</span>
                <span className="text-zinc-500">v</span>
                <span>{formatNum(snapshot?.requested?.speedMps)}</span>
                <span>{formatNum(snapshot?.applied?.speedMps)}</span>
                <span>{formatNum(snapshot?.achieved?.speedMps)}</span>
                <span className="text-zinc-500">δ</span>
                <span>{formatNum(snapshot?.requested?.steeringRad, 3)}</span>
                <span>{formatNum(snapshot?.applied?.steeringRad, 3)}</span>
                <span>{formatNum(snapshot?.achieved?.steeringRad, 3)}</span>
                <span className="text-zinc-500">a</span>
                <span>{formatNum(snapshot?.requested?.accelerationMps2)}</span>
                <span>{formatNum(snapshot?.applied?.accelerationMps2)}</span>
                <span>{formatNum(snapshot?.achieved?.accelerationMps2)}</span>
            </div>
            <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-zinc-500">
                <span>age {formatAge(snapshot?.heartbeatAgeNs ?? snapshot?.ageNs)}</span>
                <span>delay {formatAge(snapshot?.delayNs)}</span>
                {flagLabels.map((label) => (
                    <span
                        key={label}
                        className="rounded bg-[rgba(251,191,36,0.15)] px-1.5 py-0.5 text-[rgb(251,191,36)]"
                    >
                        {label}
                    </span>
                ))}
            </div>
        </div>
    );
}
