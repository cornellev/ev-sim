import { useState } from "react";
import { DeviceDatabase } from "../data/DeviceDatabase";
import { Vector3 } from "three";
import { isVector3 } from "../../util/Checks";
import { Object } from "../data/objects/Object";
import { Data } from "../data/Data";
import { keys, keyText } from "../../util/Keys";

export function DeviceOverlayObject({ keyName, value, path, onChange }) {
    const isObject = value !== null && typeof value === "object";

    if (isObject) {
        return (
            <div className="pt-2 border-t border-[#3f3f3f]">
                {keyName && (
                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-300 select-none">
                        {keyText(keyName)}
                    </p>
                )}
                {keys(value).map((childKey) => (
                    <DeviceOverlayObject
                        key={childKey}
                        keyName={childKey}
                        value={value[childKey]}
                        path={[...path, childKey]}
                        onChange={onChange}
                    />
                ))}
            </div>
        );
    }

    return (
        <div className="flex items-center justify-between gap-2 py-1">
            <label className="w-2/5 text-[11px] text-gray-200 select-none truncate">
                {keyText(keyName)}
            </label>
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(path, e.target.value)}
                className="w-3/5 rounded-sm border border-[#555555] bg-[#1f1f1f] px-1 py-0.5 text-[11px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-[#5fa9ff] focus:border-[#5fa9ff]"
            />
        </div>
    );
}

export function DeviceOverlay({ device, data=new Data() }) {
    const [settings, setSettings] = useState(device.settings);
    const [enabled, setEnabled] = useState(device.enabled);

    const [minimized, setMinimized] = useState(false);

    const updateSettingsAtPath = (currentSettings, path, newValue) => {
        if (!path || path.length === 0) {
            return currentSettings;
        }

        const [head, ...rest] = path;

        if (rest.length === 0) {
            return {
                ...currentSettings,
                [head]: newValue,
            };
        }

        const child =
            currentSettings[head] && typeof currentSettings[head] === "object"
                ? currentSettings[head]
                : {};

        return {
            ...currentSettings,
            [head]: updateSettingsAtPath(child, rest, newValue),
        };
    };

    const handleChange = (path, newValue) => {
        setSettings((prev) => {
            const next = updateSettingsAtPath(prev || {}, path, newValue);
            device.settings = next;
            return next;
        });
    };

    return (
        <div
            className="relative top-[10px] left-[10px] bg-[#2b2b2b] rounded-md border border-[#555555] text-white shadow-lg min-w-[260px] max-w-sm select-all cursor-default pointer-events-auto"
            onMouseDown={data.settings().disableControls}
            onMouseUp={data.settings().enableControls}
        >
            <div className="flex items-center justify-between px-3 py-2 bg-[#3a3a3a] rounded-t-md border-b border-[#555555]">
                <p className="text-xs font-semibold tracking-wide select-none">{device.name}</p>
                <button
                    className="text-gray-400 hover:text-gray-200 focus:outline-none cursor-pointer"
                    onClick={() => setMinimized(!minimized)}
                >
                    {minimized ? (
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
                        </svg>
                    ) : (
                        <svg
                            xmlns="http://www.w3.org/2000/svg"
                            className="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                    )}
                </button>
            </div>
            {!minimized && (
            <div className="px-3 py-2 space-y-3 text-xs">
                <div className="flex items-center justify-between">
                    <label className="mr-2 font-medium text-[11px] uppercase tracking-wide text-gray-200 select-none">
                        Enabled
                    </label>
                    <input
                        type="checkbox"
                        className="h-3 w-3 accent-[#5fa9ff] cursor-pointer"
                        checked={enabled}
                        onChange={(e) => {
                            const nextEnabled = e.target.checked;
                            setEnabled(nextEnabled);
                            device.enabled = nextEnabled;
                        }}
                    />
                </div>

                <div className="space-y-2">
                    {keys(settings || {}).map((key) => (
                        <DeviceOverlayObject
                            key={key}
                            keyName={key}
                            value={settings[key]}
                            path={[key]}
                            onChange={handleChange}
                        />
                    ))}
                </div>
            </div>)}
        </div>
    );
}

export default class Device extends Object {
    constructor(name, settings={}) {
        super(true, true, false);

        this.name = name || "Generic Device";
        this.settings = settings;
        this.enabled = true;
        this.parent = null;
    }

    /**
     * @return {DeviceDatabase}
     */
    getParent() {
        return this.parent;
    }

    setup(scene) {
        // Override in subclasses
    }

}