

import { useEffect, useMemo, useState } from "react";
import {
    IconPlayerPlay as FaPlay,
    IconPlayerPause as FaPause,
    IconPlayerTrackNext as FaStepForward,
    IconPlayerStop as FaStop,
    IconAdjustmentsHorizontal as FaSlidersH,
    IconCube as FaCube,
    IconTool as FaTools,
    IconPencil as FaEdit,
    IconCpu as FaMicrochip,
    IconWorld as FaGlobe,
    IconBroadcast as FaBroadcastTower,
    IconDatabase as FaDatabase,
    IconStack2 as FaLayerGroup,
    IconCircle as FaCircle,
} from "@tabler/icons-react";
import { FlyoutPanel } from "./ui/FlyoutPanel";
import { MenuButton } from "./ui/MenuButton";
import { MenuToggle } from "./ui/MenuToggle";
import { PanelSection } from "./ui/PanelSection";
import { IconMap2 as BiWorld } from "@tabler/icons-react";
import { RecordingPanel } from "../../logging/RecordingPanel";
import { getRecordingController } from "../../logging/RecordingController";
import { getRunSessionController } from "../../simulation/RunSessionController";
import { SimulationRunStatus } from "./SimulationRunStatus";
import { deriveSimulationStatus, formatSimulationTime } from "./simulationStatus";

const SIMULATION_MENU_CONTROL_LOCK = "simulation-menu";

export function SimulationMenu({ data, vehicleOverlayVisible = true, onVehicleOverlayVisibleChange, onOpenReplay }) {
    const [openPanel, setOpenPanel] = useState(null);
    const [toggles, setToggles] = useState({
        agents: true,
        recording: false,
        overlay: false,
    });

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

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(SIMULATION_MENU_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(SIMULATION_MENU_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => () => controls.enable(), [controls]);

    const setToggle = (key, value) => {
        setToggles((prev) => ({ ...prev, [key]: value }));
    };

    const togglePanel = (panel) => {
        setOpenPanel((current) => (current === panel ? null : panel));
    };

    return (<>
        <SimulationRunStatus simState={simState} runState={runState} recordingState={recordingState} />
        <div className="fixed bottom-0 left-0 right-0 z-20 px-3 pb-3 pointer-events-auto">
            <div
                className="relative mx-auto w-fit"
                onPointerDown={controls.disable}
                onPointerUp={controls.enable}
                onPointerCancel={controls.enable}
                onPointerLeave={controls.enable}
            >
                {openPanel && (
                    <div className="absolute bottom-[calc(100%+10px)] right-0">
                        {openPanel === "engine" && (
                            <FlyoutPanel
                                title="Engine Settings"
                                subtitle="Master simulation runtime behavior"
                            >
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
                            </FlyoutPanel>
                        )}

                        {openPanel === "modules" && (
                            <FlyoutPanel
                                title="Module Visibility"
                                subtitle="Global systems for any simulation type"
                            >
                                <PanelSection title="Core Modules">
                                    {/* TODO: implement agents! */}
                                    <MenuToggle
                                        label="Agents"
                                        icon={<FaCube className="h-3 w-3" />}
                                        checked={toggles.agents}
                                        onChange={(v) => setToggle("agents", v)}
                                    />
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
                                    <MenuToggle
                                        label="Scenario diagnostics"
                                        icon={<FaLayerGroup className="h-3 w-3" />}
                                        checked={!!simState?.scenarioDiagnostics?.enabled}
                                        onChange={(value) => sim?.setScenarioDiagnosticsEnabled?.(value)}
                                    />
                                </PanelSection>
                            </FlyoutPanel>
                        )}

                        {openPanel === "views" && (
                            <FlyoutPanel
                                title="Operator Views"
                                subtitle="Used for viewing the scene."
                            >
                                <PanelSection title="Tools">
                                    <div className="grid grid-cols-2 gap-1.5">
                                        <MenuButton compact title="Open sensor viewer and inspector" className="justify-start">
                                            <FaSlidersH className="h-3 w-3" />
                                            PhysicsView
                                        </MenuButton>
                                        <MenuButton compact title="Open vehicle viewer, editor, and inspector" className="justify-start">
                                            <FaEdit className="h-3 w-3" />
                                            AutoShop
                                        </MenuButton>
                                        <MenuButton compact title="Open world view editor and viewer" className="justify-start">
                                            <BiWorld className="h-3 w-3" />
                                            WorldEdit
                                        </MenuButton>
                                        <MenuButton compact title="Change to simulation view" className="justify-start">
                                            <BiWorld className="h-3 w-3" />
                                            SimView
                                        </MenuButton>
                                    </div>
                                </PanelSection>
                                <PanelSection title="Views">
                                    <div className="grid grid-cols-2 gap-1.5">
                                        <MenuButton compact title="Open sensor viewer and inspector" className="justify-start">
                                            <FaSlidersH className="h-3 w-3" />
                                            Normal Render
                                        </MenuButton>
                                        <MenuButton compact title="Open world view editor and viewer" className="justify-start">
                                            <BiWorld className="h-3 w-3" />
                                            Sensor Render
                                        </MenuButton>
                                        <MenuButton compact title="Open vehicle viewer, editor, and inspector" className="justify-start">
                                            <FaEdit className="h-3 w-3" />
                                            Life Render
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
                            onClick={() => invokeRunControl(() => runController.play(), () => sim?.play())}
                            title="Run simulation"
                            ariaLabel="Play"
                        >
                            <FaPlay className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            active={simState?.status === "paused"}
                            onClick={() => invokeRunControl(() => runController.pause(), () => sim?.pause())}
                            title="Pause simulation"
                            ariaLabel="Pause"
                        >
                            <FaPause className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            onClick={() => invokeRunControl(() => runController.step(), () => sim?.step())}
                            title="Advance one simulation step"
                            ariaLabel="Step"
                        >
                            <FaStepForward className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            variant="danger"
                            active={simState?.status === "stopped"}
                            onClick={() => invokeRunControl(() => runController.reset(), () => sim?.stop())}
                            title="Finalize and reset simulation"
                            ariaLabel="Reset"
                        >
                            <FaStop className="h-3 w-3" />
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
                        <MenuButton
                            iconOnly
                            active={openPanel === "engine"}
                            onClick={() => togglePanel("engine")}
                            title="Open engine settings"
                            ariaLabel="Engine settings"
                        >
                            <FaSlidersH className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            active={openPanel === "modules"}
                            onClick={() => togglePanel("modules")}
                            title="Open module visibility settings"
                            ariaLabel="Modules"
                        >
                            <FaCube className="h-3 w-3" />
                        </MenuButton>
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
