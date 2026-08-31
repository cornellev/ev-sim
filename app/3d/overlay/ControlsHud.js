'use client';

import { useEffect, useMemo, useState } from "react";
import { IconChevronUp, IconCircleFilled } from "@tabler/icons-react";
import { Panel } from "../../ui";

const CONTROLS_HUD_LOCK = "simulation-controls-hud";
const PANEL_COLLAPSED_KEY = "sf.controls-hud.collapsed";

const FLAG_META = [
    { key: "timedOut", label: "timeout", tone: "bad" },
    { key: "fallbackActive", label: "fallback", tone: "bad" },
    { key: "saturated", label: "sat", tone: "warn" },
    { key: "rateLimited", label: "rate", tone: "warn" },
    { key: "delayed", label: "delay", tone: "warn" },
    { key: "passthrough", label: "awaiting", tone: "idle" },
];

function readCollapsedPreference() {
    if (typeof window === "undefined") return true;
    try {
        const stored = window.localStorage.getItem(PANEL_COLLAPSED_KEY);
        if (stored === "1") return true;
        if (stored === "0") return false;
        return true;
    } catch {
        return true;
    }
}

function writeCollapsedPreference(collapsed) {
    try {
        window.localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
        // Ignore quota / private-mode failures.
    }
}

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

function statusTone(snapshot, flags) {
    if (!snapshot) return "idle";
    if (flags.fallbackActive || flags.timedOut) return "bad";
    if (flags.saturated || flags.rateLimited || flags.delayed) return "warn";
    const status = String(snapshot.status || "").toLowerCase();
    if (status === "stale" || status === "invalid" || status === "rejected") return "warn";
    return "ok";
}

function MeterRow({ label, unit, requested, applied, achieved, digits, warnApplied }) {
    return (
        <tr>
            <th scope="row">{label}</th>
            <td>{formatNum(requested, digits)}</td>
            <td data-warn={warnApplied || undefined}>{formatNum(applied, digits)}</td>
            <td data-achieved="true">{formatNum(achieved, digits)}</td>
            <td className="controls-hud-unit">{unit}</td>
        </tr>
    );
}

/**
 * Corner-docked requested / applied / achieved controls instrument.
 */
export function ControlsHud({ data }) {
    const [snapshot, setSnapshot] = useState(null);
    const [collapsed, setCollapsed] = useState(() => readCollapsedPreference());

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(CONTROLS_HUD_LOCK),
            enable: () => settings?.enableControls?.(CONTROLS_HUD_LOCK),
        };
    }, [data]);

    useEffect(() => () => controls.enable(), [controls]);

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
    const flagLabels = FLAG_META.filter((entry) => flags[entry.key]);
    const tone = statusTone(snapshot, flags);
    const status = snapshot?.status || (snapshot ? "live" : "idle");
    const authority = snapshot?.authority || "";
    const achievedSpeed = snapshot?.achieved?.speedMps;

    const toggleCollapsed = () => {
        setCollapsed((previous) => {
            const next = !previous;
            writeCollapsedPreference(next);
            return next;
        });
    };

    return (
        <Panel
            material="floating"
            className="controls-hud pointer-events-auto"
            data-testid="controls-hud"
            data-expanded={collapsed ? undefined : "true"}
            data-tone={tone}
            aria-label="Vehicle controls"
            onPointerDown={controls.disable}
            onPointerUp={controls.enable}
            onPointerCancel={controls.enable}
            onPointerLeave={controls.enable}
        >
            <button
                type="button"
                className="controls-hud__handle"
                aria-expanded={!collapsed}
                aria-controls="controls-hud-body"
                onClick={toggleCollapsed}
            >
                <IconCircleFilled className="controls-hud__dot" size={8} aria-hidden="true" />
                <span className="controls-hud__identity">
                    <span className="controls-hud__title">Controls</span>
                    {authority ? <span className="controls-hud__authority">{authority}</span> : null}
                </span>
                <span className="controls-hud__speed">
                    {snapshot ? (
                        <>
                            {formatNum(achievedSpeed)}
                            <span className="controls-hud-unit">m/s</span>
                        </>
                    ) : (
                        <span className="controls-hud-unit">idle</span>
                    )}
                </span>
                <IconChevronUp className="controls-hud__chevron" size={14} stroke={1.75} aria-hidden="true" />
            </button>

            {!collapsed && (
                <div id="controls-hud-body" className="controls-hud-body">
                    {snapshot ? (
                        <>
                            <div className="controls-hud-meta">
                                <span>{status}</span>
                                <span>{snapshot.mode || "stop"} · seq {snapshot.sequence ?? "—"}</span>
                            </div>

                            <div className="controls-hud-meter">
                                <table className="controls-hud-table">
                                    <thead>
                                        <tr>
                                            <th scope="col"><span className="controls-hud-sr">Signal</span></th>
                                            <th scope="col">Req</th>
                                            <th scope="col">App</th>
                                            <th scope="col">Ach</th>
                                            <th scope="col"><span className="controls-hud-sr">Unit</span></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <MeterRow
                                            label="Speed"
                                            unit="m/s"
                                            requested={snapshot.requested?.speedMps}
                                            applied={snapshot.applied?.speedMps}
                                            achieved={snapshot.achieved?.speedMps}
                                            digits={2}
                                            warnApplied={flags.saturated}
                                        />
                                        <MeterRow
                                            label="Steer"
                                            unit="rad"
                                            requested={snapshot.requested?.steeringRad}
                                            applied={snapshot.applied?.steeringRad}
                                            achieved={snapshot.achieved?.steeringRad}
                                            digits={3}
                                            warnApplied={flags.saturated}
                                        />
                                        <MeterRow
                                            label="Accel"
                                            unit="m/s²"
                                            requested={snapshot.requested?.accelerationMps2}
                                            applied={snapshot.applied?.accelerationMps2}
                                            achieved={snapshot.achieved?.accelerationMps2}
                                            digits={2}
                                            warnApplied={flags.saturated}
                                        />
                                    </tbody>
                                </table>
                            </div>

                            <div className="controls-hud-footer">
                                <span>age {formatAge(snapshot.heartbeatAgeNs ?? snapshot.ageNs)}</span>
                                <span>delay {formatAge(snapshot.delayNs)}</span>
                                {flagLabels.map((entry) => (
                                    <span key={entry.label} className="controls-hud-flag" data-tone={entry.tone}>
                                        {entry.label}
                                    </span>
                                ))}
                            </div>
                        </>
                    ) : (
                        <p className="controls-hud-empty">Waiting for plant setpoints</p>
                    )}
                </div>
            )}
        </Panel>
    );
}
