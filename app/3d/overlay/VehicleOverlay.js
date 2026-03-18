'use client';

import { useEffect, useMemo, useState } from "react";
import { DeviceOverlay } from "./DeviceOverlay";

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

    const vehicles = data?.vehicles?.()?.vehicles ?? [];

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: settings?.disableControls,
            enable: settings?.enableControls,
        };
    }, [data]);

    useEffect(() => {
        setExpandedVehicles((previous) => {
            const next = { ...previous };
            vehicles.forEach((_, index) => {
                if (typeof next[index] === "undefined") next[index] = true;
            });
            return next;
        });
    }, [vehicles]);

    useEffect(() => {
        if (!selectedDeviceRef) return;

        const stillExists =
            selectedDeviceRef.vehicleIndex < vehicles.length &&
            selectedDeviceRef.deviceIndex < (vehicles[selectedDeviceRef.vehicleIndex]?.devices?.length ?? 0);

        if (!stillExists) {
            setDeviceOverlayVisible(false);
            const timeout = setTimeout(() => {
                setSelectedDeviceRef(null);
            }, 180);

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
                className="absolute top-3 left-3 z-30 w-[292px] rounded-2xl border border-zinc-700/80 bg-zinc-950/85 p-2.5 text-zinc-100 shadow-[0_30px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl pointer-events-auto"
                onMouseDown={controls.disable}
                onMouseUp={controls.enable}
                onMouseLeave={controls.enable}
            >
                <div className="rounded-xl border border-zinc-700/80 bg-zinc-900/70 p-2">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Hierarchy</p>
                    <div className="max-h-[58vh] space-y-1 overflow-auto pr-1">
                        {vehicles.map((vehicle, vehicleIndex) => {
                            const vehicleName = getVehicleName(vehicle, vehicleIndex);
                            const isExpanded = Boolean(expandedVehicles[vehicleIndex]);
                            const isVehicleSelected = selectedVehicleIndex === vehicleIndex;
                            const devices = vehicle.devices ?? [];

                            return (
                                <div key={`${vehicleName}_${vehicleIndex}`} className="space-y-1">
                                    <div className="flex items-center gap-1">
                                        <button
                                            type="button"
                                            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-zinc-700/80 bg-zinc-900/85 text-[11px] text-zinc-300 hover:bg-zinc-800/90"
                                            onClick={() => toggleVehicleExpand(vehicleIndex)}
                                            title={isExpanded ? "Collapse" : "Expand"}
                                            aria-label={isExpanded ? "Collapse" : "Expand"}
                                        >
                                            {isExpanded ? "▾" : "▸"}
                                        </button>
                                        <button
                                            type="button"
                                            className={`flex-1 rounded-md border px-2 py-1 text-left text-[11px] font-medium transition-colors ${
                                                isVehicleSelected
                                                    ? "border-sky-400/80 bg-sky-500/20 text-zinc-100"
                                                    : "border-zinc-700/80 bg-zinc-900/85 text-zinc-100 hover:bg-zinc-800/90"
                                            }`}
                                            onClick={() => setSelectedVehicleIndex(vehicleIndex)}
                                        >
                                            {vehicleName}
                                            <span className="ml-2 text-[10px] text-zinc-400">({devices.length})</span>
                                        </button>
                                    </div>

                                    {isExpanded && (
                                        <div className="ml-7 space-y-1 border-l border-zinc-700/80 pl-2">
                                            {!devices.length && (
                                                <p className="px-1 py-0.5 text-[10px] text-zinc-500">No attached devices</p>
                                            )}

                                            {devices.map((device, deviceIndex) => {
                                                const selected =
                                                    selectedDeviceRef?.vehicleIndex === vehicleIndex &&
                                                    selectedDeviceRef?.deviceIndex === deviceIndex;

                                                return (
                                                    <button
                                                        key={`${device.name}_${vehicleIndex}_${deviceIndex}`}
                                                        type="button"
                                                        className={`flex w-full items-center justify-between rounded-md border px-2 py-1 text-left transition-colors ${
                                                            selected
                                                                ? "border-sky-400/80 bg-sky-500/20"
                                                                : "border-zinc-700/80 bg-zinc-900/80 hover:bg-zinc-800/90"
                                                        }`}
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
                                                        <span className="truncate text-[11px] text-zinc-100">{device.name}</span>
                                                        <span
                                                            className={`h-2 w-2 rounded-full ${
                                                                device.enabled ? "bg-emerald-400" : "bg-zinc-500"
                                                            }`}
                                                            title={device.enabled ? "Active" : "Disabled"}
                                                        />
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
                    data={data}
                    device={selectedDevice}
                    onBack={() => {
                        setDeviceOverlayVisible(false);
                        setTimeout(() => {
                            setSelectedDeviceRef(null);
                        }, 180);
                    }}
                    panelClassName="left-[306px]"
                    visible={deviceOverlayVisible}
                />
            )}
        </>
    );
}
