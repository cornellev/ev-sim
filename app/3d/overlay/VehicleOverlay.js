'use client';

import { useEffect, useMemo, useState } from "react";
import { IconPower } from "@tabler/icons-react";
import { DeviceOverlay } from "./DeviceOverlay";

const EMPTY_VEHICLES = [];
const HIERARCHY_CONTROL_LOCK = "simulation-vehicle-hierarchy";

function getVehicleName(vehicle, index) {
    if (!vehicle) return `Vehicle ${index + 1}`;
    if (vehicle.name && String(vehicle.name).trim()) return vehicle.name;
    if (vehicle.constructor?.name) return vehicle.constructor.name;
    return `Vehicle ${index + 1}`;
}

export function VehicleOverlay({ data }) {
    const [expandedVehicles, setExpandedVehicles] = useState({});
    const [selectedVehicleIndex, setSelectedVehicleIndex] = useState(null);
    const [selectedDeviceRef, setSelectedDeviceRef] = useState(null);
    const [deviceOverlayVisible, setDeviceOverlayVisible] = useState(false);
    const [deviceEnabledOverrides, setDeviceEnabledOverrides] = useState({});
    const [, refreshDevices] = useState(0);

    const vehicles = useMemo(() => data?.vehicles?.()?.vehicles ?? EMPTY_VEHICLES, [data]);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(HIERARCHY_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(HIERARCHY_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => {
        if (!selectedDeviceRef) return;

        const stillExists =
            selectedDeviceRef.vehicleIndex < vehicles.length &&
            selectedDeviceRef.deviceIndex < (vehicles[selectedDeviceRef.vehicleIndex]?.devices?.length ?? 0);

        if (!stillExists) {
            const timeout = setTimeout(() => {
                setDeviceOverlayVisible(false);
                setSelectedDeviceRef(null);
            }, 0);

            return () => clearTimeout(timeout);
        }
    }, [vehicles, selectedDeviceRef]);

    if (!vehicles.length) return null;

    const selectedDevice = selectedDeviceRef
        ? vehicles[selectedDeviceRef.vehicleIndex]?.devices?.[selectedDeviceRef.deviceIndex] ?? null
        : null;

    const toggleVehicleExpand = (index) => {
        setExpandedVehicles((previous) => ({
            ...previous,
            [index]: !previous[index],
        }));
    };

    return (
        <>
            <div
                className="absolute top-[58px] left-3 z-30 w-[292px] rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/85 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] pointer-events-auto"
                onMouseDown={controls.disable}
                onMouseUp={controls.enable}
                onMouseLeave={controls.enable}
            >
                <div className="rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/70 p-2">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Hierarchy</p>
                    <div className="max-h-[58vh] space-y-1 overflow-auto pr-1">
                        {vehicles.map((vehicle, vehicleIndex) => {
                            const vehicleName = getVehicleName(vehicle, vehicleIndex);
                            const isExpanded = expandedVehicles[vehicleIndex] ?? true;
                            const isVehicleSelected = selectedVehicleIndex === vehicleIndex;
                            const devices = vehicle.devices ?? [];

                            return (
                                <div key={`${vehicleName}_${vehicleIndex}`} className="space-y-1">
                                    <div className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/85 text-[11px] text-zinc-300 hover:bg-zinc-800/90"
                                            onClick={() => toggleVehicleExpand(vehicleIndex)}
                                            title={isExpanded ? "Collapse" : "Expand"}
                                            aria-label={isExpanded ? "Collapse" : "Expand"}
                                        >
                                            {isExpanded ? "▾" : "▸"}
                                        </button>
                                        <button
                                            type="button"
                                            className={`flex-1 rounded-[var(--radius)] border px-2 py-1 text-left text-[11px] font-medium transition-colors ${
                                                isVehicleSelected
                                                    ? "border-sky-400/80 bg-sky-500/20 text-zinc-100"
                                                    : "border-zinc-700/80 bg-zinc-900/85 text-zinc-100 hover:bg-zinc-800/90"
                                            }`}
                                            onClick={() => setSelectedVehicleIndex(vehicleIndex)}
                                        >
                                            {vehicleName}
                                            <span className="ml-2 text-[11px] text-zinc-400">({devices.length})</span>
                                        </button>
                                    </div>

                                    {isExpanded && (
                                        <div className="ml-7 space-y-1 border-l border-zinc-700/80 pl-2">
                                            {!devices.length && (
                                                <p className="px-1 py-0.5 text-[11px] text-zinc-500">No attached devices</p>
                                            )}

                                            {devices.map((device, deviceIndex) => {
                                                const deviceKey = `${vehicleIndex}:${deviceIndex}`;
                                                const deviceEnabled = Object.hasOwn(deviceEnabledOverrides, deviceKey)
                                                    ? deviceEnabledOverrides[deviceKey]
                                                    : Boolean(device.enabled);
                                                const selected =
                                                    selectedDeviceRef?.vehicleIndex === vehicleIndex &&
                                                    selectedDeviceRef?.deviceIndex === deviceIndex;

                                                return (
                                                    <button
                                                        key={`${device.name}_${vehicleIndex}_${deviceIndex}`}
                                                        type="button"
                                                        className="sf-device-hierarchy-row"
                                                        data-enabled={deviceEnabled}
                                                        data-selected={selected || undefined}
                                                        aria-label={`${device.name}, ${deviceEnabled ? "enabled" : "disabled"}`}
                                                        onClick={() => {
                                                            setSelectedVehicleIndex(vehicleIndex);
                                                            const isSameOpen =
                                                                selectedDeviceRef?.vehicleIndex === vehicleIndex &&
                                                                selectedDeviceRef?.deviceIndex === deviceIndex &&
                                                                deviceOverlayVisible;

                                                            if (isSameOpen) {
                                                                setDeviceOverlayVisible(false);
                                                                setTimeout(() => {
                                                                    setSelectedDeviceRef(null);
                                                                }, 180);
                                                                return;
                                                            }

                                                            setSelectedDeviceRef({ vehicleIndex, deviceIndex });
                                                            setDeviceOverlayVisible(true);
                                                        }}
                                                    >
                                                        <IconPower className="sf-device-hierarchy-row__state" size={13} stroke={1.9} aria-hidden="true" />
                                                        <span className="sf-device-hierarchy-row__name">{device.name}</span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            </div>

            {selectedDevice && (
                <DeviceOverlay
                    key={`${selectedDeviceRef.vehicleIndex}:${selectedDeviceRef.deviceIndex}`}
                    data={data}
                    device={selectedDevice}
                    onBack={() => {
                        setDeviceOverlayVisible(false);
                        setTimeout(() => {
                            setSelectedDeviceRef(null);
                        }, 180);
                    }}
                    onDeviceEnabledChange={(enabled) => {
                        selectedDevice.setEnabled?.(enabled);
                        setDeviceEnabledOverrides((current) => ({
                            ...current,
                            [`${selectedDeviceRef.vehicleIndex}:${selectedDeviceRef.deviceIndex}`]: Boolean(enabled),
                        }));
                        refreshDevices((revision) => revision + 1);
                    }}
                    onDeviceSettingsChange={(settings) => {
                        selectedDevice.setSettings?.(settings);
                        refreshDevices((revision) => revision + 1);
                    }}
                    onDeviceTelemetryIdChange={() => refreshDevices((revision) => revision + 1)}
                    panelClassName="left-[306px]"
                    visible={deviceOverlayVisible}
                />
            )}
        </>
    );
}
