'use client';

import { useEffect, useMemo, useRef } from "react";
import { FaCheck, FaCode, FaCog, FaCube, FaTimes } from "react-icons/fa";
import { cn } from "../ui/cn";

export default function Menu({
    activeView = "scripting",
    onScene,
    onConfig,
    onScripting,
    onClose,
}) {
    const focusItemRef = useRef(null);

    const items = useMemo(() => [
        {
            key: "3d",
            label: "Scene",
            hint: "Simulation viewport",
            icon: <FaCube className="h-4 w-4" />,
            onSelect: onScene,
        },
        {
            key: "scripting",
            label: "Scripting",
            hint: "Visual logic canvas",
            icon: <FaCode className="h-4 w-4" />,
            onSelect: onScripting,
        },
        {
            key: "config",
            label: "Config",
            hint: "Settings panel",
            icon: <FaCog className="h-4 w-4" />,
            onSelect: onConfig,
        },
    ], [onConfig, onScene, onScripting]);

    const focusKey = useMemo(() => {
        const activeItem = items.find((item) => item.key === activeView && typeof item.onSelect === "function");
        const firstEnabledItem = items.find((item) => typeof item.onSelect === "function");

        return activeItem?.key ?? firstEnabledItem?.key;
    }, [activeView, items]);

    useEffect(() => {
        const previousFocus = document.activeElement;
        focusItemRef.current?.focus();

        return () => {
            if (previousFocus instanceof HTMLElement) {
                previousFocus.focus();
            }
        };
    }, []);

    return (
        <div
            className="route-switcher-scrim fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12dvh] text-zinc-100"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                    onClose?.();
                }
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="route-switcher-title"
                className="route-switcher-panel w-full max-w-[420px] rounded-2xl border border-zinc-700/80 bg-zinc-950/90 p-2 shadow-[0_30px_100px_rgba(0,0,0,0.55)] backdrop-blur-2xl"
                onMouseDown={(event) => event.stopPropagation()}
            >
                <div className="flex items-center justify-between gap-3 px-2 py-2">
                    <div className="min-w-0">
                        <p id="route-switcher-title" className="text-[13px] font-semibold tracking-wide text-zinc-50">
                            Switch workspace
                        </p>
                        <p className="mt-0.5 text-[11px] text-zinc-400">
                            Choose where to work next.
                        </p>
                    </div>
                    <button
                        type="button"
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-zinc-700/80 bg-zinc-900/75 text-zinc-300 transition-[background-color,border-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-zinc-800/85 focus:outline-none focus:ring-2 focus:ring-sky-400/60 active:scale-[0.97]"
                        aria-label="Close switcher"
                        title="Close switcher"
                        onClick={onClose}
                    >
                        <FaTimes className="h-3 w-3" />
                    </button>
                </div>

                <div className="space-y-1">
                    {items.map((item, index) => {
                        const enabled = typeof item.onSelect === "function";
                        const active = item.key === activeView;

                        return (
                            <button
                                key={item.key}
                                ref={item.key === focusKey ? focusItemRef : undefined}
                                type="button"
                                disabled={!enabled}
                                aria-current={active ? "page" : undefined}
                                className={cn(
                                    "route-switcher-item flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left focus:outline-none focus:ring-2 focus:ring-sky-400/60",
                                    active
                                        ? "border-sky-400/70 bg-sky-500/15 text-sky-50"
                                        : "border-transparent bg-zinc-900/35 text-zinc-100",
                                    enabled
                                        ? "cursor-pointer hover:border-zinc-600/80 hover:bg-zinc-800/80"
                                        : "cursor-not-allowed opacity-45"
                                )}
                                onClick={() => {
                                    if (!enabled) return;
                                    item.onSelect();
                                }}
                            >
                                <span
                                    className={cn(
                                        "flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border",
                                        active
                                            ? "border-sky-400/70 bg-sky-500/20 text-sky-100"
                                            : "border-zinc-700/70 bg-zinc-900/80 text-zinc-300"
                                    )}
                                >
                                    {item.icon}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-[13px] font-semibold tracking-wide">
                                        {item.label}
                                    </span>
                                    <span className="mt-0.5 block truncate text-[11px] text-zinc-400">
                                        {enabled ? item.hint : "Not wired yet"}
                                    </span>
                                </span>
                                {active && (
                                    <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-400/15 text-sky-200">
                                        <FaCheck className="h-3 w-3" />
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
