'use client';

import { useEffect, useRef } from "react";
import styles from "./AnalysisPage.module.css";

export default function UPlotGraph({ data, series, loading = false, onCursor, onUnlockLive, onWidth }) {
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
                    { stroke: "#8a8a8a", grid: { stroke: "rgba(255,255,255,.06)", width: 1 }, ticks: { stroke: "rgba(255,255,255,.12)" }, values: (_u, values) => values.map((value) => `${value.toFixed(1)}s`) },
                    { stroke: "#8a8a8a", grid: { stroke: "rgba(255,255,255,.06)", width: 1 }, ticks: { stroke: "rgba(255,255,255,.12)" }, size: 55 },
                    { side: 1, scale: "y2", stroke: "#8a8a8a", grid: { show: false }, ticks: { stroke: "rgba(255,255,255,.12)" }, size: 55 },
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

    return <div className={styles.graph} onPointerUp={finishPointerGesture}><div ref={mountRef} className={styles.graphMount} />{loading && <div className={styles.graphEmpty}><div><p>Loading series</p><span>Reading recorded samples for the selected signals.</span></div></div>}{!loading && !data?.[0]?.length && <div className={styles.graphEmpty}><div><p>Add a signal with data to graph to visualize it.</p><span>Use the add button, double-click, press Enter, or drag a signal here.</span></div></div>}</div>;
}
