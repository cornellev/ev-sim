'use client';

import { useEffect, useState } from "react";
import { SimulationMenu } from "./SimulationMenu";
import { VehicleOverlay } from "./VehicleOverlay";
import { useShortcut } from "../../ui";

export function SimulationChrome({ data, onOpenReplay }) {
    const [vehicleOverlayVisible, setVehicleOverlayVisible] = useState(true);
    const [compact, setCompact] = useState(false);

    useEffect(() => {
        const query = window.matchMedia("(max-width: 1023px)");
        const sync = () => {
            setCompact(query.matches);
            setVehicleOverlayVisible(!query.matches);
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
            <SimulationMenu
                data={data}
                vehicleOverlayVisible={vehicleOverlayVisible}
                onVehicleOverlayVisibleChange={setVehicleOverlayVisible}
                onOpenReplay={onOpenReplay}
            />
        </>
    );
}
