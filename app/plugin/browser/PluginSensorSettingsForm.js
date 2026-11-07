import { useState } from "react";

import { sensorJsonBufferId } from "../../config/runConfigSession.js";

const inputClass = "w-full rounded-[var(--radius)] border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-xs text-white outline-none";

function parseSettingValue(setting, raw) {
    if (setting.valueType === "boolean") return Boolean(raw);
    if (setting.valueType === "int32") return Number.parseInt(raw, 10);
    if (setting.valueType === "float64") return Number.parseFloat(raw);
    if (setting.valueType === "json") return typeof raw === "string" ? JSON.parse(raw) : raw;
    return raw;
}

function displaySettingValue(setting, value) {
    if (setting.valueType === "json") {
        return typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
    }
    return value ?? "";
}

function parameterRoot(context) {
    return context?.kind === "vehicle" ? "config" : "calibration";
}

export default function PluginSensorSettingsForm({
    context = { kind: "run" },
    sensor,
    descriptor,
    diagnostics = [],
    onChange,
    disabled = false,
    lockVehicleFields = false,
    onJsonBuffer = null,
    jsonResets = {},
}) {
    const root = parameterRoot(context);
    const parameters = sensor?.[root]?.parameters ?? {};
    const products = sensor?.[root]?.products ?? {};
    const scanLayout = sensor?.[root]?.scanLayout;
    const [layoutText, setLayoutText] = useState(() => JSON.stringify(scanLayout ?? {}, null, 2));
    const [seenLayout, setSeenLayout] = useState(scanLayout);
    const [draft, setDraft] = useState(() => ({ ...parameters }));
    const [seenParameters, setSeenParameters] = useState(parameters);
    const [error, setError] = useState(null);
    const [seenResets, setSeenResets] = useState(jsonResets);
    const layoutId = sensor?.id ? sensorJsonBufferId(sensor.id, `${root}.scanLayout`) : "";
    const layoutReset = layoutId ? (jsonResets[layoutId] ?? 0) : 0;
    const layoutTokenChanged = Boolean(layoutId) && (seenResets[layoutId] ?? 0) !== layoutReset;
    const parameterReset = (descriptor?.settings ?? []).some((setting) => {
        if (setting.valueType !== "json" || !sensor?.id) return false;
        const id = sensorJsonBufferId(sensor.id, `${root}.parameters.${setting.key}`);
        return (seenResets[id] ?? 0) !== (jsonResets[id] ?? 0);
    });
    if (layoutTokenChanged || parameterReset) {
        setSeenResets(jsonResets);
        setError(null);
        if (layoutTokenChanged) {
            setSeenLayout(scanLayout);
            setLayoutText(JSON.stringify(scanLayout ?? {}, null, 2));
        }
        if (parameterReset) setDraft({ ...parameters });
    } else if (scanLayout !== seenLayout) {
        setSeenLayout(scanLayout);
        setLayoutText(JSON.stringify(scanLayout ?? {}, null, 2));
    }
    if (parameters !== seenParameters) {
        setSeenParameters(parameters);
        setDraft({ ...parameters });
    }

    const commit = (path, value) => {
        try {
            const applied = onChange?.({ path, value });
            if (applied === false) {
                setDraft((current) => {
                    const next = { ...parameters };
                    for (const setting of descriptor?.settings ?? []) {
                        if (setting.valueType === "json" && typeof current[setting.key] === "string") {
                            next[setting.key] = current[setting.key];
                        }
                    }
                    return next;
                });
                return;
            }
            setError(null);
        } catch (caught) {
            setError(caught.message);
        }
    };

    const reportJson = (id, label, path, raw, { flushNow }) => {
        try {
            const parsed = JSON.parse(raw);
            setError(null);
            onJsonBuffer?.(id, {
                label,
                text: raw,
                parsed,
                patch: { kind: "sensor-json", sensorId: sensor.id, path },
            }, { flushNow });
        } catch (caught) {
            setError(caught.message);
            onJsonBuffer?.(id, {
                label,
                text: raw,
                error: caught.message,
                patch: { kind: "sensor-json", sensorId: sensor.id, path },
            }, { flushNow: false });
        }
    };

    const locked = disabled || lockVehicleFields;
    const diagnosticText = Array.isArray(diagnostics) ? diagnostics.filter(Boolean).join(" ") : diagnostics;

    return (
        <div className="space-y-2">
            {diagnosticText && <p className="text-[11px] text-amber-200">{diagnosticText}</p>}
            <label className="block text-[11px] text-zinc-400">
                Scan layout
                <textarea
                    className={`${inputClass} mt-1 font-mono`}
                    aria-label="Scan layout JSON"
                    disabled={locked}
                    rows={8}
                    value={layoutText}
                    onChange={(event) => {
                        const next = event.target.value;
                        setLayoutText(next);
                        if (!onJsonBuffer || !layoutId) return;
                        reportJson(layoutId, "Scan layout", `${root}.scanLayout`, next, { flushNow: false });
                    }}
                    onBlur={(event) => {
                        const next = event.target.value;
                        if (onJsonBuffer && layoutId) {
                            reportJson(layoutId, "Scan layout", `${root}.scanLayout`, next, { flushNow: true });
                            return;
                        }
                        try {
                            commit(`${root}.scanLayout`, JSON.parse(next));
                        } catch (caught) {
                            setError(caught.message);
                        }
                    }}
                />
            </label>
            {(descriptor?.settings ?? []).map((setting) => {
                const value = draft[setting.key] ?? setting.default ?? "";
                const path = `${root}.parameters.${setting.key}`;
                const settingBufferId = sensor?.id && setting.valueType === "json"
                    ? sensorJsonBufferId(sensor.id, path)
                    : "";
                if (setting.valueType === "boolean") {
                    return (
                        <label key={setting.key} className="flex items-center gap-2 text-[11px] text-zinc-300">
                            <input
                                type="checkbox"
                                disabled={locked}
                                checked={Boolean(value)}
                                onChange={(event) => {
                                    setDraft((current) => ({ ...current, [setting.key]: event.target.checked }));
                                    commit(path, event.target.checked);
                                }}
                            />
                            {setting.key}
                        </label>
                    );
                }
                if (setting.valueType === "enum") {
                    return (
                        <label key={setting.key} className="block text-[11px] text-zinc-400">
                            {setting.key}
                            <select
                                className={`${inputClass} mt-1`}
                                disabled={locked}
                                value={value}
                                onChange={(event) => {
                                    setDraft((current) => ({ ...current, [setting.key]: event.target.value }));
                                    commit(path, event.target.value);
                                }}
                            >
                                {(setting.options || []).map((option) => (
                                    <option key={option} value={option}>{option}</option>
                                ))}
                            </select>
                        </label>
                    );
                }
                return (
                    <label key={setting.key} className="block text-[11px] text-zinc-400">
                        {setting.key}
                        {setting.valueType === "json" ? (
                            <textarea
                                className={`${inputClass} mt-1 font-mono`}
                                disabled={locked}
                                rows={4}
                                value={displaySettingValue(setting, value)}
                                onChange={(event) => {
                                    const next = event.target.value;
                                    setDraft((current) => ({ ...current, [setting.key]: next }));
                                    if (!onJsonBuffer || !settingBufferId) return;
                                    reportJson(settingBufferId, setting.key, path, next, { flushNow: false });
                                }}
                                onBlur={(event) => {
                                    if (onJsonBuffer && settingBufferId) {
                                        reportJson(settingBufferId, setting.key, path, event.target.value, { flushNow: true });
                                        return;
                                    }
                                    try {
                                        const next = parseSettingValue(setting, event.target.value);
                                        setDraft((current) => ({ ...current, [setting.key]: next }));
                                        commit(path, next);
                                    } catch (caught) {
                                        setError(caught.message);
                                    }
                                }}
                            />
                        ) : (
                            <input
                                className={`${inputClass} mt-1`}
                                disabled={locked}
                                aria-label={setting.key}
                                type={["float64", "int32"].includes(setting.valueType) ? "number" : "text"}
                                min={setting.min}
                                max={setting.max}
                                value={value ?? ""}
                                onChange={(event) => setDraft((current) => ({ ...current, [setting.key]: event.target.value }))}
                                onBlur={(event) => {
                                    try {
                                        const next = parseSettingValue(setting, event.target.value);
                                        setDraft((current) => ({ ...current, [setting.key]: next }));
                                        commit(path, next);
                                    } catch (caught) {
                                        setError(caught.message);
                                    }
                                }}
                            />
                        )}
                    </label>
                );
            })}
            {(descriptor?.products ?? []).map((product) => (
                <label key={product.productId} className="flex items-center gap-2 text-[11px] text-zinc-300">
                    <input
                        type="checkbox"
                        disabled={locked}
                        checked={products[product.productId] === true}
                        onChange={(event) => commit(`${root}.products.${product.productId}`, event.target.checked)}
                    />
                    Enable {product.productId}
                    {product.kind === "vendor-packets" ? " (vendor packets)" : ""}
                </label>
            ))}
            {error && <p className="text-[11px] text-rose-300">{error}</p>}
        </div>
    );
}
