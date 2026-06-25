'use client';

import { useEffect, useMemo, useState } from "react";
import {
    FaBroadcastTower,
    FaChevronUp,
    FaClock,
    FaExclamationTriangle,
    FaImage,
    FaLayerGroup,
    FaStop,
    FaStepForward,
} from "react-icons/fa";
import { prepareRgbaForPng } from "../environment/visualization/bakeUpload";
import { cn } from "./ui/cn";

const TABS = [
    { key: "image", label: "Image", icon: FaImage },
    { key: "mask", label: "Mask", icon: FaLayerGroup },
    { key: "lidar", label: "LiDAR", icon: FaBroadcastTower },
];
const BAKE_OVERLAY_CONTROL_LOCK = "bake-progress-overlay";

function clamp01(value) {
    return Math.max(0, Math.min(1, Number(value) || 0));
}

function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "n/a";
    return new Intl.NumberFormat("en-US").format(Number(value));
}

function formatPercent(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "0%";
    const rounded = Math.round(Number(value) * 10) / 10;
    return `${rounded}%`;
}

function formatMs(ms) {
    if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return "n/a";
    const seconds = Math.max(0, Math.round(Number(ms) / 1000));
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    if (minutes <= 0) return `${rest}s`;
    return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

function stopEvent(event) {
    event.stopPropagation();
}

function statusTone(status) {
    if (status === "complete") return "border-emerald-400/70 bg-emerald-500/20 text-emerald-100";
    if (status === "error") return "border-rose-400/70 bg-rose-500/20 text-rose-100";
    if (status === "stopped") return "border-amber-400/70 bg-amber-500/20 text-amber-100";
    if (status === "preparing") return "border-sky-400/70 bg-sky-500/20 text-sky-100";
    return "border-sky-400/70 bg-sky-500/25 text-sky-50";
}

function useBakeSnapshot(data) {
    const [snapshot, setSnapshot] = useState(() => data?.baking?.()?.getSnapshot?.() ?? null);

    useEffect(() => {
        const harness = data?.baking?.();
        if (!harness?.subscribe) {
            setSnapshot(null);
            return undefined;
        }

        return harness.subscribe(setSnapshot);
    }, [data]);

    return snapshot;
}

function useFrameObjectUrl(frame, options = {}) {
    const [url, setUrl] = useState(null);
    const signature = frame?.updatedAt ?? null;

    useEffect(() => {
        if (!frame?.data || !frame.width || !frame.height) {
            setUrl(null);
            return undefined;
        }

        let revoked = false;
        let objectUrl = null;
        const canvas = document.createElement("canvas");
        canvas.width = frame.width;
        canvas.height = frame.height;
        const context = canvas.getContext("2d");

        if (!context) {
            setUrl(null);
            return undefined;
        }

        const imageData = context.createImageData(frame.width, frame.height);
        imageData.data.set(prepareRgbaForPng(frame.data, frame.width, frame.height, {
            flipY: options.flipY ?? frame.source !== "model",
            linearToSrgb: options.linearToSrgb ?? frame.colorSpace !== "srgb",
        }));
        context.putImageData(imageData, 0, 0);

        canvas.toBlob((blob) => {
            if (!blob || revoked) return;
            objectUrl = URL.createObjectURL(blob);
            setUrl(objectUrl);
        }, "image/png");

        return () => {
            revoked = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [frame, signature, options.flipY, options.linearToSrgb]);

    return url;
}

function Metric({ label, value, tone = "default" }) {
    return (
        <div className="flex h-7 min-w-0 items-center justify-between gap-2 overflow-hidden border-b border-zinc-800/80 last:border-b-0">
            <span className="min-w-0 truncate text-[10px] text-zinc-500">{label}</span>
            <span
                className={cn(
                    "max-w-[62%] shrink truncate text-right text-[11px] font-semibold tabular-nums",
                    tone === "good" && "text-emerald-300",
                    tone === "warn" && "text-amber-300",
                    tone === "bad" && "text-rose-300",
                    tone === "accent" && "text-sky-200",
                    tone === "default" && "text-zinc-100",
                )}
            >
                {value}
            </span>
        </div>
    );
}

function Section({ title, children, className }) {
    return (
        <section className={cn("min-w-0 min-h-[325px] overflow-hidden rounded-xl border border-zinc-700/70 bg-zinc-900/65 p-2.5", className)}>
            <div className="mb-1.5 flex items-center justify-between">
                <p className="text-[10px] font-semibold tracking-wide text-zinc-300">{title}</p>
            </div>
            {children}
        </section>
    );
}

function PreviewPlaceholder({ label }) {
    return (
        <div className="flex h-full items-center justify-center bg-zinc-950/75">
            <span className="text-[11px] text-zinc-500">{label}</span>
        </div>
    );
}

function LidarPreview({ lidar }) {
    const hitRatio = lidar?.totalRays ? clamp01(lidar.hitCount / lidar.totalRays) : 0;
    const topTags = Object.entries(lidar?.tagCounts ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4);

    return (
        <div className="flex h-full flex-col justify-between bg-zinc-950/75 p-3">
            <div className="grid grid-cols-2 gap-2">
                <div>
                    <p className="text-[10px] text-zinc-500">Hits</p>
                    <p className="text-lg font-semibold tabular-nums text-zinc-100">{formatNumber(lidar?.hitCount)}</p>
                </div>
                <div>
                    <p className="text-[10px] text-zinc-500">Hit ratio</p>
                    <p className="text-lg font-semibold tabular-nums text-zinc-100">{formatPercent(hitRatio * 100)}</p>
                </div>
                <div>
                    <p className="text-[10px] text-zinc-500">Filtered</p>
                    <p className="text-lg font-semibold tabular-nums text-sky-200">{formatNumber(lidar?.filteredCount)}</p>
                </div>
                <div>
                    <p className="text-[10px] text-zinc-500">Candidates</p>
                    <p className="text-lg font-semibold tabular-nums text-sky-200">{formatNumber(lidar?.updateCandidateCount)}</p>
                </div>
            </div>

            <div className="space-y-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                        className="h-full origin-left bg-sky-400"
                        style={{ transform: `scaleX(${hitRatio})` }}
                    />
                </div>
                <div className="flex flex-wrap gap-1">
                    {topTags.length > 0 ? topTags.map(([tag, count]) => (
                        <span
                            key={tag}
                            className="rounded-md border border-zinc-700/80 bg-zinc-900 px-1.5 py-0.5 text-[10px] text-zinc-300"
                        >
                            {tag}: {formatNumber(count)}
                        </span>
                    )) : (
                        <span className="text-[10px] text-zinc-500">No tagged hits yet</span>
                    )}
                </div>
            </div>
        </div>
    );
}

function Preview({ snapshot }) {
    const [tab, setTab] = useState("image");
    const imageUrl = useFrameObjectUrl(snapshot.lastImage);
    const maskUrl = useFrameObjectUrl(snapshot.mask, { flipY: true, linearToSrgb: false });
    const image = snapshot.lastImage;
    const mask = snapshot.mask;

    const metadata = tab === "mask"
        ? [
            ["Pass", mask?.passId],
            ["Pixels", mask?.whitePixels !== undefined ? formatNumber(mask.whitePixels) : null],
            ["Sliver", mask?.sliverPixels !== undefined && mask?.sliverPixels !== null ? formatNumber(mask.sliverPixels) : null],
        ]
        : tab === "lidar"
            ? [
                ["Rays", snapshot.lidar?.totalRays ? formatNumber(snapshot.lidar.totalRays) : null],
                ["Range", snapshot.lidar?.range ? `${formatNumber(snapshot.lidar.range)}m` : null],
                ["Grid", snapshot.lidar?.width && snapshot.lidar?.height ? `${snapshot.lidar.width} x ${snapshot.lidar.height}` : null],
            ]
            : [
                ["Source", image?.source],
                ["Size", image?.width && image?.height ? `${image.width} x ${image.height}` : null],
                ["Color", image?.colorSpace],
            ];

    return (
        <Section title="Latest Frame">
            <div className="mb-2 grid grid-cols-3 gap-1 rounded-lg border border-zinc-700/70 bg-zinc-950/70 p-1">
                {TABS.map((item) => {
                    const Icon = item.icon;
                    const active = tab === item.key;

                    return (
                        <button
                            key={item.key}
                            type="button"
                            className={cn(
                                "flex h-7 items-center justify-center gap-1 rounded-md text-[10px] font-medium transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.98]",
                                active ? "bg-sky-500/25 text-sky-100" : "text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100",
                            )}
                            onClick={() => setTab(item.key)}
                        >
                            <Icon className="h-3 w-3" />
                            {item.label}
                        </button>
                    );
                })}
            </div>

            <div className="aspect-video overflow-hidden rounded-lg border border-zinc-700/70 bg-zinc-950">
                {tab === "image" && (
                    imageUrl ? (
                        <img src={imageUrl} alt="Latest baked frame" className="h-full w-full object-cover" />
                    ) : (
                        <PreviewPlaceholder label="No image captured" />
                    )
                )}
                {tab === "mask" && (
                    maskUrl ? (
                        <img src={maskUrl} alt="Latest process mask" className="h-full w-full object-cover" />
                    ) : (
                        <PreviewPlaceholder label="No mask captured" />
                    )
                )}
                {tab === "lidar" && <LidarPreview lidar={snapshot.lidar} />}
            </div>

            <div className="mt-2 grid grid-cols-3 gap-1.5">
                {metadata.map(([label, value]) => (
                    <div key={label} className="min-w-0 rounded-md border border-zinc-800/80 bg-zinc-950/50 px-2 py-1">
                        <p className="truncate text-[9px] text-zinc-500">{label}</p>
                        <p className="truncate text-[10px] font-medium text-zinc-200">{value ?? "n/a"}</p>
                    </div>
                ))}
            </div>
        </Section>
    );
}

function EventLog({ events }) {
    return (
        <Section title="Recent Events">
            <div className="max-h-[132px] space-y-1 overflow-auto pr-1">
                {(events ?? []).length > 0 ? events.slice(-5).reverse().map((event) => (
                    <div
                        key={event.id}
                        className={cn(
                            "rounded-lg border px-2 py-1.5",
                            event.severity === "error" && "border-rose-500/50 bg-rose-500/10",
                            event.severity === "warning" && "border-amber-500/45 bg-amber-500/10",
                            event.severity !== "error" && event.severity !== "warning" && "border-zinc-800/80 bg-zinc-950/45",
                        )}
                    >
                        <div className="flex items-start gap-2">
                            {(event.severity === "error" || event.severity === "warning") && (
                                <FaExclamationTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" />
                            )}
                            <div className="min-w-0">
                                <p className="truncate text-[10px] font-medium text-zinc-100">{event.message}</p>
                                {event.detail && <p className="truncate text-[9px] text-zinc-500">{event.detail}</p>}
                            </div>
                        </div>
                    </div>
                )) : (
                    <p className="rounded-lg border border-zinc-800/80 bg-zinc-950/45 px-2 py-2 text-[10px] text-zinc-500">
                        No bake events yet
                    </p>
                )}
            </div>
        </Section>
    );
}

function PhotoStepper({ snapshot, manualAdvance, pendingManualSamples }) {
    const currentFrame = snapshot.currentFrameIndex;
    const nextFrame = snapshot.nextFrameIndex;
    const currentSample = snapshot.currentSampleId || snapshot.sampleId;
    const nextSample = snapshot.nextSampleId;

    return (
        <div className="mt-2 grid grid-cols-2 gap-2">
            <div className="min-w-0 overflow-hidden rounded-xl border border-zinc-700/80 bg-zinc-950/55 p-2.5">
                <p className="text-[10px] font-medium text-zinc-500">Current Photo</p>
                <p className="mt-1 truncate text-2xl font-semibold leading-none tabular-nums text-zinc-50">
                    {currentFrame === null || currentFrame === undefined ? "None" : `#${formatNumber(currentFrame)}`}
                </p>
                <p className="mt-1 truncate text-[10px] text-zinc-500">{currentSample || "No frame captured yet"}</p>
            </div>
            <div className="min-w-0 overflow-hidden rounded-xl border border-sky-400/50 bg-sky-500/[0.12] p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] font-medium text-sky-200/80">Next Photo</p>
                    {manualAdvance && (
                        <span className="rounded-md border border-sky-300/45 bg-sky-400/15 px-1.5 py-0.5 text-[9px] font-semibold text-sky-100">
                            {pendingManualSamples > 0 ? "queued" : "manual"}
                        </span>
                    )}
                </div>
                <p className="mt-1 truncate text-2xl font-semibold leading-none tabular-nums text-sky-50">
                    {nextFrame === null || nextFrame === undefined ? "Done" : `#${formatNumber(nextFrame)}`}
                </p>
                <p className="mt-1 truncate text-[10px] text-sky-100/60">
                    {nextSample || "No next sample"}
                    {Number.isFinite(snapshot.nextDistance) ? ` at ${snapshot.nextDistance.toFixed(1)}m` : ""}
                </p>
            </div>
        </div>
    );
}

function Diagnostics({ snapshot }) {
    const maskCoverage = snapshot.mask?.coverage !== undefined && snapshot.mask?.coverage !== null
        ? formatPercent(snapshot.mask.coverage * 100)
        : "n/a";
    const serverState = snapshot.server?.healthy === false
        ? "offline"
        : snapshot.server?.awaitingModel
            ? "waiting"
            : snapshot.server?.healthy === true
                ? "online"
                : "unknown";

    return (
        <div className="grid min-w-0 grid-cols-1 gap-2">
            <Section title="Masking">
                <Metric label="Active building" value={snapshot.mask?.activeBuildingId || snapshot.mask?.buildingId || "n/a"} tone="accent" />
                <Metric label="Visible buildings" value={formatNumber(snapshot.mask?.visibleBuildingIds?.length)} />
                <Metric label="Mask pixels" value={formatNumber(snapshot.mask?.whitePixels)} />
                <Metric label="Coverage" value={maskCoverage} />
                <Metric label="Sliver pixels" value={formatNumber(snapshot.mask?.sliverPixels)} tone={snapshot.mask?.sliverPixels === 0 ? "warn" : "default"} />
            </Section>

            <Section title="LiDAR">
                <Metric label="Hits" value={formatNumber(snapshot.lidar?.hitCount)} tone="accent" />
                <Metric label="World points" value={formatNumber(snapshot.lidar?.worldPointCount)} />
                <Metric label="Filtered" value={formatNumber(snapshot.lidar?.filteredCount)} />
                <Metric label="Candidates" value={formatNumber(snapshot.lidar?.updateCandidateCount)} tone={snapshot.lidar?.updateCandidateCount === 0 ? "warn" : "default"} />
                <Metric label="Range" value={snapshot.lidar?.range ? `${formatNumber(snapshot.lidar.range)}m` : "n/a"} />
            </Section>

            <Section title="Splats">
                <Metric label="Committed" value={formatNumber(snapshot.splat?.committed)} tone={snapshot.splat?.committed === 0 ? "warn" : "good"} />
                <Metric label="Total" value={formatNumber(snapshot.splat?.total)} tone="accent" />
                <Metric label="Input points" value={formatNumber(snapshot.splat?.inputCount)} />
                <Metric label="Skipped covered" value={formatNumber(snapshot.splat?.skippedCovered)} />
                <Metric label="Skipped masked" value={formatNumber(snapshot.splat?.skippedMasked)} />
            </Section>

            <Section title="Server">
                <Metric label="State" value={serverState} tone={serverState === "offline" ? "bad" : serverState === "waiting" ? "warn" : "default"} />
                <Metric label="Model" value={snapshot.server?.useModel ? "enabled" : "raw only"} />
                <Metric label="Latency" value={snapshot.server?.lastLatencyMs ? formatMs(snapshot.server.lastLatencyMs) : "n/a"} />
                <Metric label="Host" value={snapshot.server?.host || "n/a"} />
                <Metric label="Warnings" value={formatNumber(snapshot.warnings?.length)} tone={snapshot.warnings?.length ? "warn" : "default"} />
            </Section>
        </div>
    );
}

export function BakeProgressOverlay({ data }) {
    const snapshot = useBakeSnapshot(data);
    const [drawerOpen, setDrawerOpen] = useState(true);
    const [hiddenAfterStop, setHiddenAfterStop] = useState(false);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: settings?.disableControls,
            enable: settings?.enableControls,
        };
    }, [data]);

    useEffect(() => {
        return () => {
            controls.enable?.(BAKE_OVERLAY_CONTROL_LOCK);
        };
    }, [controls]);

    useEffect(() => {
        if (!snapshot) return undefined;
        if (snapshot.status !== "stopped") {
            setHiddenAfterStop(false);
            return undefined;
        }

        const timeout = setTimeout(() => setHiddenAfterStop(true), 3500);
        return () => clearTimeout(timeout);
    }, [snapshot]);

    if (!snapshot || snapshot.status === "idle" || hiddenAfterStop) return null;

    const progress = clamp01((snapshot.percent ?? 0) / 100);
    const canStop = snapshot.status === "running" || snapshot.status === "preparing";
    const canAdvance = snapshot.status === "running" || snapshot.status === "preparing";
    const manualAdvance = Boolean(snapshot.control?.manualAdvance);
    const pendingManualSamples = snapshot.control?.pendingManualSamples ?? 0;

    const stopBake = () => {
        const harness = data?.baking?.();
        harness?.stop?.();
        data?.simulation?.()?.setModule?.("baking", false);
    };

    const queueNextPhoto = () => {
        const harness = data?.baking?.();
        harness?.requestNextPhoto?.();
        data?.simulation?.()?.setModule?.("baking", true);
    };

    const resumeAuto = () => {
        const harness = data?.baking?.();
        harness?.setManualAdvance?.(false);
        data?.simulation?.()?.setModule?.("baking", true);
    };

    const disablePanelControls = (event) => {
        event.stopPropagation();
        controls.disable?.(BAKE_OVERLAY_CONTROL_LOCK);
    };

    const enablePanelControls = (event) => {
        event?.stopPropagation?.();
        controls.enable?.(BAKE_OVERLAY_CONTROL_LOCK);
    };

    if (!drawerOpen) {
        return (
            <button
                type="button"
                title="Open bake progress"
                aria-label="Open bake progress"
                onClick={(event) => {
                    stopEvent(event);
                    setDrawerOpen(true);
                }}
                onPointerDown={stopEvent}
                className="bake-progress-overlay fixed right-0 top-24 z-30 flex h-24 w-11 flex-col items-center justify-center gap-1 rounded-l-2xl border border-r-0 border-zinc-700/80 bg-zinc-950/90 text-zinc-100 shadow-[0_20px_60px_rgba(0,0,0,0.4)] backdrop-blur-2xl pointer-events-auto transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-zinc-900/95 focus:outline-none focus:ring-2 focus:ring-sky-400/60 active:scale-[0.98]"
            >
                <FaLayerGroup className="h-3.5 w-3.5 text-sky-300" />
                <span className="[writing-mode:vertical-rl] text-[10px] font-semibold tracking-wide text-zinc-200">
                    Bake
                </span>
                <span className="text-[9px] tabular-nums text-sky-200">{formatPercent(snapshot.percent)}</span>
            </button>
        );
    }

    return (
        <aside
            className={cn(
                "bake-progress-overlay fixed bottom-20 right-3 top-3 z-30 flex w-[380px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-zinc-700/80 bg-zinc-950/85 p-2.5 text-zinc-100 shadow-[0_30px_90px_rgba(0,0,0,0.48)] backdrop-blur-2xl pointer-events-auto md:right-3 max-md:left-3 max-md:w-auto",
            )}
            onPointerDown={disablePanelControls}
            onPointerUp={enablePanelControls}
            onPointerCancel={enablePanelControls}
            onPointerLeave={enablePanelControls}
            onClick={stopEvent}
        >
            <div className="shrink-0 rounded-xl border border-zinc-700/80 bg-zinc-900/70 p-2.5">
                <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                        <div className="mb-1.5 flex items-center gap-1.5">
                            <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-semibold", statusTone(snapshot.status))}>
                                {snapshot.status}
                            </span>
                            <span className="truncate text-[10px] text-zinc-400">{snapshot.runId}</span>
                        </div>
                        <h2 className="truncate text-sm font-semibold text-zinc-50">{snapshot.stage}</h2>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                        {canStop && (
                            <button
                                type="button"
                                title="Stop bake"
                                aria-label="Stop bake"
                                onClick={stopBake}
                                className="flex h-8 w-8 items-center justify-center rounded-lg border border-rose-500/70 bg-rose-500/20 text-rose-100 transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-rose-500/30 focus:outline-none focus:ring-2 focus:ring-rose-400/60 active:scale-[0.97]"
                            >
                                <FaStop className="h-3 w-3" />
                            </button>
                        )}
                        <button
                            type="button"
                            title="Hide bake progress"
                            aria-label="Hide bake progress"
                            onClick={() => {
                                controls.enable?.(BAKE_OVERLAY_CONTROL_LOCK);
                                setDrawerOpen(false);
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900/85 text-zinc-200 transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-zinc-800/90 focus:outline-none focus:ring-2 focus:ring-sky-400/60 active:scale-[0.97]"
                        >
                            <FaChevronUp className="h-3 w-3 rotate-90" />
                        </button>
                    </div>
                </div>

                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                    <div
                        className="bake-progress-fill h-full origin-left bg-sky-400"
                        style={{ transform: `scaleX(${progress})` }}
                    />
                </div>

                {canAdvance && (
                    <div className="mt-2 grid grid-cols-[1fr_auto] gap-1.5">
                        <button
                            type="button"
                            title="Queue the next bake photo"
                            aria-label="Next photo"
                            onClick={queueNextPhoto}
                            className="flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-sky-400/70 bg-sky-500/20 px-2 text-[11px] font-semibold text-sky-100 transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-sky-500/30 focus:outline-none focus:ring-2 focus:ring-sky-400/60 active:scale-[0.98]"
                        >
                            <FaStepForward className="h-3 w-3 shrink-0" />
                            <span className="truncate">Next Photo</span>
                            {pendingManualSamples > 0 && (
                                <span className="rounded-md border border-sky-300/50 bg-sky-400/20 px-1 text-[9px] tabular-nums">
                                    {pendingManualSamples}
                                </span>
                            )}
                        </button>
                        {manualAdvance && (
                            <button
                                type="button"
                                title="Resume automatic bake advance"
                                aria-label="Resume automatic bake advance"
                                onClick={resumeAuto}
                                className="flex h-8 items-center justify-center rounded-lg border border-zinc-700/80 bg-zinc-900/85 px-2 text-[11px] font-semibold text-zinc-200 transition-[background-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-zinc-800/90 focus:outline-none focus:ring-2 focus:ring-sky-400/60 active:scale-[0.98]"
                            >
                                Auto
                            </button>
                        )}
                    </div>
                )}

                <PhotoStepper
                    snapshot={snapshot}
                    manualAdvance={manualAdvance}
                    pendingManualSamples={pendingManualSamples}
                />

                <div className="mt-2 grid grid-cols-2 gap-1.5 min-[360px]:grid-cols-4">
                    <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-950/55 px-2 py-1">
                        <p className="text-[9px] text-zinc-500">Progress</p>
                        <p className="truncate text-[11px] font-semibold tabular-nums text-zinc-100">{formatPercent(snapshot.percent)}</p>
                    </div>
                    <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-950/55 px-2 py-1">
                        <p className="text-[9px] text-zinc-500">Sample</p>
                        <p className="truncate text-[11px] font-semibold tabular-nums text-zinc-100">
                            {formatNumber(snapshot.completedSamples)}/{formatNumber(snapshot.totalSamples)}
                        </p>
                    </div>
                    <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-950/55 px-2 py-1">
                        <p className="flex items-center gap-1 text-[9px] text-zinc-500"><FaClock className="h-2.5 w-2.5" />Elapsed</p>
                        <p className="truncate text-[11px] font-semibold tabular-nums text-zinc-100">{formatMs(snapshot.elapsedMs)}</p>
                    </div>
                    <div className="min-w-0 overflow-hidden rounded-lg border border-zinc-800/80 bg-zinc-950/55 px-2 py-1">
                        <p className="text-[9px] text-zinc-500">ETA</p>
                        <p className="truncate text-[11px] font-semibold tabular-nums text-zinc-100">{formatMs(snapshot.etaMs)}</p>
                    </div>
                </div>
            </div>

            <div className="mt-2 flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-auto pr-1">
                <Preview snapshot={snapshot} />
                <Diagnostics snapshot={snapshot} />
                <EventLog events={snapshot.recentEvents} />
            </div>
        </aside>
    );
}
