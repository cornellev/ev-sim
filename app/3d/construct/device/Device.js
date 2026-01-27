import { useState } from "react";

export function DeviceOverlay({ device, disableOrbit, enableOrbit }) {
    const [settings, setSettings] = useState(device.settings);
    const [enabled, setEnabled] = useState(device.enabled);

    return (
        <div
            className="relative bg-[#2b2b2b] rounded-md border border-[#555555] text-white shadow-lg min-w-[260px] max-w-sm"
            onMouseDown={disableOrbit}
            onMouseUp={enableOrbit}
        >
            <div className="flex items-center justify-between px-3 py-2 bg-[#3a3a3a] rounded-t-md border-b border-[#555555]">
                <p className="text-xs font-semibold tracking-wide select-none">{device.name}</p>
            </div>

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
                    {Object.keys(settings).map((key) => (
                        <div key={key} className="pt-2 border-t border-[#3f3f3f]">
                            {typeof settings[key] === "object" ? (
                                <>
                                    <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-300 select-none">
                                        {key}
                                    </p>
                                    {Object.keys(settings[key]).map((subKey) => (
                                        <div
                                            key={subKey}
                                            className="flex items-center justify-between gap-2 py-0.5"
                                        >
                                            <label className="w-2/5 text-[11px] text-gray-200 select-none truncate">
                                                {subKey}
                                            </label>
                                            <input
                                                type="text"
                                                value={settings[key][subKey]}
                                                onChange={(e) => {
                                                    const newSettings = {
                                                        ...settings,
                                                        [key]: {
                                                            ...settings[key],
                                                            [subKey]: e.target.value,
                                                        },
                                                    };
                                                    setSettings(newSettings);
                                                    device.settings = newSettings;
                                                }}
                                                className="w-3/5 rounded-sm border border-[#555555] bg-[#1f1f1f] px-1 py-0.5 text-[11px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-[#5fa9ff] focus:border-[#5fa9ff]"
                                            />
                                        </div>
                                    ))}
                                </>
                            ) : (
                                <div className="flex items-center justify-between gap-2 py-0.5">
                                    <label className="w-2/5 text-[11px] text-gray-200 select-none truncate">
                                        {key}
                                    </label>
                                    <input
                                        type="text"
                                        value={settings[key]}
                                        onChange={(e) => {
                                            const newSettings = { ...settings, [key]: e.target.value };
                                            setSettings(newSettings);
                                            device.settings = newSettings;
                                        }}
                                        className="w-3/5 rounded-sm border border-[#555555] bg-[#1f1f1f] px-1 py-0.5 text-[11px] text-gray-100 focus:outline-none focus:ring-1 focus:ring-[#5fa9ff] focus:border-[#5fa9ff]"
                                    />
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

export default class Device {
    constructor(name, settings={}) {
        this.name = name || "Generic Device";
        this.settings = settings;
        this.position = { x: 0, y: 0, z: 0 };
        this.enabled = true;
    }

    getPosition() {
        return this.position;
    }

    setPosition(x, y, z) {
        this.position = { x, y, z };
    }

    getMesh({ ...props }) {
        // Placeholder for mesh generation logic
        return null;
    }

    meshContructor() {
        return this.getMesh.bind(this);
    }

    overlayConstructor() {
        const device = this;
        return function OverlayInstance(props) {
            return <DeviceOverlay device={device} {...props} />;
        };
    }
}

