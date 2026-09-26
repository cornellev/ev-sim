'use client';

import { useEffect, useState } from "react";
import { SimulationMenu } from "./SimulationMenu";
import { SimulationCleanupOverlay } from "./SimulationCleanupOverlay";
import { VisualPreviewDiagnostic } from "./VisualPreviewDiagnostic";
import { VehicleOverlay } from "./VehicleOverlay";
import { SensorProductPanel } from "./SensorProductPanel";
import { ControlsHud } from "./ControlsHud";
import { PerspectiveTransport } from "./PerspectiveTransport";
import { PlanView } from "../../spatial/planview/PlanView.js";
import { useShortcut } from "../../ui";

const INACTIVE_PERSPECTIVE = Object.freeze({ active: false, locked: false, label: "" });

export function SimulationChrome({ data, onOpenReplay }) {
    const [vehicleOverlayVisible, setVehicleOverlayVisible] = useState(true);
    const [sensorPanelVisible, setSensorPanelVisible] = useState(true);
    const [compact, setCompact] = useState(false);
    const [viewMode, setViewMode] = useState("3d");
    const perspectiveView = data?.simulation?.()?.perspectiveView ?? null;
    const [perspective, setPerspective] = useState(() => perspectiveView?.getSnapshot?.() ?? INACTIVE_PERSPECTIVE);

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

    useEffect(() => {
        if (!perspectiveView?.subscribe) return undefined;
        return perspectiveView.subscribe(setPerspective);
    }, [perspectiveView]);

    useEffect(() => () => perspectiveView?.exit?.(), [perspectiveView]);

    const mapActive = viewMode === "map" && !perspective.active;
    useEffect(() => {
        const simulation = data?.simulation?.();
        simulation?.setSceneRenderEnabled?.(!mapActive);
        return () => simulation?.setSceneRenderEnabled?.(true);
    }, [data, mapActive]);

    useEffect(() => {
        if (!mapActive) return undefined;
        const root = document.documentElement;
        root.dataset.simView = "map";
        return () => {
            delete root.dataset.simView;
        };
    }, [mapActive]);

    useShortcut({
        id: "simulation-compact-hierarchy",
        keys: "Escape",
        priority: 20,
        enabled: compact && vehicleOverlayVisible && !perspective.active,
        handler: () => {
            setVehicleOverlayVisible(false);
            return true;
        },
    });

    if (!data) return null;

    if (perspective.active) {
        return (
            <>
                <PerspectiveTransport data={data} snapshot={perspective} />
                <SimulationCleanupOverlay data={data} />
            </>
        );
    }

    return (
        <>
            {mapActive && <PlanView data={data} />}
            {vehicleOverlayVisible && <VehicleOverlay data={data} />}
            {sensorPanelVisible && (
                <div
                    className="pointer-events-auto fixed right-3 top-3 z-30"
                    style={{ width: "min(420px, calc(100vw - 1.5rem))" }}
                >
                    <SensorProductPanel compact={compact} />
                </div>
            )}
            <ControlsHud data={data} />
            <VisualPreviewDiagnostic data={data} />
            <SimulationCleanupOverlay data={data} />
            <SimulationMenu
                data={data}
                vehicleOverlayVisible={vehicleOverlayVisible}
                onVehicleOverlayVisibleChange={setVehicleOverlayVisible}
                sensorPanelVisible={sensorPanelVisible}
                onSensorPanelVisibleChange={setSensorPanelVisible}
                onOpenReplay={onOpenReplay}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
            />
        </>
    );
}
