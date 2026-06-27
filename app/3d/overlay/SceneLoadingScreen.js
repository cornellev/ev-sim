'use client';

import { useEffect, useState } from "react";
import { FaGlobeAmericas } from "react-icons/fa";
import { THREE_D_MODES } from "../viewState";
import { cn } from "./ui/cn";

const STATUS_COPY = {
    atmosphere: {
        label: "Atmosphere",
        detail: "Loading sky environment",
    },
    scene: {
        label: "Geometry",
        detail: "Assembling world scene",
    },
    runtime: {
        label: "Runtime",
        detail: "Starting simulation modules",
    },
};

function StatusRow({ active, complete, label, detail }) {
    return (
        <div
            className={cn(
                "flex items-start gap-3 border-l py-2 pl-4 transition-[border-color,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
                active && "border-sky-400/80 opacity-100",
                complete && !active && "border-emerald-400/50 opacity-70",
                !active && !complete && "border-zinc-800/80 opacity-45",
            )}
        >
            <span
                className={cn(
                    "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full transition-[background-color,transform] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)]",
                    active && "scene-loading-pulse bg-sky-300",
                    complete && !active && "bg-emerald-400",
                    !active && !complete && "bg-zinc-600",
                )}
            />
            <div className="min-w-0">
                <p className="text-[11px] font-semibold tracking-wide text-zinc-200">{label}</p>
                <p className="text-[10px] text-zinc-500">{detail}</p>
            </div>
        </div>
    );
}

export function SceneLoadingScreen({ visible, mode = THREE_D_MODES.SIMULATION, phase = "atmosphere" }) {
    const [mounted, setMounted] = useState(visible);

    useEffect(() => {
        if (visible) {
            setMounted(true);
            return undefined;
        }

        const timeout = setTimeout(() => setMounted(false), 240);
        return () => clearTimeout(timeout);
    }, [visible]);

    if (!mounted) return null;

    const modeLabel = mode === THREE_D_MODES.ENVIRONMENT ? "Environment Editor" : "Simulation";
    const phaseIndex = phase === "atmosphere" ? 0 : phase === "scene" ? 1 : 2;
    const current = STATUS_COPY[phase] ?? STATUS_COPY.atmosphere;

    return (
        <div
            aria-busy={visible}
            aria-live="polite"
            aria-label="Loading 3D scene"
            className={cn(
                "scene-loading-screen fixed inset-0 z-50 flex min-h-[100dvh] items-center bg-zinc-950 text-zinc-100",
                !visible && "scene-loading-screen--exit",
            )}
        >
            <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(56,189,248,0.12),transparent_55%)]"
            />
            <div
                aria-hidden="true"
                className="scene-loading-grain pointer-events-none absolute inset-0 opacity-[0.035]"
            />

            <div className="relative mx-auto grid w-full max-w-7xl grid-cols-1 gap-10 px-6 py-10 md:grid-cols-[1.15fr_0.85fr] md:px-10 md:py-16 lg:pl-[12vw]">
                <div className="flex flex-col justify-center">
                    <div className="mb-6 flex items-center gap-2 text-sky-200/80">
                        <FaGlobeAmericas className="h-4 w-4" />
                        <span className="text-[11px] font-semibold tracking-[0.18em] uppercase">{modeLabel}</span>
                    </div>

                    <h1 className="max-w-[14ch] text-4xl font-semibold tracking-tight text-zinc-50 md:text-5xl md:leading-[0.95]">
                        Preparing scene
                    </h1>
                    <p className="mt-4 max-w-[42ch] text-sm leading-relaxed text-zinc-400">
                        Waiting for the sky environment before revealing the canvas and tools.
                    </p>

                    <div className="mt-8 max-w-md">
                        <div className="mb-2 flex items-center justify-between gap-3">
                            <span className="text-[10px] font-medium tracking-wide text-zinc-500">{current.label}</span>
                            <span className="truncate text-[10px] text-zinc-400">{current.detail}</span>
                        </div>
                        <div className="h-1 overflow-hidden rounded-full bg-zinc-900">
                            <div className="scene-loading-shimmer h-full w-1/3 origin-left rounded-full bg-sky-400/90" />
                        </div>
                    </div>
                </div>

                <div className="flex flex-col justify-center md:pt-6">
                    <div className="rounded-[1.75rem] border border-zinc-800/80 bg-zinc-900/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] backdrop-blur-sm">
                        <p className="mb-3 text-[10px] font-semibold tracking-[0.14em] uppercase text-zinc-500">Load sequence</p>
                        <div className="space-y-1">
                            <StatusRow
                                active={phaseIndex === 0}
                                complete={phaseIndex > 0}
                                label={STATUS_COPY.atmosphere.label}
                                detail={STATUS_COPY.atmosphere.detail}
                            />
                            <StatusRow
                                active={phaseIndex === 1}
                                complete={phaseIndex > 1}
                                label={STATUS_COPY.scene.label}
                                detail={STATUS_COPY.scene.detail}
                            />
                            <StatusRow
                                active={phaseIndex === 2}
                                complete={false}
                                label={STATUS_COPY.runtime.label}
                                detail={STATUS_COPY.runtime.detail}
                            />
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
