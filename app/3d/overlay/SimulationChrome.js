'use client';

import { useState } from "react";
import { SimulationMenu } from "./SimulationMenu";
import { VehicleOverlay } from "./VehicleOverlay";

export function SimulationChrome({ data, onOpenReplay }) {
    const [vehicleOverlayVisible, setVehicleOverlayVisible] = useState(true);

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
