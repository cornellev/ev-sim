'use client';

import { useEffect, useState } from "react";
import { SimulationMenu } from "./SimulationMenu";
import { VehicleOverlay } from "./VehicleOverlay";
import { SensorProductPanel } from "./SensorProductPanel";
import { useShortcut } from "../../ui";

export function SimulationChrome({ data, onOpenReplay }) {
    const [vehicleOverlayVisible, setVehicleOverlayVisible] = useState(true);
    const [sensorPanelVisible, setSensorPanelVisible] = useState(true);
    const [compact, setCompact] = useState(false);

    useEffect(() => {
        const query = window.matchMedia("(max-width: 1023px)");
        const sync = () => {
            setCompact(query.matches);
            setVehicleOverlayVisible(!query.matches);
            setSensorPanelVisible(!query.matches);
        };
        sync();
        query.addEventListener("change", sync);
        return () => query.removeEventListener("change", sync);
    }, []);

    useShortcut({
        id: "simulation-compact-hierarchy",
        keys: "Escape",
        priority: 20,
        enabled: compact && vehicleOverlayVisible,
        handler: () => {
            setVehicleOverlayVisible(false);
            return true;
        },
    });

    if (!data) return null;

    return (
        <>
            {vehicleOverlayVisible && <VehicleOverlay data={data} />}
            {sensorPanelVisible && (
                <div
                    className="pointer-events-auto fixed right-3 top-3 z-30"
                    style={{ width: "min(420px, calc(100vw - 1.5rem))" }}
                >
                    <SensorProductPanel compact={compact} />
                </div>
            )}
            <SimulationMenu
                data={data}
                vehicleOverlayVisible={vehicleOverlayVisible}
                onVehicleOverlayVisibleChange={setVehicleOverlayVisible}
                sensorPanelVisible={sensorPanelVisible}
                onSensorPanelVisibleChange={setSensorPanelVisible}
                onOpenReplay={onOpenReplay}
            />
        </>
    );
}
