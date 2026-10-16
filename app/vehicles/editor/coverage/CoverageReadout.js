'use client';

import { Switch } from "../../../ui";

function meters(value) {
    if (value == null || !Number.isFinite(value)) return "—";
    return `${value.toFixed(2)} m`;
}

function angle(value) {
    if (!Number.isFinite(value)) return "—";
    const rounded = Math.round(value * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}°` : `${rounded.toFixed(1)}°`;
}

/**
 * Viewport readout for the coverage pass. It does not edit the vehicle document.
 */
export function CoverageReadout({
    report,
    shellRadiusM,
    onShellRadius,
    shellVisible = true,
    floorVisible = true,
    onShellVisible,
    onFloorVisible,
}) {
    const measuring = !report || report.complete !== true;
    const noRays = report?.complete === true && report.rayCount === 0;
    return (
        <section
            aria-label="Sensor coverage"
            className="pointer-events-auto absolute bottom-3 left-3 w-72 max-h-[70%] overflow-y-auto rounded-[var(--radius)] border border-[var(--slate-border)] bg-[var(--slate-floating)] p-3 text-[12px] text-[var(--slate-fg)] shadow-sm"
        >
            <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-[13px] font-semibold">Sensor coverage</h2>
                {measuring && <span className="text-[11px] text-[var(--slate-muted)]">Measuring…</span>}
            </div>
            <label className="mb-3 flex items-center justify-between gap-2 text-[11px] text-[var(--slate-muted)]">
                Shell radius
                <input
                    className="sf-input w-24"
                    type="number"
                    min="0.5"
                    step="0.5"
                    aria-label="Coverage shell radius"
                    value={shellRadiusM}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next) && next > 0) onShellRadius(next);
                    }}
                />
            </label>
            <div className="mb-3 space-y-1.5">
                <Switch label="Shell" checked={shellVisible} onCheckedChange={onShellVisible} />
                <Switch label="Floor" checked={floorVisible} onCheckedChange={onFloorVisible} />
            </div>
            {noRays && (
                <p className="text-[12px] leading-relaxed text-[var(--slate-muted)]">
                    No ranging sensors. IMU, GNSS, and wheel odometry are not included.
                </p>
            )}
            {report?.complete === true && report.rayCount > 0 && (
                <dl className="space-y-1.5">
                    <Metric label="Nearest surroundings sample" value={meters(report.nearestSampleM)} />
                    <Metric
                        label="Ground unseen radius"
                        value={report.groundBlindRadiusM == null ? "No ground hits" : meters(report.groundBlindRadiusM)}
                    />
                    <Metric
                        label="Open ground beyond the body"
                        value={report.groundGapM == null ? "No ground hits" : meters(report.groundGapM)}
                    />
                    <Metric
                        label="Largest horizon gap"
                        value={report.horizonGap
                            ? `${angle(report.horizonGap.spanDeg)} around ${angle(report.horizonGap.centerDeg)}`
                            : (report.clearCount > 0 ? "None" : "—")}
                    />
                </dl>
            )}
            {report?.complete === true && report.occluderSource === "none" && report.rayCount > 0 && (
                <p className="mt-2 text-[11px] leading-relaxed text-[var(--slate-muted)]">
                    The body is not occluding these rays.
                </p>
            )}
            {report?.complete === true && report.sensors?.length > 0 && (
                <ul className="mt-3 space-y-2 border-t border-[var(--slate-border)] pt-2">
                    {report.sensors.map((sensor) => (
                        <li key={sensor.id || sensor.type}>
                            <p className="truncate font-medium">{sensor.id || sensor.type}</p>
                            <p className="text-[11px] text-[var(--slate-muted)]">
                                {sensor.blockedCount} blocked · ground {meters(sensor.nearestGroundM)} to {meters(sensor.farthestGroundM)}
                            </p>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

function Metric({ label, value }) {
    return (
        <div className="flex items-baseline justify-between gap-3">
            <dt className="text-[11px] text-[var(--slate-muted)]">{label}</dt>
            <dd className="text-right font-medium tabular-nums">{value}</dd>
        </div>
    );
}
