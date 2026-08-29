import {
    IconCircle as FaCircle,
    IconClock as FaClock,
    IconDatabase as FaDatabase,
    IconFileText as FaFileAlt,
    IconFlag as FaFlagCheckered,
} from "@tabler/icons-react";

import {
    deriveSimulationStatus,
    formatClockMode,
    formatSimulationTime,
    summarizeAssertions,
} from "./simulationStatus.js";

const TONES = {
    zinc: "text-zinc-300",
    sky: "text-sky-300",
    emerald: "text-emerald-300",
    amber: "text-amber-300",
    rose: "text-rose-300",
};

const DOTS = {
    zinc: "text-zinc-500",
    sky: "text-sky-400",
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    rose: "text-rose-400",
};

function Metric({ icon, label, value, valueClassName = "text-zinc-100", className = "", boldValue = "" }) {
    return (
        <div className={`min-w-0 px-3 ${className}`}>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                {icon}
                <span>{label}</span>
                <span className="font-bold">{boldValue}</span>
            </div>
            <p className={`mt-0.5 truncate font-mono text-[11px] font-semibold tabular-nums ${valueClassName}`}>{value}</p>
        </div>
    );
}

export function SimulationRunStatus({ simState, runState, recordingState, sensorPanelVisible = false }) {
    const presentation = deriveSimulationStatus(runState, simState);
    const resolved = runState?.activeResolved;
    const manifest = resolved?.manifest;
    const assertions = summarizeAssertions(runState?.assertionResults || simState?.assertions);
    const loggingPolicy = manifest?.logging?.policy;
    const recordingLabel = recordingState?.status === "error"
        ? "Log error"
        : recordingState?.active
            ? "Recording"
            : recordingState?.status === "starting"
                ? "Opening log"
                : loggingPolicy === "disabled"
                    ? "Disabled"
                    : loggingPolicy
                        ? `Ready (${loggingPolicy})`
                        : "Off";
    const recordingTone = recordingState?.status === "error"
        ? "text-rose-300"
        : recordingState?.active
            ? "text-rose-300"
            : "text-zinc-300";

    return (
        <header
            aria-label="Simulation run status"
            className="pointer-events-none fixed left-[320px] top-3 z-20 select-none max-md:hidden"
            style={{
                right: sensorPanelVisible
                    ? "calc(1.5rem + min(420px, calc(100vw - 1.5rem)))"
                    : "0.75rem",
            }}
        >
            <div className="grid min-h-14 grid-cols-[minmax(170px,0.85fr)_minmax(220px,1.5fr)_110px_120px] items-center divide-x divide-zinc-800 overflow-hidden rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/90 text-zinc-100 shadow-[0_16px_45px_rgba(0,0,0,0.38)] max-lg:grid-cols-[minmax(150px,1fr)_minmax(180px,1.2fr)_100px]">
                <div className="min-w-0 px-3.5 py-2">
                    <div className="flex items-center gap-2">
                        <FaCircle aria-hidden="true" className={`h-2 w-2 shrink-0 ${DOTS[presentation.tone]}`} />
                        <p role="status" className={`truncate text-[11px] font-semibold ${TONES[presentation.tone]}`}>{presentation.label}</p>
                    </div>
                    <p className="mt-0.5 truncate pl-4 text-[11px] text-zinc-500">{presentation.detail}</p>
                </div>

                <div className="min-w-0 px-3.5 py-2">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                        <FaFileAlt aria-hidden="true" className="h-2.5 w-2.5" />
                        <span>Run manifest</span>
                    </div>
                    {manifest ? (
                        <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
                            <p className="truncate text-[11px] font-semibold text-zinc-100">{manifest.name}</p>
                            <p className="shrink-0 font-mono text-[11px] text-zinc-500">{manifest.id} · {String(resolved.resolvedHash || "unresolved").slice(0, 8)}</p>
                        </div>
                    ) : (
                        <div className="mt-0.5 flex min-w-0 items-baseline gap-2">
                            <p className="truncate text-[11px] font-semibold text-zinc-300">No manifest loaded</p>
                            <p className="truncate text-[11px] text-zinc-600">{runState?.selectedManifestId ? `${runState.selectedManifestId} selected` : "Use Config to launch one"}</p>
                        </div>
                    )}
                </div>

                <Metric
                    icon={<FaClock aria-hidden="true" className="h-2.5 w-2.5" />}
                    label={`Step`}
                    boldValue={simState?.steps ?? 0}
                    value={formatSimulationTime(simState?.time)}
                    className="max-sm:hidden"
                />

                <div className="min-w-0 px-3 py-2 max-lg:hidden">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                        <FaDatabase aria-hidden="true" className="h-2.5 w-2.5" />
                        <span>Logging</span>
                    </div>
                    <p className={`mt-0.5 truncate text-[11px] font-semibold ${recordingTone}`}>{recordingLabel}</p>
                </div>
            </div>

            <div className="mx-3 grid grid-cols-[1fr_auto] border-x border-b border-zinc-800 bg-zinc-950/85 px-3 py-1 text-[11px] text-zinc-500 max-sm:hidden">
                <span className="truncate font-mono tabular-nums">{formatClockMode(simState)}</span>
                <span className={`ml-3 flex items-center gap-1.5 ${TONES[assertions.tone]}`}><FaFlagCheckered aria-hidden="true" className="h-2.5 w-2.5" />Assertions: {assertions.label}</span>
            </div>
        </header>
    );
}
