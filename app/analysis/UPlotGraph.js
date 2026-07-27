'use client';

import { useEffect, useRef } from "react";

export default function UPlotGraph({ data, series, onCursor, onUnlockLive, onWidth }) {
    const mountRef = useRef(null);
    const plotRef = useRef(null);
    const dataRef = useRef(data);
    const callbacksRef = useRef({ onCursor, onUnlockLive, onWidth });
    callbacksRef.current = { onCursor, onUnlockLive, onWidth };
    dataRef.current = data;

    useEffect(() => {
        let disposed = false;
        let observer;
        const mount = mountRef.current;
        if (!mount) return undefined;
        import("uplot").then(({ default: uPlot }) => {
            if (disposed) return;
            const rect = mount.getBoundingClientRect();
            callbacksRef.current.onWidth?.(Math.floor(rect.width));
            const options = {
                width: Math.max(320, Math.floor(rect.width)),
                height: Math.max(240, Math.floor(rect.height)),
                cursor: { drag: { x: true, y: false, setScale: true } },
                select: { show: true },
                scales: { x: { time: false }, y: { auto: true }, y2: { auto: true } },
                axes: [
                    { stroke: "#71717a", grid: { stroke: "#27272a", width: 1 }, ticks: { stroke: "#3f3f46" }, values: (_u, values) => values.map((value) => `${value.toFixed(1)}s`) },
                    { stroke: "#71717a", grid: { stroke: "#27272a", width: 1 }, ticks: { stroke: "#3f3f46" }, size: 55 },
                    { side: 1, scale: "y2", stroke: "#71717a", grid: { show: false }, ticks: { stroke: "#3f3f46" }, size: 55 },
                ],
                series: [
                    { label: "Time" },
                    ...series.map((item) => ({
                        label: item.label,
                        stroke: item.color,
                        width: item.width || 1.5,
                        scale: item.axis === "right" ? "y2" : "y",
                        points: { show: false },
                        spanGaps: true,
                    })),
                ],
                hooks: {
                    setCursor: [(plot) => {
                        const index = plot.cursor.idx;
                        if (index !== null && index !== undefined && plot.data[0][index] !== undefined) callbacksRef.current.onCursor?.(plot.data[0][index] * 1e6);
                    }],
                },
            };
            const initialData = dataRef.current?.length === series.length + 1
                ? dataRef.current
                : Array.from({ length: series.length + 1 }, () => []);
            const plot = new uPlot(options, initialData, mount);
            plotRef.current = plot;
            observer = new ResizeObserver(() => {
                const next = mount.getBoundingClientRect();
                callbacksRef.current.onWidth?.(Math.floor(next.width));
                plot.setSize({ width: Math.max(320, Math.floor(next.width)), height: Math.max(240, Math.floor(next.height)) });
            });
            observer.observe(mount);
        });
        return () => {
            disposed = true;
            observer?.disconnect();
            plotRef.current?.destroy();
            plotRef.current = null;
        };
    }, [series]);

    useEffect(() => {
        if (plotRef.current && data?.length === series.length + 1) plotRef.current.setData(data);
    }, [data, series.length]);

    const finishPointerGesture = () => {
        const latest = dataRef.current?.[0]?.at(-1);
        const visibleEnd = plotRef.current?.scales?.x?.max;
        if (Number.isFinite(latest) && Number.isFinite(visibleEnd) && visibleEnd < latest - 0.001) {
            callbacksRef.current.onUnlockLive?.();
        }
    };

    return <div className="relative h-full min-h-[240px] w-full bg-zinc-950" onPointerUp={finishPointerGesture}><div ref={mountRef} className="absolute inset-0 overflow-hidden" />{!data?.[0]?.length && <div className="pointer-events-none absolute inset-0 grid place-items-center bg-zinc-950 text-center"><div><p className="text-xs font-medium text-zinc-300">Add numeric signals to graph</p><p className="mt-1 text-[10px] text-zinc-600">Click +, double-click a signal, press Enter, or drag it here.</p></div></div>}</div>;
}
