'use client';

import { useEffect, useMemo, useRef, useState } from "react";
import { SKY_MODES, SKY_QUALITY_PRESETS } from "../skybox/EnvironmentSkyConfig";
import { MenuButton } from "./ui/MenuButton";
import { MenuToggle } from "./ui/MenuToggle";
import { PanelSection } from "./ui/PanelSection";
import { cn } from "./ui/cn";

export function SkyToolIcon({ className = "h-3 w-3" }) {
    return (
        <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            className={className}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M4 17.5h16" />
            <path d="M7.2 14.4a5.2 5.2 0 0 1 9.6 0" />
            <path d="M9.1 11.8 7.6 10.3" />
            <path d="M12 10V7.8" />
            <path d="m14.9 11.8 1.5-1.5" />
            <path d="M5.2 17.5c.5-1.5 1.9-2.5 3.5-2.5.7 0 1.4.2 2 .6" />
            <path d="M13.3 15.6c.6-.4 1.3-.6 2-.6 1.6 0 3 1 3.5 2.5" />
        </svg>
    );
}

function formatTime(value) {
    const hours = Math.floor(Number(value) || 0);
    const minutes = Math.round(((Number(value) || 0) - hours) * 60);
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function RuntimeBadge({ runtime }) {
    const status = runtime?.status ?? "idle";
    const isLoading = status === "loading";
    const isError = status === "error";

    return (
        <div
            className={cn(
                "flex items-center justify-between gap-3 rounded-xl border px-2.5 py-2 transition-[background-color,border-color,color] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]",
                isError
                    ? "border-rose-500/50 bg-rose-500/10 text-rose-100"
                    : isLoading
                        ? "border-amber-400/40 bg-amber-400/10 text-amber-100"
                        : "border-emerald-400/35 bg-emerald-400/10 text-emerald-100",
            )}
        >
            <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em]">
                    {isError ? "Sky Error" : isLoading ? "Preparing Sky" : "Sky Ready"}
                </p>
                <p className="mt-0.5 text-[10px] text-zinc-300">
                    {runtime?.error || (isLoading ? "Loading atmosphere resources" : "Live environment preview")}
                </p>
            </div>
            <span
                className={cn(
                    "h-2.5 w-2.5 rounded-full",
                    isError ? "bg-rose-300" : isLoading ? "animate-pulse bg-amber-200" : "bg-emerald-300",
                )}
            />
        </div>
    );
}

function FieldBlock({ label, helper, children, error }) {
    return (
        <label className="grid gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                {label}
            </span>
            {children}
            {helper && !error && <span className="text-[10px] leading-snug text-zinc-500">{helper}</span>}
            {error && <span className="text-[10px] leading-snug text-rose-200">{error}</span>}
        </label>
    );
}

function RangeControl({ label, helper, value, min, max, step, display, onChange }) {
    return (
        <FieldBlock label={label} helper={helper}>
            <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                <input
                    type="range"
                    value={value}
                    min={min}
                    max={max}
                    step={step}
                    onChange={(event) => onChange?.(Number(event.target.value))}
                    className="h-1.5 w-full cursor-pointer accent-sky-300"
                />
                <span className="min-w-12 rounded-md border border-zinc-700/80 bg-zinc-950/70 px-1.5 py-1 text-right font-mono text-[10px] text-zinc-200">
                    {display ?? value}
                </span>
            </div>
        </FieldBlock>
    );
}

function SelectControl({ label, value, children, onChange }) {
    return (
        <FieldBlock label={label}>
            <select
                value={value}
                onChange={(event) => onChange?.(event.target.value)}
                className="h-8 rounded-lg border border-zinc-700/80 bg-zinc-950/80 px-2 text-[11px] text-zinc-100 outline-none transition-[border-color,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus:border-sky-300/80 focus:ring-2 focus:ring-sky-400/30"
            >
                {children}
            </select>
        </FieldBlock>
    );
}

function SkyModeButton({ active, children, onClick }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex-1 rounded-lg border px-2.5 py-2 text-[11px] font-semibold tracking-wide transition-[background-color,border-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.97]",
                active
                    ? "border-sky-300/80 bg-sky-500/25 text-sky-50"
                    : "border-zinc-700/80 bg-zinc-900/80 text-zinc-300 hover:bg-zinc-800/90",
            )}
        >
            {children}
        </button>
    );
}

