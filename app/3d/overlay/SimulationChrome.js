'use client';

import { useEffect, useRef, useState } from "react";
import { SimulationMenu } from "./SimulationMenu";
import { SimulationCleanupOverlay } from "./SimulationCleanupOverlay";
import { VisualPreviewDiagnostic } from "./VisualPreviewDiagnostic";
import { VehicleOverlay } from "./VehicleOverlay";
import { SensorProductPanel } from "./SensorProductPanel";
import { ControlsHud } from "./ControlsHud";
import { PerspectiveTransport } from "./PerspectiveTransport";
import { PlanView } from "../../spatial/planview/PlanView.js";
import { getRunSessionController } from "../../simulation/RunSessionController";
import { useShortcut } from "../../ui";
import {
    applySimulationVisibilityPreference,
    panelVisibilityForLayout,
    readSimulationVisibilityPreference,
    writeSimulationVisibilityPreference,
} from "./simulationVisibilityPreferences.js";

const INACTIVE_PERSPECTIVE = Object.freeze({ active: false, locked: false, label: "" });

function viewportIsCompact() {
    try {
        return globalThis.window?.matchMedia?.("(max-width: 1023px)")?.matches === true;
    } catch {
        return false;
    }
}

function rememberedPanels() {
    const stored = readSimulationVisibilityPreference();
    return {
        vehicleHierarchy: stored.vehicleHierarchy !== false,
        sensorPanel: stored.sensorPanel !== false,
    };
}

export function SimulationChrome({ data, onOpenReplay }) {
    const preferredPanelsRef = useRef(null);
    if (preferredPanelsRef.current === null) preferredPanelsRef.current = rememberedPanels();
    const [compact, setCompact] = useState(viewportIsCompact);
    const [vehicleOverlayVisible, setVehicleOverlayVisible] = useState(
        () => panelVisibilityForLayout(viewportIsCompact(), preferredPanelsRef.current).vehicleHierarchy,
    );
    const [sensorPanelVisible, setSensorPanelVisible] = useState(
        () => panelVisibilityForLayout(viewportIsCompact(), preferredPanelsRef.current).sensorPanel,
    );
    const [viewMode, setViewMode] = useState("3d");
    const [lidarViewportEnabled, setLidarViewportEnabled] = useState(false);
    const [colliderViewportEnabled, setColliderViewportEnabled] = useState(false);
    const perspectiveView = data?.simulation?.()?.perspectiveView ?? null;
    const [perspective, setPerspective] = useState(() => perspectiveView?.getSnapshot?.() ?? INACTIVE_PERSPECTIVE);

    useEffect(() => {
        const query = window.matchMedia("(max-width: 1023px)");
        const sync = () => {
            const nextCompact = query.matches;
            setCompact(nextCompact);
            const panels = panelVisibilityForLayout(nextCompact, preferredPanelsRef.current);
            setVehicleOverlayVisible(panels.vehicleHierarchy);
            setSensorPanelVisible(panels.sensorPanel);
        };
        sync();
        query.addEventListener("change", sync);
        return () => query.removeEventListener("change", sync);
    }, []);

    useEffect(() => {
        const simulation = data?.simulation?.();
        if (!simulation) return;
        applySimulationVisibilityPreference(simulation, getRunSessionController(), readSimulationVisibilityPreference());
    }, [data]);

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
        const simulation = data?.simulation?.();
        simulation?.setLidarViewportEnabled?.(lidarViewportEnabled);
        return () => simulation?.setLidarViewportEnabled?.(false);
    }, [data, lidarViewportEnabled]);

    useEffect(() => {
        const simulation = data?.simulation?.();
        simulation?.setColliderViewportEnabled?.(colliderViewportEnabled);
        return () => simulation?.setColliderViewportEnabled?.(false);
    }, [data, colliderViewportEnabled]);

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

    const rememberPanel = (key, value) => {
        const enabled = value === true;
        preferredPanelsRef.current = { ...preferredPanelsRef.current, [key]: enabled };
        writeSimulationVisibilityPreference({ [key]: enabled });
        if (key === "vehicleHierarchy") setVehicleOverlayVisible(enabled);
        else setSensorPanelVisible(enabled);
    };

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
                onVehicleOverlayVisibleChange={(value) => rememberPanel("vehicleHierarchy", value)}
                sensorPanelVisible={sensorPanelVisible}
                onSensorPanelVisibleChange={(value) => rememberPanel("sensorPanel", value)}
                onOpenReplay={onOpenReplay}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
                lidarViewportEnabled={lidarViewportEnabled}
                onLidarViewportEnabledChange={(enabled) => {
                    setLidarViewportEnabled(enabled);
                    if (enabled) setColliderViewportEnabled(false);
                }}
                colliderViewportEnabled={colliderViewportEnabled}
                onColliderViewportEnabledChange={(enabled) => {
                    setColliderViewportEnabled(enabled);
                    if (enabled) setLidarViewportEnabled(false);
                }}
            />
        </>
    );
}
