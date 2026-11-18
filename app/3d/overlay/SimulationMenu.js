

import { useEffect, useMemo, useRef, useState } from "react";
import {
    IconPlayerPlay as FaPlay,
    IconPlayerPause as FaPause,
    IconPlayerTrackNext as FaStepForward,
    IconPlayerStop as FaStop,
    IconRestore as FaRestore,
    IconAdjustmentsHorizontal as FaSlidersH,
    IconBox as FaBox,
    IconCube as FaCube,
    IconTool as FaTools,
    IconCpu as FaMicrochip,
    IconWorld as FaGlobe,
    IconBroadcast as FaBroadcastTower,
    IconDatabase as FaDatabase,
    IconStack2 as FaLayerGroup,
    IconCircle as FaCircle,
    IconCamera as FaCamera,
    IconView360 as FaView360,
    IconRadar as FaRadar,
    IconEye,
    IconChevronLeft,
    IconChevronRight,
    IconX,
} from "@tabler/icons-react";
import { Button, IconButton, PopoverSurface } from "../../ui";
import { SIMULATION_VISIBILITY_GROUPS, focusSimulationVisibility } from "./simulationVisibility.js";
import { applySimulationVisibilityPreference, writeSimulationVisibilityPreference } from "./simulationVisibilityPreferences.js";
import { FlyoutPanel } from "./ui/FlyoutPanel";
import { MenuButton } from "./ui/MenuButton";
import { MenuToggle } from "./ui/MenuToggle";
import { PanelSection } from "./ui/PanelSection";
import { IconMap2 as BiWorld } from "@tabler/icons-react";
import { RecordingPanel } from "../../logging/RecordingPanel";
import { getRecordingController } from "../../logging/RecordingController";
import { getRunSessionController } from "../../simulation/RunSessionController";
import { SimulationRunStatus } from "./SimulationRunStatus";
import { deriveSimulationStatus, formatSimulationTime, simulationPlaybackDisabled } from "./simulationStatus";
import { pauseSimulation, playSimulation, stopSimulation } from "./runPlayback";

const SIMULATION_MENU_CONTROL_LOCK = "simulation-menu";
const SIMULATION_POPOVER_CONTROL_LOCK = "simulation-menu-popover";
const VISIBILITY_GROUP_ICONS = {
    panels: FaLayerGroup,
    autonomy: FaMicrochip,
    roads: BiWorld,
    occupancy: FaRadar,
    diagnostics: FaSlidersH,
};

