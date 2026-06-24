

import { useEffect, useMemo, useState } from "react";
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
import { cn } from "./ui/cn";
import { BiWorld } from "react-icons/bi";

export function SimulationMenu({ data, vehicleOverlayVisible = true, onVehicleOverlayVisibleChange }) {
    const [openPanel, setOpenPanel] = useState(null);
    const [toggles, setToggles] = useState({
        agents: true,
        diagnostics: false,
        recording: false,
        overlay: false,
    });

    const sim = data?.simulation?.();

    const [simState, setSimState] = useState(() => {
        return sim?.getSnapshot?.() ?? null;
    });

    useEffect(() => {
        if (!sim) return;
        return sim.subscribe(setSimState);
    }, [sim]);

    const [mode, setMode] = useState("run");
    const modeOptions = [
        { key: "run", icon: <FaFlask className="h-3 w-3" />, title: "Run mode" },
        { key: "inspect", icon: <FaSearch className="h-3 w-3" />, title: "Inspect mode" },
        { key: "author", icon: <FaEdit className="h-3 w-3" />, title: "Author mode" },
    ];

    const engineToggleCount = [simState?.modules?.physics, simState?.realtime, simState?.deterministic].filter(Boolean).length;
    const modulesToggleCount = [toggles.agents, simState?.modules?.environment, simState?.modules?.sensors, simState?.modules?.scripting].filter(Boolean).length;

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
                    </div>
                )}

                <div className="flex items-center gap-2 rounded-2xl border border-zinc-700/80 bg-zinc-950/70 p-2 text-zinc-100 shadow-[0_20px_70px_rgba(0,0,0,0.5)] backdrop-blur-2xl">

                    <div className="flex items-center gap-1 rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-1">
                        <MenuButton
                            iconOnly
                            variant="primary"
                            active={simState?.status === "playing"}
                            onClick={() => sim?.play()}
                            title="Run simulation"
                            ariaLabel="Play"
                        >
                            <FaPlay className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            active={simState?.status === "paused"}
                            onClick={() => sim?.pause()}
                            title="Pause simulation"
                            ariaLabel="Pause"
                        >
                            <FaPause className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            onClick={() => sim?.step()}
                            title="Advance one simulation step"
                            ariaLabel="Step"
                        >
                            <FaStepForward className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            variant="danger"
                            active={simState?.status === "stopped"}
                            onClick={() => sim?.stop()}
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

function ModeSwitch({ value, options, onChange }) {
    const activeIndex = Math.max(0, options.findIndex((option) => option.key === value));

    const move = (direction) => {
        const nextIndex = (activeIndex + direction + options.length) % options.length;
        onChange(options[nextIndex].key);
    };

    return (
        <div
            role="radiogroup"
            aria-label="Interaction mode"
            className="relative grid w-[104px] shrink-0 grid-cols-3 rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-1"
            onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                    event.preventDefault();
                    move(1);
                }

                if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                    event.preventDefault();
                    move(-1);
                }
            }}
        >
            <span
                aria-hidden="true"
                className="mode-switch-thumb absolute left-1 top-1 h-8 w-8 rounded-lg border border-sky-400/70 bg-sky-500/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.14)]"
                style={{ transform: `translateX(${activeIndex * 2}rem)` }}
            />
            {options.map((option) => {
                const active = option.key === value;

                return (
                    <button
                        key={option.key}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={option.title}
                        aria-label={option.title}
                        className={cn(
                            "relative z-[1] flex h-8 w-8 items-center justify-center rounded-lg transition-[color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] focus:outline-none focus:ring-2 focus:ring-sky-400/60 active:scale-[0.97]",
                            active ? "text-sky-50" : "text-zinc-400 hover:text-zinc-100"
                        )}
                        onClick={() => onChange(option.key)}
                    >
                        {option.icon}
                    </button>
                );
            })}
        </div>
    );
}
