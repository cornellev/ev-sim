'use client';

import { IconAlertTriangle, IconCheck, IconLoader2, IconMinus, IconWorld } from "@tabler/icons-react";

import { Button } from "../../ui";
import { THREE_D_MODES } from "../viewState";
import { cn } from "./ui/cn";

const STATUS_COPY = {
    atmosphere: { label: "Atmosphere", detail: "Load the sky environment" },
    scene: { label: "Geometry", detail: "Assemble world geometry" },
    runtime: { label: "Runtime", detail: "Start simulation modules" },
};

const PHASES = Object.keys(STATUS_COPY);

function StatusRow({ active, complete, label, detail }) {
    const Icon = complete ? IconCheck : active ? IconLoader2 : IconMinus;
    return (
        <div className="scene-status-row" data-active={active || undefined} data-complete={complete || undefined}>
            <Icon className={cn("scene-status-row__icon", active && "scene-status-row__icon--spin")} size={15} stroke={1.6} aria-hidden="true" />
            <span className="scene-status-row__label">{label}</span>
            <span className="scene-status-row__detail">{detail}</span>
        </div>
    );
}

export function SceneLoadingScreen({
    visible,
    mode = THREE_D_MODES.SIMULATION,
    phase = "atmosphere",
    error,
    onRetry,
}) {
    if (!visible) return null;

    const modeLabel = mode === THREE_D_MODES.ENVIRONMENT ? "Environment editor" : "Simulation";
    const phaseIndex = Math.max(0, PHASES.indexOf(phase));
    const progress = ((phaseIndex + 1) / PHASES.length) * 100;

    return (
        <div
            aria-busy={!error}
            aria-live="polite"
            aria-label={error ? "3D environment failed to load" : "Loading 3D environment"}
            className={cn("scene-loading-screen fixed inset-0 z-50 grid min-h-[100dvh] place-items-center bg-[var(--slate-bg)] px-6 text-[var(--slate-fg)]")}
        >
            <section className="scene-loading-instrument">
                <header className="scene-loading-instrument__header">
                    <IconWorld size={18} stroke={1.5} aria-hidden="true" />
                    <div>
                        <p className="scene-loading-instrument__mode">{modeLabel}</p>
                        <h1>{error ? "Environment load failed" : "Preparing scene"}</h1>
                    </div>
                </header>

                {error ? (
                    <div className="scene-loading-error" role="alert">
                        <IconAlertTriangle size={17} stroke={1.6} aria-hidden="true" />
                        <div>
                            <p>{error}</p>
                            <span>Check the environment data and try again.</span>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="scene-loading-progress" aria-hidden="true">
                            <span style={{ transform: `scaleX(${progress / 100})` }} />
                        </div>
                        <div className="scene-loading-sequence">
                            {PHASES.map((key, index) => (
                                <StatusRow
                                    key={key}
                                    active={index === phaseIndex}
                                    complete={index < phaseIndex}
                                    {...STATUS_COPY[key]}
                                />
                            ))}
                        </div>
                    </>
                )}

                {error && onRetry && (
                    <footer className="scene-loading-instrument__footer">
                        <Button variant="primary" onClick={onRetry}>Retry</Button>
                    </footer>
                )}
            </section>
        </div>
    );
}
