

import { useMemo, useState } from "react";
import {
    FaPlay,
    FaPause,
    FaStepForward,
    FaStop,
    FaSlidersH,
    FaCube,
    FaTools,
    FaFlask,
    FaSearch,
    FaEdit,
    FaMicrochip,
    FaGlobe,
    FaBroadcastTower,
    FaDatabase,
    FaChartBar,
    FaVideo,
    FaLayerGroup,
} from "react-icons/fa";
import { FlyoutPanel } from "./ui/FlyoutPanel";
import { MenuButton } from "./ui/MenuButton";
import { MenuToggle } from "./ui/MenuToggle";
import { PanelSection } from "./ui/PanelSection";

export function SimulationMenu({ data, vehicleOverlayVisible = true, onVehicleOverlayVisibleChange }) {
    const [openPanel, setOpenPanel] = useState(null);
    const [transportState, setTransportState] = useState("stopped");
    const [toggles, setToggles] = useState({
        physics: false,
        realtime: true,
        deterministic: false,
        agents: true,
        environment: true,
        sensors: true,
        dataFeeds: true,
        diagnostics: false,
        recording: false,
        overlay: false,
    });

    const [mode, setMode] = useState("run");
    const modeOptions = [
        { key: "run", icon: <FaFlask className="h-3 w-3" />, title: "Run mode" },
        { key: "inspect", icon: <FaSearch className="h-3 w-3" />, title: "Inspect mode" },
        { key: "author", icon: <FaEdit className="h-3 w-3" />, title: "Author mode" },
    ];

    const engineToggleCount = [toggles.physics, toggles.realtime, toggles.deterministic].filter(Boolean).length;
    const modulesToggleCount = [toggles.agents, toggles.environment, toggles.sensors, toggles.dataFeeds].filter(Boolean).length;

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: settings?.disableControls,
            enable: settings?.enableControls,
        };
    }, [data]);

    const setToggle = (key, value) => {
        setToggles((prev) => ({ ...prev, [key]: value }));
    };

    const togglePanel = (panel) => {
        setOpenPanel((current) => (current === panel ? null : panel));
    };

    return (
        <div className="fixed bottom-0 left-0 right-0 z-20 px-3 pb-3 pointer-events-auto">
            <div
                className="relative mx-auto w-fit"
                onMouseDown={controls.disable}
                onMouseUp={controls.enable}
                onMouseLeave={controls.enable}
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
                                        checked={toggles.physics}
                                        onChange={(v) => setToggle("physics", v)}
                                    />
                                    <MenuToggle
                                        label="Real-Time Clock"
                                        icon={<FaBroadcastTower className="h-3 w-3" />}
                                        checked={toggles.realtime}
                                        onChange={(v) => setToggle("realtime", v)}
                                    />
                                    <MenuToggle
                                        label="Deterministic Mode"
                                        icon={<FaLayerGroup className="h-3 w-3" />}
                                        checked={toggles.deterministic}
                                        onChange={(v) => setToggle("deterministic", v)}
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
                                    <MenuToggle
                                        label="Agents"
                                        icon={<FaCube className="h-3 w-3" />}
                                        checked={toggles.agents}
                                        onChange={(v) => setToggle("agents", v)}
                                    />
                                    <MenuToggle
                                        label="Environment"
                                        icon={<FaGlobe className="h-3 w-3" />}
                                        checked={toggles.environment}
                                        onChange={(v) => setToggle("environment", v)}
                                    />
                                    <MenuToggle
                                        label="Sensors"
                                        icon={<FaBroadcastTower className="h-3 w-3" />}
                                        checked={toggles.sensors}
                                        onChange={(v) => setToggle("sensors", v)}
                                    />
                                    <MenuToggle
                                        label="Data Feeds"
                                        icon={<FaDatabase className="h-3 w-3" />}
                                        checked={toggles.dataFeeds}
                                        onChange={(v) => setToggle("dataFeeds", v)}
                                    />
                                </PanelSection>
                            </FlyoutPanel>
                        )}

                        {openPanel === "tools" && (
                            <FlyoutPanel
                                title="Operator Tools"
                                subtitle="Inspection, scripting, and diagnostics"
                            >
                                <PanelSection title="Actions">
                                    <div className="grid grid-cols-2 gap-1.5">
                                        <MenuButton compact variant="primary" title="Open ROS visual scripts" className="justify-start">
                                            <FaSlidersH className="h-3 w-3" />
                                            ROS
                                        </MenuButton>
                                        <MenuButton compact title="Open visual scripting canvas" className="justify-start">
                                            <FaEdit className="h-3 w-3" />
                                            Script
                                        </MenuButton>
                                        <MenuButton compact title="Open profiling tools" className="justify-start">
                                            <FaChartBar className="h-3 w-3" />
                                            Profile
                                        </MenuButton>
                                        <MenuButton compact title="Reset all runtime states" variant="danger" className="justify-start">
                                            <FaStop className="h-3 w-3" />
                                            Reset
                                        </MenuButton>
                                    </div>
                                </PanelSection>
                                <PanelSection title="Overlays">
                                    <MenuToggle
                                        label="Diagnostics"
                                        icon={<FaChartBar className="h-3 w-3" />}
                                        checked={toggles.diagnostics}
                                        onChange={(v) => setToggle("diagnostics", v)}
                                    />
                                    <MenuToggle
                                        label="Recording"
                                        icon={<FaVideo className="h-3 w-3" />}
                                        checked={toggles.recording}
                                        onChange={(v) => setToggle("recording", v)}
                                    />
                                    <MenuToggle
                                        label="Viewport Overlay"
                                        icon={<FaLayerGroup className="h-3 w-3" />}
                                        checked={toggles.overlay}
                                        onChange={(v) => setToggle("overlay", v)}
                                    />
                                </PanelSection>
                            </FlyoutPanel>
                        )}
                    </div>
                )}

                <div className="flex items-center gap-2 rounded-2xl border border-zinc-700/80 bg-zinc-950/70 p-2 text-zinc-100 shadow-[0_20px_70px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
                    <div className="flex items-center gap-1 rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-1">
                        {modeOptions.map((option) => (
                            <MenuButton
                                key={option.key}
                                iconOnly
                                variant="ghost"
                                active={option.key === mode}
                                onClick={() => setMode(option.key)}
                                title={option.title}
                                ariaLabel={option.title}
                            >
                                {option.icon}
                            </MenuButton>
                        ))}
                    </div>

                    <div className="h-7 w-px bg-zinc-700/80" />

                    <div className="flex items-center gap-1 rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-1">
                        <MenuButton
                            iconOnly
                            variant="primary"
                            active={transportState === "playing"}
                            onClick={() => setTransportState("playing")}
                            title="Run simulation"
                            ariaLabel="Play"
                        >
                            <FaPlay className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            active={transportState === "paused"}
                            onClick={() => setTransportState("paused")}
                            title="Pause simulation"
                            ariaLabel="Pause"
                        >
                            <FaPause className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            onClick={() => setTransportState("step")}
                            title="Advance one simulation step"
                            ariaLabel="Step"
                        >
                            <FaStepForward className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            variant="danger"
                            onClick={() => setTransportState("stopped")}
                            title="Stop and reset simulation"
                            ariaLabel="Reset"
                        >
                            <FaStop className="h-3 w-3" />
                        </MenuButton>
                    </div>

                    <div className="h-7 w-px bg-zinc-700/80" />

                    <div className="flex items-center gap-1 rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-1">
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
                            active={openPanel === "tools"}
                            onClick={() => togglePanel("tools")}
                            title="Open operator tools"
                            ariaLabel="Tools"
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

                    <div className="flex items-center gap-1 rounded-lg border border-zinc-700/80 bg-zinc-900/80 px-2 py-1 text-[10px] font-medium tracking-wide text-zinc-300 select-none">
                        <span className="text-sky-300">{engineToggleCount}</span>
                        <span className="text-zinc-500">/</span>
                        <span>{modulesToggleCount}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}