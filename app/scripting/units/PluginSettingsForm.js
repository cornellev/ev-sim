import { useState } from "react";

import { requestUnitReconfiguration } from "../ScriptManager.js";
import { assertPluginSettingValue } from "../../plugin/PluginValues.js";

const inputClass = "w-full rounded-[var(--radius)] border border-white/10 bg-[var(--slate-bg)] px-2.5 py-1.5 text-xs text-white outline-none";

function parseSettingValue(setting, raw) {
    if (setting.valueType === "boolean") return Boolean(raw);
    if (setting.valueType === "int32") return Number.parseInt(raw, 10);
    if (setting.valueType === "float64") return Number.parseFloat(raw);
    if (setting.valueType === "json") return typeof raw === "string" ? JSON.parse(raw) : raw;
    return raw;
}

export default function PluginSettingsForm({
    uuid,
    settings = [],
    state = {},
    disabled = false,
    diagnostic = null,
}) {
    const [draft, setDraft] = useState(() => ({ ...state }));
    const [error, setError] = useState(null);
    const [seenState, setSeenState] = useState(state);
    if (state !== seenState) {
        setSeenState(state);
        setDraft({ ...state });
    }

    const commit = (key, nextValue) => {
        const setting = settings.find((entry) => entry.key === key);
        if (!setting) return;
        try {
            const value = parseSettingValue(setting, nextValue);
            assertPluginSettingValue(setting, value, setting.key);
            const next = { ...draft, [key]: value };
            const result = requestUnitReconfiguration(uuid, { state: next });
            if (!result?.ok) {
                setError(result?.error || "Could not update plugin settings.");
                return;
            }
            setDraft(result.state || next);
            setError(null);
        } catch (caught) {
            setError(caught.message);
        }
    };

    if (!settings.length && !diagnostic) return null;

    return (
        <div className="space-y-2">
            {diagnostic && (
                <p className="text-[11px] text-amber-200">{diagnostic}</p>
            )}
            {settings.map((setting) => {
                const value = draft[setting.key] ?? setting.default ?? "";
                if (setting.valueType === "boolean") {
                    return (
                        <label key={setting.key} className="flex items-center gap-2 text-[11px] text-zinc-300">
                            <input
                                type="checkbox"
                                disabled={disabled}
                                checked={Boolean(value)}
                                onChange={(event) => commit(setting.key, event.target.checked)}
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
                                disabled={disabled}
                                value={value}
                                onChange={(event) => commit(setting.key, event.target.value)}
                            >
                                {(setting.options || []).map((option) => (
                                    <option key={option} value={option}>{option}</option>
                                ))}
                            </select>
                        </label>
                    );
                }
                if (setting.valueType === "json") {
                    return (
                        <label key={setting.key} className="block text-[11px] text-zinc-400">
                            {setting.key}
                            <textarea
                                className={`${inputClass} mt-1 font-mono`}
                                disabled={disabled}
                                rows={4}
                                value={typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                                onBlur={(event) => commit(setting.key, event.target.value)}
                                onChange={(event) => setDraft((current) => ({ ...current, [setting.key]: event.target.value }))}
                            />
                        </label>
                    );
                }
                return (
                    <label key={setting.key} className="block text-[11px] text-zinc-400">
                        {setting.key}
                        <input
                            className={`${inputClass} mt-1`}
                            disabled={disabled}
                            aria-label={setting.key}
                            type={["float64", "int32"].includes(setting.valueType) ? "number" : "text"}
                            value={value ?? ""}
                            onChange={(event) => setDraft((current) => ({ ...current, [setting.key]: event.target.value }))}
                            onBlur={(event) => commit(setting.key, event.target.value)}
                        />
                    </label>
                );
            })}
            {error && <p className="text-[11px] text-rose-300">{error}</p>}
        </div>
    );
}