export function SimulationMenu({
    data,
    vehicleOverlayVisible = true,
    onVehicleOverlayVisibleChange,
    sensorPanelVisible = true,
    onSensorPanelVisibleChange,
    onOpenReplay,
    viewMode = "3d",
    onViewModeChange,
    lidarViewportEnabled = false,
    onLidarViewportEnabledChange,
    colliderViewportEnabled = false,
    onColliderViewportEnabledChange,
}) {
    const [openPanel, setOpenPanel] = useState(null);
    const [visibilityGroup, setVisibilityGroup] = useState(null);
    const visibilityBodyRef = useRef(null);
    const categoryToFocusRef = useRef(null);
    const visibilityKeyboardNavigationRef = useRef(false);

    const sim = data?.simulation?.();

    const [simState, setSimState] = useState(() => {
        return sim?.getSnapshot?.() ?? null;
    });
    const recordingController = useMemo(() => getRecordingController(), []);
    const runController = useMemo(() => getRunSessionController(), []);
    const [recordingState, setRecordingState] = useState(() => recordingController.getSnapshot());
    const [runState, setRunState] = useState(() => runController.getSnapshot());

    useEffect(() => {
        if (!sim) return;
        return sim.subscribe(setSimState);
    }, [sim]);

    useEffect(() => recordingController.subscribe(setRecordingState), [recordingController]);
    useEffect(() => runController.subscribe(setRunState), [runController]);

    const invokeRunControl = (manifestAction, legacyAction) => {
        const result = runState.activeRunId ? manifestAction() : legacyAction();
        result?.catch?.((error) => console.warn("Run control failed", error));
    };

    const runtimeStatus = deriveSimulationStatus(runState, simState);
    const stopActive = (runState.transitioning && ["ready", "running", "paused"].includes(runState.status))
        || ["stopped", "interrupted", "reset", "superseded"].includes(runState.status)
        || simState?.status === "stopped";
    const playbackDisabled = simulationPlaybackDisabled(runState);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(SIMULATION_MENU_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(SIMULATION_MENU_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => () => controls.enable(), [controls]);

    useEffect(() => {
        if (openPanel !== "engine" && openPanel !== "visibility") return;
        const settings = data?.settings?.();
        settings?.disableControls?.(SIMULATION_POPOVER_CONTROL_LOCK);
        return () => {
            settings?.enableControls?.(SIMULATION_POPOVER_CONTROL_LOCK);
            controls.enable();
        };
    }, [openPanel, data, controls]);

    useEffect(() => {
        if (openPanel !== "visibility") return;
        focusSimulationVisibility(
            visibilityBodyRef.current,
            visibilityKeyboardNavigationRef.current,
            visibilityGroup ? null : categoryToFocusRef.current ?? SIMULATION_VISIBILITY_GROUPS[0].id,
        );
        categoryToFocusRef.current = null;
    }, [openPanel, visibilityGroup]);

    const changePopover = (panel, open) => {
        if (panel === "visibility") {
            setVisibilityGroup(null);
            categoryToFocusRef.current = null;
        }
        setOpenPanel((current) => open ? panel : current === panel ? null : current);
        if (!open) controls.enable();
    };

    const togglePanel = (panel) => {
        setOpenPanel((current) => (current === panel ? null : panel));
    };

    const setVisibility = (key, value) => {
        const enabled = value === true;
        writeSimulationVisibilityPreference({ [key]: enabled });
        applySimulationVisibilityPreference(sim, runController, { [key]: enabled });
    };

    const visibilityOptions = {
        vehicleHierarchy: (
            <MenuToggle
                label="Vehicle hierarchy"
                icon={<FaLayerGroup className="h-3 w-3" />}
                checked={vehicleOverlayVisible}
                onChange={(value) => onVehicleOverlayVisibleChange?.(value)}
            />
        ),
        sensorPanel: (
            <MenuToggle
                label="Sensor product panel"
                icon={<FaSlidersH className="h-3 w-3" />}
                checked={sensorPanelVisible}
                onChange={(value) => onSensorPanelVisibleChange?.(value)}
            />
        ),
        oracle: (
            <MenuToggle
                label="Oracle overlays"
                icon={<FaLayerGroup className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.oracle !== false}
                onChange={(value) => setVisibility("oracle", value)}
            />
        ),
        candidate: (
            <MenuToggle
                label="Candidate overlays"
                icon={<FaBroadcastTower className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.candidate !== false}
                onChange={(value) => setVisibility("candidate", value)}
            />
        ),
        ekf: (
            <MenuToggle
                label="EKF estimate"
                icon={<FaMicrochip className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.ekf !== false}
                onChange={(value) => setVisibility("ekf", value)}
            />
        ),
        estimateClone: (
            <MenuToggle
                label="Estimate clone"
                icon={<FaCube className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.estimateClone !== false}
                onChange={(value) => setVisibility("estimateClone", value)}
            />
        ),
        lanes: (
            <MenuToggle
                label="Lane overlays"
                icon={<FaGlobe className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.lanes !== false}
                onChange={(value) => setVisibility("lanes", value)}
            />
        ),
        controls: (
            <MenuToggle
                label="Control arcs"
                icon={<FaSlidersH className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.controls !== false}
                onChange={(value) => setVisibility("controls", value)}
            />
        ),
        pastTrajectories: (
            <MenuToggle
                label="Past trajectories"
                icon={<FaLayerGroup className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.pastTrajectories !== false}
                onChange={(value) => setVisibility("pastTrajectories", value)}
            />
        ),
        oracleOccupancy: (
            <MenuToggle
                label="Oracle occupancy"
                icon={<FaGlobe className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.oracleOccupancy === true}
                onChange={(value) => setVisibility("oracleOccupancy", value)}
            />
        ),
        lidarOccupancy: (
            <MenuToggle
                label="LiDAR occupancy"
                icon={<FaRadar className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.lidarOccupancy === true}
                onChange={(value) => setVisibility("lidarOccupancy", value)}
            />
        ),
        stackOccupancy: (
            <MenuToggle
                label="Imported occupancy"
                icon={<FaBroadcastTower className="h-3 w-3" />}
                checked={simState?.autonomyOverlay?.stackOccupancy === true}
                onChange={(value) => setVisibility("stackOccupancy", value)}
            />
        ),
        scenarioDiagnostics: (
            <MenuToggle
                label="Scenario diagnostics"
                icon={<FaLayerGroup className="h-3 w-3" />}
                checked={!!simState?.scenarioDiagnostics?.enabled}
                onChange={(value) => setVisibility("scenarioDiagnostics", value)}
            />
        ),
        sensorMarkers: (
            <MenuToggle
                label="Sensor markers"
                icon={<FaBroadcastTower className="h-3 w-3" />}
                checked={simState?.debugVisuals?.sensorMarkers !== false}
                onChange={(value) => setVisibility("sensorMarkers", value)}
            />
        ),
        originMarker: (
            <MenuToggle
                label="Origin marker"
                icon={<FaCube className="h-3 w-3" />}
                checked={simState?.debugVisuals?.originMarker !== false}
                onChange={(value) => setVisibility("originMarker", value)}
            />
        ),
    };

    return (<>
        <SimulationRunStatus
            simState={simState}
            runState={runState}
            recordingState={recordingState}
            sensorPanelVisible={sensorPanelVisible}
        />
        <div className="fixed bottom-0 left-0 right-0 z-20 px-3 pb-3 pointer-events-auto">
            <div
                className="relative mx-auto w-fit"
                onPointerDown={controls.disable}
                onPointerUp={controls.enable}
                onPointerCancel={controls.enable}
                onPointerLeave={controls.enable}
            >
                {(openPanel === "views" || openPanel === "recording") && (
                    <div className="absolute bottom-[calc(100%+10px)] right-0">
                        {openPanel === "views" && (
                            <FlyoutPanel
                                title="Operator Views"
                                subtitle="Give yourself a different perspective!"
                            >
                                <PanelSection title="Views">
                                    <div className="grid grid-cols-2 gap-1.5">
                                        <MenuButton
                                            compact
                                            active={lidarViewportEnabled}
                                            title={lidarViewportEnabled ? "Show the camera view" : "Show the LiDAR view from this camera"}
                                            ariaLabel="LiDAR View"
                                            className="justify-start"
                                            onClick={() => onLidarViewportEnabledChange?.(!lidarViewportEnabled)}
                                        >
                                            <FaRadar className="h-3 w-3" />
                                            LiDAR View
                                        </MenuButton>
                                        <MenuButton
                                            compact
                                            active={colliderViewportEnabled}
                                            title={colliderViewportEnabled ? "Show the camera view" : "Show the collider view from this camera"}
                                            ariaLabel="Collider View"
                                            className="justify-start"
                                            onClick={() => onColliderViewportEnabledChange?.(!colliderViewportEnabled)}
                                        >
                                            <FaBox className="h-3 w-3" />
                                            Collider View
                                        </MenuButton>
                                    </div>
                                </PanelSection>
                            </FlyoutPanel>
                        )}

                        {openPanel === "recording" && (
                            <FlyoutPanel
                                title="Telemetry Recording"
                                subtitle="Compact backend logs with replay checkpoints"
                            >
                                <RecordingPanel data={data} onOpenReplay={onOpenReplay} />
                            </FlyoutPanel>
                        )}
                    </div>
                )}

                <div className="flex max-w-[calc(100vw-1.5rem)] items-center gap-2 overflow-x-auto rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-950/90 p-2 text-zinc-100 shadow-[0_20px_70px_rgba(0,0,0,0.5)]">

                    <div className="hidden min-w-[118px] px-2 sm:block">
                        <div className="flex items-center gap-1.5">
                            <FaCircle className={`h-2 w-2 ${runtimeStatus.tone === "emerald" ? "text-emerald-400" : runtimeStatus.tone === "amber" ? "text-amber-400" : runtimeStatus.tone === "rose" ? "text-rose-400" : runtimeStatus.tone === "sky" ? "text-sky-400" : "text-zinc-500"}`} />
                            <span className="truncate text-[11px] font-semibold text-zinc-200">{runtimeStatus.label}</span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] tabular-nums text-zinc-500">step {simState?.steps ?? 0} / {formatSimulationTime(simState?.time)}</p>
                    </div>

                    <div className="h-7 w-px shrink-0 bg-zinc-700/80" />

                    <div className="flex items-center gap-1 rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/80 p-1">
                        <MenuButton
                            iconOnly
                            variant="primary"
                            active={simState?.status === "playing"}
                            onClick={() => playSimulation(data)}
                            title="Run simulation"
                            ariaLabel="Play"
                            disabled={playbackDisabled}
                        >
                            <FaPlay className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            active={simState?.status === "paused"}
                            onClick={() => pauseSimulation(data)}
                            title="Pause simulation"
                            ariaLabel="Pause"
                            disabled={playbackDisabled}
                        >
                            <FaPause className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            onClick={() => invokeRunControl(() => runController.step(), () => sim?.step())}
                            title="Advance one simulation step"
                            ariaLabel="Step"
                            disabled={playbackDisabled}
                        >
                            <FaStepForward className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            variant="danger"
                            active={stopActive}
                            onClick={() => stopSimulation(data)}
                            title="Stop simulation"
                            ariaLabel="Stop"
                        >
                            <FaStop className="h-3 w-3" />
                        </MenuButton>
                        {runState.activeRunId && (
                            <MenuButton
                                iconOnly
                                onClick={() => invokeRunControl(() => runController.reset(), () => {})}
                                title="Finalize and reset simulation"
                                ariaLabel="Reset"
                                disabled={runState.transitioning}
                            >
                                <FaRestore className="h-3 w-3" />
                            </MenuButton>
                        )}
                        <MenuButton
                            iconOnly
                            active={viewMode === "map"}
                            onClick={() => onViewModeChange?.(viewMode === "map" ? "3d" : "map")}
                            title={viewMode === "map" ? "Switch to 3D view" : "Switch to map view"}
                            ariaLabel={viewMode === "map" ? "Switch to 3D view" : "Switch to map view"}
                        >
                            {viewMode === "map" ? <FaView360 className="h-3 w-3" /> : <BiWorld className="h-3 w-3" />}
                        </MenuButton>
                    </div>

                    <div className="h-7 w-px bg-zinc-700/80" />

                    <div className="flex items-center gap-1 rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/80 p-1">
                        <MenuButton
                            iconOnly
                            variant={recordingState.active ? "danger" : "default"}
                            active={recordingState.active || openPanel === "recording"}
                            onClick={() => togglePanel("recording")}
                            title={recordingState.active ? "Recording in progress" : "Configure logging"}
                            ariaLabel="Telemetry recording"
                        >
                            <FaCircle className={`h-2.5 w-2.5 ${recordingState.active ? "animate-pulse" : "text-red-400"}`} />
                        </MenuButton>
                    </div>

                    <div className="h-7 w-px bg-zinc-700/80" />

                    <div className="flex items-center gap-1 rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/80 p-1">
                        <PopoverSurface
                            open={openPanel === "engine"}
                            onOpenChange={(open) => changePopover("engine", open)}
                            side="top"
                            align="end"
                            collisionPadding={12}
                            className="sf-simulation-settings"
                            aria-label="Engine settings"
                            trigger={(
                                <IconButton label="Engine settings" tooltip="Open engine settings" variant="default" active={openPanel === "engine"}>
                                    <FaSlidersH className="h-3 w-3" />
                                </IconButton>
                            )}
                        >
                            <header className="sf-simulation-settings__header">
                                <h2 className="flex-1 text-[13px] font-semibold">Engine Settings</h2>
                                <IconButton label="Close engine settings" tooltip={false} onClick={() => changePopover("engine", false)}>
                                    <IconX size={14} aria-hidden="true" />
                                </IconButton>
                            </header>
                            <div className="sf-simulation-settings__body">
                                <PanelSection title="Runtime">
                                    <MenuToggle
                                        label="Physics Engine"
                                        icon={<FaMicrochip className="h-3 w-3" />}
                                        checked={!!simState?.modules?.physics}
                                        onChange={(v) => sim?.setPhysicsEnabled(v)}
                                    />
                                    <MenuToggle
                                        label="Real-Time Clock"
                                        icon={<FaBroadcastTower className="h-3 w-3" />}
                                        checked={!!simState?.realtime}
                                        onChange={(v) => sim?.setRealtime(v)}
                                    />
                                    <MenuToggle
                                        label="Deterministic Mode"
                                        icon={<FaLayerGroup className="h-3 w-3" />}
                                        checked={!!simState?.deterministic}
                                        onChange={(v) => sim?.setDeterministic(v)}
                                    />
                                </PanelSection>
                                <PanelSection title="Enabled systems">
                                    <p className="mb-2 text-[11px] text-[var(--slate-muted)]">These switches change execution, not visibility.</p>
                                    <MenuToggle
                                        label="Environment"
                                        icon={<FaGlobe className="h-3 w-3" />}
                                        checked={!!simState?.modules?.environment}
                                        onChange={(v) => sim?.setModule("environment", v)}
                                    />
                                    <MenuToggle
                                        label="Sensors"
                                        icon={<FaBroadcastTower className="h-3 w-3" />}
                                        checked={!!simState?.modules?.sensors}
                                        onChange={(v) => sim?.setModule("sensors", v)}
                                    />
                                    <MenuToggle
                                        label="Scripting"
                                        icon={<FaDatabase className="h-3 w-3" />}
                                        checked={!!simState?.modules?.scripting}
                                        onChange={(v) => sim?.setModule("scripting", v)}
                                    />
                                </PanelSection>
                            </div>
                        </PopoverSurface>
                        <PopoverSurface
                            open={openPanel === "visibility"}
                            onOpenChange={(open) => changePopover("visibility", open)}
                            side="top"
                            align="start"
                            collisionPadding={12}
                            className="sf-simulation-settings sf-simulation-visibility"
                            aria-label={visibilityGroup?.title ?? "Visibility"}
                            trigger={(
                                <IconButton
                                    label="Visibility"
                                    tooltip="Open visibility settings"
                                    variant="default"
                                    active={openPanel === "visibility"}
                                    onClick={(event) => { visibilityKeyboardNavigationRef.current = event.detail === 0; }}
                                >
                                    <IconEye className="h-3 w-3" />
                                </IconButton>
                            )}
                        >
                            <header className="sf-simulation-settings__header">
                                {visibilityGroup && (
                                    <Button
                                        size="compact"
                                        variant="ghost"
                                        aria-label="Back to visibility"
                                        onClick={(event) => {
                                            visibilityKeyboardNavigationRef.current = event.detail === 0;
                                            categoryToFocusRef.current = visibilityGroup.id;
                                            setVisibilityGroup(null);
                                        }}
                                    >
                                        <IconChevronLeft size={14} aria-hidden="true" />
                                        Back
                                    </Button>
                                )}
                                <h2 className="min-w-0 flex-1 text-[13px] font-semibold">{visibilityGroup?.title ?? "Visibility"}</h2>
                                <IconButton label="Close visibility" tooltip={false} onClick={() => changePopover("visibility", false)}>
                                    <IconX size={14} aria-hidden="true" />
                                </IconButton>
                            </header>
                            <div ref={visibilityBodyRef} tabIndex={-1} className="sf-simulation-settings__body space-y-1.5">
                                {visibilityGroup ? visibilityGroup.options.map((optionId) => (
                                    <div key={optionId}>{visibilityOptions[optionId]}</div>
                                )) : SIMULATION_VISIBILITY_GROUPS.map((group) => {
                                    const Icon = VISIBILITY_GROUP_ICONS[group.id];
                                    return (
                                        <Button
                                            key={group.id}
                                            variant="ghost"
                                            className="sf-simulation-settings__category"
                                            data-visibility-category={group.id}
                                            onClick={(event) => {
                                                visibilityKeyboardNavigationRef.current = event.detail === 0;
                                                setVisibilityGroup(group);
                                            }}
                                        >
                                            <Icon size={14} aria-hidden="true" className="text-[var(--slate-muted)]" />
                                            {group.title}
                                            <IconChevronRight size={14} aria-hidden="true" className="ml-auto text-[var(--slate-muted)]" />
                                        </Button>
                                    );
                                })}
                            </div>
                        </PopoverSurface>
                        <MenuButton
                            iconOnly
                            active={openPanel === "views"}
                            onClick={() => togglePanel("views")}
                            title="Open operator views"
                            ariaLabel="Views"
                        >
                            <FaTools className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            variant={vehicleOverlayVisible ? "primary" : "default"}
                            active={vehicleOverlayVisible}
                            className={vehicleOverlayVisible ? "border-emerald-400/80 bg-emerald-500/25 text-emerald-100" : "border-zinc-700/90 bg-zinc-900/90 text-zinc-400"}
                            onClick={() => onVehicleOverlayVisibleChange?.(!vehicleOverlayVisible)}
                            title={vehicleOverlayVisible ? "Hierarchy enabled (click to hide)" : "Hierarchy disabled (click to show)"}
                            ariaLabel="Toggle vehicle hierarchy"
                        >
                            <FaLayerGroup className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            onClick={() => data?.simulation?.()?.perspectiveView?.enter()}
                            title="Vehicle camera perspective"
                            ariaLabel="Vehicle camera perspective"
                        >
                            <FaCamera className="h-3 w-3" />
                        </MenuButton>
                    </div>

                    <div className="flex shrink-0 items-center gap-1 rounded-[var(--radius)] border border-zinc-700/80 bg-zinc-900/80 px-2 py-1 font-mono text-[11px] font-medium tabular-nums text-zinc-300 select-none" title="Simulation clock">
                        <span className="text-zinc-500">t</span>
                        <span>{formatSimulationTime(simState?.time)}</span>
                    </div>
                </div>
            </div>
        </div>
    </>);
}