export function EnvironmentSkyPanel({ data }) {
    const [snapshot, setSnapshot] = useState(null);
    const [imageDraft, setImageDraft] = useState("");
    const lastImageUrlRef = useRef("");

    const sky = useMemo(() => data?.sky?.() ?? data?.environment?.()?.sky?.(), [data]);

    useEffect(() => {
        return sky?.subscribe?.((nextSnapshot) => {
            const nextUrl = nextSnapshot?.image?.url ?? "";
            setSnapshot(nextSnapshot);
            setImageDraft((current) => {
                const shouldFollowExternalUrl = current === "" || current === lastImageUrlRef.current;
                lastImageUrlRef.current = nextUrl;
                return shouldFollowExternalUrl ? nextUrl : current;
            });
        });
    }, [sky]);

    if (!snapshot || !sky) {
        return (
            <PanelSection title="Sky System">
                <div className="rounded-xl border border-zinc-700/80 bg-zinc-900/70 p-3">
                    <div className="h-2 w-24 animate-pulse rounded-full bg-zinc-700/80" />
                    <div className="mt-2 h-2 w-40 animate-pulse rounded-full bg-zinc-800/90" />
                </div>
            </PanelSection>
        );
    }

    const updateTakram = (settings) => {
        sky.setTakramSettings(settings);
        data?.simulation?.()?.render?.();
    };

    const updateImage = (settings) => {
        sky.setImageSettings(settings);
        data?.simulation?.()?.render?.();
    };

    const setMode = (mode) => {
        sky.setMode(mode);
        data?.simulation?.()?.render?.();
    };

    const applyImageUrl = () => {
        updateImage({ url: imageDraft });
        setMode(SKY_MODES.IMAGE);
    };

    const handleFilePreview = (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        const url = URL.createObjectURL(file);
        sky.setImageLocalPreview(url, file.name);
        data?.simulation?.()?.render?.();
        event.target.value = "";
    };

    const clearPreview = () => {
        const previewUrl = snapshot.image.localPreviewUrl;
        sky.clearImageLocalPreview();
        if (previewUrl?.startsWith("blob:")) {
            URL.revokeObjectURL(previewUrl);
        }
        data?.simulation?.()?.render?.();
    };

    return (
        <>
            <PanelSection title="Sky System">
                <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-zinc-700/80 bg-zinc-900/70 p-1.5">
                    <SkyModeButton
                        active={snapshot.mode === SKY_MODES.TAKRAM}
                        onClick={() => setMode(SKY_MODES.TAKRAM)}
                    >
                        Takram Atmosphere
                    </SkyModeButton>
                    <SkyModeButton
                        active={snapshot.mode === SKY_MODES.IMAGE}
                        onClick={() => setMode(SKY_MODES.IMAGE)}
                    >
                        Image Skybox
                    </SkyModeButton>
                </div>
                <RuntimeBadge runtime={snapshot.runtime} />
            </PanelSection>

            {snapshot.mode === SKY_MODES.TAKRAM && (
                <PanelSection title="Takram Controls">
                    <MenuToggle
                        label="Volumetric clouds"
                        checked={snapshot.takram.cloudsEnabled}
                        onChange={(cloudsEnabled) => updateTakram({ cloudsEnabled })}
                        icon={<SkyToolIcon className="h-3 w-3" />}
                        hint="Clouds and aerial perspective are default"
                    />
                    <RangeControl
                        label="Cloud coverage"
                        value={snapshot.takram.cloudCoverage}
                        min={0}
                        max={1}
                        step={0.01}
                        display={`${Math.round(snapshot.takram.cloudCoverage * 100)}%`}
                        helper="Higher values thicken the Takram cloud layer."
                        onChange={(cloudCoverage) => updateTakram({ cloudCoverage })}
                    />
                    <div className="grid grid-cols-2 gap-2">
                        <SelectControl
                            label="Quality"
                            value={snapshot.takram.cloudQuality}
                            onChange={(cloudQuality) => updateTakram({ cloudQuality })}
                        >
                            {SKY_QUALITY_PRESETS.map((quality) => (
                                <option key={quality} value={quality}>
                                    {quality}
                                </option>
                            ))}
                        </SelectControl>
                        <RangeControl
                            label="Atmosphere"
                            value={snapshot.takram.atmosphereIntensity}
                            min={0.2}
                            max={2}
                            step={0.05}
                            display={snapshot.takram.atmosphereIntensity.toFixed(2)}
                            onChange={(atmosphereIntensity) => updateTakram({ atmosphereIntensity })}
                        />
                    </div>
                    <RangeControl
                        label="Solar time"
                        value={snapshot.takram.timeOfDay}
                        min={0}
                        max={23.99}
                        step={0.05}
                        display={formatTime(snapshot.takram.timeOfDay)}
                        helper="Moves sun, moon, sky lighting, and cloud illumination together."
                        onChange={(timeOfDay) => updateTakram({ timeOfDay })}
                    />
                    <div className="grid grid-cols-2 gap-1.5">
                        <MenuToggle
                            label="Haze"
                            checked={snapshot.takram.haze}
                            onChange={(haze) => updateTakram({ haze })}
                            hint="Low-altitude atmospheric depth"
                        />
                        <MenuToggle
                            label="Light shafts"
                            checked={snapshot.takram.lightShafts}
                            onChange={(lightShafts) => updateTakram({ lightShafts })}
                            hint="More dramatic, more expensive"
                        />
                    </div>
                </PanelSection>
            )}

            {snapshot.mode === SKY_MODES.IMAGE && (
                <PanelSection title="Imported Image">
                    <FieldBlock
                        label="Image URL or asset path"
                        helper="Persisted in the environment manifest. Local files are preview-only."
                        error={snapshot.runtime?.status === "error" ? snapshot.runtime.error : null}
                    >
                        <div className="grid grid-cols-[1fr_auto] gap-1.5">
                            <input
                                type="text"
                                value={imageDraft}
                                onChange={(event) => setImageDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter") applyImageUrl();
                                }}
                                placeholder="assets/skybox/sky.exr"
                                className="h-8 min-w-0 rounded-lg border border-zinc-700/80 bg-zinc-950/80 px-2 text-[11px] text-zinc-100 outline-none transition-[border-color,box-shadow] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] placeholder:text-zinc-600 focus:border-sky-300/80 focus:ring-2 focus:ring-sky-400/30"
                            />
                            <MenuButton compact onClick={applyImageUrl} title="Apply image sky URL">
                                Apply
                            </MenuButton>
                        </div>
                    </FieldBlock>
                    <RangeControl
                        label="Image exposure"
                        value={snapshot.image.exposure}
                        min={0.1}
                        max={3}
                        step={0.05}
                        display={snapshot.image.exposure.toFixed(2)}
                        onChange={(exposure) => updateImage({ exposure })}
                    />
                    <div className="rounded-xl border border-zinc-700/80 bg-zinc-950/55 p-2.5">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">
                            Local Preview
                        </p>
                        <p className="mt-1 text-[10px] leading-snug text-zinc-500">
                            Choose a local equirectangular image to test it without writing a managed asset.
                        </p>
                        <div className="mt-2 flex items-center gap-1.5">
                            <label className="inline-flex cursor-pointer items-center justify-center rounded-xl border border-zinc-700/90 bg-zinc-900/90 px-2.5 py-1.5 text-[11px] font-medium tracking-wide text-zinc-100 transition-[background-color,border-color,color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:bg-zinc-800/90 active:scale-[0.97]">
                                Choose file
                                <input
                                    type="file"
                                    accept=".exr,.hdr,image/*"
                                    onChange={handleFilePreview}
                                    className="sr-only"
                                />
                            </label>
                            {snapshot.image.localPreviewUrl && (
                                <MenuButton compact variant="ghost" onClick={clearPreview} title="Clear local preview">
                                    Clear preview
                                </MenuButton>
                            )}
                        </div>
                        {snapshot.image.localPreviewName ? (
                            <p className="mt-2 truncate font-mono text-[10px] text-sky-100">
                                {snapshot.image.localPreviewName}
                            </p>
                        ) : (
                            <p className="mt-2 text-[10px] text-zinc-500">
                                No local preview selected.
                            </p>
                        )}
                    </div>
                </PanelSection>
            )}
        </>
    );
}
