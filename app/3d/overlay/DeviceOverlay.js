'use client';

import * as THREE from "three";
import { useMemo, useState } from "react";
import { keyText, keys } from "../../util/Keys";

function asInputValue(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string") return value;
    return JSON.stringify(value);
}

function updateSettingsAtPath(current, path, newValue) {
    if (!path.length) return current;

    const [head, ...rest] = path;

    if (current instanceof THREE.Vector3 || current instanceof THREE.Euler) {
        const cloned = current.clone();
        if (!rest.length) {
            cloned[head] = newValue;
            return cloned;
        }

        cloned[head] = updateSettingsAtPath(cloned[head], rest, newValue);
        return cloned;
    }

    if (Array.isArray(current)) {
        const clone = [...current];
        const index = Number(head);
        if (!rest.length) {
            clone[index] = newValue;
            return clone;
        }

        clone[index] = updateSettingsAtPath(clone[index], rest, newValue);
        return clone;
    }

    const base = current && typeof current === "object" ? current : {};
    if (!rest.length) {
        return {
            ...base,
            [head]: newValue,
        };
    }

    return {
        ...base,
        [head]: updateSettingsAtPath(base[head], rest, newValue),
    };
}

function DeviceSettingField({ label, value, path, onChange }) {
    if (value instanceof THREE.Vector3 || value instanceof THREE.Euler) {
        return (
            <div className="rounded-lg border border-zinc-700/80 bg-zinc-900/70 p-2">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{keyText(label)}</p>
                <div className="grid grid-cols-3 gap-1.5">
                    {[
                        ["x", value.x],
                        ["y", value.y],
                        ["z", value.z],
                    ].map(([axis, axisValue]) => (
                        <label key={axis} className="space-y-1">
                            <span className="text-[10px] uppercase text-zinc-400">{axis}</span>
                            <input
                                type="number"
                                value={asInputValue(axisValue)}
                                onChange={(e) => {
                                    const next = Number(e.target.value);
                                    onChange(path.concat(axis), Number.isFinite(next) ? next : axisValue);
                                }}
                                className="h-8 w-full rounded-md border border-zinc-700/80 bg-zinc-950/80 px-2 text-[11px] text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
                            />
                        </label>
                    ))}
                </div>
            </div>
        );
    }

    if (Array.isArray(value)) {
        return (
            <div className="rounded-lg border border-zinc-700/80 bg-zinc-900/70 p-2">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{keyText(label)}</p>
                <div className="space-y-1.5">
                    {value.map((entry, index) => (
                        <DeviceSettingField
                            key={`${label}_${index}`}
                            label={`Item ${index + 1}`}
                            value={entry}
                            path={path.concat(String(index))}
                            onChange={onChange}
                        />
                    ))}
                </div>
            </div>
        );
    }

    const isObject = value !== null && typeof value === "object";
    if (isObject) {
        return (
            <div className="rounded-lg border border-zinc-700/80 bg-zinc-900/70 p-2">
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">{keyText(label)}</p>
                <div className="space-y-1.5">
                    {keys(value).map((childKey) => (
                        <DeviceSettingField
                            key={childKey}
                            label={childKey}
                            value={value[childKey]}
                            path={path.concat(childKey)}
                            onChange={onChange}
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (typeof value === "boolean") {
        return (
            <button
                type="button"
                className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700/80 bg-zinc-900/85 px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/90"
                onClick={() => onChange(path, !value)}
            >
                <span className="text-[11px] font-medium text-zinc-100">{keyText(label)}</span>
                <span
                    className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
                        value ? "border-sky-400/80 bg-sky-500/75" : "border-zinc-500/70 bg-zinc-700/80"
                    }`}
                >
                    <span
                        className={`mx-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                            value ? "translate-x-4" : "translate-x-0"
                        }`}
                    />
                </span>
            </button>
        );
    }

    const numeric = typeof value === "number";

    return (
        <label className="flex items-center justify-between gap-2 rounded-lg border border-zinc-700/80 bg-zinc-900/85 px-2 py-1.5">
            <span className="truncate text-[11px] font-medium text-zinc-100">{keyText(label)}</span>
            <input
                type={numeric ? "number" : "text"}
                value={asInputValue(value)}
                onChange={(e) => {
                    if (numeric) {
                        const next = Number(e.target.value);
                        onChange(path, Number.isFinite(next) ? next : value);
                        return;
                    }

                    onChange(path, e.target.value);
                }}
                className="h-8 w-28 rounded-md border border-zinc-700/80 bg-zinc-950/80 px-2 text-[11px] text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-400/60"
            />
        </label>
    );
}

export function DeviceOverlay({ device, data, onBack, panelClassName = "", visible = true }) {
    const [settings, setSettings] = useState(device?.settings ?? {});
    const [collapsed, setCollapsed] = useState(false);
    const [enabled, setEnabled] = useState(Boolean(device?.enabled));

    const controls = useMemo(() => {
        const settingsRef = data?.settings?.();
        return {
            disable: settingsRef?.disableControls,
            enable: settingsRef?.enableControls,
        };
    }, [data]);

    if (!device) return null;

    const handleChange = (path, newValue) => {
        setSettings((previous) => {
            const next = updateSettingsAtPath(previous, path, newValue);
            device.settings = next;
            return next;
        });
    };

    return (
        <div
            className={`absolute top-3 left-3 z-30 w-[300px] rounded-2xl border border-zinc-700/80 bg-zinc-950/85 p-3 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl transition-all duration-200 ease-out ${visible ? "opacity-100 translate-y-0 scale-100 pointer-events-auto" : "opacity-0 -translate-y-1 scale-[0.985] pointer-events-none"} ${panelClassName}`}
            onMouseDown={controls.disable}
            onMouseUp={controls.enable}
            onMouseLeave={controls.enable}
        >
            <div className="mb-2 flex items-center justify-between border-b border-zinc-700/80 pb-2">
                <div className="min-w-0">
                    <p className="truncate text-[12px] font-semibold tracking-wide text-zinc-100">{device.name}</p>
                    <p className="text-[10px] text-zinc-400">Device Control Panel</p>
                </div>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        className="rounded-md border border-zinc-700/80 bg-zinc-900/80 px-2 py-1 text-[10px] font-medium text-zinc-200 hover:bg-zinc-800/90"
                        onClick={onBack}
                    >
                        Back
                    </button>
                    <button
                        type="button"
                        className="h-7 w-7 rounded-md border border-zinc-700/80 bg-zinc-900/80 text-xs text-zinc-200 hover:bg-zinc-800/90"
                        onClick={() => setCollapsed((prev) => !prev)}
                        aria-label={collapsed ? "Expand panel" : "Collapse panel"}
                        title={collapsed ? "Expand panel" : "Collapse panel"}
                    >
                        {collapsed ? "▾" : "▴"}
                    </button>
                </div>
            </div>

            {!collapsed && (
                <div className="space-y-2">
                    <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700/80 bg-zinc-900/85 px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/90"
                        onClick={() => {
                            const next = !enabled;
                            setEnabled(next);
                            device.enabled = next;
                        }}
                    >
                        <div>
                            <p className="text-[11px] font-medium text-zinc-100">Enabled</p>
                        </div>
                        <span
                            className={`relative inline-flex h-5 w-9 items-center rounded-full border transition-colors ${
                                enabled ? "border-sky-400/80 bg-sky-500/75" : "border-zinc-500/70 bg-zinc-700/80"
                            }`}
                        >
                            <span
                                className={`mx-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                                    enabled ? "translate-x-4" : "translate-x-0"
                                }`}
                            />
                        </span>
                    </button>

                    <div className="max-h-[52vh] space-y-1.5 overflow-auto pr-1 hide-scrollbar">
                        {keys(settings || {}).map((key) => (
                            <DeviceSettingField
                                key={key}
                                label={key}
                                value={settings[key]}
                                path={[key]}
                                onChange={handleChange}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
