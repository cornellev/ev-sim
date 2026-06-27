'use client';

import { useEffect, useMemo, useState } from "react";
import {
    FaCube,
    FaLayerGroup,
    FaMap,
    FaMousePointer,
    FaPlay,
    FaRoad,
    FaStop,
    FaTools,
} from "react-icons/fa";
import { EDITOR_MODES, EDITOR_TOOLS } from "../editor/EditorState";
import { PLACEMENT_CATALOG } from "../editor/placement/PlacementCatalog";
import { FlyoutPanel } from "./ui/FlyoutPanel";
import { MenuButton } from "./ui/MenuButton";
import { MenuToggle } from "./ui/MenuToggle";
import { PanelSection } from "./ui/PanelSection";

const MENU_CONTROL_LOCK = "environment-editor-menu";

export function EnvironmentEditorMenu({ data }) {
    const [openPanel, setOpenPanel] = useState(null);
    const [editorSnapshot, setEditorSnapshot] = useState(null);
    const [bakeRunning, setBakeRunning] = useState(false);

    const controls = useMemo(() => {
        const settings = data?.settings?.();
        return {
            disable: () => settings?.disableControls?.(MENU_CONTROL_LOCK),
            enable: () => settings?.enableControls?.(MENU_CONTROL_LOCK),
        };
    }, [data]);

    useEffect(() => data?.editor?.()?.subscribe?.(setEditorSnapshot), [data]);

    useEffect(() => {
        const harness = data?.baking?.();
        if (!harness?.subscribe) return undefined;

        return harness.subscribe((snapshot) => {
            setBakeRunning(snapshot?.status === "running" || snapshot?.status === "preparing");
        });
    }, [data]);

    const toggleBake = async () => {
        const harness = data?.baking?.();
        const sim = data?.simulation?.();
        if (!harness || !sim) return;

        if (harness.running) {
            harness.stop();
            sim.setModule("baking", false);
            sim.pause();
            setBakeRunning(false);
            return;
        }

        await harness.start();
        sim.setModule("baking", true);
        sim.play();
        setBakeRunning(true);
    };

    const setLayer = (key, value) => {
        data?.editor?.()?.setLayerVisible?.(key, value);
        data?.environment?.()?.objects?.()?.setLayerVisible?.(key, value);
        data?.simulation?.()?.render?.();
    };

    const setChunkOutlinesVisible = (value) => {
        data?.editor?.()?.setChunkOutlinesVisible?.(value);
        data?.simulation?.()?.render?.();
    };

    const togglePanel = (panel) => {
        setOpenPanel((current) => (current === panel ? null : panel));
    };

    const layers = editorSnapshot?.layers ?? {
        buildings: true,
        roads: true,
        props: true,
    };
    const chunkOutlinesVisible = editorSnapshot?.chunkOutlinesVisible !== false;
    const activeTool = editorSnapshot?.activeTool ?? EDITOR_TOOLS.SELECT;
    const activePlacementId = editorSnapshot?.activePlacement?.id ?? null;
    const setTool = (tool) => data?.editor?.()?.setActiveTool?.(tool);
    const setPlacementAsset = (asset) => data?.editor?.()?.setPlacementAsset?.(asset);
    const enterMapMode = () => data?.editor?.()?.setEditorMode?.(EDITOR_MODES.MAP);

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
                        {openPanel === "layers" && (
                            <FlyoutPanel
                                title="Layer Visibility"
                                subtitle="Toggle world content groups"
                            >
                                <PanelSection title="Environment Layers">
                                    <MenuToggle
                                        label="Buildings"
                                        icon={<FaCube className="h-3 w-3" />}
                                        checked={layers.buildings}
                                        onChange={(value) => setLayer("buildings", value)}
                                        hint="Building meshes and footprints"
                                    />
                                    <MenuToggle
                                        label="Roads"
                                        icon={<FaRoad className="h-3 w-3" />}
                                        checked={layers.roads}
                                        onChange={(value) => setLayer("roads", value)}
                                        hint="Road surfaces and intersections"
                                    />
                                    <MenuToggle
                                        label="Props"
                                        icon={<FaLayerGroup className="h-3 w-3" />}
                                        checked={layers.props}
                                        onChange={(value) => setLayer("props", value)}
                                        hint="Signs, barrels, and decorations"
                                    />
                                    <MenuToggle
                                        label="Chunks"
                                        icon={<FaCube className="h-3 w-3" />}
                                        checked={chunkOutlinesVisible}
                                        onChange={setChunkOutlinesVisible}
                                        hint="20m chunk grid walls"
                                    />
                                </PanelSection>
                            </FlyoutPanel>
                        )}

                        {openPanel === "tools" && (
                            <FlyoutPanel
                                title="Edit Tools"
                                subtitle="Environment authoring utilities"
                            >
                                <PanelSection title="Place Objects">
                                    <div className="grid grid-cols-2 gap-1.5">
                                        {PLACEMENT_CATALOG.map((asset) => (
                                            <MenuButton
                                                key={asset.id}
                                                compact
                                                active={activeTool === EDITOR_TOOLS.PLACE && activePlacementId === asset.id}
                                                className="justify-start"
                                                onClick={() => setPlacementAsset(asset)}
                                                title={`Place ${asset.label}`}
                                            >
                                                <FaCube className="h-3 w-3" />
                                                {asset.label}
                                            </MenuButton>
                                        ))}
                                    </div>
                                </PanelSection>
                                <PanelSection title="Roads">
                                    <MenuButton
                                        compact
                                        className="justify-start"
                                        onClick={enterMapMode}
                                        title="Open map mode for road, building, and feature editing"
                                    >
                                        <FaMap className="h-3 w-3" />
                                        Map Mode
                                    </MenuButton>
                                </PanelSection>
                            </FlyoutPanel>
                        )}
                    </div>
                )}

                <div className="flex items-center gap-2 rounded-2xl border border-zinc-700/80 bg-zinc-950/70 p-2 text-zinc-100 shadow-[0_20px_70px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
                    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-100">
                        Environment Editor
                    </div>

                    <div className="h-7 w-px bg-zinc-700/80" />

                    <div className="flex items-center gap-1 rounded-xl border border-zinc-700/80 bg-zinc-900/80 p-1">
                        <MenuButton
                            iconOnly
                            variant={activeTool === EDITOR_TOOLS.SELECT ? "primary" : "default"}
                            active={activeTool === EDITOR_TOOLS.SELECT}
                            className={activeTool === EDITOR_TOOLS.SELECT ? "border-emerald-400/80 bg-emerald-500/25 text-emerald-100" : "border-zinc-700/90 bg-zinc-900/90 text-zinc-400"}
                            onClick={() => setTool(EDITOR_TOOLS.SELECT)}
                            title="Select objects (Q)"
                            ariaLabel="Select tool"
                        >
                            <FaMousePointer className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            variant={bakeRunning ? "primary" : "default"}
                            active={bakeRunning}
                            className={bakeRunning ? "border-sky-400/80 bg-sky-500/25 text-sky-100" : "border-zinc-700/90 bg-zinc-900/90 text-zinc-400"}
                            onClick={toggleBake}
                            title={bakeRunning ? "Stop bake run" : "Start bake run"}
                            ariaLabel={bakeRunning ? "Stop bake" : "Start bake"}
                        >
                            {bakeRunning ? <FaStop className="h-3 w-3" /> : <FaPlay className="h-3 w-3" />}
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            active={openPanel === "layers"}
                            onClick={() => togglePanel("layers")}
                            title="Open layer visibility"
                            ariaLabel="Layers"
                        >
                            <FaLayerGroup className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            onClick={enterMapMode}
                            title="Open map mode"
                            ariaLabel="Map mode"
                        >
                            <FaMap className="h-3 w-3" />
                        </MenuButton>
                        <MenuButton
                            iconOnly
                            active={openPanel === "tools"}
                            onClick={() => togglePanel("tools")}
                            title="Open edit tools"
                            ariaLabel="Edit tools"
                        >
                            <FaTools className="h-3 w-3" />
                        </MenuButton>
                    </div>
                </div>
            </div>
        </div>
    );
}
